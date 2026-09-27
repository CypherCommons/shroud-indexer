import { Test, TestingModule } from '@nestjs/testing';
import { CacheModule } from '@nestjs/cache-manager';
import { TransactionsService } from '@/transactions/transactions.service';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';
import { silentBlockEncodingFixture } from '@/silent-blocks/silent-blocks.service.fixtures';
import { encodeSilentBlock } from '@/silent-blocks/silent-block-encoder';
import { SilentBlocksGateway } from '@/silent-blocks/silent-blocks.gateway';
import { BlockStateService } from '@/block-state/block-state.service';
import { StorageService } from '@/storage/storage.service';
import { PartitionManager } from '@/storage/partition-manager';
import { DbTransactionService } from '@/db-transaction/db-transaction.service';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SilentBlocksService', () => {
    let service: SilentBlocksService;
    let storageService: StorageService;
    let partitions: PartitionManager;
    let blockStateService: { getCurrentBlockState: jest.Mock };
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-blocks-test-'));

        const module: TestingModule = await Test.createTestingModule({
            imports: [CacheModule.register()],
            providers: [
                SilentBlocksService,
                TransactionsService,
                StorageService,
                PartitionManager,
                DbTransactionService,
                {
                    provide: ConfigService,
                    useValue: {
                        get: (key: string) => {
                            if (key === 'db.path') return tmpDir;
                            // Small partitions so tests cross boundaries.
                            if (key === 'db.partitionBlocks') return 5;
                            if (key === 'db.partitionMapSize')
                                return 16 * 1024 * 1024;
                            if (key === 'db.mapSize') return 16 * 1024 * 1024;
                            if (key === 'db.openPartitions') return 2;
                            return null;
                        },
                    },
                },
                {
                    provide: 'BlockDataProvider',
                    useValue: { getTransactionForTweak: jest.fn() },
                },
                {
                    provide: SilentBlocksGateway,
                    useValue: jest.fn(),
                },
                {
                    provide: BlockStateService,
                    useValue: {
                        getCurrentBlockState: jest.fn(),
                    },
                },
            ],
        }).compile();

        partitions = module.get<PartitionManager>(PartitionManager);
        partitions.onModuleInit();
        storageService = module.get<StorageService>(StorageService);
        blockStateService = module.get(BlockStateService);
        service = module.get<SilentBlocksService>(SilentBlocksService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    it.each(silentBlockEncodingFixture)(
        'should encode a silent block correctly by block height: $blockHeight',
        async ({ transactions, blockHeight, encodedBlockHex }) => {
            // Seed data via StorageService
            const batch = storageService.createBatch();
            for (const tx of transactions) {
                storageService.saveTransaction(batch, {
                    ...tx,
                    outputs: tx.outputs.map((o) => ({
                        ...o,
                        transactionId: tx.id,
                    })),
                });
            }
            // A block hash resolves to a height through the global index,
            // which block state owns.
            storageService.saveBlockState(batch, {
                blockHeight: transactions[0].blockHeight,
                blockHash: transactions[0].blockHash,
            });
            await batch.commit();

            const encodedBlock = await service.getSilentBlockByHeight(
                blockHeight,
            );

            expect(encodedBlock.toString('hex')).toEqual(encodedBlockHex);
        },
    );

    it.each(silentBlockEncodingFixture)(
        'should encode a silent block correctly by block hash: $blockHash',
        async ({ transactions, blockHash, encodedBlockHex }) => {
            const batch = storageService.createBatch();
            for (const tx of transactions) {
                storageService.saveTransaction(batch, {
                    ...tx,
                    outputs: tx.outputs.map((o) => ({
                        ...o,
                        transactionId: tx.id,
                    })),
                });
            }
            // A block hash resolves to a height through the global index,
            // which block state owns.
            storageService.saveBlockState(batch, {
                blockHeight: transactions[0].blockHeight,
                blockHash: transactions[0].blockHash,
            });
            await batch.commit();

            const encodedBlock = await service.getSilentBlockByHash(blockHash);

            expect(encodedBlock.toString('hex')).toEqual(encodedBlockHex);
        },
    );

    it('should encode a silent block identically regardless of input order', () => {
        const txs = silentBlockEncodingFixture[0].transactions.map((tx) => ({
            ...tx,
            outputs: tx.outputs.map((o) => ({ ...o, transactionId: tx.id })),
        }));
        expect(txs.length).toBeGreaterThan(1);

        const forward = encodeSilentBlock(txs);
        const reversed = encodeSilentBlock([...txs].reverse());

        expect(reversed.toString('hex')).toEqual(forward.toString('hex'));
        expect(txs[0].id).toEqual(
            silentBlockEncodingFixture[0].transactions[0].id,
        );
    });

    it('should return correct framed data from streamSilentBlocksRange', async () => {
        const fixture = silentBlockEncodingFixture[0];

        const batch = storageService.createBatch();
        for (const tx of fixture.transactions) {
            storageService.saveTransaction(batch, {
                ...tx,
                outputs: tx.outputs.map((o) => ({
                    ...o,
                    transactionId: tx.id,
                })),
            });
        }
        storageService.saveSilentBlock(
            batch,
            fixture.blockHeight,
            Buffer.from(fixture.encodedBlockHex, 'hex'),
        );
        storageService.saveBlockState(batch, {
            blockHeight: fixture.blockHeight,
            blockHash: fixture.blockHash,
        });
        await batch.commit();

        blockStateService.getCurrentBlockState.mockResolvedValue({
            blockHeight: fixture.blockHeight,
            blockHash: fixture.blockHash,
        });

        const frames: Buffer[] = [];
        for await (const frame of service.streamSilentBlocksRange(
            fixture.blockHeight,
            fixture.blockHeight,
        )) {
            frames.push(frame);
        }

        expect(frames.length).toBe(1);
        const result = frames[0];
        const frameHeight = result.readUInt32BE(0);
        const frameLength = result.readUInt32BE(4);
        const frameBlob = result.subarray(8, 8 + frameLength);

        expect(frameHeight).toBe(fixture.blockHeight);
        expect(frameBlob.toString('hex')).toBe(fixture.encodedBlockHex);
    });

    it('should yield individual frames from streamSilentBlocksRange', async () => {
        const fixture = silentBlockEncodingFixture[0];
        const blob = Buffer.from(fixture.encodedBlockHex, 'hex');

        const batch = storageService.createBatch();
        storageService.saveSilentBlock(batch, fixture.blockHeight, blob);
        storageService.saveBlockState(batch, {
            blockHeight: fixture.blockHeight,
            blockHash: fixture.blockHash,
        });
        await batch.commit();

        blockStateService.getCurrentBlockState.mockResolvedValue({
            blockHeight: fixture.blockHeight,
            blockHash: fixture.blockHash,
        });

        const frames: Buffer[] = [];
        for await (const frame of service.streamSilentBlocksRange(
            fixture.blockHeight,
            fixture.blockHeight,
        )) {
            frames.push(frame);
        }

        // Each frame is: height (4B) + length (4B) + blob
        expect(frames.length).toBe(1);
        const frame = frames[0];
        expect(frame.readUInt32BE(0)).toBe(fixture.blockHeight);
        expect(frame.readUInt32BE(4)).toBe(blob.length);
        expect(frame.subarray(8)).toEqual(blob);
    });

    it('should skip empty heights in streamSilentBlocksRange', async () => {
        const fixture = silentBlockEncodingFixture[0];
        const nonEmptyHeight = fixture.blockHeight;
        const emptyHeightBefore = nonEmptyHeight - 1;
        const emptyHeightAfter = nonEmptyHeight + 1;

        const batch = storageService.createBatch();
        // Store a non-empty blob for one height.
        storageService.saveSilentBlock(
            batch,
            nonEmptyHeight,
            Buffer.from(fixture.encodedBlockHex, 'hex'),
        );
        // Store explicit empty blobs (type + varint(0) = 2 bytes) for neighbour heights.
        const emptyBlob = Buffer.from([0x00, 0x00]);
        storageService.saveSilentBlock(batch, emptyHeightBefore, emptyBlob);
        storageService.saveSilentBlock(batch, emptyHeightAfter, emptyBlob);
        storageService.saveBlockState(batch, {
            blockHeight: emptyHeightAfter,
            blockHash: fixture.blockHash,
        });
        await batch.commit();

        blockStateService.getCurrentBlockState.mockResolvedValue({
            blockHeight: emptyHeightAfter,
            blockHash: fixture.blockHash,
        });

        const frames: Buffer[] = [];
        for await (const frame of service.streamSilentBlocksRange(
            emptyHeightBefore,
            emptyHeightAfter,
        )) {
            frames.push(frame);
        }

        // Only the non-empty height should produce a frame.
        expect(frames.length).toBe(1);
        expect(frames[0].readUInt32BE(0)).toBe(nonEmptyHeight);
    });

    it('should backfill a missing silent block blob', async () => {
        const fixture = silentBlockEncodingFixture[0];
        const { blockHeight, blockHash, encodedBlockHex } = fixture;

        // Tx data and block state, but no blob: a height indexed before blobs
        // were written at index time.
        const batch = storageService.createBatch();
        for (const tx of fixture.transactions) {
            storageService.saveTransaction(batch, {
                ...tx,
                outputs: tx.outputs.map((o) => ({
                    ...o,
                    transactionId: tx.id,
                })),
            });
        }
        storageService.saveBlockState(batch, { blockHeight, blockHash });
        await batch.commit();

        blockStateService.getCurrentBlockState.mockResolvedValue({
            blockHeight,
            blockHash,
        });

        expect(storageService.getSilentBlock(blockHeight)).toBeNull();

        await (
            service as unknown as {
                backfillSilentBlocks: () => Promise<void>;
            }
        ).backfillSilentBlocks();

        expect(
            storageService.getSilentBlock(blockHeight)?.toString('hex'),
        ).toEqual(encodedBlockHex);
    });

    it('should delete a silent block blob when its block is reorged out', async () => {
        const fixture = silentBlockEncodingFixture[0];
        const { blockHeight, blockHash } = fixture;

        const batch = storageService.createBatch();
        storageService.saveSilentBlock(
            batch,
            blockHeight,
            Buffer.from(fixture.encodedBlockHex, 'hex'),
        );
        storageService.saveBlockState(batch, { blockHeight, blockHash });
        await batch.commit();

        const del = storageService.createBatch();
        await storageService.deleteTransactionsAtBlockHash(del, blockHash);
        await del.commit();

        expect(storageService.getSilentBlock(blockHeight)).toBeNull();
    });

    afterEach(async () => {
        await partitions.onModuleDestroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});
