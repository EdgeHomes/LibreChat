import jwt from 'jsonwebtoken';

export const POSITION_ROLE_PLACEHOLDER = '{{LIBRECHAT_OBO_POSITION_ROLE}}';
const POSITION_ROLE_PREFIX = 'mcp-role.position.';

/**
 * Picks the user's `mcp-role.position.*` app role from the `roles` claim of the
 * token LibreChat holds for this server (the OBO token). The token is only read,
 * not verified: the downstream server verifies it and rejects a role it lacks.
 */
export const getPositionRole = (accessToken?: string): string => {
  if (!accessToken) {
    return '';
  }
  const payload = jwt.decode(accessToken);
  const roles = payload && typeof payload === 'object' ? payload.roles : undefined;
  if (!Array.isArray(roles)) {
    return '';
  }
  const role = roles.find(
    (value): value is string => typeof value === 'string' && value.startsWith(POSITION_ROLE_PREFIX),
  );
  return role ?? '';
};

/** Replaces `{{LIBRECHAT_OBO_POSITION_ROLE}}` in header values with the token's position role. */
export const applyPositionRole = (
  headers: Record<string, string>,
  accessToken?: string,
): Record<string, string> => {
  const entries = Object.entries(headers);
  if (!entries.some(([, value]) => value.includes(POSITION_ROLE_PLACEHOLDER))) {
    return headers;
  }
  const role = getPositionRole(accessToken);
  return Object.fromEntries(
    entries.map(([key, value]) => [key, value.split(POSITION_ROLE_PLACEHOLDER).join(role)]),
  );
};
