const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { PrincipalType, PrincipalModel } = require('librechat-data-provider');
const {
  buildTierPlan,
  parseTierMapping,
  resolveConfigSecret,
  buildGroupOverrides,
  encryptTierOverrides,
  validateTierMapping,
  buildFloorKeyRequest,
} = require('@librechat/api');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const connect = require('./connect');

const { getAppConfig } = require('~/server/services/Config');
const { findGroupByExternalId, findConfigByPrincipal, upsertConfig } = require('~/models');
const { Agent } = require('~/db/models');

const DEFAULT_MAPPING_PATH = './litellm-tiers.json';
const DEFAULT_BASE_URL = 'http://litellm:4000';

function parseArgs(argv) {
  const args = { dryRun: false, mappingPath: DEFAULT_MAPPING_PATH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--mapping') {
      args.mappingPath = argv[++i];
      continue;
    }
    if (arg === '--base-url') {
      args.baseURL = argv[++i];
    }
  }
  return args;
}

function createLiteLLMClient(baseURL, masterKey) {
  const client = axios.create({
    baseURL,
    timeout: 30000,
    headers: { Authorization: `Bearer ${masterKey}`, 'Content-Type': 'application/json' },
  });

  return {
    async listModels() {
      const { data } = await client.get('/v1/models');
      return (data?.data ?? []).map((entry) => entry.id);
    },
    /** LiteLLM returns a generated key value exactly once; it cannot be read back later. */
    async generateKey(request) {
      const { data } = await client.post('/key/generate', request);
      if (!data?.key) {
        throw new Error(`/key/generate returned no key for alias "${request.key_alias}"`);
      }
      return data.key;
    },
    /** Targets the key by value — `/key/update` has no alias selector. */
    async updateKey(key, request) {
      await client.post('/key/update', {
        key,
        models: request.models,
        metadata: request.metadata,
      });
    },
  };
}

/** Spec name to the model its agent runs, so a tier cannot list a spec its key would reject. */
async function loadSpecModels(baseSpecs) {
  const agentIdBySpec = new Map();
  for (const spec of baseSpecs) {
    const agentId = spec.preset?.agent_id;
    if (agentId) {
      agentIdBySpec.set(spec.name, agentId);
    }
  }

  if (agentIdBySpec.size === 0) {
    return new Map();
  }

  const agents = await Agent.find(
    { id: { $in: [...agentIdBySpec.values()] } },
    { id: 1, model: 1, _id: 0 },
  ).lean();

  const modelByAgentId = new Map(agents.map((agent) => [agent.id, agent.model]));
  const specModels = new Map();
  for (const [specName, agentId] of agentIdBySpec) {
    const model = modelByAgentId.get(agentId);
    if (model) {
      specModels.set(specName, model);
    }
  }
  return specModels;
}

function findEndpointEntry(appConfig, endpointName) {
  const custom = appConfig?.endpoints?.custom ?? [];
  return custom.find((entry) => entry.name === endpointName);
}

function readStoredKey(config, endpointName) {
  const entry = (config?.overrides?.endpoints?.custom ?? []).find(
    (candidate) => candidate.name === endpointName,
  );
  if (!entry?.apiKey) {
    return null;
  }
  return resolveConfigSecret(entry.apiKey) ?? null;
}

async function syncFloorKey({ mapping, client, dryRun }) {
  const request = buildFloorKeyRequest(mapping);
  const existingKey = process.env.LITELLM_FLOOR_KEY;

  if (dryRun) {
    const action = existingKey ? 'update' : 'generate';
    logger.info(
      `[litellm-tiers] would ${action} floor key with models: ${request.models.join(', ')}`,
    );
    return;
  }

  if (existingKey) {
    await client.updateKey(existingKey, request);
    logger.info(`[litellm-tiers] updated floor key models: ${request.models.join(', ')}`);
    return;
  }

  const key = await client.generateKey(request);
  logger.info(`[litellm-tiers] generated floor key models: ${request.models.join(', ')}`);
  console.log(
    `\nStore this once — LiteLLM will not show it again.\n  LITELLM_FLOOR_KEY=${key}\nAdd it to the LibreChat .env secret, then redeploy the api service.\n`,
  );
}

async function syncTier({ entry, mapping, client, dryRun }) {
  const { tier, keyRequest, specs } = entry;

  const group = await findGroupByExternalId(tier.entraGroupId, 'entra');
  if (!group) {
    return {
      tier: tier.name,
      status: 'skipped',
      reason: `Entra group ${tier.entraGroupId} is not synced to LibreChat`,
    };
  }

  const existingConfig = await findConfigByPrincipal(PrincipalType.GROUP, group._id, {
    includeInactive: true,
  });
  const storedKey = readStoredKey(existingConfig, mapping.endpointName);

  if (dryRun) {
    return {
      tier: tier.name,
      status: storedKey ? 'would update' : 'would create',
      group: group.name,
      models: keyRequest.models.join(', '),
      specs: specs.map((spec) => spec.name).join(', '),
    };
  }

  let apiKey = storedKey;
  if (apiKey) {
    await client.updateKey(apiKey, keyRequest);
  } else {
    apiKey = await client.generateKey(keyRequest);
  }

  const overrides = encryptTierOverrides(
    buildGroupOverrides({ endpointName: mapping.endpointName, apiKey, specs }),
  );
  await upsertConfig(
    PrincipalType.GROUP,
    group._id,
    PrincipalModel.GROUP,
    overrides,
    tier.priority,
  );

  return {
    tier: tier.name,
    status: storedKey ? 'updated' : 'created',
    group: group.name,
    models: keyRequest.models.join(', '),
    specs: specs.map((spec) => spec.name).join(', '),
  };
}

async function syncTiers(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const masterKey = process.env.LITELLM_MASTER_KEY;
  if (!masterKey) {
    throw new Error('LITELLM_MASTER_KEY is required');
  }

  const mappingPath = path.resolve(process.cwd(), args.mappingPath);
  const mapping = parseTierMapping(JSON.parse(fs.readFileSync(mappingPath, 'utf8')));

  const baseURL = args.baseURL || process.env.LITELLM_BASE_URL || DEFAULT_BASE_URL;
  const client = createLiteLLMClient(baseURL, masterKey);

  await connect();

  const appConfig = await getAppConfig({ baseOnly: true });
  const baseSpecs = appConfig?.modelSpecs?.list ?? [];
  if (baseSpecs.length === 0) {
    throw new Error('Base config has no modelSpecs.list to derive per-tier spec lists from');
  }

  const endpointEntry = findEndpointEntry(appConfig, mapping.endpointName);
  if (!endpointEntry) {
    throw new Error(`Base config has no custom endpoint named "${mapping.endpointName}"`);
  }

  const [specModels, knownModels] = await Promise.all([
    loadSpecModels(baseSpecs),
    client.listModels(),
  ]);

  const errors = validateTierMapping(mapping, {
    baseSpecs,
    knownModels,
    specModels,
    titleModel: endpointEntry.titleModel,
  });
  if (errors.length > 0) {
    throw new Error(`Tier mapping is inconsistent:\n  - ${errors.join('\n  - ')}`);
  }

  await syncFloorKey({ mapping, client, dryRun: args.dryRun });

  const plan = buildTierPlan(mapping, baseSpecs);
  const results = [];
  for (const entry of plan) {
    results.push(await syncTier({ entry, mapping, client, dryRun: args.dryRun }));
  }

  return { dryRun: args.dryRun, baseURL, mappingPath, results };
}

if (require.main === module) {
  syncTiers()
    .then((result) => {
      console.table(result.results);
      const skipped = result.results.filter((entry) => entry.status === 'skipped');
      for (const entry of skipped) {
        console.error(`Skipped "${entry.tier}": ${entry.reason}`);
      }
      if (!result.dryRun) {
        console.log(
          '\nGroup overrides are cached for up to 60s. Run `node config/flush-cache.js` to apply immediately.',
        );
      }
      process.exit(skipped.length > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error('litellm-tiers failed:', error.message);
      process.exit(1);
    });
}

module.exports = { syncTiers };
