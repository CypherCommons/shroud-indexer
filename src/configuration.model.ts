import {
    IsBoolean,
    IsDefined,
    IsEnum,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUrl,
    Max,
    Min,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BitcoinNetwork, ProviderType } from '@/common/enum';

class DbConfig {
    @IsNotEmpty()
    @IsString()
    path: string;

    @IsInt()
    @Min(1)
    mapSize: number;

    @IsOptional()
    @IsInt()
    @Min(1)
    commitBatchBlocks?: number;
}

class AxiosRetryConfig {
    @IsInt()
    @Min(1)
    count: number;

    @IsInt()
    @Min(500)
    delay: number;
}

class AppConfig {
    @IsInt()
    @Min(1)
    @Max(65535)
    port: number;

    // Interface to bind to. Defaults to 0.0.0.0 when unset (container-friendly);
    // set to 127.0.0.1 when a reverse proxy on the same host is the only client.
    @IsOptional()
    @IsString()
    host?: string;

    @IsEnum(BitcoinNetwork)
    network: BitcoinNetwork;

    @IsDefined()
    @ValidateNested()
    @Type(() => AxiosRetryConfig)
    requestRetry: AxiosRetryConfig;

    @IsOptional()
    @IsBoolean()
    verbose?: boolean;

    @IsOptional()
    @IsBoolean()
    debug?: boolean;
}

class EsploraConfig {
    @IsUrl({
        protocols: ['http', 'https'],
        require_protocol: true,
        require_host: true,
    })
    url: string;

    @IsInt()
    @Min(1)
    @Max(100)
    batchSize: number;
}

export class BitcoinCoreConfig {
    @IsString()
    @IsIn(['http', 'https'])
    protocol: string;

    @IsNotEmpty()
    @IsString()
    rpcHost: string;

    @IsNotEmpty()
    @IsString()
    rpcPass: string;

    @IsNotEmpty()
    @IsString()
    rpcUser: string;

    @IsInt()
    @Min(1)
    @Max(65535)
    rpcPort: number;
}

class CacheConfig {
    @IsInt()
    @Min(1000)
    ttl: number;
}

export class Config {
    @IsDefined()
    @ValidateNested()
    @Type(() => DbConfig)
    db: DbConfig;

    @IsDefined()
    @ValidateNested()
    @Type(() => AppConfig)
    app: AppConfig;

    @IsEnum(ProviderType)
    providerType: ProviderType;

    @ValidateIf((o) => o.providerType === ProviderType.ESPLORA)
    @IsDefined()
    @ValidateNested()
    @Type(() => EsploraConfig)
    esplora: EsploraConfig;

    @ValidateIf((o) => o.providerType === ProviderType.BITCOIN_CORE_RPC)
    @IsDefined()
    @ValidateNested()
    @Type(() => BitcoinCoreConfig)
    bitcoinCore: BitcoinCoreConfig;

    @IsDefined()
    @ValidateNested()
    @Type(() => CacheConfig)
    cache: CacheConfig;
}
