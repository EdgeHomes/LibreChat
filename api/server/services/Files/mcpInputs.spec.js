const mockStage = jest.fn();
jest.mock('@librechat/data-schemas', () => ({ logger: { warn: jest.fn() } }));
jest.mock('@librechat/api', () => ({
  createMCPInputService: jest.fn(() => mockStage),
  resolveDownloadPath: jest.fn(),
  mcpFileInputDirFor: jest.fn(),
  safeMCPFilename: jest.fn(),
}));
jest.mock('./strategies', () => ({ getStrategyFunctions: jest.fn() }));
const { stageMCPFileInputs, hideCodeTools } = require('./mcpInputs');
it('wires upload staging to the shared TypeScript service', () => {
  expect(stageMCPFileInputs).toBe(mockStage);
});
describe('hideCodeTools', () => {
  const isCode = (name) => ['execute_code', 'bash_tool', 'read_file'].includes(name);

  it('removes code tools from every place an agent lists them and keeps the rest', () => {
    const agent = {
      tools: ['execute_code', { name: 'pdf_create_mcp_pdfcraft' }, { name: 'bash_tool' }],
      toolDefinitions: [{ name: 'read_file' }, { name: 'web_search' }],
      toolRegistry: new Map([
        ['execute_code', {}],
        ['tool_call_mcp_pdfcraft', {}],
      ]),
      toolContextMap: { execute_code: 'use /mnt/data', web_search: 'x' },
    };
    expect(hideCodeTools(agent, isCode).sort()).toEqual(['bash_tool', 'execute_code', 'read_file']);
    expect(agent.tools).toEqual([{ name: 'pdf_create_mcp_pdfcraft' }]);
    expect(agent.toolDefinitions).toEqual([{ name: 'web_search' }]);
    expect([...agent.toolRegistry.keys()]).toEqual(['tool_call_mcp_pdfcraft']);
    expect(agent.toolContextMap).toEqual({ web_search: 'x' });
  });

  it('accepts an agent with no tools', () => {
    expect(hideCodeTools({}, isCode)).toEqual([]);
  });
});
