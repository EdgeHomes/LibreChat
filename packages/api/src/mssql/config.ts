import { isEnabled, math } from '~/utils';

/** TDS connection settings for the Sapphire MSSQL database used for role checks. */
export interface SapphireDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schema: string;
  /** Encrypt the TDS connection (TLS). Off by default for local dev servers without a certificate. */
  encrypt: boolean;
  /** Trust a self-signed server certificate. Defaults to true so local dev servers connect. */
  trustServerCertificate: boolean;
}

const resolveTrustServerCertificate = (): boolean =>
  process.env.SAPPHIRE_DB_TRUST_SERVER_CERTIFICATE == null
    ? true
    : isEnabled(process.env.SAPPHIRE_DB_TRUST_SERVER_CERTIFICATE);

/** Connection settings resolved from the SAPPHIRE_DB_* environment variables. */
export const sapphireDbConfig: SapphireDbConfig = {
  host: process.env.SAPPHIRE_DB_HOST ?? '',
  port: math(process.env.SAPPHIRE_DB_PORT, 1433),
  user: process.env.SAPPHIRE_DB_USERNAME ?? '',
  password: process.env.SAPPHIRE_DB_PASSWORD ?? '',
  database: process.env.SAPPHIRE_DB_DATABASE ?? 'sapphire',
  schema: process.env.SAPPHIRE_DB_SCHEMA ?? 'dbo',
  encrypt: isEnabled(process.env.SAPPHIRE_DB_ENCRYPT),
  trustServerCertificate: resolveTrustServerCertificate(),
};

/** Whether the minimum Sapphire connection settings are present. */
export const isSapphireConfigured = (): boolean =>
  Boolean(sapphireDbConfig.host && sapphireDbConfig.user && sapphireDbConfig.password);
