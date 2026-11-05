const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { resolveDownloadPath } = require('@librechat/api');
const { getStrategyFunctions } = require('./strategies');

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function maxBytes() {
  const parsed = Number(process.env.MCP_FILE_MAX_BYTES);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

/** A file name with no directory part or control characters; `file` when nothing is left. */
function safeFilename(name) {
  const leaf = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 200);
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : 'file';
}

/**
 * The input folder a YAML-defined stdio MCP server declares with `fileInputDir`, or null. Only
 * the operator's YAML config is read: user-defined and admin-overlay servers cannot name a folder
 * for LibreChat to write into (`fileInputDir` is a process field, like `command`).
 * @param {object | undefined} appConfig
 * @param {string} serverName
 */
function fileInputDirFor(appConfig, serverName) {
  const config = appConfig?.mcpConfig?.[serverName];
  if (!config || typeof config !== 'object' || (config.type ?? 'stdio') !== 'stdio') {
    return null;
  }
  const dir = config.fileInputDir;
  return typeof dir === 'string' && path.isAbsolute(dir) ? dir : null;
}

/** Copies one stored file to `target` unless it is already there. */
async function copyStoredFile(req, file, target) {
  try {
    await fs.promises.access(target);
    return;
  } catch {
    // not copied yet
  }
  const { getDownloadStream } = getStrategyFunctions(file.source);
  if (!getDownloadStream) {
    throw new Error(`no download stream for source ${file.source}`);
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const stream = await getDownloadStream(req, resolveDownloadPath(file));
  const partial = `${target}.partial`;
  let seen = 0;
  const limit = maxBytes();
  stream.on('data', (chunk) => {
    seen += chunk.length;
    if (seen > limit) {
      stream.destroy(new Error(`file exceeds ${limit} bytes`));
    }
  });
  try {
    await pipeline(stream, fs.createWriteStream(partial));
    await fs.promises.rename(partial, target);
  } catch (error) {
    await fs.promises.rm(partial, { force: true });
    throw error;
  }
}

/**
 * Copies the files the user attached this turn into the input folder of every MCP server the
 * agent uses that declares one, and returns a note telling the model where they are (empty when
 * nothing was copied). Each file lands at `<fileInputDir>/inputs/<file_id>/<name>`; the file id
 * is a random UUID, so one user cannot guess the path of another's upload. Failures are logged
 * and skipped: a file that cannot be copied must never fail the chat turn.
 * @param {{ req: ServerRequest; serverNames: string[]; files: Array<MongoFile | undefined | null> }} params
 * @returns {Promise<string>}
 */
async function stageMCPFileInputs({ req, serverNames, files }) {
  const usable = (files ?? []).filter(
    (file) =>
      file?.file_id &&
      file.filepath &&
      file.source !== FileSources.text &&
      !(Number(file.bytes) > maxBytes()),
  );
  if (usable.length === 0 || !serverNames?.length) {
    return '';
  }
  const lines = [];
  for (const serverName of new Set(serverNames)) {
    const dir = fileInputDirFor(req.config, serverName);
    if (!dir) {
      continue;
    }
    const staged = [];
    for (const file of usable) {
      const target = path.join(
        dir,
        'inputs',
        safeFilename(file.file_id),
        safeFilename(file.filename),
      );
      try {
        await copyStoredFile(req, file, target);
        staged.push(`- ${safeFilename(file.filename)}: ${target}`);
      } catch (error) {
        logger.warn(
          `[MCP][${serverName}] Could not copy upload ${file.file_id} for the server`,
          error,
        );
      }
    }
    if (staged.length > 0) {
      lines.push(
        `Files the user attached are available to the "${serverName}" MCP tools at these paths. Open, edit or convert them there, then return the result with that server's file tools:\n${staged.join('\n')}`,
      );
    }
  }
  return lines.join('\n\n');
}

module.exports = { stageMCPFileInputs, fileInputDirFor, safeFilename };
