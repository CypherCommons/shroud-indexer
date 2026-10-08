import { INestApplication, Logger } from '@nestjs/common';
import { AppModule } from '@/app.module';
import * as Docker from 'dockerode';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { ConfigService } from '@nestjs/config';
import { readFileSync, rmSync } from 'fs';
import * as yaml from 'js-yaml';
import { BitcoinRPCUtil } from '@e2e/helpers/rpc.helper';
import { FileLogger } from '@e2e/file-logger';

async function startBitcoinD(
    configPath = './config/e2e.config.yaml',
): Promise<Docker.Container> {
    const logger = new Logger('Bitcoind');
    let container: Docker.Container;

    const config = yaml.load(readFileSync(configPath, 'utf8')) as Record<
        string,
        any
    >;

    const user = config.bitcoinCore.rpcUser;
    const password = config.bitcoinCore.rpcPass;
    const network = config.app.network;
    const port = config.bitcoinCore.rpcPort;

    try {
        const docker = new Docker();
        const imageName = 'btcpayserver/bitcoin:24.0.1-1';

        const images = await docker.listImages();
        const imageExists = images.some(
            (image) => image.RepoTags && image.RepoTags.includes(imageName),
        );

        // Pull the image if it's not available
        if (!imageExists) {
            logger.log(`Image ${imageName} not found locally. Pulling...`);
            const stream = await docker.pull(imageName);
            await new Promise((resolve, reject) => {
                docker.modem.followProgress(stream, (err, output) =>
                    err ? reject(err) : resolve(output),
                ),
                    (event) => logger.log(event.status);
            });
        }

        // Create and start the container
        container = await docker.createContainer({
            Image: imageName,
            ExposedPorts: { [`${port}/tcp`]: {} }, // Expose the Bitcoin RPC and P2P ports
            HostConfig: {
                PortBindings: {
                    [`${port}/tcp`]: [{ HostPort: `${port}` }],
                },
            },
            Env: [
                `BITCOIN_NETWORK=${network}`,
                `BITCOIN_EXTRA_ARGS=server=1\n
                    rest=1\n
                    rpcbind=0.0.0.0:${port}\n
                    rpcallowip=0.0.0.0/0\n
                    rpcuser=${user}\n
                    rpcpassword=${password}\n
                    debug=0\n
                    logips=1\n
                    logtimemicros=1\n
                    blockmintxfee=0\n
                    deprecatedrpc=signrawtransaction\n
                    listenonion=0\n
                    fallbackfee=0.00001\n
                    txindex=1`,
            ],
        });

        logger.log('Starting bitcoind container...');
        await container.start();

        // Pipe the container logs to the file
        const logs = await container.logs({
            follow: true,
            stdout: true,
            stderr: true,
        });
        logs.pipe(new FileLogger('bitcoind').getWriteStream());

        return container;
    } catch (error) {
        logger.error('Error starting bitcoind container:', error);
        await container.remove({ v: true, force: true });
        throw new Error(error);
    }
}

async function setupTestApp(): Promise<INestApplication> {
    const bitcoinRpc = new BitcoinRPCUtil();
    await bitcoinRpc.waitForBitcoind();

    new Logger('Indexer').log('Starting Indexer...');
    const app = await NestFactory.create(AppModule, {
        logger: new FileLogger('indexer'),
    });
    app.useWebSocketAdapter(new WsAdapter(app));

    const configService = app.get<ConfigService>(ConfigService);
    const port = configService.get<number>('app.port');

    await app.listen(port);

    return app;
}

export async function initialiseDep() {
    // Nothing cleans this up between runs, and a stale partition tree from a
    // run that reached different heights makes boundary behaviour
    // non-deterministic.
    const config = yaml.load(
        readFileSync('./config/e2e.config.yaml', 'utf8'),
    ) as Record<string, any>;
    rmSync(config.db.path, { recursive: true, force: true });

    const bitcoind = await startBitcoinD();
    const app = await setupTestApp();

    return async function shutdownDep() {
        await app.close();
        await bitcoind.stop();
        await bitcoind.remove({ v: true, force: true });
    };
}
