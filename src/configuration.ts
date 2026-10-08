import { join } from 'path';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { camelToSnakeCase } from '@/common/common';
import { Config } from '@/configuration.model';
import { validateSync } from 'class-validator';
import { plainToClass } from 'class-transformer';

const getConfigFilePath = (): string => {
    switch (process.env.NODE_ENV) {
        case 'dev':
            return join(__dirname, 'config', 'dev.config.yaml');
        case 'e2e':
            return join(__dirname, '..', 'config', 'e2e.config.yaml');
        default:
            return join(__dirname, 'config', 'config.yaml');
    }
};

export function mergeEnvVariablesRecursive(
    config: Record<string, any>,
    envVarName = '',
) {
    for (const key of Object.keys(config)) {
        const currentEnvVarName = envVarName
            ? `${envVarName}_${camelToSnakeCase(key)}`
            : camelToSnakeCase(key);
        const currentEnvVarValue = process.env[currentEnvVarName];
        if (config[key] && typeof config[key] === 'object') {
            mergeEnvVariablesRecursive(config[key], currentEnvVarName);
        } else if (typeof currentEnvVarValue !== 'undefined') {
            try {
                config[key] = JSON.parse(currentEnvVarValue);
            } catch {
                config[key] = currentEnvVarValue;
            }
        }
    }
}

export default () => {
    const config = load(readFileSync(getConfigFilePath(), 'utf8')) as Record<
        string,
        any
    >;
    mergeEnvVariablesRecursive(config);

    const validateConfig = plainToClass(Config, config, {
        enableImplicitConversion: true,
    });

    const errors = validateSync(validateConfig, {
        skipMissingProperties: true,
    });

    if (errors.length > 0) {
        throw new Error(errors.toString());
    }

    return config;
};
