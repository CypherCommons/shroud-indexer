import { TransactionOutput as TransactionOutputEntity } from '@/transactions/transaction-output.entity';
import {
    createTaggedHash,
    extractPubKeyFromScript,
    isP2TR,
} from '@/common/common';
import { publicKeyCombine, publicKeyTweakMul } from 'secp256k1';
import { Injectable } from '@nestjs/common';
import { BatchWriter } from '@/storage/batch-writer';
import { StorageService } from '@/storage/storage.service';
import { TransactionData, OutputData } from '@/storage/interfaces';

export type TransactionInput = {
    txid: string; // transaction id
    vout: number; // output index
    scriptSig: string; // unlocking script
    witness?: string[]; // witness data
    prevOutScript: string; // previous output script
};

export type TransactionOutput = {
    scriptPubKey: string;
    value: number;
};

export type ScanTweakAndOutputs = {
    scanTweak: Buffer;
    eligibleOutputs: TransactionOutputEntity[];
};

@Injectable()
export class IndexerService {
    constructor(private readonly storageService: StorageService) {}

    async index(
        txid: string,
        vin: TransactionInput[],
        vout: TransactionOutput[],
        blockHeight: number,
        blockHash: string,
        blockTime: number,
        batch: BatchWriter,
    ): Promise<TransactionData | null> {
        const transaction = this.buildTransactionData(
            txid,
            vin,
            vout,
            blockHeight,
            blockHash,
            blockTime,
        );
        if (transaction === null) return null;

        this.storageService.saveTransaction(batch, transaction);
        return transaction;
    }

    /**
     * Derives the stored record for a transaction, or null if it is not an
     * eligible silent-payment transaction.
     *
     * Shared by the block-indexing path and the live txid lookup so that a
     * record derived on demand is bit-identical to the one that was stored:
     * the scan tweak is a pure function of the transaction and its prevouts,
     * but only if both callers compute it the same way.
     */
    public buildTransactionData(
        txid: string,
        vin: TransactionInput[],
        vout: TransactionOutput[],
        blockHeight: number,
        blockHash: string,
        blockTime: number,
    ): TransactionData | null {
        const scanResult = this.deriveOutputsAndComputeScanTweak(vin, vout);
        if (scanResult === null) return null;

        const { scanTweak, eligibleOutputs } = scanResult;

        const outputs: OutputData[] = eligibleOutputs.map((out) => ({
            transactionId: txid,
            vout: out.vout,
            pubKey: out.pubKey,
            value: out.value,
        }));

        return {
            id: txid,
            blockHeight,
            blockHash,
            blockTime,
            scanTweak: scanTweak.toString('hex'),
            outputs,
        };
    }

    public deriveOutputsAndComputeScanTweak(
        vin: TransactionInput[],
        vout: TransactionOutput[],
    ): ScanTweakAndOutputs | null {
        const eligibleOutputs: TransactionOutputEntity[] = [];

        // verify if the transaction contains at least one BIP341 P2TR output
        // this output could be a potential silent pay
        let n = 0;
        for (const output of vout) {
            if (isP2TR(output.scriptPubKey)) {
                const outputEntity = TransactionOutputEntity.fromOutput(
                    output,
                    n,
                );

                eligibleOutputs.push(outputEntity);
            }
            n++;
        }

        if (eligibleOutputs.length === 0) return null;

        // verify that the transaction does not spend an output with SegWit version > 1
        // this would make the transaction invalid for silent payment v0
        for (const input of vin) {
            // grab the first op code of the prevOutScript
            const firstOpCode = parseInt(input.prevOutScript.slice(0, 2), 16);
            // if the first op code is in the range OP_2-OP_16 (0x52-0x60)
            // then the transaction is ineligible
            if (0x52 <= firstOpCode && firstOpCode <= 0x60) return null;
        }

        // extract the input public keys from the transaction
        const pubKeys: Buffer[] = [];
        for (const input of vin) {
            const pubKey = extractPubKeyFromScript(
                Buffer.from(input.prevOutScript, 'hex'),
                Buffer.from(input.scriptSig, 'hex'),
                input.witness?.map((w) => Buffer.from(w, 'hex')),
            );
            if (pubKey) pubKeys.push(pubKey);
        }

        if (pubKeys.length === 0) return null;

        const smallestOutpoint = this.getSmallestOutpoint(vin);

        let sumOfPublicKeys: Buffer;
        try {
            sumOfPublicKeys = Buffer.from(publicKeyCombine(pubKeys, true));
        } catch (error) {
            // if sumOfPublicKeys is the point at infinity(not valid), skip the transaction
            // https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki#scanning
            if (error.message === 'The sum of the public keys is not valid') {
                return null;
            }
            throw error;
        }

        const inputHash = createTaggedHash(
            'BIP0352/Inputs',
            Buffer.concat([smallestOutpoint, sumOfPublicKeys]),
        );

        // A * inputHash
        const scanTweak = Buffer.from(
            publicKeyTweakMul(sumOfPublicKeys, inputHash, true),
        );

        return { scanTweak, eligibleOutputs };
    }

    private getSmallestOutpoint(vins: TransactionInput[]): Buffer {
        const outpoints = vins.map((vin) => {
            const n = Buffer.alloc(4);
            n.writeUInt32LE(vin.vout);
            return Buffer.concat([Buffer.from(vin.txid, 'hex').reverse(), n]);
        });

        let smallest = outpoints[0];
        for (const outpoint of outpoints) {
            if (outpoint.compare(smallest) < 0) smallest = outpoint;
        }
        return smallest;
    }
}
