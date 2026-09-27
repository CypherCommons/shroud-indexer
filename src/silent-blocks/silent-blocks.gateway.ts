import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import {
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
    SubscribeMessage,
    MessageBody,
    ConnectedSocket,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';

// Pause the height cursor while the socket's outbound buffer is above this, so a
// slow client can't make the server buffer the whole range in memory.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

// A client that drains nothing at all for this long is treated as dead. Any
// progress at all drops it under the threshold, so this only catches sockets
// the kernel has not yet given up on (half-open connections retry for minutes).
const STALL_TIMEOUT_MS = 60_000;

// Extra passes handleSync will make to pick up blocks indexed while it was
// streaming. Bounded so a client syncing during a fast catch-up (regtest, IBD)
// can't hold the socket indefinitely — it just gets a `synced` ack whose `tip`
// is above `to` and syncs again.
const MAX_CATCHUP_ROUNDS = 3;

interface SyncRequest {
    from?: number;
    to?: number;
}

@Injectable()
@WebSocketGateway()
export class SilentBlocksGateway
    implements OnGatewayConnection, OnGatewayDisconnect
{
    private readonly logger = new Logger(SilentBlocksGateway.name);

    @WebSocketServer() server: Server;

    // Clients mid-backfill: a bare tip broadcast would desync their frame parser.
    private readonly syncing = new Set<WebSocket>();

    constructor(
        @Inject(forwardRef(() => SilentBlocksService))
        private readonly silentBlocksService: SilentBlocksService,
    ) {}

    handleConnection(client: WebSocket) {
        const remoteAddress = (client as any)._socket.remoteAddress;
        this.logger.debug(`Client connected: ${remoteAddress}`);
    }

    handleDisconnect(client: WebSocket) {
        this.syncing.delete(client);
        const remoteAddress = (client as any)._socket.remoteAddress;
        this.logger.debug(`Client disconnected: ${remoteAddress}`);
    }

    /**
     * Stream a contiguous range of binary silent blocks over the socket.
     *
     * Control in (text): { event: 'sync', data: { from, to? } }
     * Data out (binary): one `height|len|blob` frame per message.
     * Done out (text):   { event: 'synced', data: { from, to, tip, count } }
     * Error out (text):  { event: 'error',  data: { message } }
     *
     * One connection carries the whole backfill, so the ~1.5s tunnel round-trip is
     * paid once per sync session instead of once per 200-block chunk.
     */
    @SubscribeMessage('sync')
    async handleSync(
        @ConnectedSocket() client: WebSocket,
        @MessageBody() data: SyncRequest,
    ): Promise<void> {
        // The ws adapter dispatches messages with `mergeMap`, so nothing
        // serialises handlers per socket. Two overlapping syncs would interleave
        // frames and the first to finish would clear `syncing`, re-admitting
        // unframed broadcasts into the other's stream.
        if (this.syncing.has(client)) {
            this.sendControl(client, 'error', {
                message: 'a sync is already in progress on this socket',
            });
            return;
        }
        this.syncing.add(client);

        try {
            // Number() coerces null/''/[]/false to 0, which would silently turn
            // a junk cursor into a full sync from genesis.
            const from = data?.from;
            if (!Number.isInteger(from) || from < 0) {
                this.sendControl(client, 'error', {
                    message: 'sync requires a non-negative integer `from`',
                });
                return;
            }

            let tip =
                await this.silentBlocksService.getLatestIndexedBlockHeight();
            if (data?.to != null && !Number.isInteger(data.to)) {
                this.sendControl(client, 'error', {
                    message: '`to` must be an integer',
                });
                return;
            }
            let to = Math.min(data?.to ?? tip, tip);

            if (to < from) {
                // Nothing to send (client already at/above tip) — still ack.
                this.sendControl(client, 'synced', { from, to, tip, count: 0 });
                return;
            }

            // A block indexed while we stream falls past `to`, and
            // broadcastSilentBlock skips this client for as long as it's in
            // `syncing` — so it would be dropped with no signal. Re-read the
            // tip after each pass and stream the delta. Nothing awaits between
            // the final tip read and `syncing.delete` in the `finally`, so a
            // broadcast can't slip through that gap.
            let count = 0;
            let cursor = from;

            let round = 0;

            for (;;) {
                for await (const frame of this.silentBlocksService.streamSilentBlocksRange(
                    cursor,
                    to,
                )) {
                    if (client.readyState !== WebSocket.OPEN) return; // client gone
                    await this.awaitDrain(client);
                    if (client.readyState !== WebSocket.OPEN) return;
                    client.send(frame, { binary: true });
                    count++;
                }

                cursor = to + 1;
                tip =
                    await this.silentBlocksService.getLatestIndexedBlockHeight();
                const nextTo = Math.min(data?.to ?? tip, tip);
                // `to` only moves when another pass will actually run, so the
                // ack never claims a height we didn't stream.
                if (nextTo < cursor || ++round > MAX_CATCHUP_ROUNDS) break;
                to = nextTo;
            }

            // `to < tip` here means the rounds ran out — the ack tells the
            // client it's still behind so it can sync again.
            this.sendControl(client, 'synced', { from, to, tip, count });
        } catch (err) {
            this.logger.error(
                `sync stream failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            this.sendControl(client, 'error', {
                message: err instanceof Error ? err.message : 'sync failed',
            });
        } finally {
            this.syncing.delete(client);
        }
    }

    @SubscribeMessage('ping')
    handlePing(@ConnectedSocket() client: WebSocket): void {
        this.sendControl(client, 'pong', null);
    }

    broadcastSilentBlock(silentBlock: Buffer) {
        for (const client of this.server.clients) {
            if (this.syncing.has(client)) continue;
            if (client.readyState === WebSocket.OPEN) {
                client.send(silentBlock);
            }
        }
    }

    private sendControl(client: WebSocket, event: string, data: unknown): void {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ event, data }));
        }
    }

    // The deadline is per call, so a slow-but-progressing client gets a fresh
    // budget for every frame; only a total stall runs it out.
    private async awaitDrain(client: WebSocket): Promise<void> {
        const deadline = Date.now() + STALL_TIMEOUT_MS;
        let delay = 5;

        while (
            client.readyState === WebSocket.OPEN &&
            client.bufferedAmount > MAX_BUFFERED_BYTES
        ) {
            if (Date.now() > deadline) {
                this.logger.warn(
                    `Terminating client stalled at ${client.bufferedAmount} buffered bytes for ${STALL_TIMEOUT_MS}ms`,
                );
                client.terminate();
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, 100);
        }
    }
}
