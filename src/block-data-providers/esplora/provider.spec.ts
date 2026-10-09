import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EsploraProvider } from '@/block-data-providers/esplora/provider';
import { IndexerService } from '@/indexer/indexer.service';
import { OperationStateService } from '@/operation-state/operation-state.service';
import { BlockStateService } from '@/block-state/block-state.service';
import { DbTransactionService } from '@/db-transaction/db-transaction.service';
import { StorageService } from '@/storage/storage.service';

// Coinbase first, as Esplora returns them. With a batch size of 2 the first
// two blocks span several fetch batches; the third has only its coinbase.
const blockTxids = new Map<string, string[]>([
    ['hash1', ['cb1', 'a', 'b', 'c', 'd', 'e']],
    ['hash2', ['cb2', 'f', 'g', 'h', 'i']],
    ['hash3', ['cb3']],
]);

const expectedWrites = [
    { txids: ['a', 'b', 'c', 'd', 'e'], spentChunks: [0], savedHeight: 1 },
    { txids: ['f', 'g', 'h', 'i'], spentChunks: [0], savedHeight: 2 },
    { txids: [], spentChunks: [0], savedHeight: 3 },
];

describe('Esplora Provider', () => {
    let provider: EsploraProvider;
    let state: Record<string, number>;
    // One entry per write transaction: what it indexed, the spent index
    // chunks it wrote and the height it saved.
    type Write = {
        txids: string[];
        spentChunks: number[];
        savedHeight?: number;
    };
    let writes: Write[];
    let current: Write;
    let getTx: jest.SpyInstance;

    beforeEach(async () => {
        // State saved by older versions still carries lastProcessedTxIndex;
        // it must be ignored.
        state = { indexedBlockHeight: 0, lastProcessedTxIndex: 0 };
        writes = [];

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EsploraProvider,
                {
                    provide: IndexerService,
                    useValue: {
                        index: jest.fn((txid: string) => {
                            current.txids.push(txid);
                        }),
                    },
                },
                {
                    provide: ConfigService,
                    useValue: {
                        get: (key: string) =>
                            ({
                                'esplora.batchSize': 2,
                                'esplora.url': 'http://esplora',
                                'app.network': 'regtest',
                            }[key] ?? null),
                    },
                },
                {
                    provide: OperationStateService,
                    useValue: {
                        getOperationState: jest.fn(async () => ({
                            state: { ...state },
                        })),
                    },
                },
                { provide: BlockStateService, useClass: jest.fn() },
                {
                    provide: DbTransactionService,
                    useValue: {
                        execute: jest.fn(async (fn) => {
                            current = { txids: [], spentChunks: [] };
                            await fn({});
                            writes.push(current);
                        }),
                    },
                },
                { provide: EventEmitter2, useValue: { emit: jest.fn() } },
                {
                    provide: StorageService,
                    useValue: {
                        saveOperationState: jest.fn((_batch, _key, s) => {
                            state = { ...s };
                            current.savedHeight = s.indexedBlockHeight;
                        }),
                        saveBlockState: jest.fn(),
                        saveSpentIndex: jest.fn((_batch, _height, chunk) => {
                            current.spentChunks.push(chunk);
                        }),
                    },
                },
            ],
        }).compile();

        provider = module.get<EsploraProvider>(EsploraProvider);

        jest.spyOn(provider as any, 'getTipHeight').mockResolvedValue(3);
        jest.spyOn(provider, 'traceReorg').mockResolvedValue(null);
        jest.spyOn(provider, 'getBlockHash').mockImplementation(
            async (height: number) => `hash${height}`,
        );
        jest.spyOn(provider as any, 'getTxidsForBlock').mockImplementation(
            async (hash: string) => blockTxids.get(hash),
        );
        jest.spyOn(provider as any, 'getBlockTime').mockResolvedValue(0);
        getTx = jest
            .spyOn(provider as any, 'getTx')
            .mockImplementation(async (txid: string) => ({
                txid,
                vin: [],
                vout: [],
                status: { block_time: 0 },
            }));
    });

    it('indexes every non-coinbase tx of each block in one write per block', async () => {
        await provider.sync();

        expect(writes).toEqual(expectedWrites);
    });

    it('leaves a block unindexed when a fetch fails, then indexes it whole', async () => {
        getTx.mockRejectedValueOnce(new Error('timeout'));

        await expect(provider.sync()).rejects.toThrow('timeout');
        expect(writes).toEqual([]);
        expect(state.indexedBlockHeight).toBe(0);

        await provider.sync();

        expect(writes).toEqual(expectedWrites);
    });
});
