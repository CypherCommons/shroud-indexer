import { UTXO, WalletHelper, AddressType } from '@e2e/helpers/wallet.helper';
import { initialiseDep } from '@e2e/setup';
import { ApiHelper } from '@e2e/helpers/api.helper';
import { BitcoinRPCUtil } from '@e2e/helpers/rpc.helper';

describe('Reorg Handling (E2E)', () => {
    let apiHelper: ApiHelper;
    let walletHelper: WalletHelper;
    let rpcHelper: BitcoinRPCUtil;
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
        rpcHelper = new BitcoinRPCUtil();

        await walletHelper.initializeWallet();
    });

    afterAll(async () => {
        if (shutdownDep) {
            await shutdownDep();
        }
    });

    it('should handle a blockchain reorganization', async () => {
        const taprootOutput = walletHelper.generateAddresses(
            1,
            AddressType.P2TR,
        )[0];
        const outputs = walletHelper.generateAddresses(1, AddressType.P2TR);
        const utxo = await walletHelper.addFundToUTXO(outputs[0], 1);
        
        // Broadcast tx and mine Block A
        const { txid, blockHash: originalBlockHash } = await walletHelper.craftAndSendTransaction(
            [{ ...utxo, addressType: AddressType.P2TR, index: 0 }],
            taprootOutput,
            0.5,
            0.001,
        );

        // wait for indexer to index Block A
        await new Promise((resolve) => setTimeout(resolve, 15000));
        
        // Verify transaction is indexed
        let response = await apiHelper.get(`/transactions/hash/${originalBlockHash}`);
        expect(response.status).toBe(200);
        expect(response.data.transactions).toBeDefined();
        expect(response.data.transactions.length).toBeGreaterThan(0);
        expect(response.data.transactions[0].id).toBe(txid);

        // Invalidate Block A
        await rpcHelper.invalidateBlock(originalBlockHash);

        // Mine 2 new blocks to make a new longest chain
        // The previous transaction will NOT be in these blocks because we didn't re-broadcast it to mempool
        // Actually, it might be in the mempool and get mined again. But let's just generate blocks.
        const newAddress = await rpcHelper.getNewAddress();
        await rpcHelper.mineToAddress(2, newAddress);

        // Wait for indexer to process reorg
        await new Promise((resolve) => setTimeout(resolve, 20000));

        // The transaction should no longer be associated with the old block hash.
        try {
            // Note: Since block was invalidated, getting by old hash might return empty or 404 depending on indexer logic
            const oldHashResponse = await apiHelper.get(`/transactions/hash/${originalBlockHash}`);
            expect(oldHashResponse.data.transactions.length).toBe(0);
        } catch (e) {
            // If it throws 404 it's also fine
            if (e.response && e.response.status === 404) {
                expect(e.response.status).toBe(404);
            } else {
                throw e;
            }
        }
    }, 60000);
});
