import {
    Injectable,
    Logger,
    NotImplementedException,
    OnApplicationBootstrap,
} from '@nestjs/common';
import {
    BaseBlockDataProvider,
    ProviderTransaction,
} from '@/block-data-providers/base-block-data-provider.abstract';
import { AxiosRetryConfig, makeRequest } from '@/common/request';
import { ConfigService } from '@nestjs/config';
import { IndexerService, TransactionInput } from '@/indexer/indexer.service';
import { OperationStateService } from '@/operation-state/operation-state.service';
import { BitcoinNetwork } from '@/common/enum';
import { URL } from 'url';
import {
    EsploraOperationState,
    EsploraTransaction,
} from '@/block-data-providers/esplora/interface';
import { BIP352_ACTIVATION_HEIGHT } from '@/common/constants';
import { BlockStateService } from '@/block-state/block-state.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DbTransactionService } from '@/db-transaction/db-transaction.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { INDEXED_BLOCK_EVENT } from '@/common/events';
import { StorageService } from '@/storage/storage.service';
import { encodeSilentBlock } from '@/silent-blocks/silent-block-encoder';
import { TransactionData } from '@/storage/interfaces';

@Injectable()
export class EsploraProvider
    extends BaseBlockDataProvider<EsploraOperationState>
    implements OnApplicationBootstrap
{
    protected readonly logger = new Logger(EsploraProvider.name);
    protected readonly operationStateKey = 'esplora-operation-state';
    private readonly baseUrl: string;
    private retryConfig: AxiosRetryConfig;
    private isSyncing = false;
    private readonly batchSize: number;

    constructor(
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

        this.batchSize = this.configService.get<number>('esplora.batchSize');

        let pathPrefix;
        switch (this.configService.get<BitcoinNetwork>('app.network')) {
            case BitcoinNetwork.TESTNET:
                pathPrefix = '/testnet/api';
                break;
            case BitcoinNetwork.REGTEST:
                pathPrefix = '/regtest/api';
                break;
            case BitcoinNetwork.MAINNET:
            default:
                pathPrefix = '/api';
        }
        this.baseUrl = new URL(
            `${this.configService.get<string>('esplora.url')}${pathPrefix}`,
        ).toString();

        this.retryConfig =
            this.configService.get<AxiosRetryConfig>('app.requestRetry');
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

            // A crash mid-block leaves that block's first batches committed
            // above the tip, and the purge below deletes them. Rewind the
            // cursor first so the block is redone from its start, otherwise
            // it would resume past transactions that are no longer stored.
            if (currentState.lastProcessedTxIndex !== 0) {
                currentState.lastProcessedTxIndex = 0;
                await this.dbTransactionService.execute(async (batch) => {
                    this.storageService.saveOperationState(
                        batch,
                        this.operationStateKey,
                        currentState,
                    );
                });
            }
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
                    {
                        currentBlockHeight: 0,
                        indexedBlockHeight,
                        lastProcessedTxIndex: 0, // we don't take coinbase txn into account
                    },
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
                this.logger.log(
                    `No new blocks found. Current tip height: ${tipHeight}`,
                );
                return;
            }

            let height =
                ((await this.traceReorg()) ?? state.indexedBlockHeight) + 1;

            let nextBlockHash: Promise<string> | null = this.prefetch(
                this.getBlockHash(height),
            );

            for (height; height <= tipHeight; height++) {
                const blockHash = await nextBlockHash;
                this.logger.log(
                    `Processing block at height ${height}, hash ${blockHash}`,
                );

                nextBlockHash =
                    height + 1 <= tipHeight
                        ? this.prefetch(this.getBlockHash(height + 1))
                        : null;

                await this.processBlock(height, blockHash);
            }
        } finally {
            this.isSyncing = false;
        }
    }

    private async processBlock(height: number, hash: string) {
        const state = await this.getState();
        const txids = await this.getTxidsForBlock(hash);

        try {
            for (
                let i = state.lastProcessedTxIndex + 1;
                i < txids.length;
                i += this.batchSize
            ) {
                const txBatch = txids.slice(
                    i,
                    Math.min(i + this.batchSize, txids.length),
                );

                await this.dbTransactionService.execute(async (batch) => {
                    await Promise.all(
                        txBatch.map(async (txid) => {
                            const tx = await this.getTx(txid);
                            const vin: TransactionInput[] = tx.vin.map(
                                (input) => ({
                                    txid: input.txid,
                                    vout: input.vout,
                                    scriptSig: input.scriptsig,
                                    prevOutScript: input.prevout.scriptpubkey,
                                    witness: input.witness,
                                }),
                            );

                            const vout = tx.vout.map((output) => ({
                                scriptPubKey: output.scriptpubkey,
                                value: output.value,
                            }));

                            await this.indexTransaction(
                                txid,
                                vin,
                                vout,
                                height,
                                hash,
                                tx.status.block_time,
                                batch,
                            );
                        }, this),
                    );

                    // Only the tx cursor moves here. indexedBlockHeight and the
                    // block state wait for the final commit below, so a crash
                    // mid-block resumes this height at the cursor instead of
                    // skipping to height + 1, and the tip never advertises a
                    // half-indexed block.
                    state.lastProcessedTxIndex = i + this.batchSize - 1;
                    this.storageService.saveOperationState(
                        batch,
                        this.operationStateKey,
                        state,
                    );
                });
            }

            // Read back from storage, not accumulated in-run: a run that
            // resumed mid-block would only see part of the block.
            const blockTxData: TransactionData[] =
                await this.storageService.getTransactionsByBlockHeight(height);
            await this.dbTransactionService.execute(async (batch) => {
                this.storageService.saveSilentBlock(
                    batch,
                    height,
                    encodeSilentBlock(blockTxData),
                );

                // The only place the height is marked done, so it also covers
                // a coinbase-only block (zero batches). Same batch as the blob,
                // so the two can't diverge.
                state.indexedBlockHeight = height;
                state.lastProcessedTxIndex = 0;
                await this.setState(
                    state,
                    {
                        blockHeight: height,
                        blockHash: hash,
                    },
                    batch,
                );
            });
        } catch (error) {
            this.logger.error(
                `Error processing block at height ${height}, hash ${hash}: ${error.message}`,
            );
            throw error;
        }

        // Emitted once per block, after the blob is stored: a per-batch emit
        // broadcast the same height repeatedly, each time re-encoding whatever
        // subset of the block had been committed so far.
        this.eventEmitter.emit(INDEXED_BLOCK_EVENT, height);
    }

    private async getTipHeight(): Promise<number> {
        return makeRequest(
            {
                method: 'GET',
                url: `${this.baseUrl}/blocks/tip/height`,
            },
            this.retryConfig,
            this.logger,
        );
    }

    private async getTipHash(): Promise<string> {
        return makeRequest(
            {
                method: 'GET',
                url: `${this.baseUrl}/blocks/tip/hash`,
            },
            this.retryConfig,
            this.logger,
        );
    }

    async getBlockHash(height: number): Promise<string> {
        return makeRequest(
            {
                method: 'GET',
                url: `${this.baseUrl}/block-height/${height}`,
            },
            this.retryConfig,
            this.logger,
        );
    }

    private async getTxidsForBlock(hash: string): Promise<string[]> {
        return makeRequest(
            {
                method: 'GET',
                url: `${this.baseUrl}/block/${hash}/txids`,
            },
            this.retryConfig,
            this.logger,
        );
    }

    /**
     * Esplora returns prevouts and the block height from a single GET /tx, so
     * this is implementable here — it is simply not implemented, to avoid a
     * second derivation path that no CI job exercises. Every other route works
     * against Esplora unchanged.
     */
    protected async fetchTransactionForTweak(): Promise<ProviderTransaction | null> {
        throw new NotImplementedException(
            'Lookup by txid requires the Bitcoin Core provider',
        );
    }

    private async getTx(txid: string): Promise<EsploraTransaction> {
        return makeRequest(
            {
                method: 'GET',
                url: `${this.baseUrl}/tx/${txid}`,
            },
            this.retryConfig,
            this.logger,
        );
    }
}
