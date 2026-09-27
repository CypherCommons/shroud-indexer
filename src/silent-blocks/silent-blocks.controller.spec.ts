import { Test, TestingModule } from '@nestjs/testing';
import { CacheInterceptor, CacheModule } from '@nestjs/cache-manager';
import { SilentBlocksController } from '@/silent-blocks/silent-blocks.controller';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';
import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import { INestApplication } from '@nestjs/common';
import { silentBlockSpanRange } from '@/storage/key-encoding';
import * as request from 'supertest';

describe('SilentBlocksController', () => {
    let controller: SilentBlocksController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            imports: [CacheModule.register()],
            controllers: [SilentBlocksController],
            providers: [
                {
                    provide: SilentBlocksService,
                    useValue: {
                        streamSilentBlocksRange: jest.fn(),
                        getSilentBlockByHeight: jest.fn(),
                        getSilentBlockByHash: jest.fn(),
                        getLatestIndexedBlockHeight: jest.fn(),
                    },
                },
            ],
        }).compile();

        controller = module.get<SilentBlocksController>(SilentBlocksController);
    });

    it('should throttle the range endpoint', () => {
        const metadata = Reflect.getMetadata(
            THROTTLER_SKIP + 'default',
            controller.getSilentBlocksRange,
        );
        expect(metadata).toBeUndefined();
    });

    it('should NOT have CacheInterceptor on getSilentBlockByHeight', () => {
        const interceptors = Reflect.getMetadata(
            '__interceptors__',
            controller.getSilentBlockByHeight,
        );
        const hasCacheInterceptor = (interceptors ?? []).some(
            (i: any) =>
                i === CacheInterceptor || i?.name === 'CacheInterceptor',
        );
        expect(hasCacheInterceptor).toBe(false);
    });

    it('should NOT have CacheInterceptor on getSilentBlockByHash', () => {
        const interceptors = Reflect.getMetadata(
            '__interceptors__',
            controller.getSilentBlockByHash,
        );
        const hasCacheInterceptor = (interceptors ?? []).some(
            (i: any) =>
                i === CacheInterceptor || i?.name === 'CacheInterceptor',
        );
        expect(hasCacheInterceptor).toBe(false);
    });
});

describe('SilentBlocksController height bounds and streaming', () => {
    let app: INestApplication;
    let service: {
        getLatestIndexedBlockHeight: jest.Mock;
        streamSilentBlocksRange: jest.Mock;
        getSilentBlockByHeight: jest.Mock;
        getSilentBlockByHash: jest.Mock;
    };

    beforeEach(async () => {
        service = {
            getLatestIndexedBlockHeight: jest.fn().mockResolvedValue(1000),
            // Exercise the real key encoder: an out-of-uint32 height throws
            // from writeUInt32BE, which is what used to surface as a 500.
            streamSilentBlocksRange: jest.fn(async function* (
                from: number,
                to: number,
            ) {
                silentBlockSpanRange(from, to);
                for (let h = from; h <= to; h++) {
                    const frame = Buffer.alloc(9);
                    frame.writeUInt32BE(h, 0);
                    frame.writeUInt32BE(1, 4);
                    yield frame;
                }
            }),
            getSilentBlockByHeight: jest
                .fn()
                .mockResolvedValue(Buffer.alloc(2)),
            getSilentBlockByHash: jest.fn().mockResolvedValue(Buffer.alloc(2)),
        };

        const module: TestingModule = await Test.createTestingModule({
            imports: [CacheModule.register()],
            controllers: [SilentBlocksController],
            providers: [{ provide: SilentBlocksService, useValue: service }],
        }).compile();

        app = module.createNestApplication();
        await app.init();
    });

    afterEach(async () => {
        await app.close();
    });

    it.each([
        ['startHeight=5000000000&endHeight=5000000000', 'above uint32'],
        [
            'startHeight=4294967295&endHeight=4294967295',
            'endHeight + 1 overflow',
        ],
    ])('rejects an out-of-range /range (%s) with 400, not 500', async (qs) => {
        const res = await request(app.getHttpServer()).get(
            `/silent-block/range?${qs}`,
        );
        expect(res.status).toBe(400);
    });

    it('rejects a negative height with 400, not 500', async () => {
        const res = await request(app.getHttpServer()).get(
            '/silent-block/height/-1',
        );
        expect(res.status).toBe(400);
        expect(service.getSilentBlockByHeight).not.toHaveBeenCalled();
    });

    it('404s a height above the indexed tip instead of serving an empty block', async () => {
        // An unindexed height encodes to the same 2 bytes as an empty block,
        // so serving it reads as "no payments here".
        const res = await request(app.getHttpServer()).get(
            '/silent-block/height/1001',
        );
        expect(res.status).toBe(404);
        expect(service.getSilentBlockByHeight).not.toHaveBeenCalled();
    });

    it('serves a height at the indexed tip', async () => {
        const res = await request(app.getHttpServer()).get(
            '/silent-block/height/1000',
        );
        expect(res.status).toBe(200);
        expect(service.getSilentBlockByHeight).toHaveBeenCalledWith(1000);
    });

    it('clamps endHeight to the indexed tip', async () => {
        service.getLatestIndexedBlockHeight.mockResolvedValue(1005);
        await request(app.getHttpServer()).get(
            '/silent-block/range?startHeight=1000&endHeight=1100',
        );
        expect(service.streamSilentBlocksRange).toHaveBeenCalledWith(
            1000,
            1005,
        );
    });

    it('does not end a truncated range cleanly when the stream throws', async () => {
        service.streamSilentBlocksRange.mockImplementation(
            // eslint-disable-next-line require-yield
            async function* () {
                yield Buffer.alloc(9);
                throw new Error('lmdb read failed');
            },
        );

        const outcome = await request(app.getHttpServer())
            .get('/silent-block/range?startHeight=0&endHeight=10')
            .then(
                (res) => ({ ok: true as const, status: res.status }),
                (err) => ({ ok: false as const, message: String(err.message) }),
            );

        // The socket is destroyed rather than end()ed, so the client sees a
        // transport error instead of a complete-looking short body.
        expect(outcome.ok).toBe(false);
    });
});
