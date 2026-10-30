import { ConfigService } from '@nestjs/config';
import { BitcoinCoreProvider } from '@/block-data-providers/bitcoin-core/provider';
import {
    bitcoinCoreConfig,
    parsedTransactions,
} from '@/block-data-providers/bitcoin-core/provider-fixtures';
import { IndexerService } from '@/indexer/indexer.service';
import { OperationStateService } from '@/operation-state/operation-state.service';
import {
    blockCountToHash,
    blocks,
    rawTransactions,
} from '@/block-data-providers/bitcoin-core/provider-fixtures';
import {
    BIP352_ACTIVATION_HEIGHT,
    BITCOIN_CORE_FULL_VERBOSITY_VERSION,
    BITCOIN_CORE_PREVOUT_RAWTX_VERSION,
} from '@/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { BlockStateService } from '@/block-state/block-state.service';
import { DbTransactionService } from '@/db-transaction/db-transaction.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StorageService } from '@/storage/storage.service';
import { PartitionManager } from '@/storage/partition-manager';
import { BitcoinNetwork } from '@/common/enum';

describe('Bitcoin Core Provider', () => {
    let provider: BitcoinCoreProvider;
    let indexerService: IndexerService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BitcoinCoreProvider,
                {
                    provide: IndexerService,
                    useValue: {
                        index: jest.fn(),
                        buildTransactionData: jest.fn(),
                    },
                },
                {
                    provide: ConfigService,
                    useValue: {
                        get: (key: string) => {
                            if (key == 'bitcoinCore') {
                                return bitcoinCoreConfig;
                            }
                            if (key == 'app.network') {
                                return 'regtest';
                            }
                            return null;
                        },
                    },
                },
                {
                    provide: OperationStateService,
                    useValue: {
                        getOperationState: jest.fn(),
                    },
                },
                {
                    provide: BlockStateService,
                    useClass: jest.fn(),
                },
                {
                    provide: DbTransactionService,
                    useValue: {
                        execute: jest.fn(),
                    },
                },
                {
                    provide: EventEmitter2,
                    useValue: jest.fn(),
                },
                {
                    provide: PartitionManager,
                    useValue: {
                        clampBatchEnd: jest.fn(),
                        partitionIndex: jest.fn(),
                    },
                },
                {
                    provide: StorageService,
                    useValue: {
                        createBatch: jest.fn(),
                        saveTransaction: jest.fn(),
                        saveBlockState: jest.fn(),
                        saveOperationState: jest.fn(),
                    },
                },
            ],
        }).compile();

        provider = module.get<BitcoinCoreProvider>(BitcoinCoreProvider);
        indexerService = module.get<IndexerService>(IndexerService);

        jest.spyOn(provider as any, 'getTipHeight').mockResolvedValue(3);

        jest.spyOn(provider as any, 'getBlockHash').mockImplementation(
            (height: number) => {
                return Promise.resolve(blockCountToHash.get(height));
            },
        );
        jest.spyOn(provider as any, 'getBlock').mockImplementation(
            (hash: string) => {
                return Promise.resolve(blocks.get(hash));
            },
        );
        jest.spyOn(provider as any, 'getRawTransaction').mockImplementation(
            (hash: string) => {
                return Promise.resolve(rawTransactions.get(hash));
            },
        );
    });

    it('should process each transaction of a block appropriately', async () => {
        const { transactions } = await provider.processBlock(3, 2);
        expect(transactions).toHaveLength(1);
        expect(transactions).toEqual(
            expect.arrayContaining([...parsedTransactions.values()]),
        );
    });

    describe('sync', () => {
        let processBlock: jest.SpyInstance;
        let traceReorg: jest.SpyInstance;

        beforeEach(() => {
            jest.spyOn(provider, 'getState').mockResolvedValue({
                indexedBlockHeight: 3,
            });
            jest.spyOn(provider, 'setState').mockResolvedValue(undefined);
            jest.spyOn(provider as any, 'getNodeVersion').mockResolvedValue(
                BITCOIN_CORE_FULL_VERBOSITY_VERSION,
            );
            processBlock = jest
                .spyOn(provider, 'processBlock')
                .mockResolvedValue({
                    transactions: [],
                    blockHash: blockCountToHash.get(3),
                    blockTime: 0,
                });
            traceReorg = jest.spyOn(provider, 'traceReorg');

            (
                provider['dbTransactionService'].execute as jest.Mock
            ).mockImplementation((fn) => fn({}));
            (
                provider['partitionManager'].clampBatchEnd as jest.Mock
            ).mockImplementation((_height, _blocks, tipHeight) => tipHeight);
            (provider as any).eventEmitter = { emit: jest.fn() };
        });

        it('does nothing when the indexed tip is still on the chain', async () => {
            traceReorg.mockResolvedValue(3);

            await provider.sync();

            expect(processBlock).not.toHaveBeenCalled();
        });

        it('re-indexes the tip after a reorg that keeps the same height', async () => {
            // Block 3 was replaced, so the trace falls back to height 2 while
            // the node's tip height is still 3.
            traceReorg.mockResolvedValue(2);

            await provider.sync();

            expect(traceReorg).toHaveBeenCalled();
            expect(processBlock).toHaveBeenCalledTimes(1);
            expect(processBlock).toHaveBeenCalledWith(3, 3);
        });
    });

    describe('getTransactionForTweak', () => {
        const blockHash = blockCountToHash.get(3);
        const block = blocks.get(blockHash) as any;
        const coinbase = { ...block.tx[0], blockhash: blockHash };
        const confirmed = { ...block.tx[1], blockhash: blockHash };
        const expected = parsedTransactions.get(confirmed.txid);

        let getRawTransaction: jest.SpyInstance;
        let getBlockHeader: jest.SpyInstance;

        beforeEach(() => {
            jest.spyOn(provider as any, 'getNetworkInfo').mockResolvedValue({
                version: 28_0000,
            });
            getBlockHeader = jest
                .spyOn(provider as any, 'getBlockHeader')
                .mockResolvedValue({ height: 7110, time: 1714634200 });
            getRawTransaction = jest.spyOn(
                provider as any,
                'getRawTransaction',
            );
        });

        it('derives from the parsed transaction and the block header', async () => {
            getRawTransaction.mockResolvedValueOnce(confirmed);

            await provider.getTransactionForTweak(confirmed.txid);

            // Height and time come from the header, not from the transaction:
            // getrawtransaction reports neither, and `confirmations` races the
            // tip.
            expect(getBlockHeader).toHaveBeenCalledWith(blockHash);
            expect(indexerService.buildTransactionData).toHaveBeenCalledWith(
                confirmed.txid,
                expected.vin,
                expected.vout,
                7110,
                blockHash,
                1714634200,
            );
        });

        it('asks for verbosity 2 on a node that supports it', async () => {
            getRawTransaction.mockResolvedValueOnce(confirmed);

            await provider.getTransactionForTweak(confirmed.txid);

            expect(getRawTransaction).toHaveBeenNthCalledWith(
                1,
                confirmed.txid,
                2,
            );
        });

        it('falls back to the verbose form below Core 25', async () => {
            jest.spyOn(provider as any, 'getNetworkInfo').mockResolvedValue({
                version: BITCOIN_CORE_PREVOUT_RAWTX_VERSION - 1_0000,
            });
            getRawTransaction.mockResolvedValueOnce(confirmed);

            await provider.getTransactionForTweak(confirmed.txid);

            expect(getRawTransaction).toHaveBeenNthCalledWith(
                1,
                confirmed.txid,
                true,
            );
        });

        it('returns null for a txid the node has never seen', async () => {
            // Core answers an unknown txid with HTTP 500 carrying
            // RPC_INVALID_ADDRESS_OR_KEY. Rethrown, the route 500s where it
            // means to 404.
            getRawTransaction.mockRejectedValueOnce({
                response: {
                    data: {
                        error: {
                            code: -5,
                            message:
                                'No such mempool or blockchain transaction.',
                        },
                    },
                },
            });

            expect(
                await provider.getTransactionForTweak(confirmed.txid),
            ).toBeNull();
        });

        it('propagates an RPC failure that is not an unknown txid', async () => {
            getRawTransaction.mockRejectedValueOnce({
                response: {
                    data: {
                        error: { code: -28, message: 'Loading block index' },
                    },
                },
            });

            await expect(
                provider.getTransactionForTweak(confirmed.txid),
            ).rejects.toMatchObject({
                response: { data: { error: { code: -28 } } },
            });
        });

        it('returns null for an unconfirmed transaction', async () => {
            const { blockhash, ...mempoolTx } = confirmed;
            expect(blockhash).toBeDefined();
            getRawTransaction.mockResolvedValueOnce(mempoolTx);

            expect(
                await provider.getTransactionForTweak(confirmed.txid),
            ).toBeNull();
            expect(getBlockHeader).not.toHaveBeenCalled();
            expect(indexerService.buildTransactionData).not.toHaveBeenCalled();
        });

        it('returns null below the activation height on mainnet', async () => {
            jest.spyOn(provider['configService'], 'get').mockImplementation(
                (key: string) =>
                    key === 'app.network' ? BitcoinNetwork.MAINNET : null,
            );
            getRawTransaction.mockResolvedValueOnce(confirmed);
            getBlockHeader.mockResolvedValue({
                height: BIP352_ACTIVATION_HEIGHT - 1,
                time: 1714634200,
            });

            expect(
                await provider.getTransactionForTweak(confirmed.txid),
            ).toBeNull();
            expect(indexerService.buildTransactionData).not.toHaveBeenCalled();
        });

        it('returns null for a coinbase', async () => {
            getRawTransaction.mockResolvedValueOnce(coinbase);

            expect(
                await provider.getTransactionForTweak(coinbase.txid),
            ).toBeNull();
            expect(indexerService.buildTransactionData).not.toHaveBeenCalled();
        });
    });
});
