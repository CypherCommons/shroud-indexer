import { mergeEnvVariablesRecursive } from '@/configuration';

describe('mergeEnvVariablesRecursive', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    const baseConfig = () => ({
        app: { port: 80, debug: true },
        bitcoinCore: { rpcUser: 'polaruser', rpcPass: 'password' },
    });

    it.each(['1.50', 'true', 'null', '12345678901234567890'])(
        'should keep %s as a string for a string setting',
        (value) => {
            process.env.BITCOIN_CORE_RPC_PASS = value;
            const config = baseConfig();

            mergeEnvVariablesRecursive(config);

            expect(config.bitcoinCore.rpcPass).toBe(value);
        },
    );

    it('should still parse numbers and booleans for other settings', () => {
        process.env.APP_PORT = '8080';
        process.env.APP_DEBUG = 'false';
        const config = baseConfig();

        mergeEnvVariablesRecursive(config);

        expect(config.app.port).toBe(8080);
        expect(config.app.debug).toBe(false);
    });
});
