import { TransactionData } from '@/storage/interfaces';
import { SILENT_PAYMENT_BLOCK_TYPE } from '@/common/constants';
import { encodeVarInt, varIntSize } from '@/common/common';

export function getSilentBlockLength(transactions: TransactionData[]): number {
    let length = 1 + varIntSize(transactions.length);
    for (const tx of transactions) {
        length += 65 + varIntSize(tx.outputs.length) + tx.outputs.length * 44;
    }
    return length;
}

export function encodeSilentBlock(transactions: TransactionData[]): Buffer {
    // Producers disagree on order; the bytes are cached immutable, so they can't.
    const ordered = [...transactions].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const block = Buffer.alloc(getSilentBlockLength(ordered));
    let cursor = 0;

    cursor = block.writeUInt8(SILENT_PAYMENT_BLOCK_TYPE, cursor);
    cursor = encodeVarInt(ordered.length, block, cursor);

    for (const tx of ordered) {
        cursor += block.write(tx.id, cursor, 32, 'hex');
        cursor = encodeVarInt(tx.outputs.length, block, cursor);

        for (const output of tx.outputs) {
            cursor = block.writeBigUInt64BE(BigInt(output.value), cursor);
            cursor += block.write(output.pubKey, cursor, 32, 'hex');
            cursor = block.writeUInt32BE(output.vout, cursor);
        }

        cursor += block.write(tx.scanTweak, cursor, 33, 'hex');
    }

    return block;
}
