import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { SilentBlocksGateway } from '@/silent-blocks/silent-blocks.gateway';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';

/** Build a fake `ws` client whose send/readyState/bufferedAmount we can drive. */
function fakeClient(overrides: Partial<WebSocket> = {}) {
    return {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send: jest.fn(),
        ...overrides,
    } as unknown as WebSocket;
}

/** A service stub whose stream yields one 8-byte+ frame per height in [from,to]. */
function serviceStub(tip: number): SilentBlocksService {
    return {
        getLatestIndexedBlockHeight: jest.fn().mockResolvedValue(tip),
        async *streamSilentBlocksRange(from: number, to: number) {
            for (let h = from; h <= to; h++) {
                const frame = Buffer.alloc(9);
                frame.writeUInt32BE(h, 0);
                frame.writeUInt32BE(1, 4);
                yield frame;
            }
        },
    } as unknown as SilentBlocksService;
}

/** Split a client's send() calls into binary frames and parsed text controls. */
function classify(send: jest.Mock) {
    const frames: Buffer[] = [];
    const controls: any[] = [];
    for (const [payload] of send.mock.calls) {
        if (typeof payload === 'string') controls.push(JSON.parse(payload));
        else frames.push(payload as Buffer);
    }
    return { frames, controls };
}

describe('SilentBlocksGateway sync stream', () => {
    it('streams one frame per height then a synced control', async () => {
        const gateway = new SilentBlocksGateway(serviceStub(1000));
        const client = fakeClient();

        await gateway.handleSync(client, {
            from: 100,
            to: 104,
        });

        const { frames, controls } = classify(client.send as jest.Mock);
        expect(frames).toHaveLength(5); // heights 100..104
        expect(frames[0].readUInt32BE(0)).toBe(100);
        expect(frames[4].readUInt32BE(0)).toBe(104);
        expect(controls).toEqual([
            {
                event: 'synced',
                data: { from: 100, to: 104, tip: 1000, count: 5 },
            },
        ]);
    });

    it('clamps `to` to the current tip', async () => {
        const gateway = new SilentBlocksGateway(serviceStub(102));
        const client = fakeClient();

        await gateway.handleSync(client, { from: 100, to: 999 });

        const { frames, controls } = classify(client.send as jest.Mock);
        expect(frames).toHaveLength(3); // 100..102 (clamped)
        expect(controls[0]).toEqual({
            event: 'synced',
            data: { from: 100, to: 102, tip: 102, count: 3 },
        });
    });

    it('acks with count 0 when the client is already at tip', async () => {
        const gateway = new SilentBlocksGateway(serviceStub(50));
        const client = fakeClient();

        await gateway.handleSync(client, { from: 100 });

        const { frames, controls } = classify(client.send as jest.Mock);
        expect(frames).toHaveLength(0);
        expect(controls[0]).toEqual({
            event: 'synced',
            data: { from: 100, to: 50, tip: 50, count: 0 },
        });
    });

    it('rejects a missing/invalid `from`', async () => {
        const gateway = new SilentBlocksGateway(serviceStub(1000));
        const client = fakeClient();

        await gateway.handleSync(client, {} as any);

        const { frames, controls } = classify(client.send as jest.Mock);
        expect(frames).toHaveLength(0);
        expect(controls[0].event).toBe('error');
    });

    it('terminates a client that never drains, without acking', async () => {
        jest.useFakeTimers();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(
            () => undefined,
        );
        try {
            const gateway = new SilentBlocksGateway(serviceStub(1000));
            const client = fakeClient({
                bufferedAmount: 8 * 1024 * 1024, // pinned above MAX_BUFFERED_BYTES
            }) as any;
            // Mirror ws: terminate() leaves the socket no longer OPEN.
            client.terminate = jest.fn(() => {
                client.readyState = WebSocket.CLOSED;
            });

            const done = gateway.handleSync(client, { from: 100, to: 200 });
            await jest.advanceTimersByTimeAsync(61_000);
            await done;

            expect(client.terminate).toHaveBeenCalled();
            // Stalled before the first send, so no frames and no `synced` ack.
            expect(client.send).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
            jest.restoreAllMocks();
        }
    });

    it('stops sending once the socket is no longer open', async () => {
        const gateway = new SilentBlocksGateway(serviceStub(1000));
        const client = fakeClient({ readyState: WebSocket.CLOSING });

        await gateway.handleSync(client, { from: 100, to: 200 });

        // Closed before first send: no frames, no synced control.
        expect(client.send as jest.Mock).not.toHaveBeenCalled();
    });

    it('rejects a second concurrent sync on the same socket', async () => {
        // The ws adapter dispatches with mergeMap, so nothing serialises
        // handlers per socket; without a guard the first to finish clears
        // `syncing` and re-admits unframed broadcasts into the second stream.
        const gateway = new SilentBlocksGateway(serviceStub(1000));
        const client = fakeClient();

        const first = gateway.handleSync(client, { from: 100, to: 300 });
        const second = gateway.handleSync(client, { from: 100, to: 300 });
        await Promise.all([first, second]);

        const { controls } = classify(client.send as jest.Mock);
        expect(
            controls.filter((c) => c.event === 'error').map((c) => c.data),
        ).toEqual([
            { message: 'a sync is already in progress on this socket' },
        ]);
        expect(controls.filter((c) => c.event === 'synced')).toHaveLength(1);
    });

    it('streams blocks indexed while the sync was running', async () => {
        // broadcastSilentBlock skips a client in `syncing`, and those heights
        // are past the `to` fixed at sync start — without a catch-up pass they
        // are dropped with no signal to the client.
        const service = serviceStub(102);
        (service.getLatestIndexedBlockHeight as jest.Mock)
            .mockResolvedValueOnce(102) // tip at sync start
            .mockResolvedValue(104); // two blocks landed mid-stream
        const gateway = new SilentBlocksGateway(service);
        const client = fakeClient();

        await gateway.handleSync(client, { from: 100 });

        const { frames, controls } = classify(client.send as jest.Mock);
        expect(frames.map((f) => f.readUInt32BE(0))).toEqual([
            100, 101, 102, 103, 104,
        ]);
        expect(controls[0]).toEqual({
            event: 'synced',
            data: { from: 100, to: 104, tip: 104, count: 5 },
        });
    });

    it('acks with `tip` above `to` when the tip never settles', async () => {
        // A tip advancing every pass (regtest/IBD) must not pin the socket.
        // Bail after the round cap and let the ack tell the client it's behind
        // — `to` must still be a height we actually streamed.
        let tip = 100;
        const service = serviceStub(100);
        (service.getLatestIndexedBlockHeight as jest.Mock).mockImplementation(
            async () => ++tip,
        );
        const gateway = new SilentBlocksGateway(service);
        const client = fakeClient();

        await gateway.handleSync(client, { from: 100 });

        const { frames, controls } = classify(client.send as jest.Mock);
        const heights = frames.map((f) => f.readUInt32BE(0));
        expect(controls[0].event).toBe('synced');
        expect(controls[0].data.tip).toBeGreaterThan(controls[0].data.to);
        expect(heights[heights.length - 1]).toBe(controls[0].data.to);
    });

    it.each([[null], [''], [[]], [false], ['12']])(
        'rejects a non-integer `from` (%p) instead of coercing it to 0',
        async (from) => {
            const gateway = new SilentBlocksGateway(serviceStub(1000));
            const client = fakeClient();

            await gateway.handleSync(client, { from } as any);

            const { frames, controls } = classify(client.send as jest.Mock);
            expect(frames).toHaveLength(0);
            expect(controls[0].event).toBe('error');
        },
    );

    it('releases the sync slot so a later sync can run', async () => {
        const gateway = new SilentBlocksGateway(serviceStub(1000));
        const client = fakeClient();

        await gateway.handleSync(client, { from: 100, to: 101 });
        await gateway.handleSync(client, { from: 102, to: 103 });

        const { controls } = classify(client.send as jest.Mock);
        expect(controls.filter((c) => c.event === 'synced')).toHaveLength(2);
        expect(controls.some((c) => c.event === 'error')).toBe(false);
    });
});
