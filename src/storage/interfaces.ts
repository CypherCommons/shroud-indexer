export interface TransactionData {
    id: string; // txid hex (64 chars)
    blockHeight: number;
    blockHash: string; // hex (64 chars)
    blockTime: number; // unix timestamp
    scanTweak: string; // hex (66 chars)
    outputs: OutputData[];
}

export interface OutputData {
    transactionId: string; // txid hex (64 chars)
    vout: number;
    pubKey: string; // hex (64 chars)
    value: number; // satoshis
}

export interface BlockStateData {
    blockHeight: number;
    blockHash: string; // hex (64 chars)
}

export interface OperationStateData {
    id: string;
    state: any;
}

export interface SpentIndexData {
    height: number;
    blockHash: string;
    blockTime: number;
    /** Concatenated 8-byte spent outpoint hashes, hex. */
    hashes: string;
}
