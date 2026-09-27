import { UTXO, WalletHelper, AddressType } from '@e2e/helpers/wallet.helper';
import { transactionToEntity } from '@e2e/helpers/common.helper';
import { initialiseDep } from '@e2e/setup';
import { ApiHelper } from '@e2e/helpers/api.helper';
import { encodeSilentBlock } from '@/silent-blocks/silent-block-encoder';

describe('Indexer', () => {
    let apiHelper: ApiHelper;
    let walletHelper: WalletHelper;
    let shutdownDep: () => Promise<void>;

    beforeAll(async () => {
        shutdownDep = await initialiseDep();
        walletHelper = new WalletHelper();
        apiHelper = new ApiHelper();

        await walletHelper.initializeWallet();
    });

    afterAll(async () => {
        await shutdownDep();
    });

    it.each(Object.values<AddressType>(AddressType))(
        '%s - should ensure that the correct silent block is fetched',
        async (addressType) => {
            const taprootOutput = walletHelper.generateAddresses(
                1,
                AddressType.P2TR,
            )[0];
            const outputs = walletHelper.generateAddresses(6, addressType);
            const utxos: UTXO[] = [];

            for (const [index, output] of outputs.entries()) {
                const utxo: UTXO = {
                    ...(await walletHelper.addFundToUTXO(output, 1)),
                    addressType,
                    index,
                };
                utxos.push(utxo);
            }

            const { transaction, txid, blockHash } =
                await walletHelper.craftAndSendTransaction(
                    utxos,
                    taprootOutput,
                    5.999,
                    0.001,
                );

            const blockCount = await walletHelper.getBlockCount();
            const transformedTransaction = transactionToEntity(
                transaction,
                txid,
                blockHash,
                blockCount,
                outputs,
            );

            const silentBlock = encodeSilentBlock([transformedTransaction]);

            // remove this once Web Socket is implemented
            await new Promise((resolve) => setTimeout(resolve, 15000));
            const response = await apiHelper.get(
                `/silent-block/hash/${blockHash}`,
                {
                    responseType: 'arraybuffer',
                },
            );

            expect(response.data).toEqual(silentBlock);
        },
    );
});
