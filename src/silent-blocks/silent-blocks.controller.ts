import { CacheInterceptor } from '@nestjs/cache-manager';
import {
    Controller,
    Get,
    NotFoundException,
    Param,
    ParseIntPipe,
    Query,
    Res,
    UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';
import { MAX_SILENT_BLOCK_RANGE } from '@/common/constants';
import { assertHeight, assertHeightRange } from '@/common/common';

const CACHE_CONFIRMATION_DEPTH = 6;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store';

// A client that stops reading must not pin the generator (and its LMDB reads)
// forever. Mirrors STALL_TIMEOUT_MS on the WebSocket path.
const STREAM_STALL_TIMEOUT_MS = 60_000;

@Controller('silent-block')
export class SilentBlocksController {
    constructor(private readonly silentBlocksService: SilentBlocksService) {}

    @Get('height/:height')
    async getSilentBlockByHeight(
        @Param('height', ParseIntPipe) blockHeight: number,
        @Res() res: Response,
    ) {
        assertHeight(blockHeight, 'height');

        const latestHeight =
            await this.silentBlocksService.getLatestIndexedBlockHeight();

        // An unindexed height encodes to the same 2 bytes as a genuinely empty
        // block, so serving it would tell the client "no payments here" for a
        // block we haven't seen. /range clamps for the same reason.
        if (blockHeight > latestHeight) {
            throw new NotFoundException(
                `height ${blockHeight} is not indexed yet (tip ${latestHeight})`,
            );
        }

        const buffer = await this.silentBlocksService.getSilentBlockByHeight(
            blockHeight,
        );

        const cacheable =
            blockHeight <= latestHeight - CACHE_CONFIRMATION_DEPTH;

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': buffer.length,
            'Cache-Control': cacheable ? IMMUTABLE : NO_STORE,
        });
        res.send(buffer);
    }

    @Get('hash/:hash')
    async getSilentBlockByHash(
        @Param('hash') blockHash: string,
        @Res() res: Response,
    ) {
        const buffer = await this.silentBlocksService.getSilentBlockByHash(
            blockHash,
        );

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': buffer.length,
            // Depth is unknowable from a hash, so bound staleness instead. An
            // unknown hash encodes to the same 2 bytes as an empty block, so
            // never let a cache pin "no payments" on a block we haven't indexed.
            'Cache-Control':
                buffer.length <= 2 ? NO_STORE : 'public, max-age=60',
        });
        res.send(buffer);
    }

    @Get('range')
    async getSilentBlocksRange(
        @Query('startHeight', ParseIntPipe) startHeight: number,
        @Query('endHeight', ParseIntPipe) endHeight: number,
        @Res() res: Response,
    ) {
        assertHeightRange(startHeight, endHeight, MAX_SILENT_BLOCK_RANGE);

        const latestHeight =
            await this.silentBlocksService.getLatestIndexedBlockHeight();

        // Empty heights are omitted from the stream, so an unindexed height is
        // byte-identical to an empty one. Clamp to the tip (as the WebSocket
        // path does) so we never present "not indexed yet" as "no payments".
        if (startHeight > latestHeight) {
            throw new NotFoundException(
                `startHeight ${startHeight} is not indexed yet (tip ${latestHeight})`,
            );
        }
        const lastHeight = Math.min(endHeight, latestHeight);

        const isDeepRange =
            lastHeight <= latestHeight - CACHE_CONFIRMATION_DEPTH;
        res.set({
            'Content-Type': 'application/octet-stream',
            'Cache-Control': isDeepRange ? IMMUTABLE : NO_STORE,
            // The body can't show where a clamped range stopped, so say it here
            // (the WebSocket path does the same with the `synced` ack's `to`).
            'X-Last-Height': lastHeight,
        });

        res.setTimeout(STREAM_STALL_TIMEOUT_MS, () => res.destroy());

        try {
            await pipeline(
                Readable.from(
                    this.silentBlocksService.streamSilentBlocksRange(
                        startHeight,
                        lastHeight,
                    ),
                    { objectMode: false },
                ),
                res,
            );
        } catch {
            // Headers are already out, so letting Nest's filter end() the
            // response would present a truncated range as a complete one — and
            // a deep range is cached immutable for a year. Break the connection
            // instead so the client retries.
            res.destroy();
        }
    }

    @Get('latest-height')
    @UseInterceptors(CacheInterceptor)
    async getLatestIndexedBlockHeight() {
        const height =
            await this.silentBlocksService.getLatestIndexedBlockHeight();
        return { height };
    }
}
