import { ConfigService } from '@nestjs/config';
import { BitcoinCoreConfig } from '@/configuration.model';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { BitcoinNetwork } from '@/common/enum';
import {
    BITCOIN_CORE_FULL_VERBOSITY_VERSION,
    BITCOIN_CORE_PREVOUT_RAWTX_VERSION,
    BIP352_ACTIVATION_HEIGHT,
    DEFAULT_COMMIT_BATCH_BLOCKS,
} from '@/common/constants';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
    IndexerService,
    TransactionInput,
    TransactionOutput,
} from '@/indexer/indexer.service';
import { OperationStateService } from '@/operation-state/operation-state.service';
import {
    BaseBlockDataProvider,
    ProviderTransaction,
} from '@/block-data-providers/base-block-data-provider.abstract';
import {
    Block,
    BitcoinCoreOperationState,
    BlockHeader,
    BlockTransaction,
    Transaction,
    Output,
    RPCRequestBody,
    Input,
    NetworkInfo,
} from '@/block-data-providers/bitcoin-core/interfaces';
import { AxiosRequestConfig } from 'axios';
import { AxiosRetryConfig, makeRequest } from '@/common/request';
import { BlockStateService } from '@/block-state/block-state.service';
import { DbTransactionService } from '@/db-transaction/db-transaction.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { INDEXED_BLOCK_EVENT } from '@/common/events';
import { btcToSats } from '@/common/common';
import { StorageService } from '@/storage/storage.service';
import { PartitionManager } from '@/storage/partition-manager';
import { BlockTimer } from '@/common/telemetry';

/** RPC_INVALID_ADDRESS_OR_KEY: the txid is in neither the mempool nor a block. */
const RPC_INVALID_ADDRESS_OR_KEY = -5;

function isUnknownTransactionError(error: unknown): boolean {
    const rpcError = (
        error as {
            response?: { data?: { error?: { code?: number } } };
        }
    )?.response?.data?.error;
    return rpcError?.code === RPC_INVALID_ADDRESS_OR_KEY;
}
import { encodeSilentBlock } from '@/silent-blocks/silent-block-encoder';
import { TransactionData } from '@/storage/interfaces';

@Injectable()
export class BitcoinCoreProvider
    extends BaseBlockDataProvider<BitcoinCoreOperationState>
    implements OnApplicationBootstrap
{
    protected readonly logger = new Logger(BitcoinCoreProvider.name);
    protected readonly operationStateKey = 'bitcoincore-operation-state';
    private readonly rpcUrl: string;
    private isSyncing = false;
    private nodeVersion: number | null = null;
    private retryConfig: AxiosRetryConfig;
    private readonly commitBatchBlocks: number;

    public constructor(
        configService: ConfigService,
        indexerService: IndexerService,
        operationStateService: OperationStateService,
        blockStateService: BlockStateService,
        private readonly dbTransactionService: DbTransactionService,
        protected readonly eventEmitter: EventEmitter2,
        storageService: StorageService,
        private readonly partitionManager: PartitionManager,
    ) {
        super(
            configService,
            indexerService,
            operationStateService,
            blockStateService,
            storageService,
        );

        const { protocol, rpcPort, rpcHost } =
            configService.get<BitcoinCoreConfig>('bitcoinCore');

        this.rpcUrl = `${protocol}://${rpcHost}:${rpcPort}/`;

        this.retryConfig =
            this.configService.get<AxiosRetryConfig>('app.requestRetry');

        this.commitBatchBlocks =
            this.configService.get<number>('db.commitBatchBlocks') ??
            DEFAULT_COMMIT_BATCH_BLOCKS;
    }

    async onApplicationBootstrap() {
        const currentState = await this.getState();
        let indexedBlockHeight: number;

        if (currentState) {
            this.logger.log(
                `Restoring state from previous run: ${JSON.stringify(
                    currentState,
                )}`,
            );
            indexedBlockHeight = currentState.indexedBlockHeight;
        } else {
            this.logger.log('No previous state found. Starting from scratch.');

            indexedBlockHeight =
                this.configService.get<BitcoinNetwork>('app.network') ===
                BitcoinNetwork.MAINNET
                    ? BIP352_ACTIVATION_HEIGHT - 1
                    : 0;
            const blockHash = await this.getBlockHash(indexedBlockHeight);

            await this.dbTransactionService.execute(async (batch) => {
                await this.setState(
                    { indexedBlockHeight },
                    { blockHash, blockHeight: indexedBlockHeight },
                    batch,
                );
            });
        }

        await this.purgeAboveIndexedTip(indexedBlockHeight);
    }

    @Cron(CronExpression.EVERY_10_SECONDS)
    async sync() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        try {
            // Inside the try: if getState() throws or comes back empty, the
            // finally still clears the flag. Otherwise every later cron tick
            // no-ops and the indexer stalls silently until restart.
            const state = await this.getState();

            if (!state) {
                throw new Error('State not found');
            }

            const tipHeight = await this.getTipHeight();

            if (tipHeight <= state.indexedBlockHeight) {
                this.logger.debug(
                    `No new blocks found. Current tip height: ${tipHeight}`,
                );
                return;
            }

            const verbosityLevel = this.versionToVerbosity(
                await this.getNodeVersion(),
            );

            let height =
                ((await this.traceReorg()) ?? state.indexedBlockHeight) + 1;

            // Fetch height + 1 while height is indexed, so the RPC round trip
            // overlaps with the CPU-bound scan-tweak work.
            let nextBlock = this.prefetch(
                this.processBlock(height, verbosityLevel),
            );

            while (height <= tipHeight) {
                // One write transaction per run of blocks. Committing each
                // block separately re-walks and rewrites the same B+tree
                // interior pages every time; batching amortises them.
                // Clamped to a partition boundary, so a batch is never split
                // across two environments. That is what bounds crash recovery
                // to the single partition holding the first unindexed height.
                const batchEnd = this.partitionManager.clampBatchEnd(
                    height,
                    this.commitBatchBlocks,
                    tipHeight,
                );
                const timer = new BlockTimer();
                const indexedHeights: number[] = [];

                await this.dbTransactionService.execute(
                    async (batch) => {
                        for (let h = height; h <= batchEnd; h++) {
                            const { transactions, blockHash, blockTime } =
                                await timer.measureAsync(
                                    'processBlock',
                                    () => nextBlock,
                                );
                            if (h + 1 <= tipHeight) {
                                nextBlock = this.prefetch(
                                    this.processBlock(h + 1, verbosityLevel),
                                );
                            }
                            const blockTxData: TransactionData[] = [];

                            for (const transaction of transactions) {
                                const {
                                    txid,
                                    vin,
                                    vout,
                                    blockHeight,
                                    blockHash: txBlockHash,
                                } = transaction;
                                timer.count('numTx');
                                timer.count('numInputs', vin.length);
                                timer.count('numOutputs', vout.length);
                                const txData = await timer.measureAsync(
                                    'index',
                                    () =>
                                        this.indexTransaction(
                                            txid,
                                            vin,
                                            vout,
                                            blockHeight,
                                            txBlockHash,
                                            blockTime,
                                            batch,
                                        ),
                                );
                                if (txData) blockTxData.push(txData);
                            }

                            this.storageService.saveSilentBlock(
                                batch,
                                h,
                                encodeSilentBlock(blockTxData),
                            );

                            // Written per block, not once per batch: traceReorg
                            // walks block state one height at a time, so every
                            // height needs its own record.
                            state.indexedBlockHeight = h;
                            await this.setState(
                                state,
                                {
                                    blockHash: blockHash,
                                    blockHeight: h,
                                },
                                batch,
                            );
                            indexedHeights.push(h);
                        }
                    },
                    (ms) => timer.mark('commit', ms),
                );

                const { phasesMs, counts, totalMs } = timer.summary();
                const blocks = indexedHeights.length;
                this.logger.debug(
                    `blocks=${height}-${batchEnd} (${blocks}) ` +
                        `part=${this.partitionManager.partitionIndex(
                            height,
                        )} ` +
                        `tx=${counts.numTx ?? 0} ` +
                        `in=${counts.numInputs ?? 0} out=${
                            counts.numOutputs ?? 0
                        } | ` +
                        `processBlock=${phasesMs.processBlock ?? 0}ms ` +
                        `index=${phasesMs.index ?? 0}ms ` +
                        `commit=${phasesMs.commit ?? 0}ms ` +
                        `total=${totalMs}ms ` +
                        `perBlock=${(totalMs / blocks).toFixed(1)}ms`,
                );

                // Only after the commit: until then nothing is readable, and a
                // listener would read back uncommitted state.
                for (const h of indexedHeights) {
                    this.eventEmitter.emit(INDEXED_BLOCK_EVENT, h);
                }

                height = batchEnd + 1;
            }
        } finally {
            this.isSyncing = false;
        }
    }

    private async getNetworkInfo(): Promise<NetworkInfo> {
        return this.request({
            method: 'getnetworkinfo',
            params: [],
        });
    }

    /**
     * The node cannot change version without a restart, so this is resolved
     * once rather than on every sync tick and every txid lookup.
     */
    private async getNodeVersion(): Promise<number> {
        if (this.nodeVersion === null) {
            this.nodeVersion = (await this.getNetworkInfo()).version;
        }
        return this.nodeVersion;
    }

    private async getTipHeight(): Promise<number> {
        return this.request({
            method: 'getblockcount',
            params: [],
        });
    }

    async getBlockHash(height: number): Promise<string> {
        return this.request({
            method: 'getblockhash',
            params: [height],
        });
    }

    private async getBlock(hash: string, verbosity: number): Promise<Block> {
        return this.request({
            method: 'getblock',
            params: [hash, verbosity],
        });
    }

    private async getRawTransaction(
        txid: string,
        verbosity: boolean | number,
    ): Promise<BlockTransaction> {
        return this.request({
            method: 'getrawtransaction',
            params: [txid, verbosity],
        });
    }

    private async getBlockHeader(hash: string): Promise<BlockHeader> {
        return this.request({
            method: 'getblockheader',
            params: [hash],
        });
    }

    protected async fetchTransactionForTweak(
        txid: string,
    ): Promise<ProviderTransaction | null> {
        const version = await this.getNodeVersion();
        // Verbosity 2 embeds `vin[].prevout` in one call. Below Core 25 it is
        // not accepted, so ask for the plain verbose form and let
        // parseTransactionInput resolve each prevout itself.
        let tx: BlockTransaction;
        try {
            tx = await this.getRawTransaction(
                txid,
                version >= BITCOIN_CORE_PREVOUT_RAWTX_VERSION ? 2 : true,
            );
        } catch (error) {
            // Core answers an unknown txid with an HTTP 500 carrying
            // RPC_INVALID_ADDRESS_OR_KEY, which makeRequest rethrows as-is.
            // Left unhandled it would surface as a 500 from a route whose
            // caller means to return 404.
            if (isUnknownTransactionError(error)) return null;
            throw error;
        }

        // Prevouts come from block undo data, so an unconfirmed transaction
        // cannot be tweaked.
        if (!tx?.blockhash) return null;

        // A coinbase has no prevout to derive an input pubkey from; the block
        // indexer skips it for the same reason (processBlock starts at i = 1).
        if (tx.vin.some((input) => input.coinbase !== undefined)) return null;

        // Height is absent from the getrawtransaction payload at every
        // verbosity. Deriving it from `confirmations` would race the tip.
        const header = await this.getBlockHeader(tx.blockhash);

        return {
            vin: await Promise.all(
                tx.vin.map(this.parseTransactionInput, this),
            ),
            vout: tx.vout.map(this.parseTransactionOutput, this),
            blockHeight: header.height,
            blockHash: tx.blockhash,
            blockTime: header.time,
        };
    }

    public async processBlock(
        height: number,
        verbosityLevel: number,
    ): Promise<{
        transactions: Transaction[];
        blockHash: string;
        blockTime: number;
    }> {
        const parsedTransactionList: Transaction[] = [];
        const blockHash = await this.getBlockHash(height);
        this.logger.debug(
            `Processing block at height ${height}, hash ${blockHash}`,
        );

        const block = await this.getBlock(blockHash, verbosityLevel);

        for (let i = 1; i < block.tx.length; i++) {
            const parsedTransaction = await this.parseTransaction(
                block.tx[i],
                block.hash,
                block.height,
            );
            parsedTransactionList.push(parsedTransaction);
        }

        return {
            transactions: parsedTransactionList,
            blockHash: blockHash,
            blockTime: block.time,
        };
    }

    private async parseTransaction(
        txn: BlockTransaction,
        blockHash: string,
        blockHeight: number,
    ): Promise<Transaction> {
        const inputs: TransactionInput[] = await Promise.all(
            txn.vin.map(this.parseTransactionInput, this),
        );
        const outputs: TransactionOutput[] = txn.vout.map(
            this.parseTransactionOutput,
            this,
        );

        return {
            txid: txn.txid,
            vin: inputs,
            vout: outputs,
            blockHeight,
            blockHash,
        };
    }

    private async parseTransactionInput(
        txnInput: Input,
    ): Promise<TransactionInput> {
        let prevOutScript: string;
        const vout = txnInput.vout;

        if (txnInput.prevout != undefined) {
            prevOutScript = txnInput.prevout.scriptPubKey.hex;
        } else {
            const prevTransaction = await this.getRawTransaction(
                txnInput.txid,
                true,
            );

            prevOutScript = prevTransaction.vout.find((out) => out.n == vout)
                .scriptPubKey.hex;
        }

        return {
            txid: txnInput.txid,
            vout,
            scriptSig: txnInput.scriptSig.hex,
            witness: txnInput.txinwitness,
            prevOutScript,
        };
    }

    private parseTransactionOutput(txnOutput: Output): TransactionOutput {
        return {
            scriptPubKey: txnOutput.scriptPubKey.hex,
            value: btcToSats(txnOutput.value),
        };
    }

    private async request(body: RPCRequestBody): Promise<any> {
        const { rpcUser, rpcPass } =
            this.configService.get<BitcoinCoreConfig>('bitcoinCore');

        const requestConfig: AxiosRequestConfig = {
            url: this.rpcUrl,
            method: 'POST',
            auth: {
                username: rpcUser,
                password: rpcPass,
            },
            data: {
                ...body,
                jsonrpc: '1.0',
                id: 'silent_payment_indexer',
            },
        };

        const response = await makeRequest(
            requestConfig,
            this.retryConfig,
            this.logger,
        );

        return response.result;
    }

    private versionToVerbosity(version: number): 2 | 3 {
        return version >= BITCOIN_CORE_FULL_VERBOSITY_VERSION ? 3 : 2;
    }
}
