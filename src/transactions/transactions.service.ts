import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { StorageService } from '@/storage/storage.service';
import { SpentIndexData, TransactionData } from '@/storage/interfaces';
import { BaseBlockDataProvider } from '@/block-data-providers/base-block-data-provider.abstract';

@Injectable()
export class TransactionsService {
    constructor(
        private readonly storageService: StorageService,
        @Inject('BlockDataProvider')
        private readonly blockDataProvider: BaseBlockDataProvider<unknown>,
    ) {}

    async getTransactionByBlockHeight(
        blockHeight: number,
    ): Promise<TransactionData[]> {
        return this.storageService.getTransactionsByBlockHeight(blockHeight);
    }

    async getTransactionsByBlockHeightRange(
        startHeight: number,
        endHeight: number,
    ): Promise<TransactionData[]> {
        return this.storageService.getTransactionsByBlockHeightRange(
            startHeight,
            endHeight,
        );
    }

    async getSpentIndexByHeightRange(
        startHeight: number,
        endHeight: number,
    ): Promise<SpentIndexData[]> {
        return this.storageService.getSpentIndexByHeightRange(
            startHeight,
            endHeight,
        );
    }

    async getTransactionByBlockHash(
        blockHash: string,
    ): Promise<TransactionData[]> {
        return this.storageService.getTransactionsByBlockHash(blockHash);
    }

    /**
     * Derived live from the chain rather than read from storage: `tx:` records
     * are reachable only through a block height, and a txid does not carry
     * one. Recomputing is exact, since the scan tweak is a pure function of
     * the transaction and its prevouts.
     */
    async getTransactionByTxid(txid: string): Promise<TransactionData | null> {
        return this.blockDataProvider.getTransactionForTweak(txid);
    }

    async getBlockHeightByTimestamp(
        timestamp: number,
    ): Promise<{ blockHeight: number }> {
        const blockHeight = await this.storageService.getBlockHeightByTimestamp(
            timestamp,
        );

        if (blockHeight === null) {
            throw new NotFoundException(
                'No block found after the given timestamp',
            );
        }

        return { blockHeight };
    }
}
