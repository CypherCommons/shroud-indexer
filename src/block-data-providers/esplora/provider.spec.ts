import { ConfigService } from '@nestjs/config';
import { EsploraProvider } from '@/block-data-providers/esplora/provider';

/**
 * A coinbase-only block runs zero batches in processBlock (the loop starts at
 * lastProcessedTxIndex + 1 === txids.length), so the height used to be saved as
 * a silent block and broadcast without ever being marked done — a restart then
 * reprocessed and re-emitted it.
 */
describe('Esplora Provider coinbase-only block', () => {
    it('commits block state for a block with only a coinbase tx', async () => {
        const config = {
            'esplora.batchSize': 10,
            'esplora.url': 'http://localhost:3000',
            'app.network': 'regtest',
            'app.requestRetry': {},
        };

        const saveOperationState = jest.fn();
        const saveBlockState = jest.fn();
        const saveSilentBlock = jest.fn();
        const storageService = {
            saveOperationState,
            saveBlockState,
            saveSilentBlock,
            getTransactionsByBlockHeight: jest.fn().mockResolvedValue([]),
        };
        const emit = jest.fn();

        const provider = new EsploraProvider(
            { get: (k: string) => config[k] } as unknown as ConfigService,
            {} as any,
            {} as any,
            {} as any,
            {
                execute: jest.fn((fn) => fn({} as any)),
            } as any,
            { emit } as any,
            storageService as any,
        );

        jest.spyOn(provider, 'getState').mockResolvedValue({
            currentBlockHeight: 0,
            indexedBlockHeight: 99,
            lastProcessedTxIndex: 0,
        });
        // Only the coinbase tx.
        (provider as any).getTxidsForBlock = jest
            .fn()
            .mockResolvedValue(['cb'.repeat(32)]);

        await (provider as any).processBlock(100, 'hash-100');

        expect(saveSilentBlock).toHaveBeenCalled();
        expect(saveBlockState).toHaveBeenCalledWith(expect.anything(), {
            blockHeight: 100,
            blockHash: 'hash-100',
        });
        expect(saveOperationState).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(String),
            expect.objectContaining({
                indexedBlockHeight: 100,
                lastProcessedTxIndex: 0,
            }),
        );
        expect(emit).toHaveBeenCalledWith(expect.any(String), 100);
    });

    it('does not mark a height done until its last batch commits', async () => {
        const config = {
            'esplora.batchSize': 1,
            'esplora.url': 'http://localhost:3000',
            'app.network': 'regtest',
            'app.requestRetry': {},
        };
        // state is mutated in place, so record the height at call time
        const heights: number[] = [];
        const saveOperationState = jest.fn((_b, _k, s) =>
            heights.push(s.indexedBlockHeight),
        );
        const saveBlockState = jest.fn();
        const storageService = {
            saveOperationState,
            saveBlockState,
            saveSilentBlock: jest.fn(),
            getTransactionsByBlockHeight: jest.fn().mockResolvedValue([]),
        };
        const provider = new EsploraProvider(
            { get: (k: string) => config[k] } as unknown as ConfigService,
            {} as any,
            {} as any,
            {} as any,
            { execute: jest.fn((fn) => fn({} as any)) } as any,
            { emit: jest.fn() } as any,
            storageService as any,
        );
        jest.spyOn(provider, 'getState').mockResolvedValue({
            currentBlockHeight: 0,
            indexedBlockHeight: 99,
            lastProcessedTxIndex: 0,
        });
        jest.spyOn(provider, 'indexTransaction').mockResolvedValue(null);
        (provider as any).getTxidsForBlock = jest
            .fn()
            .mockResolvedValue(['00', '01', '02']);
        (provider as any).getTx = jest
            .fn()
            .mockResolvedValue({ vin: [], vout: [], status: {} });

        await (provider as any).processBlock(100, 'hash-100');

        // Two per-batch cursor writes, then one final commit.
        expect(heights).toEqual([99, 99, 100]);
        expect(saveBlockState).toHaveBeenCalledTimes(1);
    });

    it('rewinds a mid-block cursor before purging above the tip on boot', async () => {
        const config = {
            'esplora.batchSize': 10,
            'esplora.url': 'http://localhost:3000',
            'app.network': 'regtest',
            'app.requestRetry': {},
        };
        const calls: string[] = [];
        const storageService = {
            saveOperationState: jest.fn((_b, _k, s) =>
                calls.push(`cursor=${s.lastProcessedTxIndex}`),
            ),
            createBatch: jest.fn(() => ({
                commit: jest.fn(),
                dispose: jest.fn(),
            })),
            purgeAboveHeight: jest.fn(() => calls.push('purge')),
        };
        const provider = new EsploraProvider(
            { get: (k: string) => config[k] } as unknown as ConfigService,
            {} as any,
            {} as any,
            {} as any,
            { execute: jest.fn((fn) => fn({} as any)) } as any,
            { emit: jest.fn() } as any,
            storageService as any,
        );
        jest.spyOn(provider, 'getState').mockResolvedValue({
            currentBlockHeight: 0,
            indexedBlockHeight: 99,
            lastProcessedTxIndex: 20,
        });

        await provider.onApplicationBootstrap();

        // The purge deletes height 100's committed batches, so the cursor
        // into height 100 has to be gone before that.
        expect(calls).toEqual(['cursor=0', 'purge']);
    });
});
