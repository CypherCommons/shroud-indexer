import { ConfigService } from '@nestjs/config';
import { BitcoinCoreConfig } from '@/configuration.model';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { BitcoinNetwork } from '@/common/enum';
import {
    BITCOIN_CORE_FULL_VERBOSITY_VERSION,
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
import { BaseBlockDataProvider } from '@/block-data-providers/base-block-data-provider.abstract';
import {
    Block,
    BitcoinCoreOperationState,
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
import { btcToSats, isP2TR } from '@/common/common';
import { StorageService } from '@/storage/storage.service';
import { BlockTimer } from '@/common/telemetry';

@Injectable()
export class BitcoinCoreProvider
    extends BaseBlockDataProvider<BitcoinCoreOperationState>
    implements OnApplicationBootstrap
{
    protected readonly logger = new Logger(BitcoinCoreProvider.name);
    protected readonly operationStateKey = 'bitcoincore-operation-state';
    private readonly rpcUrl: string;
    private isSyncing = false;
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
        if (currentState) {
            this.logger.log(
                `Restoring state from previous run: ${JSON.stringify(
                    currentState,
                )}`,
            );
        } else {
            this.logger.log('No previous state found. Starting from scratch.');

            const blockHeight =
                this.configService.get<BitcoinNetwork>('app.network') ===
                BitcoinNetwork.MAINNET
                    ? BIP352_ACTIVATION_HEIGHT - 1
                    : 0;
            const blockHash = await this.getBlockHash(blockHeight);

            await this.dbTransactionService.execute(async (batch) => {
                await this.setState(
                    {
                        indexedBlockHeight: blockHeight,
                    },
                    {
                        blockHash,
                        blockHeight,
                    },
                    batch,
                );
            });
        }
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

            const networkInfo = await this.getNetworkInfo();
            const verbosityLevel = this.versionToVerbosity(networkInfo.version);

            let height =
                ((await this.traceReorg()) ?? state.indexedBlockHeight) + 1;

            while (height <= tipHeight) {
                // One write transaction per run of blocks. Committing each
                // block separately re-walks and rewrites the same B+tree
                // interior pages every time; batching amortises them.
                const batchEnd = Math.min(
                    height + this.commitBatchBlocks - 1,
                    tipHeight,
                );
                const timer = new BlockTimer();
                const indexedHeights: number[] = [];

                await this.dbTransactionService.execute(
                    async (batch) => {
                        // Spans the whole batch, not one block: an output
                        // created in one block and spent in a later block of
                        // the same batch is not committed yet, so the spend can
                        // only be resolved from here.
                        const pendingOutputs = new Map<
                            string,
                            { pubKey: string; value: number }
                        >();

                        for (let h = height; h <= batchEnd; h++) {
                            const { transactions, blockHash, blockTime } =
                                await timer.measureAsync('processBlock', () =>
                                    this.processBlock(h, verbosityLevel),
                                );

                            const spentOutpoints: [string, number][] = [];

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
                                const saved = await timer.measureAsync(
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

                                for (const [k, v] of saved) {
                                    pendingOutputs.set(k, v);
                                }

                                for (const input of vin) {
                                    // Only a P2TR prevout can have an `out:`
                                    // record, so anything else is a guaranteed
                                    // miss. Skipping it avoids a full B+tree
                                    // descent per input.
                                    if (!isP2TR(input.prevOutScript)) {
                                        timer.count('skipped');
                                        continue;
                                    }
                                    spentOutpoints.push([
                                        input.txid,
                                        input.vout,
                                    ]);
                                }
                            }

                            const spendStats = await timer.measureAsync(
                                'markSpent',
                                () =>
                                    this.storageService.markOutputsSpent(
                                        batch,
                                        spentOutpoints,
                                        pendingOutputs,
                                    ),
                            );
                            timer.count('probes', spendStats.probes);
                            timer.count('hits', spendStats.hits);

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
                        `tx=${counts.numTx ?? 0} ` +
                        `in=${counts.numInputs ?? 0} out=${
                            counts.numOutputs ?? 0
                        } | ` +
                        `processBlock=${phasesMs.processBlock ?? 0}ms ` +
                        `index=${phasesMs.index ?? 0}ms ` +
                        `markSpent=${phasesMs.markSpent ?? 0}ms ` +
                        `(probes=${counts.probes ?? 0} hits=${
                            counts.hits ?? 0
                        } skipped=${counts.skipped ?? 0}) ` +
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
        isVerbose: boolean,
    ): Promise<BlockTransaction> {
        return this.request({
            method: 'getrawtransaction',
            params: [txid, isVerbose],
        });
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
