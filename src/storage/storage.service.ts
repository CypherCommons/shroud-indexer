import { Injectable } from '@nestjs/common';
import { RootDatabase } from 'lmdb';
import { BatchWriter } from '@/storage/batch-writer';
import { EnvLease, PartitionManager } from '@/storage/partition-manager';
import {
    TransactionData,
    OutputData,
    BlockStateData,
    OperationStateData,
} from '@/storage/interfaces';
import {
    encodeTxKey,
    encodeTxValue,
    decodeTxValue,
    encodeOutputKey,
    encodeOutputValue,
    decodeOutputKey,
    decodeOutputValue,
    encodeHeightIndexKey,
    decodeHeightIndexKey,
    encodeHashIndexKey,
    encodeHashIndexValue,
    decodeHashIndexValue,
    encodeTimeIndexKey,
    decodeTimeIndexKey,
    encodeBlockStateKey,
    decodeBlockStateKey,
    encodeOpStateKey,
    heightSpanRange,
    outputPrefixRange,
    blockStateRange,
    timeIndexSeek,
    encodeSilentBlockKey,
    decodeSilentBlockKey,
    silentBlockSpanRange,
} from '@/storage/key-encoding';

const EMPTY = Buffer.alloc(0);

type Db = RootDatabase<Buffer, Buffer>;

function get(db: Db, key: Buffer): Buffer | null {
    const val = db.getBinary(key);
    return val ? Buffer.from(val) : null;
}

/**
 * Materialises a range into an array inside a single synchronous call.
 *
 * Both halves of that matter. getRange returns a lazy iterable backed by an
 * open cursor, and closing an environment under a live cursor segfaults rather
 * than throwing, so an iterator must never outlive the call that made it. And
 * the buffers it yields can be slices of a module-level scratch buffer shared
 * across environments, so the copies below are load-bearing, not defensive.
 */
function collectRange<T>(
    db: Db,
    opts: { gte: Buffer; lt: Buffer; reverse?: boolean; limit?: number },
    decode: (key: Buffer, value: Buffer) => T,
): T[] {
    const results: T[] = [];
    // LMDB-js positions the cursor at `start` and walks toward `end`,
    // so reverse iteration needs the bounds swapped (high → low).
    const range = db.getRange({
        start: opts.reverse ? opts.lt : opts.gte,
        end: opts.reverse ? opts.gte : opts.lt,
        reverse: opts.reverse,
        limit: opts.limit,
    });
    // keyEncoding and encoding are both 'binary', so both sides are Buffers at
    // runtime; lmdb-js still types the key as its wider `Key` union.
    for (const { key, value } of range) {
        results.push(decode(Buffer.from(key as Buffer), Buffer.from(value)));
    }
    return results;
}

/**
 * Reads and writes the indexed chain data.
 *
 * Transactions, their outputs and the height index are routed to the partition
 * that owns the block's height. Everything that cannot be routed by height —
 * block state, operation state, and the hash and timestamp indexes — lives in
 * the global environment.
 *
 * Every LMDB access happens synchronously between acquiring an environment and
 * releasing it, so a lease never spans an `await` and an environment can never
 * be evicted mid-read.
 */
@Injectable()
export class StorageService {
    constructor(private readonly partitions: PartitionManager) {}

    createBatch(): BatchWriter {
        return new BatchWriter();
    }

    // --- Transaction reads ---

    async getTransactionsByBlockHeight(
        height: number,
    ): Promise<TransactionData[]> {
        return this.withPartition(height, (db) =>
            this.readTransactionsIn(db, height, height),
        );
    }

    async getTransactionsByBlockHeightRange(
        startHeight: number,
        endHeight: number,
    ): Promise<TransactionData[]> {
        const transactions: TransactionData[] = [];
        // One partition at a time: holding every lease at once would force the
        // LRU open to the width of the range.
        for (const span of this.partitions.splitRange(startHeight, endHeight)) {
            transactions.push(
                ...this.withPartition(span.lo, (db) =>
                    this.readTransactionsIn(db, span.lo, span.hi),
                ),
            );
        }
        return transactions;
    }

    async getTransactionsByBlockHash(
        blockHash: string,
    ): Promise<TransactionData[]> {
        const height = await this.getHeightForBlockHash(blockHash);
        if (height === null) return [];
        return this.getTransactionsByBlockHeight(height);
    }

    /**
     * Resolves a block hash to its height via the global index.
     *
     * Only one block is ever stored per height — a reorg deletes the old one
     * before the replacement is indexed — so the height alone identifies the
     * block's transactions.
     */
    async getHeightForBlockHash(blockHash: string): Promise<number | null> {
        return this.withGlobal((db) => {
            const buf = get(db, encodeHashIndexKey(blockHash));
            return buf ? decodeHashIndexValue(buf) : null;
        });
    }

    async getBlockHeightByTimestamp(timestamp: number): Promise<number | null> {
        return this.withGlobal((db) => {
            const results = collectRange(
                db,
                { ...timeIndexSeek(timestamp), limit: 1 },
                (key) => decodeTimeIndexKey(key).blockHeight,
            );
            return results.length > 0 ? results[0] : null;
        });
    }

    // --- Block state ---

    async getCurrentBlockState(): Promise<BlockStateData | null> {
        return this.withGlobal((db) => {
            const results = collectRange(
                db,
                { ...blockStateRange(), reverse: true, limit: 1 },
                (key, value) => ({
                    blockHeight: decodeBlockStateKey(key),
                    blockHash: value.toString('hex'),
                }),
            );
            return results.length > 0 ? results[0] : null;
        });
    }

    getLowestBlockStateHeight(): number | null {
        return this.withGlobal((db) => {
            const results = collectRange(
                db,
                { ...blockStateRange(), limit: 1 },
                (key) => decodeBlockStateKey(key),
            );
            return results.length > 0 ? results[0] : null;
        });
    }

    // --- Operation state ---

    async getOperationState(id: string): Promise<OperationStateData | null> {
        return this.withGlobal((db) => {
            const buf = get(db, encodeOpStateKey(id));
            if (!buf) return null;
            return { id, state: JSON.parse(buf.toString('utf8')) };
        });
    }

    // --- Batch write operations ---

    /** Saves a transaction and its outputs to the batch. */
    saveTransaction(batch: BatchWriter, tx: TransactionData): void {
        const part = this.partitions.acquirePartition(tx.blockHeight);

        batch.put(
            part,
            encodeTxKey(tx.id),
            encodeTxValue(
                tx.blockHeight,
                tx.blockHash,
                tx.blockTime,
                tx.scanTweak,
            ),
        );

        for (const out of tx.outputs) {
            batch.put(
                part,
                encodeOutputKey(tx.id, out.vout),
                encodeOutputValue(out.pubKey, out.value),
            );
        }

        batch.put(part, encodeHeightIndexKey(tx.blockHeight, tx.id), EMPTY);

        // The time index is global: a timestamp carries no height to route by.
        // Every transaction in a block derives the identical key, so putOnce
        // collapses them into the single entry per block that this really is.
        batch.putOnce(
            this.partitions.acquireGlobal(),
            encodeTimeIndexKey(tx.blockTime, tx.blockHeight),
            EMPTY,
        );
    }

    saveBlockState(batch: BatchWriter, state: BlockStateData): void {
        const global = this.partitions.acquireGlobal();
        batch.put(
            global,
            encodeBlockStateKey(state.blockHeight),
            Buffer.from(state.blockHash, 'hex'),
        );
        batch.put(
            global,
            encodeHashIndexKey(state.blockHash),
            encodeHashIndexValue(state.blockHeight),
        );
    }

    saveOperationState(
        batch: BatchWriter,
        id: string,
        state: OperationStateData['state'],
    ): void {
        batch.put(
            this.partitions.acquireGlobal(),
            encodeOpStateKey(id),
            Buffer.from(JSON.stringify(state), 'utf8'),
        );
    }

    /**
     * Removes everything indexed for a block.
     *
     * Height-scoped rather than hash-scoped: `idx:bh:` now resolves a hash to a
     * height rather than listing txids, so this deletes whatever sits at that
     * height. That is also what clears any records a crashed batch left behind.
     */
    async deleteTransactionsAtBlockHash(
        batch: BatchWriter,
        blockHash: string,
    ): Promise<void> {
        const height = await this.getHeightForBlockHash(blockHash);
        if (height === null) return;

        this.deleteTransactionsIn(batch, height, height);
        batch.del(
            this.partitions.acquireGlobal(),
            encodeHashIndexKey(blockHash),
        );
    }

    /**
     * Removes any indexed data above the recorded tip.
     *
     * A batch commits its partition before the global environment, so a crash
     * in between leaves blocks written that no `bs:` record claims. Replaying
     * them is normally harmless, but if the chain reorged while the process was
     * down, traceReorg sees a matching tip, resumes, and indexes the
     * replacement block on top of the originals — which nothing would ever
     * delete, because their block hash is not in `idx:bh:`.
     *
     * Batch clamping is what makes this cheap: the dirty heights can only be in
     * the partition holding `tipHeight + 1`, so this is one bounded scan, and
     * in the normal case it is a single seek that finds nothing.
     */
    purgeAboveHeight(batch: BatchWriter, tipHeight: number): void {
        const from = tipHeight + 1;
        this.deleteTransactionsIn(
            batch,
            from,
            this.partitions.partitionEndHeight(from),
        );
    }

    deleteBlockState(batch: BatchWriter, height: number): void {
        batch.del(this.partitions.acquireGlobal(), encodeBlockStateKey(height));
    }

    // --- Silent block blobs ---
    // Height-routed like transactions, so a reorg or purge that clears a
    // height's partition data clears its blob in the same transaction.

    saveSilentBlock(batch: BatchWriter, height: number, blob: Buffer): void {
        batch.put(
            this.partitions.acquirePartition(height),
            encodeSilentBlockKey(height),
            blob,
        );
    }

    getSilentBlock(height: number): Buffer | null {
        return this.withPartition(height, (db) =>
            get(db, encodeSilentBlockKey(height)),
        );
    }

    getSilentBlocksRange(
        startHeight: number,
        endHeight: number,
    ): { height: number; blob: Buffer }[] {
        const blobs: { height: number; blob: Buffer }[] = [];
        for (const span of this.partitions.splitRange(startHeight, endHeight)) {
            blobs.push(
                ...this.withPartition(span.lo, (db) =>
                    collectRange(
                        db,
                        silentBlockSpanRange(span.lo, span.hi),
                        (key, blob) => ({
                            height: decodeSilentBlockKey(key),
                            blob,
                        }),
                    ),
                ),
            );
        }
        return blobs;
    }

    // --- Private helpers ---

    private withPartition<T>(height: number, read: (db: Db) => T): T {
        const lease = this.partitions.acquirePartition(height);
        try {
            return read(lease.db);
        } finally {
            lease.release();
        }
    }

    private withGlobal<T>(read: (db: Db) => T): T {
        const lease = this.partitions.acquireGlobal();
        try {
            return read(lease.db);
        } finally {
            lease.release();
        }
    }

    /** Reads an inclusive height range out of a single partition. */
    private readTransactionsIn(
        db: Db,
        lo: number,
        hi: number,
    ): TransactionData[] {
        const txids = collectRange(
            db,
            heightSpanRange(lo, hi),
            (key) => decodeHeightIndexKey(key).txid,
        );

        const transactions: TransactionData[] = [];
        for (const txid of txids) {
            const tx = this.readTransaction(db, txid);
            if (tx) transactions.push(tx);
        }
        return transactions;
    }

    /**
     * Reads a transaction by txid out of a known partition. Private because a
     * txid alone carries no height and so is not a usable entry point;
     * `GET transactions/txid/:txid` derives its answer from the node instead.
     */
    private readTransaction(db: Db, txid: string): TransactionData | null {
        const txBuf = get(db, encodeTxKey(txid));
        if (!txBuf) return null;

        const outputs = this.readOutputs(db, txid);
        if (outputs.length === 0) return null;

        return { id: txid, ...decodeTxValue(txBuf), outputs };
    }

    private readOutputs(db: Db, txid: string): OutputData[] {
        return collectRange(db, outputPrefixRange(txid), (key, value) => {
            const { vout } = decodeOutputKey(key);
            return {
                transactionId: txid,
                vout,
                ...decodeOutputValue(value),
            };
        });
    }

    /**
     * Queues deletion of every transaction in an inclusive height range. The
     * range must lie within one partition, which both callers guarantee.
     */
    private deleteTransactionsIn(
        batch: BatchWriter,
        lo: number,
        hi: number,
    ): void {
        // Handed to the batch, which keeps it pinned until it commits or is
        // disposed — this scan reads through the same lease it writes through.
        const part = batch.adopt(this.partitions.acquirePartition(lo));
        let global: EnvLease | null = null;

        const entries = collectRange(part.db, heightSpanRange(lo, hi), (key) =>
            decodeHeightIndexKey(key),
        );

        // A block with no eligible transactions still has a blob, and has no
        // `idx:h:` entries to find it by, so blobs get their own scan.
        for (const key of collectRange(
            part.db,
            silentBlockSpanRange(lo, hi),
            (key) => key,
        )) {
            batch.del(part, key);
        }

        for (const { height, txid } of entries) {
            const txBuf = get(part.db, encodeTxKey(txid));

            batch.del(part, encodeTxKey(txid));
            for (const key of collectRange(
                part.db,
                outputPrefixRange(txid),
                (key) => key,
            )) {
                batch.del(part, key);
            }
            batch.del(part, encodeHeightIndexKey(height, txid));

            if (txBuf) {
                // One `idx:bt:` key per block, derived here by every
                // transaction in it; delOnce keeps that a single delete.
                const tx = decodeTxValue(txBuf);
                global ??= batch.adopt(this.partitions.acquireGlobal());
                batch.delOnce(
                    global,
                    encodeTimeIndexKey(tx.blockTime, tx.blockHeight),
                );
            }
        }
    }
}
