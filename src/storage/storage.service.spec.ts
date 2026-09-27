import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '@/storage/storage.service';
import { PartitionManager } from '@/storage/partition-manager';
import { BatchWriter } from '@/storage/batch-writer';
import { TransactionData } from '@/storage/interfaces';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const txid = (n: number) => n.toString(16).padStart(64, '0');
const hash = (n: number) => n.toString(16).padStart(64, 'f');
const pubKey = (n: number) => n.toString(16).padStart(64, 'a');

const makeTx = (
    id: string,
    outputs: { vout: number; value: number }[],
    blockHeight = 100,
    blockHash = hash(999),
    blockTime = 1_700_000_000,
): TransactionData => ({
    id,
    blockHeight,
    blockHash,
    blockTime,
    scanTweak: '02'.padEnd(66, 'b'),
    outputs: outputs.map((o) => ({
        transactionId: id,
        vout: o.vout,
        pubKey: pubKey(o.vout),
        value: o.value,
    })),
});

describe('StorageService', () => {
    let storage: StorageService;
    let partitions: PartitionManager;
    let tmpDir: string;

    const save = async (...txs: TransactionData[]) => {
        const batch = storage.createBatch();
        const blocks = new Map<number, string>();
        for (const tx of txs) {
            storage.saveTransaction(batch, tx);
            blocks.set(tx.blockHeight, tx.blockHash);
        }
        // Indexing always records block state alongside a block's
        // transactions, and that is what populates the hash index.
        for (const [blockHeight, blockHash] of blocks) {
            storage.saveBlockState(batch, { blockHeight, blockHash });
        }
        await batch.commit();
    };

    // Transactions are only reachable through a block, so every read-back goes
    // via the height index rather than a txid lookup.
    const findTx = async (height: number, id: string) =>
        (await storage.getTransactionsByBlockHeight(height)).find(
            (t) => t.id === id,
        ) ?? null;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                StorageService,
                PartitionManager,
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
            ],
        }).compile();

        partitions = module.get<PartitionManager>(PartitionManager);
        partitions.onModuleInit();
        storage = module.get<StorageService>(StorageService);
    });

    afterEach(async () => {
        await partitions.onModuleDestroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('transaction reads', () => {
        it('round-trips a transaction and its outputs', async () => {
            await save(
                makeTx(txid(1), [
                    { vout: 0, value: 500 },
                    { vout: 3, value: 700 },
                ]),
            );

            const tx = await findTx(100, txid(1));
            expect(tx.id).toBe(txid(1));
            expect(tx.blockHeight).toBe(100);
            expect(tx.blockHash).toBe(hash(999));
            expect(tx.blockTime).toBe(1_700_000_000);
            expect(tx.outputs.map((o) => [o.vout, o.value])).toEqual([
                [0, 500],
                [3, 700],
            ]);
        });

        it('returns nothing for an unknown txid', async () => {
            expect(await findTx(100, txid(42))).toBeNull();
        });

        it('returns every transaction at a height, txid-ascending', async () => {
            await save(
                makeTx(txid(20), [{ vout: 0, value: 1 }], 500),
                makeTx(txid(10), [{ vout: 0, value: 2 }], 500),
                makeTx(txid(30), [{ vout: 0, value: 3 }], 501),
            );

            const txs = await storage.getTransactionsByBlockHeight(500);
            expect(txs.map((t) => t.id)).toEqual([txid(10), txid(20)]);
        });

        it('spans an inclusive height range in height order', async () => {
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 10),
                makeTx(txid(2), [{ vout: 0, value: 2 }], 11),
                makeTx(txid(3), [{ vout: 0, value: 3 }], 12),
                makeTx(txid(4), [{ vout: 0, value: 4 }], 13),
            );

            const txs = await storage.getTransactionsByBlockHeightRange(11, 12);
            expect(txs.map((t) => t.id)).toEqual([txid(2), txid(3)]);
        });

        it('returns every transaction for a block hash', async () => {
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 10, hash(1)),
                makeTx(txid(2), [{ vout: 0, value: 2 }], 11, hash(2)),
            );

            const txs = await storage.getTransactionsByBlockHash(hash(2));
            expect(txs.map((t) => t.id)).toEqual([txid(2)]);
        });

        it('returns an empty list for heights and hashes with no data', async () => {
            expect(await storage.getTransactionsByBlockHeight(7)).toEqual([]);
            expect(await storage.getTransactionsByBlockHash(hash(7))).toEqual(
                [],
            );
        });
    });

    describe('getBlockHeightByTimestamp', () => {
        it('finds the first block strictly after the timestamp', async () => {
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 10, hash(1), 1000),
                makeTx(txid(2), [{ vout: 0, value: 2 }], 11, hash(2), 2000),
            );

            expect(await storage.getBlockHeightByTimestamp(999)).toBe(10);
            // Strictly after: a block AT the timestamp is not a match.
            expect(await storage.getBlockHeightByTimestamp(1000)).toBe(11);
            expect(await storage.getBlockHeightByTimestamp(2000)).toBeNull();
        });
    });

    describe('block state', () => {
        it('returns the highest recorded height', async () => {
            const batch = storage.createBatch();
            storage.saveBlockState(batch, {
                blockHeight: 10,
                blockHash: hash(1),
            });
            storage.saveBlockState(batch, {
                blockHeight: 12,
                blockHash: hash(2),
            });
            storage.saveBlockState(batch, {
                blockHeight: 11,
                blockHash: hash(3),
            });
            await batch.commit();

            expect(await storage.getCurrentBlockState()).toEqual({
                blockHeight: 12,
                blockHash: hash(2),
            });
        });

        it('falls back to the next-highest once the tip is deleted', async () => {
            const batch = storage.createBatch();
            storage.saveBlockState(batch, {
                blockHeight: 10,
                blockHash: hash(1),
            });
            storage.saveBlockState(batch, {
                blockHeight: 11,
                blockHash: hash(2),
            });
            await batch.commit();

            const remove = storage.createBatch();
            storage.deleteBlockState(remove, 11);
            await remove.commit();

            expect((await storage.getCurrentBlockState()).blockHeight).toBe(10);
        });

        it('returns null when nothing is recorded', async () => {
            expect(await storage.getCurrentBlockState()).toBeNull();
        });
    });

    describe('operation state', () => {
        it('round-trips a JSON state blob', async () => {
            const batch = storage.createBatch();
            storage.saveOperationState(batch, 'core', {
                indexedBlockHeight: 842579,
            });
            await batch.commit();

            expect(await storage.getOperationState('core')).toEqual({
                id: 'core',
                state: { indexedBlockHeight: 842579 },
            });
        });

        it('returns null for an unknown id', async () => {
            expect(await storage.getOperationState('nope')).toBeNull();
        });
    });

    describe('deleteTransactionsAtBlockHash', () => {
        it('removes the transactions, outputs and every index for that block', async () => {
            await save(
                makeTx(
                    txid(1),
                    [
                        { vout: 0, value: 1 },
                        { vout: 1, value: 2 },
                    ],
                    10,
                    hash(1),
                    1000,
                ),
                makeTx(txid(2), [{ vout: 0, value: 3 }], 10, hash(1), 1000),
                makeTx(txid(3), [{ vout: 0, value: 4 }], 11, hash(2), 2000),
            );

            const batch = storage.createBatch();
            await storage.deleteTransactionsAtBlockHash(batch, hash(1));
            await batch.commit();

            expect(await findTx(10, txid(1))).toBeNull();
            expect(await findTx(10, txid(2))).toBeNull();
            expect(await storage.getTransactionsByBlockHeight(10)).toEqual([]);
            expect(await storage.getTransactionsByBlockHash(hash(1))).toEqual(
                [],
            );
            // The time index for the deleted block is gone, so the next block
            // after that timestamp is now block 11.
            expect(await storage.getBlockHeightByTimestamp(999)).toBe(11);

            // The untouched block survives intact.
            const survivors = await storage.getTransactionsByBlockHeight(11);
            expect(survivors.map((t) => t.id)).toEqual([txid(3)]);
        });

        it('is a no-op for a block hash that was never indexed', async () => {
            await save(makeTx(txid(1), [{ vout: 0, value: 1 }], 10, hash(1)));

            const batch = storage.createBatch();
            await storage.deleteTransactionsAtBlockHash(batch, hash(5));
            await batch.commit();

            expect(await findTx(10, txid(1))).not.toBeNull();
        });
    });

    describe('spent index', () => {
        const hashes = (...n: number[]) =>
            Buffer.from(
                n.map((x) => x.toString(16).padStart(16, '0')).join(''),
                'hex',
            );

        const saveSpent = async (
            height: number,
            blockHash: string,
            chunks: [number, Buffer][],
        ) => {
            const batch = storage.createBatch();
            for (const [chunk, buf] of chunks) {
                storage.saveSpentIndex(
                    batch,
                    height,
                    chunk,
                    1000 + height,
                    buf,
                );
            }
            storage.saveBlockState(batch, { blockHeight: height, blockHash });
            await batch.commit();
        };

        it('joins every chunk of a block and skips heights with none', async () => {
            await saveSpent(10, hash(1), [
                [1, hashes(1, 2)],
                [26, hashes(3)],
            ]);
            await saveSpent(11, hash(2), [[1, Buffer.alloc(0)]]);
            await saveSpent(12, hash(3), [[1, hashes(4)]]);

            expect(await storage.getSpentIndexByHeightRange(9, 13)).toEqual([
                {
                    height: 10,
                    blockHash: hash(1),
                    blockTime: 1010,
                    hashes: hashes(1, 2, 3).toString('hex'),
                },
                {
                    height: 12,
                    blockHash: hash(3),
                    blockTime: 1012,
                    hashes: hashes(4).toString('hex'),
                },
            ]);
        });

        it('is deleted with its block on reorg, even with no eligible txs', async () => {
            await saveSpent(10, hash(1), [[0, hashes(1)]]);
            await saveSpent(11, hash(2), [[0, hashes(2)]]);

            const batch = storage.createBatch();
            await storage.deleteTransactionsAtBlockHash(batch, hash(1));
            await batch.commit();

            expect(
                (await storage.getSpentIndexByHeightRange(10, 11)).map(
                    (b) => b.height,
                ),
            ).toEqual([11]);
        });

        it('is purged above the indexed tip', async () => {
            await saveSpent(6, hash(1), [[0, hashes(1)]]);
            await saveSpent(7, hash(2), [[0, hashes(2)]]);

            const batch = storage.createBatch();
            storage.purgeAboveHeight(batch, 6);
            await batch.commit();

            expect(
                (await storage.getSpentIndexByHeightRange(6, 7)).map(
                    (b) => b.height,
                ),
            ).toEqual([6]);
        });
    });

    describe('partitioning', () => {
        // The spec runs with db.partitionBlocks = 5.

        it('reads a range that spans several partitions in height order', async () => {
            await save(
                ...Array.from({ length: 12 }, (_, i) =>
                    makeTx(txid(i + 1), [{ vout: 0, value: i }], 3 + i),
                ),
            );

            const txs = await storage.getTransactionsByBlockHeightRange(4, 13);

            expect(txs.map((t) => t.blockHeight)).toEqual([
                4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
            ]);
        });

        it('keeps a block reachable by hash across a partition boundary', async () => {
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 9, hash(1)),
                makeTx(txid(2), [{ vout: 0, value: 2 }], 10, hash(2)),
            );

            expect(await storage.getHeightForBlockHash(hash(1))).toBe(9);
            expect(await storage.getHeightForBlockHash(hash(2))).toBe(10);
            expect(await storage.getHeightForBlockHash(hash(3))).toBeNull();

            const across = await storage.getTransactionsByBlockHash(hash(2));
            expect(across.map((t) => t.id)).toEqual([txid(2)]);
        });

        it('deletes from the partition the block actually lives in', async () => {
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 9, hash(1)),
                makeTx(txid(2), [{ vout: 0, value: 2 }], 10, hash(2)),
            );

            const batch = storage.createBatch();
            await storage.deleteTransactionsAtBlockHash(batch, hash(2));
            await batch.commit();

            expect(await storage.getTransactionsByBlockHeight(10)).toEqual([]);
            expect(await storage.getHeightForBlockHash(hash(2))).toBeNull();
            // The neighbouring partition is untouched.
            expect(
                (await storage.getTransactionsByBlockHeight(9)).map(
                    (t) => t.id,
                ),
            ).toEqual([txid(1)]);
        });
    });

    describe('reorg across a partition boundary', () => {
        it('unwinds height by height into whichever partition owns each', async () => {
            // Heights 8 and 9 are in partition 1, height 10 starts partition 2.
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 8, hash(1), 800),
                makeTx(txid(2), [{ vout: 0, value: 2 }], 9, hash(2), 900),
                makeTx(txid(3), [{ vout: 0, value: 3 }], 10, hash(3), 1000),
            );

            // traceReorg walks back one height at a time, each in its own
            // batch, so the rollback crosses the boundary between 10 and 9.
            for (const blockHash of [hash(3), hash(2)]) {
                const batch = storage.createBatch();
                await storage.deleteTransactionsAtBlockHash(batch, blockHash);
                storage.deleteBlockState(batch, blockHash === hash(3) ? 10 : 9);
                await batch.commit();
            }

            expect(await storage.getTransactionsByBlockHeight(10)).toEqual([]);
            expect(await storage.getTransactionsByBlockHeight(9)).toEqual([]);
            expect(await storage.getHeightForBlockHash(hash(3))).toBeNull();
            expect(await storage.getHeightForBlockHash(hash(2))).toBeNull();
            expect((await storage.getCurrentBlockState()).blockHeight).toBe(8);

            // The block below the rollback survives, in the same partition one
            // of the deleted blocks came from.
            expect(
                (await storage.getTransactionsByBlockHeight(8)).map(
                    (t) => t.id,
                ),
            ).toEqual([txid(1)]);
        });

        it('is idempotent, so a crash mid-unwind converges on retry', async () => {
            await save(makeTx(txid(1), [{ vout: 0, value: 1 }], 10, hash(1)));

            for (let attempt = 0; attempt < 2; attempt++) {
                const batch = storage.createBatch();
                await storage.deleteTransactionsAtBlockHash(batch, hash(1));
                await batch.commit();
            }

            expect(await storage.getTransactionsByBlockHeight(10)).toEqual([]);
        });
    });

    describe('purgeAboveHeight', () => {
        it('drops blocks left above the recorded tip by a partial commit', async () => {
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 10, hash(1), 1000),
                // Committed to the partition, but the crash hit before block
                // state was written, so nothing claims these heights.
                makeTx(txid(2), [{ vout: 0, value: 2 }], 11, hash(2), 2000),
                makeTx(txid(3), [{ vout: 0, value: 3 }], 12, hash(3), 3000),
            );

            const batch = storage.createBatch();
            storage.purgeAboveHeight(batch, 10);
            await batch.commit();

            expect(await storage.getTransactionsByBlockHeight(11)).toEqual([]);
            expect(await storage.getTransactionsByBlockHeight(12)).toEqual([]);
            // The time index entries went with them.
            expect(await storage.getBlockHeightByTimestamp(1500)).toBeNull();
            // Everything at or below the tip is untouched.
            expect(
                (await storage.getTransactionsByBlockHeight(10)).map(
                    (t) => t.id,
                ),
            ).toEqual([txid(1)]);
        });

        it('is a no-op when nothing was written above the tip', async () => {
            await save(makeTx(txid(1), [{ vout: 0, value: 1 }], 10, hash(1)));

            const batch = storage.createBatch();
            storage.purgeAboveHeight(batch, 10);
            await batch.commit();

            expect(
                (await storage.getTransactionsByBlockHeight(10)).map(
                    (t) => t.id,
                ),
            ).toEqual([txid(1)]);
        });
    });

    describe('write amplification', () => {
        // The timestamp index is keyed by (blockTime, blockHeight), so it is
        // one entry per block — but saveTransaction derives it once per
        // transaction, into the global environment the partitioning is meant
        // to keep small.
        const timeIndexKeys = () => {
            const lease = partitions.acquireGlobal();
            try {
                return [
                    ...lease.db.getRange({
                        start: Buffer.from('idx:bt:'),
                        end: Buffer.from('idx:bt;'),
                    }),
                ].length;
            } finally {
                lease.release();
            }
        };

        it('writes one timestamp-index entry per block, not per transaction', async () => {
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 9),
                makeTx(txid(2), [{ vout: 0, value: 2 }], 9),
                makeTx(txid(3), [{ vout: 0, value: 3 }], 9),
                makeTx(txid(4), [{ vout: 0, value: 4 }], 10),
            );

            expect(timeIndexKeys()).toBe(2);
        });

        it('clears the timestamp index when the block is deleted', async () => {
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 9, hash(1)),
                makeTx(txid(2), [{ vout: 0, value: 2 }], 9, hash(1)),
            );
            expect(timeIndexKeys()).toBe(1);

            const batch = storage.createBatch();
            await storage.deleteTransactionsAtBlockHash(batch, hash(1));
            await batch.commit();

            expect(timeIndexKeys()).toBe(0);
        });
    });

    describe('environment leases', () => {
        // saveTransaction acquires a partition and the global environment per
        // transaction and hands both to the batch, which is responsible for
        // releasing the surplus. A miss there pins an environment for the life
        // of the process and the LRU silently exceeds its cap.
        const writeThreeBlocksAcrossTwoPartitions = (batch: BatchWriter) => {
            storage.saveTransaction(
                batch,
                makeTx(txid(1), [{ vout: 0, value: 1 }], 0),
            );
            storage.saveTransaction(
                batch,
                makeTx(txid(2), [{ vout: 0, value: 2 }], 1),
            );
            storage.saveTransaction(
                batch,
                makeTx(txid(3), [{ vout: 0, value: 3 }], 9),
            );
            storage.saveBlockState(batch, {
                blockHeight: 9,
                blockHash: hash(1),
            });
        };

        it('releases every environment a committed write batch touched', async () => {
            const batch = storage.createBatch();
            writeThreeBlocksAcrossTwoPartitions(batch);
            expect(partitions.leasedCount).toBeGreaterThan(0);

            await batch.commit();

            expect(partitions.leasedCount).toBe(0);
        });

        it('releases every environment an abandoned batch touched', async () => {
            const batch = storage.createBatch();
            writeThreeBlocksAcrossTwoPartitions(batch);
            batch.dispose();

            expect(partitions.leasedCount).toBe(0);
        });

        it('releases the environments a read borrowed', async () => {
            await save(makeTx(txid(1), [{ vout: 0, value: 1 }], 9, hash(1)));

            await storage.getTransactionsByBlockHeightRange(0, 12);
            await storage.getTransactionsByBlockHash(hash(1));
            await storage.getCurrentBlockState();

            expect(partitions.leasedCount).toBe(0);
        });
    });

    describe('batching', () => {
        it('writes nothing when the batch is never committed', async () => {
            const batch = storage.createBatch();
            storage.saveTransaction(
                batch,
                makeTx(txid(1), [{ vout: 0, value: 1 }]),
            );

            expect(await findTx(100, txid(1))).toBeNull();
        });
    });
});
