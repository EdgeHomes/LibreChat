import path from 'node:path';
import * as fs from 'node:fs/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { FileContext, FileSources, MCPOptionsSchema } from 'librechat-data-provider';
import type { Readable, TransformCallback } from 'node:stream';
import type { AppConfig } from '@librechat/data-schemas';
import type { MCPFilePrincipal } from '~/mcp/workspace';
import type { McpFileArtifact } from '~/mcp/types';
import {
  getMCPFileWorkspace,
  prepareMCPInputDirectory,
  cleanupMCPWorkspaceFile,
} from '~/mcp/workspace';

interface MCPFileRequest {
  user?: MCPFilePrincipal;
  config?: Pick<AppConfig, 'mcpConfig'>;
}

interface MCPInputFile {
  file_id: string;
  filename?: string;
  filepath: string;
  source: string;
  bytes?: number;
  type?: string;
  user?: string | { toString(): string };
  tenantId?: string;
}

interface MCPFileLogger {
  warn(message: string, error?: Error): void;
}

interface MCPInputDependencies {
  getStrategyFunctions(source: string): {
    getDownloadStream?: (req: MCPFileRequest, filepath: string) => Promise<Readable>;
  };
  resolveDownloadPath(file: MCPInputFile): string;
  getMaxFileBytes(): string | undefined;
  logger: MCPFileLogger;
}

export function safeMCPFilename(name?: string): string {
  const leaf = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    ?.replace(/\p{Cc}/gu, '_')
    .trim()
    .slice(0, 200);
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : 'file';
}

export function mcpFileInputDirFor(
  appConfig: Pick<AppConfig, 'mcpConfig'> | undefined,
  serverName: string,
  user?: MCPFilePrincipal,
): string | null {
  const raw = appConfig?.mcpConfig?.[serverName];
  if (!raw || (raw.type ?? 'stdio') !== 'stdio') {
    return null;
  }
  if ('fileWorkspace' in raw && raw.fileWorkspace) {
    return getMCPFileWorkspace(MCPOptionsSchema.parse(raw), user) ?? null;
  }
  const dir = 'fileInputDir' in raw ? raw.fileInputDir : undefined;
  return typeof dir === 'string' && path.isAbsolute(dir) ? dir : null;
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface MCPStageInput {
  req: MCPFileRequest;
  serverNames: string[];
  files: Array<MCPInputFile | null | undefined>;
}

export function createMCPInputService(
  deps: MCPInputDependencies,
): (input: MCPStageInput) => Promise<string> {
  function maxBytes() {
    const parsed = Number(deps.getMaxFileBytes());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 32 * 1024 * 1024;
  }
  async function copy(
    req: MCPFileRequest,
    file: MCPInputFile,
    target: string,
    limit: number,
    isolated: boolean,
  ) {
    try {
      const existing = await fs.lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size > limit) {
        throw new Error('Invalid existing MCP input');
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const { getDownloadStream } = deps.getStrategyFunctions(file.source);
    if (!getDownloadStream) {
      throw new Error(`no download stream for source ${file.source}`);
    }
    if (!isolated) {
      await fs.mkdir(path.dirname(target), { recursive: true });
    }
    const stream = await getDownloadStream(req, deps.resolveDownloadPath(file));
    const partial = `${target}.partial-${randomUUID()}`;
    let seen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        seen += chunk.length;
        if (seen > limit) {
          callback(new Error(`file exceeds ${limit} bytes`));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
      try {
        await fs.link(partial, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    } finally {
      await fs.rm(partial, { force: true });
    }
  }

  return async function stageMCPFileInputs({
    req,
    serverNames,
    files,
  }: MCPStageInput): Promise<string> {
    const usable = (files ?? []).filter((file): file is MCPInputFile =>
      Boolean(
        file?.file_id &&
          file.filepath &&
          file.source !== FileSources.text &&
          !file.type?.startsWith('image/'),
      ),
    );
    const lines: string[] = [];
    for (const serverName of new Set(serverNames ?? [])) {
      try {
        const dir = mcpFileInputDirFor(req.config, serverName, req.user);
        if (!dir) {
          continue;
        }
        const raw = req.config?.mcpConfig?.[serverName];
        const config =
          raw && 'fileWorkspace' in raw && raw.fileWorkspace
            ? MCPOptionsSchema.parse(raw)
            : undefined;
        const setting = config && 'fileWorkspace' in config ? config.fileWorkspace : undefined;
        const limit = setting?.maxFileBytes ?? maxBytes();
        const staged: string[] = [];
        for (const file of usable) {
          if (Number(file.bytes) > limit) {
            continue;
          }
          if (
            setting &&
            (String(file.user ?? '') !== req.user?.id ||
              (file.tenantId ?? '') !== (req.user?.tenantId ?? ''))
          ) {
            deps.logger.warn(`[MCP][${serverName}] Refused upload outside the authenticated owner`);
            continue;
          }
          try {
            const parent = config
              ? await prepareMCPInputDirectory(config, req.user, safeMCPFilename(file.file_id))
              : path.join(dir, 'inputs', safeMCPFilename(file.file_id));
            const target = path.join(parent, safeMCPFilename(file.filename));
            await copy(req, file, target, limit, Boolean(setting));
            staged.push(`- ${safeMCPFilename(file.filename)}: ${target}`);
          } catch (error) {
            deps.logger.warn(
              `[MCP][${serverName}] Could not stage upload ${file.file_id}`,
              errorOf(error),
            );
          }
        }
        if (staged.length) {
          lines.push(
            `Files the user attached are available to the "${serverName}" MCP tools at these paths:\n${staged.join('\n')}\n` +
              `To read, edit, fill, convert or otherwise work on these files, call the "${serverName}" tools with these exact paths. ` +
              `Do not use code execution, bash or Python for them, and do not look for them in /mnt/data. ` +
              `Save results with the "${serverName}" tools and return them to the user with its file tools (for example file_attach).`,
          );
        }
      } catch (error) {
        deps.logger.warn(`[MCP][${serverName}] Upload workspace is unavailable`, errorOf(error));
      }
    }
    return lines.join('\n\n');
  };
}

export async function saveMCPFile<T>(
  artifact: McpFileArtifact,
  {
    req,
    saveBase64File,
    logger,
  }: {
    req: MCPFileRequest;
    saveBase64File: (
      data: string,
      options: { req: MCPFileRequest; filename: string; type: string; context: FileContext },
    ) => Promise<T>;
    logger: MCPFileLogger;
  },
): Promise<T> {
  const result = await saveBase64File(artifact.data, {
    req,
    filename: artifact.filename,
    type: artifact.mimeType,
    context: FileContext.message_attachment,
  });
  if (result != null) {
    try {
      await cleanupMCPWorkspaceFile(req.config?.mcpConfig, req.user, artifact);
    } catch (error) {
      logger.warn(
        '[MCP] Temporary output cleanup failed; saved attachment retained',
        errorOf(error),
      );
    }
  }
  return result;
}
