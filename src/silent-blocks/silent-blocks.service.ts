import {
    forwardRef,
    Inject,
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common';
import { TransactionsService } from '@/transactions/transactions.service';
import { SilentBlocksGateway } from '@/silent-blocks/silent-blocks.gateway';
import { OnEvent } from '@nestjs/event-emitter';
import { INDEXED_BLOCK_EVENT } from '@/common/events';
import { BlockStateService } from '@/block-state/block-state.service';
import { StorageService } from '@/storage/storage.service';
import { DbTransactionService } from '@/db-transaction/db-transaction.service';
import { encodeSilentBlock } from '@/silent-blocks/silent-block-encoder';

// type + varint(0)
const EMPTY_SILENT_BLOCK_LENGTH = 2;

// Heights processed per DB scan inside streamSilentBlocksRange. Small enough that
// the first frame is emitted quickly (low TTFB, keeps the proxy connection warm),
// large enough to amortise the range-scan cost.
const SILENT_BLOCK_STREAM_SUB_BATCH = 20;

@Injectable()
export class SilentBlocksService implements OnModuleInit {
    private readonly logger = new Logger(SilentBlocksService.name);

    constructor(
        private readonly transactionsService: TransactionsService,
        @Inject(forwardRef(() => SilentBlocksGateway))
        private readonly silentBlocksGateway: SilentBlocksGateway,
        private readonly blockStateService: BlockStateService,
        private readonly storageService: StorageService,
        private readonly dbTransactionService: DbTransactionService,
    ) {}

    onModuleInit() {
        this.backfillSilentBlocks().catch((err) =>
            this.logger.error(`Silent block backfill failed: ${err.message}`),
        );
    }

    private async backfillSilentBlocks(): Promise<void> {
        const tip = await this.blockStateService.getCurrentBlockState();
        if (!tip) return;

        const startHeight = this.storageService.getLowestBlockStateHeight();
        if (startHeight === null) return;

        const tipHeight = tip.blockHeight;
        let written = 0;

        // Fills heights indexed before blobs were written at index time. One
        // height at a time: read -> encode -> commit keeps the window where
        // the indexer can rewrite a height underneath us to a single height,
        // and that height is re-saved by its own processBlock anyway. The
        // yield goes after the commit so these synchronous scans don't starve
        // the indexer and the HTTP server.
        for (let height = startHeight; height <= tipHeight; height++) {
            if (!this.storageService.getSilentBlock(height)) {
                const txs =
                    await this.storageService.getTransactionsByBlockHeight(
                        height,
                    );
                await this.dbTransactionService.execute(async (batch) => {
                    this.storageService.saveSilentBlock(
                        batch,
                        height,
                        encodeSilentBlock(txs),
                    );
                });
                written++;
            }

            await new Promise((resolve) => setImmediate(resolve));
        }

        if (written > 0) {
            this.logger.log(`Silent block backfill complete: ${written} blobs`);
        }
    }

    @OnEvent(INDEXED_BLOCK_EVENT)
    async handleBlockIndexedEvent(blockHeight: number) {
        this.logger.debug(`New block indexed: ${blockHeight}`);
        const silentBlock = await this.getSilentBlockByHeight(blockHeight);
        this.silentBlocksGateway.broadcastSilentBlock(silentBlock);
    }

    async getSilentBlockByHeight(blockHeight: number): Promise<Buffer> {
        const blob = this.storageService.getSilentBlock(blockHeight);
        if (blob) return blob;

        const transactions =
            await this.transactionsService.getTransactionByBlockHeight(
                blockHeight,
            );

        return encodeSilentBlock(transactions);
    }

    async getSilentBlockByHash(blockHash: string): Promise<Buffer> {
        const transactions =
            await this.transactionsService.getTransactionByBlockHash(blockHash);

        return encodeSilentBlock(transactions);
    }

    async *streamSilentBlocksRange(
        startHeight: number,
        endHeight: number,
    ): AsyncGenerator<Buffer> {
        // Emit incrementally in small sub-batches rather than scanning the whole
        // span up front. The first frame leaves the origin after one sub-batch
        // (~tens of ms) instead of after the entire range, which keeps the proxy
        // connection fed and lets the client pipeline against its scan. Frame
        // bytes are identical either way.
        for (
            let batchStart = startHeight;
            batchStart <= endHeight;
            batchStart += SILENT_BLOCK_STREAM_SUB_BATCH
        ) {
            const batchEnd = Math.min(
                batchStart + SILENT_BLOCK_STREAM_SUB_BATCH - 1,
                endHeight,
            );

            const blobsByHeight = new Map<number, Buffer>();
            for (const {
                height,
                blob,
            } of this.storageService.getSilentBlocksRange(
                batchStart,
                batchEnd,
            )) {
                blobsByHeight.set(height, blob);
            }

            for (let h = batchStart; h <= batchEnd; h++) {
                // Blob store miss (not backfilled yet): encode from tx data.
                const blob =
                    blobsByHeight.get(h) ??
                    encodeSilentBlock(
                        await this.transactionsService.getTransactionByBlockHeight(
                            h,
                        ),
                    );

                // The client learns the range was clean from the `synced` ACK.
                if (blob.length <= EMPTY_SILENT_BLOCK_LENGTH) continue;

                const header = Buffer.alloc(8);
                header.writeUInt32BE(h, 0);
                header.writeUInt32BE(blob.length, 4);
                yield Buffer.concat([header, blob]);
            }
        }
    }

    async getLatestIndexedBlockHeight(): Promise<number> {
        const currentBlockState =
            await this.blockStateService.getCurrentBlockState();
        return currentBlockState?.blockHeight ?? 0;
    }
}
