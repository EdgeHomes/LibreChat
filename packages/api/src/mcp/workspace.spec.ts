import os from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { MCPOptionsSchema } from 'librechat-data-provider';
import type { McpFileArtifact, MCPToolCallResponse } from './types';
import type { MCPFilePrincipal } from './workspace';
import {
  getMCPFileWorkspace,
  resolveMCPFileWorkspace,
  prepareMCPFileWorkspace,
  bindMCPWorkspaceFiles,
  cleanupMCPWorkspaceFile,
  sweepMCPFileWorkspaces,
} from './workspace';
import {
  canUseAppConnection,
  requiresUserScopedConnection,
  hasRuntimeContextPlaceholders,
} from './utils';
import { formatToolContent } from './parsers';
import { processMCPEnv } from '~/utils/env';

const alice = { id: 'alice', tenantId: 'tenant-a' };
const bob = { id: 'bob', tenantId: 'tenant-a' };
const applications = ['wordcraft', 'gridcraft', 'deckcraft', 'pdfcraft'];
let base: string;
function config(extra = {}) {
  return MCPOptionsSchema.parse({
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'wordcraft-edge-mcp', '--compact', '--root', '/shared-old'],
    fileWorkspace: { root: base, ...extra },
  });
}
async function workspace(user: MCPFilePrincipal = alice, options = config()) {
  const resolved = resolveMCPFileWorkspace(options, user);
  await prepareMCPFileWorkspace(resolved);
  const root = getMCPFileWorkspace(options, user);
  if (!root) {
    throw new Error('missing test workspace');
  }
  return fs.realpath(root);
}
async function artifact(options = config(), user = alice, filename = 'Proposal.docx') {
  const root = await workspace(user, options);
  const output = path.join(root, filename);
  await fs.writeFile(output, 'original-output');
  const file: McpFileArtifact = {
    filename,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data: Buffer.from('original-output').toString('base64'),
  };
  const result: MCPToolCallResponse = {
    content: [
      { type: 'text', text: JSON.stringify({ path: output }) },
      {
        type: 'resource',
        resource: { uri: `file:///${filename}`, mimeType: file.mimeType, blob: file.data },
      },
    ],
  };
  const formatted = await bindMCPWorkspaceFiles(
    formatToolContent(result, 'openai'),
    result,
    options,
    user,
    'wordcraft',
  );
  const bound = formatted[1]?.mcp_files?.[0];
  if (!bound) {
    throw new Error('missing bound test file');
  }
  return { output, file: bound, root };
}
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-mcp-workspace-'));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

it('derives distinct user and tenant roots without trusting path fragments or custom variables', () => {
  const options = config();
  const root = getMCPFileWorkspace(options, alice);
  expect(root).not.toEqual(getMCPFileWorkspace(options, bob));
  expect(root).not.toEqual(getMCPFileWorkspace(options, { ...alice, tenantId: 'tenant-b' }));
  expect(path.dirname(getMCPFileWorkspace(options, { id: '../../bob' }) ?? '')).toEqual(base);
  const runtime = processMCPEnv({
    options,
    user: alice,
    customUserVars: { LIBRECHAT_USER_ID: 'bob', ROOT: '/etc' },
  });
  expect(runtime).toMatchObject({
    args: ['-y', 'wordcraft-edge-mcp', '--compact', '--root', root],
    cwd: root,
    fileInputDir: root,
  });
  expect(options).toMatchObject({ args: expect.arrayContaining(['/shared-old']) });
});

it.each(applications)(
  'forces %s into a user-scoped process and refuses an app-shared connection',
  (name) => {
    const options = MCPOptionsSchema.parse({
      type: 'stdio',
      command: 'npx',
      args: ['-y', `${name}-edge-mcp`],
      fileWorkspace: { root: base },
    });
    expect(requiresUserScopedConnection(options)).toBe(true);
    expect(canUseAppConnection(options)).toBe(false);
    expect(hasRuntimeContextPlaceholders(options)).toBe(true);
    expect(() => resolveMCPFileWorkspace(options)).toThrow('authenticated user');
    const a = resolveMCPFileWorkspace(options, alice);
    const b = resolveMCPFileWorkspace(options, bob);
    expect(a).not.toEqual(b);
    expect(a).toMatchObject({ cwd: getMCPFileWorkspace(options, alice) });
  },
);

it('preserves legacy servers and refuses untrusted sources or conflicting automation authority', () => {
  const legacy = MCPOptionsSchema.parse({ command: 'npx', args: [], fileInputDir: base });
  expect(resolveMCPFileWorkspace(legacy)).toBe(legacy);
  expect(canUseAppConnection(legacy)).toBe(true);
  for (const source of ['user', 'plugin']) {
    expect(() => resolveMCPFileWorkspace({ ...config(), source }, alice)).toThrow('operator');
  }
  expect(() => processMCPEnv({ options: config(), user: alice, dbSourced: true })).toThrow(
    'User-defined',
  );
  const options = config();
  if (!('command' in options)) {
    throw new Error('test configuration');
  }
  expect(() =>
    resolveMCPFileWorkspace({ ...options, args: ['--automation-read-root', '/'] }, alice),
  ).toThrow('cannot combine');
  expect(() => resolveMCPFileWorkspace({ ...options, args: ['--root'] }, alice)).toThrow('operand');
});

it('provisions private identity directories, with no fallback for missing bases or symlink leaves', async () => {
  const options = config();
  const resolved = resolveMCPFileWorkspace(options, alice);
  await prepareMCPFileWorkspace(resolved);
  const root = await workspace();
  expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(path.join(root, 'inputs'))).mode & 0o777).toBe(0o700);
  await expect(prepareMCPFileWorkspace(options)).rejects.toThrow('not resolved');
  const absent = MCPOptionsSchema.parse({
    command: 'npx',
    args: [],
    fileWorkspace: { root: path.join(base, 'missing') },
  });
  await expect(prepareMCPFileWorkspace(resolveMCPFileWorkspace(absent, alice))).rejects.toThrow();
  const bRoot = getMCPFileWorkspace(options, bob);
  if (!bRoot) {
    throw new Error('test root');
  }
  await fs.symlink(root, bRoot);
  await expect(prepareMCPFileWorkspace(resolveMCPFileWorkspace(options, bob))).rejects.toThrow(
    'symlink',
  );
});

it('binds the actual resource to its owner and deletes only that source after delivery', async () => {
  const options = config();
  const { output, file } = await artifact(options);
  expect(file.workspace?.path).toBe(output);
  await expect(cleanupMCPWorkspaceFile({ wordcraft: options }, bob, file)).resolves.toBe(false);
  expect(await fs.readFile(output, 'utf8')).toBe('original-output');
  await expect(cleanupMCPWorkspaceFile({ wordcraft: options }, alice, file)).resolves.toBe(true);
  await expect(fs.stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('leaves uploaded inputs, changed files and explicitly retained outputs intact', async () => {
  const options = config();
  const { output, file, root } = await artifact(options);
  await fs.writeFile(output, 'changed-output!');
  expect(await cleanupMCPWorkspaceFile({ wordcraft: options }, alice, file)).toBe(false);
  const input = path.join(root, 'inputs', 'Original.docx');
  await fs.writeFile(input, 'original-output');
  const upload = { ...file, workspace: { serverName: 'wordcraft', path: input } };
  expect(await cleanupMCPWorkspaceFile({ wordcraft: options }, alice, upload)).toBe(false);
  await fs.writeFile(output, 'original-output');
  expect(
    await cleanupMCPWorkspaceFile(
      { wordcraft: config({ cleanupAfterDelivery: false }) },
      alice,
      file,
    ),
  ).toBe(false);
  expect(await fs.readFile(input, 'utf8')).toBe('original-output');
});

it('refuses symlinked files, foreign known paths and unbound resources as cleanup targets', async () => {
  const options = config();
  const { output, file, root } = await artifact(options);
  const otherRoot = await workspace(bob);
  const other = path.join(otherRoot, 'Other.docx');
  await fs.writeFile(other, 'original-output');
  await fs.unlink(output);
  await fs.symlink(other, output);
  expect(await cleanupMCPWorkspaceFile({ wordcraft: options }, alice, file)).toBe(false);
  const result: MCPToolCallResponse = {
    content: [{ type: 'text', text: JSON.stringify({ path: other }) }],
  };
  const bound = await bindMCPWorkspaceFiles(
    ['ok', { mcp_files: [file] }],
    result,
    options,
    alice,
    'wordcraft',
  );
  // Ignore any metadata already present in the test file: real parsers construct plain artifacts.
  expect(bound[1]?.mcp_files?.[0].workspace?.path).not.toBe(other);
  expect(await fs.readFile(other, 'utf8')).toBe('original-output');
  const unbound = { ...file };
  delete unbound.workspace;
  expect(await cleanupMCPWorkspaceFile({ wordcraft: options }, alice, unbound)).toBe(false);
  expect(root).not.toEqual(otherRoot);
});

it('expires abandoned outputs and staged copies without following links or touching durable files', async () => {
  const options = config({ retentionHours: 24 });
  const a = await workspace(alice);
  const b = await workspace(bob);
  const expired = path.join(a, 'old.docx');
  const input = path.join(a, 'inputs', 'old.docx');
  const fresh = path.join(b, 'fresh.docx');
  const durable = path.join(base, 'durable.docx');
  for (const file of [expired, input, fresh, durable]) {
    await fs.writeFile(file, 'data');
  }
  const old = new Date(Date.now() - 25 * 3600_000);
  for (const file of [expired, input, durable]) {
    await fs.utimes(file, old, old);
  }
  await fs.symlink(base, path.join(a, 'escape'));
  expect(await sweepMCPFileWorkspaces({ wordcraft: options })).toBe(2);
  await expect(fs.stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(fresh, 'utf8')).toBe('data');
  expect(await fs.readFile(durable, 'utf8')).toBe('data');
});

it('bounds expiration work and never cleans an old shared-root configuration', async () => {
  const options = config({ sweepMaxEntries: 5 });
  const root = await workspace();
  const old = new Date(Date.now() - 25 * 3600_000);
  for (let i = 0; i < 10; i++) {
    const p = path.join(root, `old-${i}.docx`);
    await fs.writeFile(p, 'x');
    await fs.utimes(p, old, old);
  }
  const removed = await sweepMCPFileWorkspaces({ wordcraft: options });
  expect(removed).toBeLessThanOrEqual(4);
  const legacy = MCPOptionsSchema.parse({ command: 'npx', args: [], fileInputDir: base });
  expect(await sweepMCPFileWorkspaces({ legacy })).toBe(0);
});

it('continues expiry on other roots when one operator root is invalid', async () => {
  const root = await workspace();
  const old = path.join(root, 'abandoned.docx');
  await fs.writeFile(old, 'expired');
  const past = new Date(Date.now() - 25 * 3600_000);
  await fs.utimes(old, past, past);
  const invalid = path.join(base, 'invalid-root');
  await fs.writeFile(invalid, 'not a directory');
  const onError = jest.fn();
  expect(
    await sweepMCPFileWorkspaces(
      {
        broken: MCPOptionsSchema.parse({
          command: 'test',
          args: [],
          fileWorkspace: { root: invalid },
        }),
        wordcraft: config(),
      },
      Date.now(),
      onError,
    ),
  ).toBe(1);
  expect(onError).toHaveBeenCalledTimes(1);
  await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('tightens existing workspace permissions without following symlinks', async () => {
  const root = await workspace();
  await fs.chmod(root, 0o755);
  await fs.chmod(path.join(root, 'inputs'), 0o755);
  await prepareMCPFileWorkspace(resolveMCPFileWorkspace(config(), alice));
  expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(path.join(root, 'inputs'))).mode & 0o777).toBe(0o700);
});
