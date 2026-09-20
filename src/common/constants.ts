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
 * Batching amortises those shared interior pages: measured at ~5x less commit
 * time per block versus committing each block on its own, with returns
 * flattening out past ~25.
 *
 * Only applies to catch-up. At the tip there is one block to write, so the
 * batch is naturally a single block and visibility is unaffected.
 */
export const DEFAULT_COMMIT_BATCH_BLOCKS = 25;
