import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { validateConfig } from '@/configuration';

const loadConfig = (file: string) =>
    load(readFileSync(join(__dirname, '..', 'config', file), 'utf8')) as Record<
        string,
        any
    >;

describe('validateConfig', () => {
    it.each(['e2e.config.yaml', 'example.config.yaml'])(
        'should accept %s',
        (file) => {
            expect(() => validateConfig(loadConfig(file))).not.toThrow();
        },
    );

    it.each([
        {
            key: 'app.requestRetry.count',
            remove: (config) => delete config.app.requestRetry.count,
        },
        { key: 'app.port', remove: (config) => delete config.app.port },
        { key: 'db.path', remove: (config) => delete config.db.path },
        {
            key: 'bitcoinCore.rpcHost',
            remove: (config) => delete config.bitcoinCore.rpcHost,
        },
        {
            key: 'providerType',
            remove: (config) => delete config.providerType,
        },
    ])('should reject a config without $key', ({ remove }) => {
        const config = loadConfig('e2e.config.yaml');
        remove(config);

        expect(() => validateConfig(config)).toThrow();
    });
});
