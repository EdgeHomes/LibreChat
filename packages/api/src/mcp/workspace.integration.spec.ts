import os from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { MCPOptionsSchema } from 'librechat-data-provider';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { getMCPFileWorkspace, bindMCPWorkspaceFiles } from './workspace';
import { formatToolContent } from './parsers';
import { MCPConnection } from './connection';
import { processMCPEnv } from '~/utils/env';
import { saveMCPFile } from '~/files/mcp';

const binaries = process.env.CRAFT_MCP_BINARIES
  ? (JSON.parse(process.env.CRAFT_MCP_BINARIES) as Record<string, string>)
  : undefined;
const integration = binaries ? describe : describe.skip;
integration('real Craft stdio workspace isolation', () => {
  it.each(['wordcraft', 'gridcraft', 'deckcraft', 'pdfcraft'])(
    '%s confines two users, including exact foreign paths and meta tools, and preserves the durable download',
    async (name) => {
      const binary = binaries?.[name];
      if (!binary || !path.isAbsolute(binary)) {
        throw new Error(`Provide CRAFT_MCP_BINARIES.${name}`);
      }
      const base = await fs.mkdtemp(path.join(os.tmpdir(), `lc-${name}-isolation-`));
      const operatorRoot = path.join(base, 'workspace');
      await fs.mkdir(operatorRoot);
      const policy = MCPOptionsSchema.parse({
        type: 'stdio',
        command: binary,
        args: ['mcp', '--compact'],
        timeout: 10000,
        initTimeout: 10000,
        fileWorkspace: { root: operatorRoot },
      });
      const alice = { id: 'alice', tenantId: 'tenant-a' };
      const bob = { id: 'bob', tenantId: 'tenant-a' };
      const a = new MCPConnection({
        serverName: name,
        userId: alice.id,
        serverConfig: processMCPEnv({ options: policy, user: alice }),
      });
      const b = new MCPConnection({
        serverName: name,
        userId: bob.id,
        serverConfig: processMCPEnv({ options: policy, user: bob }),
      });
      try {
        await a.connect();
        await b.connect();
        const aRoot = getMCPFileWorkspace(policy, alice);
        const bRoot = getMCPFileWorkspace(policy, bob);
        if (!aRoot || !bRoot) {
          throw new Error('Missing authenticated roots');
        }
        const aFile = path.join(await fs.realpath(aRoot), 'Budget.csv');
        const bFile = path.join(await fs.realpath(bRoot), 'Budget.csv');
        const aliceBytes = Buffer.from('owner,secret\nalice,ALICE-ONLY\n');
        const bobBytes = Buffer.from('owner,secret\nbob,BOB-ONLY\n');
        await fs.writeFile(aFile, aliceBytes);
        await fs.writeFile(bFile, bobBytes);
        const call = (
          connection: MCPConnection,
          tool: string,
          args: Record<string, string | object>,
        ) =>
          connection.client.request(
            { method: 'tools/call', params: { name: tool, arguments: args } },
            CallToolResultSchema,
          );
        const aResult = await call(a, 'file_attach', { path: aFile });
        const bResult = await call(b, 'file_attach', { path: bFile });
        expect(aResult.isError).not.toBe(true);
        expect(bResult.isError).not.toBe(true);
        const extract = (result: typeof aResult) => {
          const part = result.content.find((item) => item.type === 'resource');
          if (!part || part.type !== 'resource' || !('blob' in part.resource)) {
            throw new Error('Missing attached CSV');
          }
          return Buffer.from(part.resource.blob, 'base64');
        };
        expect(extract(aResult)).toEqual(aliceBytes);
        expect(extract(bResult)).toEqual(bobBytes);
        for (const [connection, foreign] of [
          [a, bFile],
          [b, aFile],
        ] as const) {
          for (const [tool, args] of [
            ['file_attach', { path: foreign }],
            ['tool_call', { name: 'file_attach', arguments: { path: foreign } }],
          ] as const) {
            const refused = await call(connection, tool, args);
            expect(refused.isError).toBe(true);
            expect(JSON.stringify(refused.content)).toMatch(/root|outside|allowed|reject/i);
            expect(JSON.stringify(refused.content)).not.toContain(
              connection === a ? 'BOB-ONLY' : 'ALICE-ONLY',
            );
          }
        }
        const traversal = await call(a, 'file_attach', {
          path: path.join('..', path.basename(bRoot), 'Budget.csv'),
        });
        expect(traversal.isError).toBe(true);
        const formatted = await bindMCPWorkspaceFiles(
          formatToolContent(aResult, 'openai'),
          aResult,
          policy,
          alice,
          name,
        );
        const artifact = formatted[1]?.mcp_files?.[0];
        if (!artifact) {
          throw new Error('Missing parsed download');
        }
        const durable = path.join(base, 'durable', alice.id, artifact.filename);
        await saveMCPFile(artifact, {
          req: { user: alice, config: { mcpConfig: { [name]: policy } } },
          logger: { warn: jest.fn() },
          saveBase64File: async (data) => {
            await fs.mkdir(path.dirname(durable), { recursive: true });
            await fs.writeFile(durable, Buffer.from(data, 'base64'));
            return { file_id: 'alice-download' };
          },
        });
        expect(await fs.readFile(durable)).toEqual(aliceBytes);
        await expect(fs.stat(aFile)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readFile(bFile)).toEqual(bobBytes);
      } finally {
        await a.dispose();
        await b.dispose();
        await fs.rm(base, { recursive: true, force: true });
      }
    },
    120000,
  );
});
