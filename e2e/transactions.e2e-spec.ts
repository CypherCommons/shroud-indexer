import { UTXO, WalletHelper, AddressType } from '@e2e/helpers/wallet.helper';
import { initialiseDep } from '@e2e/setup';
import { ApiHelper } from '@e2e/helpers/api.helper';
import { btcToSats } from '@/common/common';

describe('TransactionsController (E2E)', () => {
    let apiHelper: ApiHelper;
    let walletHelper: WalletHelper;
    let shutdownDep: () => Promise<void>;

    beforeAll(async () => {
        try {
            shutdownDep = await initialiseDep();
        } catch (e) {
            console.error('Dependencies initialization failed', e);
            throw e;
        }
        walletHelper = new WalletHelper();
        apiHelper = new ApiHelper();

        await walletHelper.initializeWallet();
    });

    afterAll(async () => {
        if (shutdownDep) {
            await shutdownDep();
        }
    });

    it('should retrieve a transaction by block hash', async () => {
        const taprootOutput = walletHelper.generateAddresses(
            1,
            AddressType.P2TR,
        )[0];
        const outputs = walletHelper.generateAddresses(1, AddressType.P2TR);
        const utxo = await walletHelper.addFundToUTXO(outputs[0], 1);
        
        const { txid, blockHash } = await walletHelper.craftAndSendTransaction(
            [{ ...utxo, addressType: AddressType.P2TR, index: 0 }],
            taprootOutput,
            0.5,
            0.001,
        );

        // wait for indexer to catch up
        await new Promise((resolve) => setTimeout(resolve, 15000));
        
        const response = await apiHelper.get(`/transactions/hash/${blockHash}`);
        
        expect(response.status).toBe(200);
        expect(response.data.transactions).toBeDefined();
        expect(response.data.transactions.length).toBeGreaterThan(0);
        expect(response.data.transactions[0].id).toBe(txid);
        expect(response.data.transactions[0].blockHash).toBe(blockHash);
    });

    it('should retrieve a transaction by block height', async () => {
        const blockCount = await walletHelper.getBlockCount();
        const response = await apiHelper.get(`/transactions/height/${blockCount}`);
        
        expect(response.status).toBe(200);
        expect(response.data.transactions).toBeDefined();
    });

    it('should retrieve transactions by height range', async () => {
        const blockCount = await walletHelper.getBlockCount();
        const response = await apiHelper.get(`/transactions/range?startHeight=${blockCount - 1}&endHeight=${blockCount}`);
        
        expect(response.status).toBe(200);
        expect(response.data.transactions).toBeDefined();
    });

    it('should retrieve a transaction by txid', async () => {
        const taprootOutput = walletHelper.generateAddresses(
            1,
            AddressType.P2TR,
        )[0];
        const outputs = walletHelper.generateAddresses(1, AddressType.P2TR);
        const utxo = await walletHelper.addFundToUTXO(outputs[0], 1);
        
        const { txid } = await walletHelper.craftAndSendTransaction(
            [{ ...utxo, addressType: AddressType.P2TR, index: 0 }],
            taprootOutput,
            0.5,
            0.001,
        );

        // wait for indexer
        await new Promise((resolve) => setTimeout(resolve, 15000));
        
        const response = await apiHelper.get(`/transactions/txid/${txid}`);
        
        expect(response.status).toBe(200);
        expect(response.data.transaction).toBeDefined();
        expect(response.data.transaction.id).toBe(txid);
    });

    it('should return 404 for an invalid txid', async () => {
        try {
            await apiHelper.get(`/transactions/txid/0000000000000000000000000000000000000000000000000000000000000000`);
            // should not reach here
            expect(true).toBe(false);
        } catch (error) {
            expect(error.response.status).toBe(404);
        }
    });
});
