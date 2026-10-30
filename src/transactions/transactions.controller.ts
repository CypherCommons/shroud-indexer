import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { Throttle } from '@nestjs/throttler';
import {
    BadRequestException,
    Controller,
    Get,
    NotFoundException,
    Param,
    ParseIntPipe,
    Query,
    UseInterceptors,
} from '@nestjs/common';
import { TransactionsService } from '@/transactions/transactions.service';
import {
    MAX_BLOCK_RANGE,
    TXID_CACHE_TTL_MS,
    TXID_THROTTLE_LIMIT,
    TXID_THROTTLE_TTL_MS,
} from '@/common/constants';

const MAX_UINT32 = 0xffffffff;
const TXID_REGEX = /^[0-9a-fA-F]{64}$/;

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
        if (startHeight < 0 || endHeight < 0) {
            throw new BadRequestException('Block heights must be non-negative');
        }

        if (startHeight > endHeight) {
            throw new BadRequestException(
                'startHeight must be less than or equal to endHeight',
            );
        }

        if (endHeight - startHeight + 1 > MAX_BLOCK_RANGE) {
            throw new BadRequestException(
                `Range too large. Maximum allowed range is ${MAX_BLOCK_RANGE} blocks`,
            );
        }

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
        // Block times are uint32 seconds and the lookup seeks from
        // timestamp + 1, so anything at or past the uint32 max (most often a
        // millisecond timestamp) would throw while encoding the key.
        if (timestamp < 0 || timestamp >= MAX_UINT32) {
            throw new BadRequestException(
                'timestamp must be a unix time in seconds',
            );
        }

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
        // Checked here so a malformed txid is a 400, not an RPC error from
        // the node surfacing as a 500.
        if (!TXID_REGEX.test(txid)) {
            throw new BadRequestException(
                'txid must be a 64 character hex string',
            );
        }

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
