// Key prefixes for namespace separation in LMDB.
//
// NOTE: 'idx:us:' was a per-txid unspent index, retired along with the isSpent
// byte it mirrored. Do not reuse that prefix for anything else.
//
// NOTE: 'idx:bh:' changed meaning when storage was partitioned. It used to be
// one empty-valued `idx:bh:<hash><txid>` key per transaction; it is now one
// `idx:bh:<hash> -> height` entry per block, living in the global environment.
// The old form is not readable as the new one, which is part of why the
// partitioned layout needs a reindex rather than a migration.
const PREFIX = {
    TX: Buffer.from('tx:'),
    OUTPUT: Buffer.from('out:'),
    HEIGHT_IDX: Buffer.from('idx:h:'),
    HASH_IDX: Buffer.from('idx:bh:'),
    TIME_IDX: Buffer.from('idx:bt:'),
    // `idx:sp:<height><chunk>` -> u32 block time + concatenated 8-byte spent
    // outpoint hashes.
    // Chunked because Esplora commits a block in several tx batches; the
    // chunk is the index of the batch's first tx.
    SPENT_IDX: Buffer.from('idx:sp:'),
    BLOCK_STATE: Buffer.from('bs:'),
    OP_STATE: Buffer.from('os:'),
    META: Buffer.from('meta:'),
} as const;

// --- Shared scalar codec ---

export function encodeUInt32(value: number): Buffer {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value);
    return buf;
}

export function decodeUInt32(buf: Buffer): number {
    return buf.readUInt32BE(0);
}

// --- Key encoders ---

export function encodeTxKey(txid: string): Buffer {
    return Buffer.concat([PREFIX.TX, Buffer.from(txid, 'hex')]);
}

export function encodeOutputKey(txid: string, vout: number): Buffer {
    return Buffer.concat([
        PREFIX.OUTPUT,
        Buffer.from(txid, 'hex'),
        encodeUInt32(vout),
    ]);
}

export function encodeHeightIndexKey(height: number, txid: string): Buffer {
    return Buffer.concat([
        PREFIX.HEIGHT_IDX,
        encodeUInt32(height),
        Buffer.from(txid, 'hex'),
    ]);
}

export function encodeHashIndexKey(blockHash: string): Buffer {
    return Buffer.concat([PREFIX.HASH_IDX, Buffer.from(blockHash, 'hex')]);
}

export function encodeHashIndexValue(blockHeight: number): Buffer {
    return encodeUInt32(blockHeight);
}

export function decodeHashIndexValue(buf: Buffer): number {
    return decodeUInt32(buf);
}

export function encodeTimeIndexKey(
    blockTime: number,
    blockHeight: number,
): Buffer {
    return Buffer.concat([
        PREFIX.TIME_IDX,
        encodeUInt32(blockTime),
        encodeUInt32(blockHeight),
    ]);
}

export function encodeBlockStateKey(height: number): Buffer {
    return Buffer.concat([PREFIX.BLOCK_STATE, encodeUInt32(height)]);
}

export function encodeOpStateKey(id: string): Buffer {
    return Buffer.concat([PREFIX.OP_STATE, Buffer.from(id, 'utf8')]);
}

/**
 * Layout facts stamped into the global environment on first open, so a later
 * run can refuse a configuration the existing data was not written under.
 */
export function encodeMetaKey(name: string): Buffer {
    return Buffer.concat([PREFIX.META, Buffer.from(name, 'utf8')]);
}

// --- Value encoders ---

export function encodeTxValue(
    blockHeight: number,
    blockHash: string,
    blockTime: number,
    scanTweak: string,
): Buffer {
    const buf = Buffer.alloc(73); // 4 + 32 + 4 + 33
    let offset = 0;
    buf.writeUInt32BE(blockHeight, offset);
    offset += 4;
    Buffer.from(blockHash, 'hex').copy(buf, offset);
    offset += 32;
    buf.writeUInt32BE(blockTime, offset);
    offset += 4;
    Buffer.from(scanTweak, 'hex').copy(buf, offset);
    return buf;
}

export function decodeTxValue(buf: Buffer): {
    blockHeight: number;
    blockHash: string;
    blockTime: number;
    scanTweak: string;
} {
    let offset = 0;
    const blockHeight = buf.readUInt32BE(offset);
    offset += 4;
    const blockHash = buf.subarray(offset, offset + 32).toString('hex');
    offset += 32;
    const blockTime = buf.readUInt32BE(offset);
    offset += 4;
    const scanTweak = buf.subarray(offset, offset + 33).toString('hex');
    return { blockHeight, blockHash, blockTime, scanTweak };
}

export function encodeOutputValue(pubKey: string, value: number): Buffer {
    const buf = Buffer.alloc(40); // 32 + 8
    let offset = 0;
    Buffer.from(pubKey, 'hex').copy(buf, offset);
    offset += 32;
    buf.writeBigUInt64BE(BigInt(value), offset);
    return buf;
}

export function decodeOutputValue(buf: Buffer): {
    pubKey: string;
    value: number;
} {
    const pubKey = buf.subarray(0, 32).toString('hex');
    const value = Number(buf.readBigUInt64BE(32));
    return { pubKey, value };
}

export function encodeSpentIndexKey(height: number, chunk: number): Buffer {
    return Buffer.concat([
        PREFIX.SPENT_IDX,
        encodeUInt32(height),
        encodeUInt32(chunk),
    ]);
}

// --- Key decoders ---

export function decodeOutputKey(key: Buffer): {
    txid: string;
    vout: number;
} {
    const data = key.subarray(PREFIX.OUTPUT.length);
    const txid = data.subarray(0, 32).toString('hex');
    const vout = data.readUInt32BE(32);
    return { txid, vout };
}

export function decodeHeightIndexKey(key: Buffer): {
    height: number;
    txid: string;
} {
    const data = key.subarray(PREFIX.HEIGHT_IDX.length);
    const height = data.readUInt32BE(0);
    const txid = data.subarray(4).toString('hex');
    return { height, txid };
}

export function decodeTimeIndexKey(key: Buffer): {
    blockTime: number;
    blockHeight: number;
} {
    const data = key.subarray(PREFIX.TIME_IDX.length);
    const blockTime = data.readUInt32BE(0);
    const blockHeight = data.readUInt32BE(4);
    return { blockTime, blockHeight };
}

export function decodeSpentIndexKey(key: Buffer): number {
    return key.readUInt32BE(PREFIX.SPENT_IDX.length);
}

export function decodeBlockStateKey(key: Buffer): number {
    return key.readUInt32BE(PREFIX.BLOCK_STATE.length);
}

// --- Range helpers for prefix scans ---

/** Returns the upper bound for a prefix scan (prefix with last byte incremented) */
export function prefixUpperBound(prefix: Buffer): Buffer {
    const upper = Buffer.from(prefix);
    if (upper[upper.length - 1] === 0xff) {
        throw new Error(
            `prefixUpperBound: prefix ends with 0xFF, cannot compute upper bound`,
        );
    }
    // Increment the last byte. This works because all our prefixes end with ':'
    // which is 0x3A, so incrementing gives 0x3B (';')
    upper[upper.length - 1]++;
    return upper;
}

/**
 * Returns a buffer one greater than `buf` interpreted as a big-endian integer.
 * Throws if `buf` is all 0xFF (no valid successor).
 */
function bigEndianIncrement(buf: Buffer): Buffer {
    const next = Buffer.from(buf);
    for (let i = next.length - 1; i >= 0; i--) {
        if (next[i] < 0xff) {
            next[i]++;
            return next;
        }
        next[i] = 0;
    }
    throw new Error(
        `bigEndianIncrement: input is all 0xFF, cannot compute successor`,
    );
}

/** Spent index range: every chunk across a block height span [start, end] */
export function spentSpanRange(
    startHeight: number,
    endHeight: number,
): { gte: Buffer; lt: Buffer } {
    return {
        gte: Buffer.concat([PREFIX.SPENT_IDX, encodeUInt32(startHeight)]),
        lt: Buffer.concat([PREFIX.SPENT_IDX, encodeUInt32(endHeight + 1)]),
    };
}

/** Height index range: all txids across a block height span [start, end] */
export function heightSpanRange(
    startHeight: number,
    endHeight: number,
): { gte: Buffer; lt: Buffer } {
    return {
        gte: Buffer.concat([PREFIX.HEIGHT_IDX, encodeUInt32(startHeight)]),
        lt: Buffer.concat([PREFIX.HEIGHT_IDX, encodeUInt32(endHeight + 1)]),
    };
}

/** Output prefix range: all outputs for a specific txid */
export function outputPrefixRange(txid: string): {
    gte: Buffer;
    lt: Buffer;
} {
    const txidBuf = Buffer.from(txid, 'hex');
    return {
        gte: Buffer.concat([PREFIX.OUTPUT, txidBuf]),
        lt: Buffer.concat([PREFIX.OUTPUT, bigEndianIncrement(txidBuf)]),
    };
}

/** Block state range for reverse iteration (get latest) */
export function blockStateRange(): { gte: Buffer; lt: Buffer } {
    return {
        gte: PREFIX.BLOCK_STATE,
        lt: prefixUpperBound(PREFIX.BLOCK_STATE),
    };
}

/** Time index: seek point for finding first block after a timestamp */
export function timeIndexSeek(timestamp: number): {
    gte: Buffer;
    lt: Buffer;
} {
    return {
        gte: Buffer.concat([PREFIX.TIME_IDX, encodeUInt32(timestamp + 1)]),
        lt: prefixUpperBound(PREFIX.TIME_IDX),
    };
}
