import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { Throttle } from '@nestjs/throttler';
import {
    Controller,
    Get,
    NotFoundException,
    Param,
    ParseIntPipe,
    Query,
    UseInterceptors,
} from '@nestjs/common';
import { TransactionsService } from '@/transactions/transactions.service';
import { assertBlockRange } from '@/common/common';
import {
    TXID_CACHE_TTL_MS,
    TXID_THROTTLE_LIMIT,
    TXID_THROTTLE_TTL_MS,
} from '@/common/constants';

@Controller('transactions')
export class TransactionController {
    constructor(private readonly transactionsService: TransactionsService) {}

    @Get('height/:height')
    @UseInterceptors(CacheInterceptor)
    async getTransactionByBlockHeight(
        @Param('height', ParseIntPipe) blockHeight: number,
    ) {
        const transactions =
            await this.transactionsService.getTransactionByBlockHeight(
                blockHeight,
            );

        return { transactions: transactions };
    }

    @Get('range')
    @UseInterceptors(CacheInterceptor)
    async getTransactionsByBlockHeightRange(
        @Query('startHeight', ParseIntPipe) startHeight: number,
        @Query('endHeight', ParseIntPipe) endHeight: number,
    ) {
        assertBlockRange(startHeight, endHeight);

        const transactions =
            await this.transactionsService.getTransactionsByBlockHeightRange(
                startHeight,
                endHeight,
            );

        return { transactions: transactions };
    }

    @Get('hash/:hash')
    @UseInterceptors(CacheInterceptor)
    async getTransactionByBlockHash(@Param('hash') blockHash: string) {
        const transactions =
            await this.transactionsService.getTransactionByBlockHash(blockHash);

        return { transactions: transactions };
    }

    @Get('timestamp-to-height')
    @UseInterceptors(CacheInterceptor)
    async getBlockHeightByTimestamp(
        @Query('timestamp', ParseIntPipe) timestamp: number,
    ) {
        return await this.transactionsService.getBlockHeightByTimestamp(
            timestamp,
        );
    }

    @Get('txid/:txid')
    @UseInterceptors(CacheInterceptor)
    @CacheTTL(TXID_CACHE_TTL_MS)
    @Throttle({
        default: { ttl: TXID_THROTTLE_TTL_MS, limit: TXID_THROTTLE_LIMIT },
    })
    async getTransactionByTxid(@Param('txid') txid: string) {
        const transaction = await this.transactionsService.getTransactionByTxid(
            txid,
        );
        if (!transaction) {
            throw new NotFoundException(
                `Transaction with txid ${txid} not found`,
            );
        }
        return { transaction: transaction };
    }
}
