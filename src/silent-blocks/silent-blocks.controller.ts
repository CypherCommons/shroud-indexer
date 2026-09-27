import { CacheInterceptor } from '@nestjs/cache-manager';
import {
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Query,
    Res,
    UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';
import { TransactionsService } from '@/transactions/transactions.service';
import { assertBlockRange } from '@/common/common';

@Controller('silent-block')
export class SilentBlocksController {
    constructor(
        private readonly silentBlocksService: SilentBlocksService,
        private readonly transactionsService: TransactionsService,
    ) {}

    @Get('spent-index/range')
    @UseInterceptors(CacheInterceptor)
    async getSpentIndexByRange(
        @Query('startHeight', ParseIntPipe) startHeight: number,
        @Query('endHeight', ParseIntPipe) endHeight: number,
    ) {
        assertBlockRange(startHeight, endHeight);

        const blocks =
            await this.transactionsService.getSpentIndexByHeightRange(
                startHeight,
                endHeight,
            );

        return { blocks };
    }

    @Get('height/:height')
    @UseInterceptors(CacheInterceptor)
    async getSilentBlockByHeight(
        @Param('height', ParseIntPipe) blockHeight: number,
        @Res() res: Response,
    ) {
        const buffer = await this.silentBlocksService.getSilentBlockByHeight(
            blockHeight,
        );

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': buffer.length,
        });
        res.send(buffer);
    }

    @Get('hash/:hash')
    @UseInterceptors(CacheInterceptor)
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
        });
        res.send(buffer);
    }

    @Get('latest-height')
    @UseInterceptors(CacheInterceptor)
    async getLatestIndexedBlockHeight() {
        const height =
            await this.silentBlocksService.getLatestIndexedBlockHeight();
        return { height };
    }
}
