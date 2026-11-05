import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as fs from 'node:fs/promises';
import { MCPOptionsSchema } from 'librechat-data-provider';
import type { McpFileArtifact } from '~/mcp/types';
import {
  getMCPFileWorkspace,
  prepareMCPFileWorkspace,
  resolveMCPFileWorkspace,
} from '~/mcp/workspace';
import { createMCPInputService, safeMCPFilename, mcpFileInputDirFor, saveMCPFile } from './mcp';

let base: string;
const user = { id: 'alice', tenantId: 'tenant-a' };
const logger = { warn: jest.fn() };
const getDownloadStream = jest.fn(async () => Readable.from([Buffer.from('upload-data')]));
const service = createMCPInputService({
  getStrategyFunctions: () => ({ getDownloadStream }),
  resolveDownloadPath: (file) => file.filepath,
  getMaxFileBytes: () => undefined,
  logger,
});
const file = {
  file_id: 'upload-uuid',
  filename: '../../etc/Original.docx',
  filepath: '/stored/Original.docx',
  source: 'local',
  user: 'alice',
  tenantId: 'tenant-a',
  bytes: 11,
};
function config(extra = {}) {
  return MCPOptionsSchema.parse({
    command: 'npx',
    args: ['-y', 'wordcraft-edge-mcp'],
    fileWorkspace: { root: base, ...extra },
  });
}
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-mcp-inputs-'));
  jest.clearAllMocks();
  getDownloadStream.mockImplementation(async () => Readable.from([Buffer.from('upload-data')]));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

it.each(['wordcraft', 'gridcraft', 'deckcraft', 'pdfcraft'])(
  'stages %s uploads into the exact process root, scoped to authenticated ownership',
  async (server) => {
    const options = config();
    const req = { user, config: { mcpConfig: { [server]: options } } };
    const note = await service({ req, serverNames: [server, server], files: [file] });
    const root = getMCPFileWorkspace(options, user);
    if (!root) {
      throw new Error('test root');
    }
    const target = path.join(await fs.realpath(root), 'inputs', 'upload-uuid', 'Original.docx');
    expect(await fs.readFile(target, 'utf8')).toBe('upload-data');
    expect(note).toContain(target);
    expect(note).toContain('Do not use code execution');
    expect(mcpFileInputDirFor(req.config, server, user)).toBe(root);
    expect(getDownloadStream).toHaveBeenCalledTimes(1);
    await service({ req, serverNames: [server], files: [file] });
    expect(getDownloadStream).toHaveBeenCalledTimes(1);
  },
);

it('refuses foreign users/tenants before storage access and fails closed without identity', async () => {
  const req = { user, config: { mcpConfig: { wordcraft: config() } } };
  for (const bad of [
    { ...file, user: 'bob' },
    { ...file, tenantId: 'tenant-b' },
    { ...file, user: undefined },
  ]) {
    expect(await service({ req, serverNames: ['wordcraft'], files: [bad] })).toBe('');
  }
  expect(
    await service({ req: { config: req.config }, serverNames: ['wordcraft'], files: [file] }),
  ).toBe('');
  expect(getDownloadStream).not.toHaveBeenCalled();
});

it('bounds the actual upload stream and removes partial files on failure', async () => {
  const options = config({ maxFileBytes: 16 });
  const req = { user, config: { mcpConfig: { wordcraft: options } } };
  getDownloadStream.mockImplementation(async () => Readable.from([Buffer.alloc(20)]));
  expect(await service({ req, serverNames: ['wordcraft'], files: [file] })).toBe('');
  const dir = path.join(getMCPFileWorkspace(options, user) ?? '', 'inputs', 'upload-uuid');
  expect(await fs.readdir(dir)).toEqual([]);
});

it('rejects linked input directories, leaves vision inputs alone and preserves legacy configuration', async () => {
  const options = config();
  await prepareMCPFileWorkspace(resolveMCPFileWorkspace(options, user));
  const root = getMCPFileWorkspace(options, user);
  if (!root) {
    throw new Error('test root');
  }
  await fs.symlink(base, path.join(root, 'inputs', 'upload-uuid'));
  const req = { user, config: { mcpConfig: { wordcraft: options } } };
  expect(await service({ req, serverNames: ['wordcraft'], files: [file] })).toBe('');
  expect(
    await service({ req, serverNames: ['wordcraft'], files: [{ ...file, type: 'image/png' }] }),
  ).toBe('');
  expect(getDownloadStream).not.toHaveBeenCalled();
  const legacy = { command: 'npx', args: [], fileInputDir: base };
  expect(
    await service({
      req: { config: { mcpConfig: { legacy } } },
      serverNames: ['legacy'],
      files: [{ ...file, filename: 'Legacy.docx' }],
    }),
  ).toContain('Legacy.docx');
  expect(
    mcpFileInputDirFor(
      { mcpConfig: { legacy: { command: 'npx', fileInputDir: 'relative' } } },
      'legacy',
    ),
  ).toBeNull();
});

it('sanitizes input filenames and skips absent server configurations', async () => {
  for (const [input, output] of [
    ['..', 'file'],
    ['', 'file'],
    ['a/b\\c.pdf', 'c.pdf'],
    ['x\u0001y', 'x_y'],
  ]) {
    expect(safeMCPFilename(input)).toBe(output);
  }
  expect(safeMCPFilename()).toBe('file');
  expect(await service({ req: {}, serverNames: ['missing'], files: [file, null] })).toBe('');
});

async function output() {
  const options = config();
  await prepareMCPFileWorkspace(resolveMCPFileWorkspace(options, user));
  const root = getMCPFileWorkspace(options, user);
  if (!root) {
    throw new Error('test root');
  }
  const source = path.join(await fs.realpath(root), 'Output.docx');
  await fs.writeFile(source, 'download');
  const artifact: McpFileArtifact = {
    filename: 'Output.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data: Buffer.from('download').toString('base64'),
    workspace: { serverName: 'wordcraft', path: source },
  };
  return { source, artifact, req: { user, config: { mcpConfig: { wordcraft: options } } } };
}

it('waits for durable attachment persistence before removing temporary output', async () => {
  const { source, artifact, req } = await output();
  const saveBase64File = jest.fn(async () => {
    expect(await fs.readFile(source, 'utf8')).toBe('download');
    return { id: 'durable-file-id' };
  });
  expect(await saveMCPFile(artifact, { req, saveBase64File, logger })).toEqual({
    id: 'durable-file-id',
  });
  await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains output on persistence failure or cancellation and retains saved attachments on cleanup errors', async () => {
  const { source, artifact, req } = await output();
  const fail = jest.fn(async () => {
    throw new Error('storage unavailable');
  });
  await expect(saveMCPFile(artifact, { req, saveBase64File: fail, logger })).rejects.toThrow(
    'storage unavailable',
  );
  expect(await fs.readFile(source, 'utf8')).toBe('download');
  expect(await saveMCPFile(artifact, { req, saveBase64File: async () => null, logger })).toBeNull();
  expect(await fs.readFile(source, 'utf8')).toBe('download');
  await fs.unlink(source);
  expect(
    await saveMCPFile(artifact, { req, saveBase64File: async () => ({ id: 'saved' }), logger }),
  ).toEqual({ id: 'saved' });
  expect(logger.warn).toHaveBeenCalled();
});

it('counts UTF-8 bytes when a storage stream yields strings', async () => {
  const options = config({ maxFileBytes: 16 });
  const req = { user, config: { mcpConfig: { wordcraft: options } } };
  getDownloadStream.mockImplementation(async () => Readable.from(['漢'.repeat(8)]));
  expect(await service({ req, serverNames: ['wordcraft'], files: [file] })).toBe('');
  const dir = path.join(getMCPFileWorkspace(options, user) ?? '', 'inputs', 'upload-uuid');
  expect(await fs.readdir(dir)).toEqual([]);
});
