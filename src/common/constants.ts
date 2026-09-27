export const NUMS_H = Buffer.from(
    '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
    'hex',
);

export const BIP352_ACTIVATION_HEIGHT = 842579; // 8 May, 2024 - when BIP-352 was merged

export const SATS_PER_BTC = 100_000_000;

export const BITCOIN_CORE_FULL_VERBOSITY_VERSION = 23_0000;

/**
 * First Core release whose `getrawtransaction` accepts verbosity 2, which
 * embeds `vin[].prevout` the way `getblock` verbosity 3 does.
 *
 * Deliberately not BITCOIN_CORE_FULL_VERBOSITY_VERSION: `getblock` gained
 * verbosity 3 in Core 23, but `getrawtransaction` only gained verbosity 2 in
 * Core 25. Reusing the 23 constant would send an unsupported argument to a
 * Core 23-24 node. Below 25 we fall back to the verbose boolean form and let
 * `parseTransactionInput` fetch each prevout itself.
 *
 * Note this is only about how many round-trips the lookup costs. At every
 * version, `getrawtransaction <txid>` with no block hash searches the mempool
 * and, only if `txindex=1` is set, the chain -- so the whole
 * `GET transactions/txid/:txid` route requires `txindex=1` on the node,
 * regardless of which branch below is taken.
 */
export const BITCOIN_CORE_PREVOUT_RAWTX_VERSION = 25_0000;

export const SILENT_PAYMENT_BLOCK_TYPE = 0x00;

export const MAX_BLOCK_RANGE = 50;

/**
 * Blocks accumulated into a single LMDB write transaction while catching up.
 *
 * `out:` keys are prefixed by raw txid, so inserts land all over the B+tree and
 * every commit rewrites the copy-on-write path from the root down to each leaf.
 * Batching amortises those shared interior pages: measured at ~5x less commit
 * time per block versus committing each block on its own, with returns
 * flattening out past ~25.
 *
 * Only applies to catch-up. At the tip there is one block to write, so the
 * batch is naturally a single block and visibility is unaffected.
 *
 * A batch is additionally clamped to a partition boundary, so a run of blocks
 * spanning one never becomes a single write transaction.
 */
export const DEFAULT_COMMIT_BATCH_BLOCKS = 25;

/**
 * Heights per storage partition.
 *
 * Partitioning exists so that the working set of a write is the partition
 * being indexed rather than the whole chain: at ~0.9MB/block, 1000 blocks is
 * ~0.9GB, which stays resident in page cache while sealed partitions do not
 * compete for it. Smaller partitions buy more cache headroom as blocks grow;
 * larger ones mean fewer directories.
 */
export const DEFAULT_PARTITION_BLOCKS = 1000;

/**
 * Map size per partition. This is a ceiling on virtual address space, not a
 * preallocation — LMDB grows the file lazily. Sizing it per partition rather
 * than for the whole chain is what removes the MDB_MAP_FULL cliff.
 */
export const DEFAULT_PARTITION_MAP_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

/** How many partition environments to keep open, least-recently-used first. */
export const DEFAULT_OPEN_PARTITIONS = 8;

/**
 * Cache lifetime for `GET transactions/txid/:txid`.
 *
 * That route is derived live from the node rather than read from LMDB, and a
 * confirmed transaction's scan tweak is immutable, so the 5s global TTL
 * (sized for the indexed tip moving) is pointlessly short here. A reorg can
 * still invalidate an entry, hence an hour rather than forever.
 */
export const TXID_CACHE_TTL_MS = 3_600_000;

/**
 * Throttle for `GET transactions/txid/:txid`: tighter than the global burst
 * window because this route costs two RPCs to the node (more on a pre-Core-25
 * node, which fetches every prevout separately) rather than an mmap lookup.
 */
export const TXID_THROTTLE_TTL_MS = 1_000;
export const TXID_THROTTLE_LIMIT = 2;
export const MAX_SILENT_BLOCK_RANGE = 200;
