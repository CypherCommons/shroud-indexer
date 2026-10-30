import { Test, TestingModule } from '@nestjs/testing';
import { CacheModule } from '@nestjs/cache-manager';
import { TransactionController } from '@/transactions/transactions.controller';
import { TransactionsService } from '@/transactions/transactions.service';
import { StorageService } from '@/storage/storage.service';
import { TransactionData } from '@/storage/interfaces';
import { BadRequestException } from '@nestjs/common';

const mockTransactions: TransactionData[] = [
    {
        id: '1',
        blockHeight: 841744,
        blockHash:
            '0000000000000000000162b9fbce878ab4140c6bf5ea3881f14736a266e4d98d',
        blockTime: 1714634200,
        scanTweak:
            '024ac253c216532e961988e2a8ce266a447c894c781e52ef6cee902361db960004',
        outputs: [
            {
                pubKey: '51203e9fce73d4e77a4809908e3c3a2e54ee147b9312dc5044a193d1fc85de46e3c1',
                vout: 1,
                value: 100000,
                transactionId: '1',
            },
        ],
    },
    {
        id: '2',
        blockHeight: 841744,
        blockHash:
            '0000000000000000000162b9fbce878ab4140c6bf5ea3881f14736a266e4d98d',
        blockTime: 1714634200,
        scanTweak:
            '024ac253c216532e961988e2a8ce266a447c894c781e52ef6cee902361db960004',
        outputs: [
            {
                pubKey: '51203e9fce73d4e77a4809908e3c3a2e54ee147b9312dc5044a193d1fc85de46e3c1',
                vout: 2,
                value: 100000,
                transactionId: '2',
            },
        ],
    },
    {
        id: '3',
        blockHeight: 841745,
        blockHash:
            '000000000000000000030d3be33f251ddeb5d7e480f28970064f594ba9dfb033',
        blockTime: 1714634640,
        scanTweak:
            '024cad5180a093d3af0f49f586bdf37f890920178e68e80561ed53351d0fa499ad',
        outputs: [
            {
                pubKey: '5120f4c2da807f89cb1501f1a77322a895acfb93c28e08ed2724d2beb8e44539ba38',
                vout: 3,
                value: 100000,
                transactionId: '3',
            },
        ],
    },
];

const mockStorageService = {
    getTransactionsByBlockHeight: jest.fn().mockResolvedValue(mockTransactions),
    getTransactionsByBlockHeightRange: jest
        .fn()
        .mockResolvedValue(mockTransactions),
    getTransactionsByBlockHash: jest.fn().mockResolvedValue(mockTransactions),
    getBlockHeightByTimestamp: jest.fn(),
    createBatch: jest.fn(),
    deleteTransactionsByBlockHash: jest.fn(),
};

// Lookup by txid is derived from the chain, not read from storage.
const mockBlockDataProvider = {
    getTransactionForTweak: jest.fn().mockResolvedValue(mockTransactions[0]),
};

describe('TransactionController', () => {
    let controller: TransactionController;
    let transactionsService: TransactionsService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            imports: [CacheModule.register()],
            controllers: [TransactionController],
            providers: [
                TransactionsService,
                {
                    provide: StorageService,
                    useValue: mockStorageService,
                },
                {
                    provide: 'BlockDataProvider',
                    useValue: mockBlockDataProvider,
                },
            ],
        }).compile();

        controller = module.get<TransactionController>(TransactionController);
        transactionsService =
            module.get<TransactionsService>(TransactionsService);
    });

    it('should return transactions by block height', async () => {
        const getTransactionByBlockHeightSpy = jest.spyOn(
            transactionsService,
            'getTransactionByBlockHeight',
        );
        const blockHeight = 841744;

        const controllerResult = await controller.getTransactionByBlockHeight(
            blockHeight,
        );

        expect(getTransactionByBlockHeightSpy).toHaveBeenCalledWith(
            blockHeight,
        );
        expect(controllerResult).toEqual({ transactions: mockTransactions });
    });

    it('should return transactions by block hash', async () => {
        const getTransactionByBlockHashSpy = jest.spyOn(
            transactionsService,
            'getTransactionByBlockHash',
        );

        const blockHash =
            '0000000000000000000162b9fbce878ab4140c6bf5ea3881f14736a266e4d98d';

        const controllerResult = await controller.getTransactionByBlockHash(
            blockHash,
        );

        expect(getTransactionByBlockHashSpy).toHaveBeenCalledWith(blockHash);
        expect(controllerResult).toEqual({
            transactions: mockTransactions,
        });
    });

    it('should return transactions by block height range', async () => {
        const getTransactionsByBlockHeightRangeSpy = jest.spyOn(
            transactionsService,
            'getTransactionsByBlockHeightRange',
        );

        const startHeight = 841744;
        const endHeight = 841745;

        const controllerResult =
            await controller.getTransactionsByBlockHeightRange(
                startHeight,
                endHeight,
            );

        expect(getTransactionsByBlockHeightRangeSpy).toHaveBeenCalledWith(
            startHeight,
            endHeight,
        );
        expect(controllerResult).toEqual({
            transactions: mockTransactions,
        });
    });

    it('should return transaction by txid', async () => {
        const getTransactionByTxidSpy = jest.spyOn(
            transactionsService,
            'getTransactionByTxid',
        );
        const txid =
            '3e9fce73d4e77a4809908e3c3a2e54ee147b9312dc5044a193d1fc85de46e3c1';
        const controllerResult = await controller.getTransactionByTxid(txid);

        expect(getTransactionByTxidSpy).toHaveBeenCalledWith(txid);
        expect(
            mockBlockDataProvider.getTransactionForTweak,
        ).toHaveBeenCalledWith(txid);
        expect(controllerResult).toEqual({ transaction: mockTransactions[0] });
    });

    it.each([
        { description: 'too short', txid: 'abc' },
        { description: 'not hex', txid: 'z'.repeat(64) },
        { description: 'too long', txid: 'a'.repeat(65) },
    ])('should reject a txid that is $description', async ({ txid }) => {
        mockBlockDataProvider.getTransactionForTweak.mockClear();

        await expect(controller.getTransactionByTxid(txid)).rejects.toThrow(
            BadRequestException,
        );
        expect(
            mockBlockDataProvider.getTransactionForTweak,
        ).not.toHaveBeenCalled();
    });

    it.each([
        { description: 'negative', timestamp: -1 },
        { description: 'in milliseconds', timestamp: 1714634200000 },
        { description: 'at the uint32 maximum', timestamp: 0xffffffff },
    ])(
        'should reject a timestamp that is $description',
        async ({ timestamp }) => {
            mockStorageService.getBlockHeightByTimestamp.mockClear();

            await expect(
                controller.getBlockHeightByTimestamp(timestamp),
            ).rejects.toThrow(BadRequestException);
            expect(
                mockStorageService.getBlockHeightByTimestamp,
            ).not.toHaveBeenCalled();
        },
    );
});
