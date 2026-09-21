# Partitioned storage, `filterSpent` removal, live txid derivation

## Context

Indexing is I/O-bound and **degrading**. Per-block cost grows with database size, so
the indexer gets slower every day it runs.

Diagnosis is settled (see measurements below): the 18GB LMDB does not fit in 15GB RAM,
`out:` keys are raw txids so writes scatter across the whole tree, and each resulting
page fault costs ~2ms on a rotational virtio volume shared with Bitcoin Core. Current
state is **21.4s/block**, of which commit is 14.6s and markSpent 4.9s.

The database is growing at ~0.9MB/block (18GB for 20,101 blocks). At ~104,000 blocks
remaining it projects to **~112GB**, so "add RAM" is not a durable fix.

This plan attacks the mechanism rather than the constant: partition storage by block
height so all writes land in a small, cacheable working set, and remove the one feature
that forces writes into historical data.

### What makes partitioning possible

`markOutputsSpent` is the only thing that writes to old blocks — it finds an output
created in an arbitrary earlier block and flips its `isSpent` byte. That is a random
read-modify-write anywhere in 18GB of history, and it is required _only_ by
`filterSpent`.

Remove `filterSpent` and every write lands in the current block's partition. Sealed
partitions become immutable, the active partition (~0.9GB) stays in page cache, and
cost per block becomes constant.

### Measured, not assumed

Partitioned vs one growing database, identical total work, **entirely in RAM** (so this
is a lower bound — production gains cache residency on top):

| after N blocks | one growing DB   | partitioned              |
| -------------- | ---------------- | ------------------------ |
| 40             | 30ms             | 13ms                     |
| 120            | 77ms             | 16ms                     |
| 200            | 98ms             | 20ms                     |
| **total**      | **65.3ms/block** | **14.0ms/block (4.67x)** |

The flat trajectory matters more than the 4.67x. Monolithic degrades forever.

Projected: **21.4s -> ~4-5s/block**, catch-up ~26 days -> ~5 days.

| phase        | now   | after                          |
| ------------ | ----- | ------------------------------ |
| markSpent    | 4.9s  | 0 (moves to read path, Step 4) |
| commit       | 14.6s | ~2-3s                          |
| processBlock | 1.7s  | 1.7s                           |
| index        | 0.2s  | 0.2s                           |

After this, RPC becomes ~40% of block time and block prefetch becomes worth doing.

---

## Sequencing

Four independently shippable steps, ordered so the risky one lands third and the two
before it de-risk it. **Step 3 depends on Step 2** — partitioning breaks the current
txid endpoint, so its replacement must exist first.

`filterSpent` is not lost. Step 1 removes it from the **write path**; Step 4 brings it
back as a **read-path** feature once partitioning is in. That split is the point: the
write path stays clean permanently, and only clients that ask for spentness pay for it.

---

## Step 1 — Remove `filterSpent` from the write path (no reindex)

Ships immediately, no migration, ~4.9s/block back. Reintroduced as a read-path feature
in Step 4.

`filterSpent` is an **optional query param defaulting to `false`** on all six endpoints,
so default behaviour is unchanged; this removes an opt-in.

-   `src/storage/storage.service.ts` — delete `markOutputsSpent` entirely. Simplify
    `getOutputsForTxid` to the plain `outputPrefixRange` scan with no filtering.
-   Both providers — delete the `spentOutpoints` accumulation and the `markSpent` timer
    phase. **Note the P2TR prefilter added in #111 becomes dead code here**: it existed
    only to avoid doomed `markOutputsSpent` probes. Remove the prefilter and its
    `skipped`/`probes`/`hits` counters. `isP2TR` itself stays — the indexer uses it for
    output eligibility.
-   `transactions.controller.ts`, `silent-blocks.controller.ts`, and both services —
    drop the `filterSpent` query param and thread it out of the service signatures.
-   `getTransactionByTxid` no longer returns null for a fully-spent transaction.

**Keep the value encoding at 41 bytes for now.** The `isSpent` byte becomes vestigial
(always 0). Deferring the encoding change to Step 3 is what makes this step deployable
against the existing database with no reindex.

Tests: remove the `filterSpent` e2e case and the `filterSpent` unit assertions in
`storage.service.spec.ts` / `silent-blocks.service.spec.ts`.

---

## Step 2 — `GET transactions/txid/:txid` via live derivation

Requires `txindex=1` synced (`bitcoin-cli getindexinfo` -> `"synced": true`).

The scan tweak is deterministic from the transaction plus its prevouts, so recomputing
gives a **bit-identical** result to the stored one — this is not an approximation.

Add an abstract `getTransactionForTweak(txid)` to `BaseBlockDataProvider` so the
configured provider serves it:

**Bitcoin Core** (2 RPCs):

1. `getrawtransaction <txid> 2` — verbosity 2 includes `vin[].prevout.scriptPubKey.hex`.
   This is the **same shape** `getblock` verbosity 3 returns and is already modelled by
   the optional `prevout` on `Input` (`interfaces.ts:27-31`), so `parseTransactionInput`
   (`provider.ts:312`) works unchanged.
2. `getblockheader <blockhash>` — for `height`, which verbosity 2 does not return. Do
   **not** derive height from `confirmations`; it races the tip.

**Esplora**: `GET /tx/:txid` returns prevouts and `status.block_height` in one call.

Then feed `deriveOutputsAndComputeScanTweak` exactly as the block path does.

### Guards

| case                                | reason                                                    | result       |
| ----------------------------------- | --------------------------------------------------------- | ------------ |
| unconfirmed / mempool               | `prevout` comes from block undo data                      | 404          |
| coinbase                            | no prevouts; block indexer already skips it (`for i = 1`) | 404          |
| height < `BIP352_ACTIVATION_HEIGHT` | index would never hold it                                 | 404          |
| height > indexed tip                | **decision needed** — see Open questions                  | 404 or allow |

### Also

-   New constant `BITCOIN_CORE_PREVOUT_RAWTX_VERSION = 25_0000`. Do **not** reuse
    `BITCOIN_CORE_FULL_VERBOSITY_VERSION` (23) — `getrawtransaction` verbosity 2 landed in
    Core 25, and reusing it would be wrong on a Core 23-24 node.
-   Confirmed transactions are immutable: cache far longer than the current 5s `cache.ttl`.
-   Give this route a tighter throttle than the LMDB-backed ones — it is now network-bound.

---

## Step 3 — Partitioned storage (requires reindex)

### Layout

**Per-partition env** at `<db.path>/parts/<floor(height / partitionBlocks)>/`:

| key                    | value                                                   |
| ---------------------- | ------------------------------------------------------- |
| `tx:<txid>`            | height, blockHash, blockTime, scanTweak (73B)           |
| `out:<txid><vout>`     | pubKey(32) + value(8) = **40B**, `isSpent` byte dropped |
| `idx:h:<height><txid>` | empty                                                   |

**Global env** at `<db.path>/global/` — everything that must span partitions:

| key                          | value           | notes                                                    |
| ---------------------------- | --------------- | -------------------------------------------------------- |
| `bs:<height>`                | blockHash       | `traceReorg` walks this per height, must stay contiguous |
| `os:<id>`                    | operation state |                                                          |
| `idx:bt:<blockTime><height>` | empty           | one per block                                            |
| `idx:bh:<blockHash>`         | height (u32)    | **replaces** `idx:bh:<hash><txid>`                       |

The global env holds ~3 entries per block — a few tens of MB at full chain, permanently
cacheable.

That `idx:bh:` change is a significant side benefit: today it is a **71-byte key per
transaction** (`prefix + 32B hash + 32B txid`), roughly 20% of stored bytes, and its only
two consumers just want "txids in this block". One entry per block plus the existing
`idx:h:` serves both.

### `PartitionManager`

New service owning env lifecycle:

-   `getEnv(height)` — lazily opens `parts/<index>`, returns the env.
-   LRU of open envs (`db.openPartitions`, default 8); close beyond that.
-   Per-partition `mapSize` (`db.partitionMapSize`, default 2GB). This **removes the
    `MDB_MAP_FULL` cliff** — no single map has to be sized for the whole chain.
-   **Clamp each commit batch to a partition boundary** so a batch never spans two
    partitions. At `commitBatchBlocks=5` and 1000-block partitions that costs one short
    batch per 200.

### Cross-env atomicity — the critical correctness detail

Today one LMDB transaction covers data + block state + op state atomically. Two envs
means two transactions, and **LMDB gives no cross-env atomicity.**

**Commit the partition env first, then the global env.** A crash between them leaves
data written but the operation state still pointing at the earlier height, so restart
re-indexes those blocks. Writes are keyed puts of identical values, so replay converges.

The reverse order is **unsafe** — state would claim heights that have no data. This
ordering must be enforced in code and stated in a comment; it is the one invariant that
cannot be recovered from if broken.

### Access paths after the change

| endpoint                                                      | resolution                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `silent-blocks/height/:height`, `transactions/height/:height` | `partition(height)`                                                                  |
| `transactions/range`                                          | `MAX_BLOCK_RANGE=50`, so at most 2 partitions; split at the boundary and concatenate |
| `silent-blocks/hash/:hash`, `transactions/hash/:hash`         | global `idx:bh:` -> height -> partition                                              |
| `transactions/timestamp-to-height`                            | global `idx:bt:`                                                                     |
| `silent-blocks/latest-height`                                 | global `bs:` reverse scan                                                            |
| `transactions/txid/:txid`                                     | live derivation (Step 2)                                                             |

### Reorgs

`deleteTransactionsByBlockHash`: hash -> height (global) -> `partition(height)`, delete
`tx:`/`out:`/`idx:h:` there, plus the global `bs:`/`idx:bh:`/`idx:bt:` entries.

Resolve the partition per height, so a rollback crossing a boundary is handled naturally.

**Do not treat sealed partitions as strictly read-only.** A reorg reaching back past a
boundary will write to an older partition. It is immutable in practice, not by
invariant — do not build an optimization that assumes otherwise.

### Config

| key                    | default | notes                                  |
| ---------------------- | ------- | -------------------------------------- |
| `db.partitionBlocks`   | 1000    | ~0.9GB per partition at current growth |
| `db.partitionMapSize`  | 2GB     | per partition                          |
| `db.openPartitions`    | 8       | LRU                                    |
| `db.mapSize`           | 1GB     | now applies to the **global** env only |
| `db.commitBatchBlocks` | 5       | unchanged; batches within a partition  |

---

## Step 4 — Reintroduce `filterSpent` as a read-path feature

Spentness is a UTXO-set question, and Bitcoin Core already maintains the UTXO set
optimally in chainstate. `gettxout <txid> <vout>` answers "is this unspent?" directly and
needs no txindex.

Serve `filterSpent=true` by querying Core for the outputs in the response, rather than by
maintaining spent state in our own storage:

-   **Zero write cost** — partitions stay immutable.
-   **Zero storage** — no spent index.
-   **Fixes an existing bug.** `deleteTransactionsByBlockHash` never un-spends outputs from
    earlier blocks, so today a reorg leaves them wrongly marked spent permanently. Reading
    live chainstate removes that entire class of bug.
-   **Better semantics.** Today `isSpent` means "spent as of when we indexed it". `gettxout`
    means "unspent as of now", which is what a caller asking the question actually wants.

### Work required

-   **JSON-RPC batching**, which the codebase does nowhere today (`provider.ts` sends one
    object per request). One silent block is ~1,250 outputs; unbatched that is 1,250
    round-trips. Core accepts an array of calls.
-   Pass `include_mempool: false` so results reflect confirmed state.
-   Cache results; give the route a tighter throttle, as it is now network-bound.

### Known limits — decide before building

-   **The `range` endpoint does not fit this model.** `MAX_BLOCK_RANGE=50` x ~1,250 outputs
    = ~62,500 lookups. Either cap the range harder when `filterSpent=true`, or do not offer
    the flag on that route.
-   Core being down degrades this endpoint (indexing is unaffected).
-   **Measure first.** Batched `gettxout` latency against warm chainstate is the number the
    whole step rests on, and it has not been measured. Do that before committing to the
    design.

---

## Rejected alternative — outpoint -> height index

Considered: a separate database mapping each stored outpoint to its creation height, so a
spend could look up the height and mark the output spent in that partition.

It is correct, but it gives back most of what partitioning buys:

-   **The index is large and randomly accessed.** ~1,250 outputs/block x ~124,000 blocks
    ~= 155M entries; at 36-byte key + 4-byte value plus node overhead and fill factor,
    **~11GB**. On a 15GB box also running Core that has the same cache problem the main
    database has today, so the probes stay expensive — moved from an 18GB tree to an 11GB
    tree, not eliminated.
-   **Writes fan out across partitions.** A block's spends reference outputs created at
    scattered heights, so a single block can touch tens of distinct partitions. Each LMDB
    env commits independently, so that is tens of write transactions and commits per block
    instead of one, plus LRU thrash. Plausibly worse than today's single commit, and it
    ends partition immutability.

Recorded here so it is not re-proposed; Step 4 achieves the same feature at no write cost.

---

## Migration

Schema is incompatible (partition split, 40-byte output values, new `idx:bh:`), so a
**full reindex from `BIP352_ACTIVATION_HEIGHT` (842,579)** is required — ~20,101 blocks,
roughly 17-28 hours at the new speed.

Prefer building into a new directory and switching after verification, keeping the old
database until then. **This needs ~32GB free** (18GB old + ~14GB new, smaller without
`idx:bh:` and the `isSpent` byte). Disk is tight on this box — confirm with `df -h`
before choosing. If headroom is insufficient, reindex in place after stopping, which
uses less disk but has no rollback.

---

## Verification

1. **Differential check — the strongest signal.** Before switching, run old and new
   builds side by side and compare API responses byte-for-byte across a sample of
   heights, hashes and timestamps. Any divergence outside the removed `filterSpent`
   behaviour is a bug.
2. **e2e with `partitionBlocks` set small** (e.g. 5) so the suite actually crosses
   partition boundaries, opens/evicts envs, and exercises the LRU. The current default
   would never cross one in a short test.
3. **Crash safety**: kill the process between the partition commit and the global
   commit, restart, confirm it re-indexes and converges.
4. **Reorg across a boundary**: invalidate a block at `N*partitionBlocks + 1` on regtest
   and confirm cleanup touches both partitions correctly.
5. Unit tests for `PartitionManager`: boundary arithmetic, lazy open, LRU eviction,
   batch clamping.
6. Confirm the telemetry line shows **flat** per-block cost as height grows — that is
   the whole point, and the one result that proves the design worked.

---

## Risks

| risk                                       | mitigation                                         |
| ------------------------------------------ | -------------------------------------------------- |
| Cross-env atomicity                        | strict commit ordering + idempotent replay (above) |
| Disk exhaustion during reindex             | check `df -h` first; in-place fallback             |
| Reorg across partition boundary            | resolve partition per height; explicit test        |
| mmap/fd exhaustion                         | LRU-bounded open envs                              |
| Reindex invalidates a day of work if wrong | differential check before switching                |

---

## Open questions — need your input

1. **`df -h /mnt/btcdata`** — is there ~32GB headroom for a side-by-side reindex, or do
   we reindex in place? This decides the migration path.
2. **txid lookups above the indexed tip** — reject for API consistency, or allow as a
   feature? Live derivation can serve them; the rest of the API cannot.
3. **Partition size** — 1000 blocks (~0.9GB) is my default. 500 gives better cache
   headroom as blocks grow; 2000 halves the file count. Preference?
4. **Any external client using `filterSpent=true`?** It is opt-in and defaults to false,
   so I expect not, but it is a breaking change worth confirming.
5. **Keep Esplora support for the txid path?** It is one call there versus two on Core.
   Costs a second implementation to maintain.
6. **`filterSpent` on the `range` endpoint** — cap the range harder when the flag is set,
   or drop the flag on that route entirely?
