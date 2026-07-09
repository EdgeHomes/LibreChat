import { logger } from '@librechat/data-schemas';
import { getSapphirePool } from './pool';

/**
 * Runs `SELECT 1` against Sapphire to confirm the pool can connect and query.
 * Returns true on success; logs and returns false on failure so callers can
 * degrade gracefully rather than throw.
 */
export const pingSapphire = async (): Promise<boolean> => {
  try {
    const pool = await getSapphirePool();
    await pool.request().query('SELECT 1 AS ok');
    return true;
  } catch (err) {
    logger.error('[sapphire] health check failed', err);
    return false;
  }
};
