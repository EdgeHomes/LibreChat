import { logger } from '@librechat/data-schemas';
import { sapphireDbConfig } from './config';
import { getSapphirePool } from './pool';

/** Bracket-quoted schema from config (a trusted identifier, not user input). */
const database = `[${sapphireDbConfig.database}]`;
const schema = `[${sapphireDbConfig.schema}]`;

/**
 * Sapphire users are matched to LibreChat users by the Azure AD object id (the
 * `oid` claim), stored on the LibreChat user as `idOnTheSource` and on the Sapphire
 * side as `UserLogins.ExternalID`. From that user, a role is held when it is
 * assigned either directly via UserAssmts or indirectly through a role group
 * (BSSUserRoleGrp -> RoleGrpAssmts); both queries below union those two paths.
 * `@roleId` matches the stable `Roles.RoleID` code. Matching is case-insensitive
 * because the database collation is CI_AS.
 * ${database} is used even though it's not necessary to future-proof in case we
 * eventually need to use another database.  It can be the case where we need to
 * join multiple databases.
 */
const HAS_ROLE_QUERY = `
SELECT TOP 1 1 AS hasRole
FROM ${database}.${schema}.UserLogins ul
JOIN ${database}.${schema}.BSSUsers u ON u.BSSUserRID = ul.BSSUserRID
WHERE ul.ExternalID = @externalId
  AND ul.Type = 'Office 365'
  AND u.Status = 'Active'
  AND EXISTS (
    SELECT 1
    FROM ${database}.${schema}.UserAssmts ua
    JOIN ${database}.${schema}.Roles r ON r.RoleRID = ua.RoleRID
    WHERE ua.BSSUserRID = u.BSSUserRID
      AND ua.Status in ('New', 'Open')
      AND r.Status in ('New', 'Open', 'Active')
      AND r.RoleID = @roleId
    UNION ALL
    SELECT 1
    FROM ${database}.${schema}.BSSUserRoleGrp urg
    JOIN ${database}.${schema}.RoleGrpAssmts rga ON rga.RoleGrpRID = urg.RoleGrpRID
    JOIN ${database}.${schema}.Roles r2 ON r2.RoleRID = rga.RoleRID
    WHERE urg.BSSUserRID = u.BSSUserRID
      AND urg.Status in ('New', 'Open')
      AND rga.Status in ('New', 'Open')
      AND r2.Status in ('New', 'Open', 'Active')
      AND r2.RoleID = @roleId
  );`;

const USER_ROLES_QUERY = `
SELECT DISTINCT r.RoleID, r.Name
FROM ${database}.${schema}.UserLogins ul
JOIN ${database}.${schema}.BSSUsers u ON u.BSSUserRID = ul.BSSUserRID
JOIN (
    SELECT ua.BSSUserRID, ua.RoleRID
    FROM ${database}.${schema}.UserAssmts ua
    WHERE ua.Status in ('New', 'Open')
    UNION
    SELECT urg.BSSUserRID, rga.RoleRID
    FROM ${database}.${schema}.BSSUserRoleGrp urg
    JOIN ${database}.${schema}.RoleGrpAssmts rga ON rga.RoleGrpRID = urg.RoleGrpRID
    WHERE urg.Status in ('New', 'Open')
      AND rga.Status in ('New', 'Open')
) ur ON ur.BSSUserRID = u.BSSUserRID
JOIN ${database}.${schema}.Roles r ON r.RoleRID = ur.RoleRID
WHERE ul.ExternalID = @externalId
  AND ul.Type = 'Office 365'
  AND r.Status in ('New', 'Open', 'Active')
  AND u.Status = 'Active'
  AND r.RoleID IS NOT NULL
ORDER BY r.RoleID;`;

/** A role assigned to a user: the stable code and its display name. */
export interface SapphireRole {
  id: string;
  name: string;
}

/**
 * Returns true if the Sapphire user identified by their Azure AD object id
 * (`externalId`, i.e. the LibreChat user's `idOnTheSource`) holds the given role
 * (by `Roles.RoleID` code), whether assigned directly or via a role group.
 * Returns false when unknown, unassigned, or on error.
 */
export const userHasRole = async (externalId: string, roleId: string): Promise<boolean> => {
  try {
    const pool = await getSapphirePool();
    const result = await pool
      .request()
      .input('externalId', externalId)
      .input('roleId', roleId)
      .query(HAS_ROLE_QUERY);
    return result.recordset.length > 0;
  } catch (err) {
    logger.error(`[sapphire] userHasRole failed for externalId '${externalId}'`, err);
    return false;
  }
};

/**
 * Returns the distinct set of roles assigned to the user (matched by Azure AD
 * object id), combining direct and role-group assignments. Prefer this over
 * repeated {@link userHasRole} calls when checking a user against several roles.
 * Returns an empty array on error or when the user is unknown.
 */
export const getUserRoles = async (externalId: string): Promise<SapphireRole[]> => {
  try {
    const pool = await getSapphirePool();
    const result = await pool
      .request()
      .input('externalId', externalId)
      .query<{ RoleID: string; Name: string }>(USER_ROLES_QUERY);
    return result.recordset.map((row) => ({ id: row.RoleID, name: row.Name }));
  } catch (err) {
    logger.error(`[sapphire] getUserRoles failed for externalId '${externalId}'`, err);
    return [];
  }
};
