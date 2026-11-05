import path from 'node:path';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MCPOptionsSchema } from 'librechat-data-provider';
import type { MCPOptions, TCustomConfig } from 'librechat-data-provider';
import type { FormattedContentResult, MCPToolCallResponse, McpFileArtifact } from './types';

export interface MCPFilePrincipal {
  id?: string;
  tenantId?: string;
}

type WorkspaceOptions = MCPOptions & { source?: string; dbId?: string };
export type MCPWorkspaceServers = NonNullable<TCustomConfig['mcpServers']>;

function policy(options: WorkspaceOptions) {
  if (!('fileWorkspace' in options) || !options.fileWorkspace) {
    return undefined;
  }
  if (
    !('command' in options) ||
    options.dbId ||
    (options.source && !['yaml', 'config'].includes(options.source))
  ) {
    throw new Error('MCP file workspaces require an operator-configured stdio server');
  }
  const setting = options.fileWorkspace;
  if (
    !path.isAbsolute(setting.root) ||
    setting.root.includes('{{') ||
    setting.root.includes('${')
  ) {
    throw new Error('MCP workspace root must be an absolute operator-configured directory');
  }
  return setting;
}

export function getMCPFileWorkspace(
  options: WorkspaceOptions,
  user?: MCPFilePrincipal,
): string | undefined {
  const setting = policy(options);
  if (!setting) {
    return undefined;
  }
  if (!user?.id || typeof user.id !== 'string' || user.id.length > 1024) {
    throw new Error('MCP file workspace requires an authenticated user');
  }
  const identity = createHash('sha256')
    .update(JSON.stringify([user.tenantId ?? '', user.id]))
    .digest('hex');
  return path.join(setting.root, identity);
}

export function resolveMCPFileWorkspace<T extends WorkspaceOptions>(
  options: T,
  user?: MCPFilePrincipal,
): T {
  const root = getMCPFileWorkspace(options, user);
  if (!root || !('command' in options)) {
    return options;
  }
  const args: string[] = [];
  for (let i = 0; i < options.args.length; i++) {
    const arg = options.args[i];
    if (arg === '--') {
      throw new Error('MCP file workspaces cannot use an argument terminator');
    }
    if (/^--automation-(read|write)-root(?:=|$)/.test(arg)) {
      throw new Error('MCP file workspaces cannot combine separate automation roots');
    }
    if (arg.startsWith('--root=')) {
      continue;
    }
    if (arg === '--root') {
      const operand = options.args[++i];
      if (!operand || operand.startsWith('--')) {
        throw new Error('Invalid --root operand in MCP server arguments');
      }
      continue;
    }
    args.push(arg);
  }
  return { ...options, args: [...args, '--root', root], cwd: root, fileInputDir: root };
}

function childOf(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}

async function privateDirectory(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const entry = await fs.lstat(dir);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('MCP workspace directory cannot be a symlink or regular file');
  }
  await fs.chmod(dir, 0o700);
}

/** Provision only the authenticated leaf; the operator's base must already exist. */
export async function prepareMCPFileWorkspace(options: WorkspaceOptions): Promise<void> {
  const setting = policy(options);
  if (!setting || !('command' in options)) {
    return;
  }
  const root = options.fileInputDir;
  if (
    !root ||
    path.dirname(root) !== path.resolve(setting.root) ||
    !/^[a-f0-9]{64}$/.test(path.basename(root))
  ) {
    throw new Error('MCP workspace was not resolved for an authenticated user');
  }
  const base = await fs.realpath(setting.root);
  if (!(await fs.stat(base)).isDirectory()) {
    throw new Error('MCP workspace base must already exist');
  }
  await privateDirectory(path.join(base, path.basename(root)));
  await privateDirectory(path.join(base, path.basename(root), 'inputs'));
}

export async function prepareMCPInputDirectory(
  options: WorkspaceOptions,
  user: MCPFilePrincipal | undefined,
  fileId: string,
): Promise<string> {
  const resolved = resolveMCPFileWorkspace(options, user);
  await prepareMCPFileWorkspace(resolved);
  const root = getMCPFileWorkspace(options, user);
  if (!root || !fileId || fileId === '.' || fileId === '..' || path.basename(fileId) !== fileId) {
    throw new Error('Invalid MCP input directory');
  }
  const dir = path.join(await fs.realpath(root), 'inputs', fileId);
  await privateDirectory(dir);
  return dir;
}

export async function bindMCPWorkspaceFiles(
  formatted: FormattedContentResult,
  result: MCPToolCallResponse,
  options: WorkspaceOptions,
  user: MCPFilePrincipal | undefined,
  serverName: string,
): Promise<FormattedContentResult> {
  const root = getMCPFileWorkspace(options, user);
  const files = formatted[1]?.mcp_files;
  if (!root || !files?.length) {
    return formatted;
  }
  let output: string | undefined;
  for (const part of result?.content ?? []) {
    if (part.type !== 'text' || typeof part.text !== 'string') {
      continue;
    }
    try {
      const metadata = JSON.parse(part.text) as { path?: string } | null;
      if (metadata && typeof metadata.path === 'string') {
        output = path.resolve(root, metadata.path);
        break;
      }
    } catch {
      continue;
    }
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(root);
  } catch {
    return formatted;
  }
  const bound = await Promise.all(
    files.map(async (file) => {
      const candidate =
        output && path.basename(output) === file.filename ? output : path.join(root, file.filename);
      if (!childOf(root, candidate) && !childOf(canonicalRoot, candidate)) {
        return file;
      }
      try {
        const real = await fs.realpath(candidate);
        if (
          !childOf(canonicalRoot, real) ||
          path.relative(canonicalRoot, real).split(path.sep)[0] === 'inputs'
        ) {
          return file;
        }
        return { ...file, workspace: { serverName, path: real } };
      } catch {
        return file;
      }
    }),
  );
  return [formatted[0], { ...formatted[1], mcp_files: bound }];
}

/** The user-owned download must be persisted before this function is called. */
export async function cleanupMCPWorkspaceFile(
  servers: MCPWorkspaceServers | null | undefined,
  user: MCPFilePrincipal | undefined,
  file: McpFileArtifact,
): Promise<boolean> {
  const source = file.workspace;
  const raw = source && servers?.[source.serverName];
  if (!source || !raw || !('fileWorkspace' in raw) || !raw.fileWorkspace) {
    return false;
  }
  const config = MCPOptionsSchema.parse(raw);
  const setting = policy(config);
  if (!setting?.cleanupAfterDelivery) {
    return false;
  }
  const root = getMCPFileWorkspace(config, user);
  if (!root) {
    return false;
  }
  const base = path.join(await fs.realpath(setting.root), path.basename(root));
  if (
    !childOf(base, source.path) ||
    path.relative(base, source.path).split(path.sep)[0] === 'inputs'
  ) {
    return false;
  }
  const real = await fs.realpath(source.path);
  if (!childOf(base, real) || real !== source.path) {
    return false;
  }
  const expected = Buffer.from(file.data, 'base64');
  if (expected.length > setting.maxFileBytes) {
    return false;
  }
  const handle = await fs.open(
    real,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expected.length) {
      return false;
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({
      start: 0,
      end: expected.length,
      autoClose: false,
    })) {
      bytes += chunk.length;
      if (bytes > expected.length) {
        return false;
      }
      hash.update(chunk);
    }
    if (
      bytes !== expected.length ||
      hash.digest('hex') !== createHash('sha256').update(expected).digest('hex')
    ) {
      return false;
    }
    const current = await fs.lstat(real);
    if (
      !current.isFile() ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs
    ) {
      return false;
    }
    await fs.unlink(real);
    return true;
  } finally {
    await handle.close();
  }
}

/** Concurrent delivery, expiry and operator cleanup may remove a file between checks. */
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function expireDirectory(
  root: string,
  dir: string,
  cutoff: number,
  budget: { left: number },
  depth = 0,
): Promise<number> {
  // Bound recursion independently of the entry budget for hostile directory trees.
  if (depth > 32 || budget.left <= 0) {
    return 0;
  }
  let removed = 0;
  if ((await fs.realpath(dir)) !== dir) {
    return 0;
  }
  const entries = await fs.opendir(dir);
  for await (const entry of entries) {
    if (budget.left-- <= 0) {
      break;
    }
    const target = path.join(dir, entry.name);
    try {
      const meta = await fs.lstat(target);
      if (meta.isSymbolicLink() || !childOf(root, target)) {
        continue;
      }
      if (meta.isDirectory()) {
        removed += await expireDirectory(root, target, cutoff, budget, depth + 1);
      } else if (meta.isFile() && meta.mtimeMs < cutoff) {
        await fs.unlink(target);
        removed++;
      }
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
  }
  return removed;
}

async function sweepWorkspace(options: WorkspaceOptions, now: number): Promise<number> {
  const setting = policy(options);
  if (!setting) {
    return 0;
  }
  const base = await fs.realpath(setting.root);
  const budget = { left: setting.sweepMaxEntries };
  let removed = 0;
  const entries = await fs.opendir(base);
  for await (const entry of entries) {
    if (budget.left-- <= 0) {
      break;
    }
    if (!/^[a-f0-9]{64}$/.test(entry.name)) {
      continue;
    }
    const target = path.join(base, entry.name);
    try {
      const meta = await fs.lstat(target);
      if (meta.isDirectory() && !meta.isSymbolicLink()) {
        removed += await expireDirectory(
          base,
          target,
          now - setting.retentionHours * 3600_000,
          budget,
        );
      }
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
  }
  return removed;
}

/** Reuses the existing file-retention sweep; never traverses a legacy shared directory. */
export async function sweepMCPFileWorkspaces(
  servers?: MCPWorkspaceServers | null,
  now: number = Date.now(),
  onError?: (error: Error) => void,
): Promise<number> {
  let removed = 0;
  for (const raw of Object.values(servers ?? {})) {
    if (!raw || !('fileWorkspace' in raw) || !raw.fileWorkspace) {
      continue;
    }
    try {
      removed += await sweepWorkspace(MCPOptionsSchema.parse(raw), now);
    } catch (error) {
      if (missing(error)) {
        continue;
      }
      if (!onError) {
        throw error;
      }
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return removed;
}
