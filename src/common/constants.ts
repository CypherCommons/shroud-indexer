export const NUMS_H = Buffer.from(
    '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
    'hex',
);

export const BIP352_ACTIVATION_HEIGHT = 842579; // 8 May, 2024 - when BIP-352 was merged

export const SATS_PER_BTC = 100_000_000;

export const BITCOIN_CORE_FULL_VERBOSITY_VERSION = 23_0000;

export const SILENT_PAYMENT_BLOCK_TYPE = 0x00;

export const MAX_BLOCK_RANGE = 50;

/**
 * Blocks accumulated into a single LMDB write transaction while catching up.
 *
 * `out:` keys are prefixed by raw txid, so inserts land all over the B+tree and
 * every commit rewrites the copy-on-write path from the root down to each leaf.
 * Batching amortises those shared interior pages.
 *
 * 5 is where the benefit saturates in production: commit cost per block was
 * 25.8s at 1 block, 14.6s at 5, and 14.3s at 25 -- so 5 captures effectively
 * all of the win while holding a fifth of the pending writes in memory,
 * re-indexing a fifth as much after a crash, and making blocks visible five
 * times sooner. (A local benchmark on a database small enough to stay in page
 * cache suggested 25 was better; production, where it does not fit, disagreed.)
 *
 * Only applies to catch-up. At the tip there is one block to write, so the
 * batch is naturally a single block and visibility is unaffected.
 */
export const DEFAULT_COMMIT_BATCH_BLOCKS = 5;
