const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const store = {};
const mockWarn = jest.fn();

jest.mock('@librechat/data-schemas', () => ({ logger: { warn: (...args) => mockWarn(...args) } }));
jest.mock('@librechat/api', () => ({ resolveDownloadPath: (file) => file.filepath }));
jest.mock('./strategies', () => ({
  getStrategyFunctions: (source) =>
    source === 'local'
      ? {
          getDownloadStream: async (_req, filepath) => {
            if (!store[filepath]) {
              throw new Error('missing');
            }
            return Readable.from([store[filepath]]);
          },
        }
      : {},
}));

const { stageMCPFileInputs, safeFilename } = require('./mcpInputs');

describe('stageMCPFileInputs', () => {
  let root;
  let req;
  const xlsx = {
    file_id: 'id-1',
    filename: '../../etc/a.xlsx',
    filepath: 'u1/a.xlsx',
    source: 'local',
    bytes: 10,
  };

  beforeEach(() => {
    mockWarn.mockClear();
    store['u1/a.xlsx'] = Buffer.from('XLSX-BYTES');
    store['u1/big.pdf'] = Buffer.alloc(64);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpin-'));
    req = {
      config: {
        mcpConfig: {
          pdfcraft: { type: 'stdio', command: 'npx', fileInputDir: root },
          relative: { command: 'x', fileInputDir: 'relative/dir' },
          http: { type: 'streamable-http', url: 'http://x', fileInputDir: root },
          plain: { command: 'x' },
        },
      },
    };
  });

  afterEach(() => {
    delete process.env.MCP_FILE_MAX_BYTES;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('copies uploads only for stdio servers with an absolute fileInputDir and lists the paths', async () => {
    const files = [
      xlsx,
      { file_id: 'id-2', filename: 't.txt', filepath: 'x', source: 'text' },
      { file_id: 'id-3', filename: 'gone.pdf', filepath: 'u1/gone.pdf', source: 'local' },
      null,
    ];
    const note = await stageMCPFileInputs({
      req,
      serverNames: ['pdfcraft', 'pdfcraft', 'relative', 'http', 'plain', 'unknown'],
      files,
    });
    const target = path.join(root, 'inputs', 'id-1', 'a.xlsx');
    expect(fs.readFileSync(target, 'utf8')).toBe('XLSX-BYTES');
    expect(note).toContain(target);
    expect(note).toContain('"pdfcraft"');
    expect(note).not.toContain('gone.pdf');
    expect(note).not.toContain('t.txt');
    expect(note.split('Files the user attached')).toHaveLength(2);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(root, 'inputs', 'id-3', 'gone.pdf.partial'))).toBe(false);
  });

  it('does not copy a file twice', async () => {
    await stageMCPFileInputs({ req, serverNames: ['pdfcraft'], files: [xlsx] });
    store['u1/a.xlsx'] = Buffer.from('CHANGED');
    await stageMCPFileInputs({ req, serverNames: ['pdfcraft'], files: [xlsx] });
    expect(fs.readFileSync(path.join(root, 'inputs', 'id-1', 'a.xlsx'), 'utf8')).toBe('XLSX-BYTES');
  });

  it('stops a file that streams past the size cap', async () => {
    process.env.MCP_FILE_MAX_BYTES = '16';
    const big = { file_id: 'id-4', filename: 'big.pdf', filepath: 'u1/big.pdf', source: 'local' };
    const note = await stageMCPFileInputs({ req, serverNames: ['pdfcraft'], files: [big] });
    expect(note).toBe('');
    expect(fs.existsSync(path.join(root, 'inputs', 'id-4', 'big.pdf'))).toBe(false);
  });

  it('returns nothing without servers or config', async () => {
    expect(await stageMCPFileInputs({ req, serverNames: [], files: [xlsx] })).toBe('');
    expect(
      await stageMCPFileInputs({ req: { config: {} }, serverNames: ['pdfcraft'], files: [xlsx] }),
    ).toBe('');
  });

  it('strips directories and control characters from file names', () => {
    expect(safeFilename('..')).toBe('file');
    expect(safeFilename('')).toBe('file');
    expect(safeFilename(undefined)).toBe('file');
    expect(safeFilename('a/b\\c.pdf')).toBe('c.pdf');
    expect(safeFilename('x\u0001y')).toBe('x_y');
  });
});
