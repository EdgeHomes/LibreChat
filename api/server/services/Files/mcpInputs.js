const { logger } = require('@librechat/data-schemas');
const {
  createMCPInputService,
  mcpFileInputDirFor,
  safeMCPFilename,
  resolveDownloadPath,
} = require('@librechat/api');
const { getStrategyFunctions } = require('./strategies');

const stageMCPFileInputs = createMCPInputService({
  getStrategyFunctions,
  resolveDownloadPath,
  getMaxFileBytes: () => process.env.MCP_FILE_MAX_BYTES,
  logger,
});

/**
 * Removes the code-sandbox tools (and their prompt notes) from an agent for this turn. Called
 * once uploads were staged for an MCP server: told in words to use the server's tools, models
 * still reached for code execution, which then failed to provision the same upload. Mutates
 * the runtime agent config in place, like `applyContextToAgent`.
 * @param {object} agent - runtime agent config (`tools`, `toolDefinitions`, `toolRegistry`, ...)
 * @param {(name: string) => boolean} isCodeTool
 * @returns {string[]} the names removed
 */
function hideCodeTools(agent, isCodeTool) {
  const removed = new Set();
  const keep = (name) => {
    if (typeof name === 'string' && isCodeTool(name)) {
      removed.add(name);
      return false;
    }
    return true;
  };
  if (Array.isArray(agent.tools)) {
    agent.tools = agent.tools.filter((tool) => keep(typeof tool === 'string' ? tool : tool?.name));
  }
  if (Array.isArray(agent.toolDefinitions)) {
    agent.toolDefinitions = agent.toolDefinitions.filter((def) => keep(def?.name));
  }
  if (agent.toolRegistry instanceof Map) {
    for (const name of [...agent.toolRegistry.keys()]) {
      if (!keep(name)) {
        agent.toolRegistry.delete(name);
      }
    }
  }
  for (const key of ['toolContextMap', 'dynamicToolContextMap']) {
    const map = agent[key];
    if (map && typeof map === 'object') {
      agent[key] = Object.fromEntries(Object.entries(map).filter(([name]) => keep(name)));
    }
  }
  return [...removed];
}

module.exports = {
  stageMCPFileInputs,
  hideCodeTools,
  fileInputDirFor: mcpFileInputDirFor,
  safeFilename: safeMCPFilename,
};
