import { ConnectionPool } from 'mssql';
import { logger } from '@librechat/data-schemas';
import type { config as SqlConfig } from 'mssql';
import { sapphireDbConfig } from './config';

/** Single connected pool shared by all callers, created lazily on first use. */
let poolPromise: Promise<ConnectionPool> | null = null;

const buildConfig = (): SqlConfig => ({
  server: sapphireDbConfig.host,
  port: sapphireDbConfig.port,
  user: sapphireDbConfig.user,
  password: sapphireDbConfig.password,
  database: sapphireDbConfig.database,
  options: {
    encrypt: sapphireDbConfig.encrypt,
    trustServerCertificate: sapphireDbConfig.trustServerCertificate,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
});

/**
 * Returns the connected Sapphire pool, creating and caching it on first use so
 * concurrent callers await the same connection. A failed attempt is cleared so
 * the next call retries rather than reusing a rejected promise.
 */
export const getSapphirePool = (): Promise<ConnectionPool> => {
  if (poolPromise) {
    return poolPromise;
  }

  poolPromise = (async () => {
    const pool = new ConnectionPool(buildConfig());
    pool.on('error', (err) => {
      logger.error('[sapphire] pool error', err);
    });
    await pool.connect();
    logger.info(`[sapphire] connected (${sapphireDbConfig.database})`);
    return pool;
  })();

  return poolPromise.catch((err) => {
    poolPromise = null;
    throw err;
  });
};

/** Closes the Sapphire pool. Intended for graceful shutdown and test teardown. */
export const closeSapphirePool = async (): Promise<void> => {
  if (!poolPromise) {
    return;
  }
  const pending = poolPromise;
  poolPromise = null;
  try {
    await (await pending).close();
  } catch (err) {
    logger.error('[sapphire] error closing pool', err);
  }
};
