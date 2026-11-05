import jwt from 'jsonwebtoken';
import { applyPositionRole, POSITION_ROLE_PLACEHOLDER } from './position';

const token = (roles?: unknown) => jwt.sign(roles === undefined ? {} : { roles }, 'secret');

describe('applyPositionRole', () => {
  it('replaces the placeholder with the mcp-role.position.* role', () => {
    const headers = { 'X-MS-API-ROLE': POSITION_ROLE_PLACEHOLDER, Other: 'kept' };
    const accessToken = token(['SQL.Read', 'mcp-role.position.vp-of-sales']);
    expect(applyPositionRole(headers, accessToken)).toEqual({
      'X-MS-API-ROLE': 'mcp-role.position.vp-of-sales',
      Other: 'kept',
    });
  });

  it('resolves to empty when the token has no position role or no token exists', () => {
    const headers = { 'X-MS-API-ROLE': POSITION_ROLE_PLACEHOLDER };
    expect(applyPositionRole(headers, token(['SQL.Read']))).toEqual({ 'X-MS-API-ROLE': '' });
    expect(applyPositionRole(headers, token())).toEqual({ 'X-MS-API-ROLE': '' });
    expect(applyPositionRole(headers, undefined)).toEqual({ 'X-MS-API-ROLE': '' });
    expect(applyPositionRole(headers, 'not-a-jwt')).toEqual({ 'X-MS-API-ROLE': '' });
  });

  it('leaves headers without the placeholder untouched', () => {
    const headers = { 'X-MS-API-ROLE': 'SQL.Read' };
    expect(applyPositionRole(headers, token(['mcp-role.position.laborer']))).toBe(headers);
  });
});
