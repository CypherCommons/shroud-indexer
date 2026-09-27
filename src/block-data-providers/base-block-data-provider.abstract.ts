import { OperationStateService } from '@/operation-state/operation-state.service';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    IndexerService,
    TransactionInput,
    TransactionOutput,
} from '@/indexer/indexer.service';
import { ConfigService } from '@nestjs/config';
import { BlockStateService } from '@/block-state/block-state.service';
import { BatchWriter } from '@/storage/batch-writer';
import { StorageService } from '@/storage/storage.service';
import { TransactionData } from '@/storage/interfaces';
import { BitcoinNetwork } from '@/common/enum';
import { BIP352_ACTIVATION_HEIGHT } from '@/common/constants';
import { isP2TR, spentOutpointHash } from '@/common/common';

/** A confirmed transaction in the shape the scan-tweak derivation needs. */
export type ProviderTransaction = {
    vin: TransactionInput[];
    vout: TransactionOutput[];
    blockHeight: number;
    blockHash: string;
    blockTime: number;
};

export abstract class BaseBlockDataProvider<OperationState> {
    protected readonly eventEmitter: EventEmitter2 = new EventEmitter2();
    protected abstract readonly logger: Logger;
    protected abstract readonly operationStateKey: string;

    protected constructor(
        protected readonly configService: ConfigService,
        protected readonly indexerService: IndexerService,
        private readonly operationStateService: OperationStateService,
        protected readonly blockStateService: BlockStateService,
        protected readonly storageService: StorageService,
    ) {}

    async indexTransaction(
        txid: string,
        vin: TransactionInput[],
        vout: TransactionOutput[],
        blockHeight: number,
        blockHash: string,
        blockTime: number,
        batch: BatchWriter,
    ): Promise<void> {
        return this.indexerService.index(
            txid,
            vin,
            vout,
            blockHeight,
            blockHash,
            blockTime,
            batch,
        );
    }

    /**
     * Stores the spent index for a run of txs in a block. Only taproot
     * prevouts are hashed: silent payment outputs are always P2TR.
     */
    saveSpentIndex(
        batch: BatchWriter,
        height: number,
        blockHash: string,
        blockTime: number,
        chunk: number,
        vins: TransactionInput[][],
    ): void {
        const hashes: Buffer[] = [];
        for (const vin of vins) {
            for (const input of vin) {
                if (isP2TR(input.prevOutScript)) {
                    hashes.push(
                        spentOutpointHash(input.txid, input.vout, blockHash),
                    );
                }
            }
        }
        this.storageService.saveSpentIndex(
            batch,
            height,
            chunk,
            blockTime,
            Buffer.concat(hashes),
        );
    }

    async getState(): Promise<OperationState> {
        return (
            await this.operationStateService.getOperationState(
                this.operationStateKey,
            )
        )?.state;
    }

    async setState(
        state: OperationState,
        blockState: { blockHeight: number; blockHash: string },
        batch: BatchWriter,
    ): Promise<void> {
        this.storageService.saveOperationState(
            batch,
            this.operationStateKey,
            state,
        );
        this.storageService.saveBlockState(batch, blockState);
    }

    /**
     * Drops anything indexed above the recorded tip before resuming.
     *
     * A batch commits its partition before the global environment, so a crash
     * in between can leave blocks written that no block-state record claims.
     * Replaying them is harmless on its own, but if the chain reorged while the
     * process was down, traceReorg would see a matching tip, resume, and index
     * the replacement block on top of the originals, which nothing would then
     * ever delete.
     */
    protected async purgeAboveIndexedTip(tipHeight: number): Promise<void> {
        const batch = this.storageService.createBatch();
        try {
            this.storageService.purgeAboveHeight(batch, tipHeight);
            await batch.commit();
        } finally {
            batch.dispose();
        }
    }

    abstract getBlockHash(height: number): Promise<string>;

    /**
     * Fetches a confirmed transaction together with its prevout scripts, or
     * null if it cannot be tweaked (unconfirmed, or a coinbase).
     */
    protected abstract fetchTransactionForTweak(
        txid: string,
    ): Promise<ProviderTransaction | null>;

    /**
     * Derives a transaction's record live from the chain instead of reading it
     * out of the index.
     *
     * The scan tweak is deterministic from the transaction plus its prevouts,
     * so this is bit-identical to what indexing stored, not an approximation.
     * Unlike the rest of the API it can answer for blocks above the indexed
     * tip, since it never consults the index.
     */
    async getTransactionForTweak(
        txid: string,
    ): Promise<TransactionData | null> {
        const tx = await this.fetchTransactionForTweak(txid);
        if (!tx) return null;

        // The index would never hold a pre-activation transaction, so neither
        // does this. Only mainnet has an activation height; every other
        // network is indexed from genesis.
        const isMainnet =
            this.configService.get<BitcoinNetwork>('app.network') ===
            BitcoinNetwork.MAINNET;
        if (isMainnet && tx.blockHeight < BIP352_ACTIVATION_HEIGHT) return null;

        return this.indexerService.buildTransactionData(
            txid,
            tx.vin,
            tx.vout,
            tx.blockHeight,
            tx.blockHash,
            tx.blockTime,
        );
    }

    async traceReorg(): Promise<number> {
        let state = await this.blockStateService.getCurrentBlockState();

        if (!state) return null;

        while (state) {
            const fetchedBlockHash = await this.getBlockHash(state.blockHeight);

            if (state.blockHash === fetchedBlockHash) return state.blockHeight;

            await this.blockStateService.removeState(state);

            this.logger.log(
                `Reorg found at height: ${state.blockHeight}, Wrong hash: ${state.blockHash}, Correct hash: ${fetchedBlockHash}`,
            );
            state = await this.blockStateService.getCurrentBlockState();
        }

        throw new Error('Cannot Reorgs, blockchain state exhausted');
    }
}
