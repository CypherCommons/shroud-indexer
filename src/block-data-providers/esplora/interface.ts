export interface EsploraOperationState {
    currentBlockHeight: number;
    indexedBlockHeight: number;
}

type EsploraTransactionInput = {
    txid: string;
    vout: number;
    prevout: {
        scriptpubkey: string;
        scriptpubkey_asm: string;
        scriptpubkey_type: string;
        scriptpubkey_address: string;
        value: number;
    };
    scriptsig: string;
    scriptsig_asm: string;
    witness: string[];
    is_coinbase: boolean;
    sequence: number;
};

type EsploraTransactionOutput = {
    scriptpubkey: string;
    scriptpubkey_asm: string;
    scriptpubkey_type: string;
    scriptpubkey_address: string;
    value: number;
};

export type EsploraTransaction = {
    txid: string;
    version: number;
    locktime: number;
    vin: EsploraTransactionInput[];
    vout: EsploraTransactionOutput[];
    size: number;
    weight: number;
    fee: number;
    status: {
        confirmed: boolean;
        block_height: number;
        block_hash: string;
        block_time: number;
    };
};
