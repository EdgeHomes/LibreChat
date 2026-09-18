process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import type { TModelSpec } from 'librechat-data-provider';

// Loaded via dynamic import in beforeAll so encryption initializes after
// CREDS_KEY is set above (encryptV3 reads the key at module load).
let buildFloorKeyRequest: typeof import('./tiers').buildFloorKeyRequest;
let buildGroupOverrides: typeof import('./tiers').buildGroupOverrides;
let buildKeyRequest: typeof import('./tiers').buildKeyRequest;
let buildTierPlan: typeof import('./tiers').buildTierPlan;
let encryptTierOverrides: typeof import('./tiers').encryptTierOverrides;
let keyAlias: typeof import('./tiers').keyAlias;
let parseTierMapping: typeof import('./tiers').parseTierMapping;
let resolveTierModels: typeof import('./tiers').resolveTierModels;
let selectSpecs: typeof import('./tiers').selectSpecs;
let validateTierMapping: typeof import('./tiers').validateTierMapping;
let resolveConfigSecret: typeof import('./secrets').resolveConfigSecret;

beforeAll(async () => {
  ({
    buildFloorKeyRequest,
    buildGroupOverrides,
    buildKeyRequest,
    buildTierPlan,
    encryptTierOverrides,
    keyAlias,
    parseTierMapping,
    resolveTierModels,
    selectSpecs,
    validateTierMapping,
  } = await import('./tiers'));
  ({ resolveConfigSecret } = await import('./secrets'));
});

const agentSpec = (name: string, model: string, isDefault = false): TModelSpec => ({
  name,
  label: model,
  default: isDefault,
  preset: { endpoint: 'agents', agent_id: `agent_${name}` },
});

const baseSpecs = (): TModelSpec[] => [
  agentSpec('anthropic-claude-sonnet-4-6', 'claude-sonnet-4-6', true),
  agentSpec('google-gemini-2.5-flash', 'gemini-2.5-flash'),
  agentSpec('openai-gpt-5-mini', 'gpt-5-mini'),
];

const specModels = (): Map<string, string> =>
  new Map([
    ['anthropic-claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['google-gemini-2.5-flash', 'gemini-2.5-flash'],
    ['openai-gpt-5-mini', 'gpt-5-mini'],
  ]);

const rawMapping = () => ({
  endpointName: 'LiteLLM',
  baselineModels: ['gemini-2.5-flash'],
  floor: { models: [] as string[] },
  tiers: [
    {
      name: 'standard',
      entraGroupId: 'guid-standard',
      priority: 10,
      models: ['gpt-5-mini'],
      specs: ['openai-gpt-5-mini', 'google-gemini-2.5-flash'],
    },
    {
      name: 'premium',
      entraGroupId: 'guid-premium',
      priority: 20,
      models: ['claude-sonnet-4-6', 'gpt-5-mini'],
      specs: ['anthropic-claude-sonnet-4-6', 'openai-gpt-5-mini', 'google-gemini-2.5-flash'],
    },
  ],
});

describe('parseTierMapping', () => {
  it('parses a well-formed mapping and defaults optional fields', () => {
    const mapping = parseTierMapping({
      endpointName: 'LiteLLM',
      floor: {},
      tiers: [
        {
          name: 'standard',
          entraGroupId: 'guid',
          priority: 10,
          models: ['gpt-5-mini'],
          specs: ['openai-gpt-5-mini'],
        },
      ],
    });

    expect(mapping.baselineModels).toEqual([]);
    expect(mapping.floor.models).toEqual([]);
    expect(mapping.tiers).toHaveLength(1);
  });

  it('rejects a tier with no models', () => {
    const raw = rawMapping();
    raw.tiers[0].models = [];
    expect(() => parseTierMapping(raw)).toThrow();
  });

  it('rejects a negative priority', () => {
    const raw = rawMapping();
    raw.tiers[0].priority = -1;
    expect(() => parseTierMapping(raw)).toThrow();
  });
});

describe('resolveTierModels', () => {
  it('appends baseline models without duplicating an already-listed one', () => {
    expect(resolveTierModels(['gpt-5-mini', 'gemini-2.5-flash'], ['gemini-2.5-flash'])).toEqual([
      'gpt-5-mini',
      'gemini-2.5-flash',
    ]);
  });

  it('keeps tier models first', () => {
    expect(resolveTierModels(['gpt-5-mini'], ['gemini-2.5-flash'])).toEqual([
      'gpt-5-mini',
      'gemini-2.5-flash',
    ]);
  });
});

describe('buildKeyRequest', () => {
  it('carries the baseline model, alias and group metadata', () => {
    const mapping = parseTierMapping(rawMapping());
    const request = buildKeyRequest(mapping.tiers[0], mapping.baselineModels);

    expect(request.key_alias).toBe('librechat-tier-standard');
    expect(request.models).toEqual(['gpt-5-mini', 'gemini-2.5-flash']);
    expect(request.metadata).toEqual({
      tier: 'standard',
      managed_by: 'litellm-tiers',
      entra_group_id: 'guid-standard',
    });
  });

  it('builds a floor key with the baseline model and no group', () => {
    const mapping = parseTierMapping(rawMapping());
    const request = buildFloorKeyRequest(mapping);

    expect(request.key_alias).toBe(keyAlias('floor'));
    expect(request.models).toEqual(['gemini-2.5-flash']);
    expect(request.metadata.entra_group_id).toBeUndefined();
  });
});

describe('selectSpecs', () => {
  it('keeps base order regardless of the order names are listed in', () => {
    const selected = selectSpecs(baseSpecs(), ['openai-gpt-5-mini', 'anthropic-claude-sonnet-4-6']);
    expect(selected.map((spec) => spec.name)).toEqual([
      'anthropic-claude-sonnet-4-6',
      'openai-gpt-5-mini',
    ]);
  });

  it('preserves the base default when the tier includes it', () => {
    const selected = selectSpecs(baseSpecs(), ['anthropic-claude-sonnet-4-6', 'openai-gpt-5-mini']);
    expect(selected.filter((spec) => spec.default)).toHaveLength(1);
    expect(selected[0].default).toBe(true);
  });

  it('promotes the first spec when the tier excludes the base default', () => {
    const selected = selectSpecs(baseSpecs(), ['google-gemini-2.5-flash', 'openai-gpt-5-mini']);

    expect(selected.map((spec) => spec.name)).toEqual([
      'google-gemini-2.5-flash',
      'openai-gpt-5-mini',
    ]);
    expect(selected[0].default).toBe(true);
    expect(selected[1].default).toBe(false);
  });

  it('does not mutate the base specs', () => {
    const specs = baseSpecs();
    selectSpecs(specs, ['google-gemini-2.5-flash']);
    expect(specs[0].default).toBe(true);
    expect(specs[1].default).toBe(false);
  });

  it('returns nothing when no name matches', () => {
    expect(selectSpecs(baseSpecs(), ['does-not-exist'])).toEqual([]);
  });
});

describe('buildGroupOverrides', () => {
  it('overrides only the endpoint key and the spec list', () => {
    const overrides = buildGroupOverrides({
      endpointName: 'LiteLLM',
      apiKey: 'sk-tier-standard',
      specs: selectSpecs(baseSpecs(), ['openai-gpt-5-mini']),
    });

    expect(overrides.endpoints.custom).toEqual([{ name: 'LiteLLM', apiKey: 'sk-tier-standard' }]);
    expect(overrides.modelSpecs.list.map((spec) => spec.name)).toEqual(['openai-gpt-5-mini']);
    expect(overrides.modelSpecs.enforce).toBe(false);
  });
});

describe('encryptTierOverrides', () => {
  it('encrypts the endpoint key and writes a preview that resolves back', () => {
    const overrides = buildGroupOverrides({
      endpointName: 'LiteLLM',
      apiKey: 'sk-tier-standard-secret',
      specs: selectSpecs(baseSpecs(), ['openai-gpt-5-mini']),
    });

    const encrypted = encryptTierOverrides(overrides);
    const entry = encrypted.endpoints.custom[0] as { apiKey: string; apiKeyPreview?: string };

    expect(entry.apiKey).not.toBe('sk-tier-standard-secret');
    expect(entry.apiKeyPreview).toBeDefined();
    expect(resolveConfigSecret(entry.apiKey)).toBe('sk-tier-standard-secret');
  });

  it('leaves the spec list untouched', () => {
    const specs = selectSpecs(baseSpecs(), ['openai-gpt-5-mini']);
    const encrypted = encryptTierOverrides(
      buildGroupOverrides({ endpointName: 'LiteLLM', apiKey: 'sk-abc', specs }),
    );
    expect(encrypted.modelSpecs.list).toEqual(specs);
  });
});

describe('buildTierPlan', () => {
  it('pairs each tier with its key request and resolved specs', () => {
    const mapping = parseTierMapping(rawMapping());
    const plan = buildTierPlan(mapping, baseSpecs());

    expect(plan).toHaveLength(2);
    expect(plan[0].keyRequest.key_alias).toBe('librechat-tier-standard');
    expect(plan[0].specs.map((spec) => spec.name)).toEqual([
      'google-gemini-2.5-flash',
      'openai-gpt-5-mini',
    ]);
    expect(plan[1].specs).toHaveLength(3);
  });
});

describe('validateTierMapping', () => {
  const context = () => ({
    baseSpecs: baseSpecs(),
    knownModels: ['claude-sonnet-4-6', 'gemini-2.5-flash', 'gpt-5-mini'],
    specModels: specModels(),
    titleModel: 'gemini-2.5-flash',
  });

  it('accepts a consistent mapping', () => {
    const mapping = parseTierMapping(rawMapping());
    expect(validateTierMapping(mapping, context())).toEqual([]);
  });

  it('flags a baseline that omits the title model', () => {
    const raw = rawMapping();
    raw.baselineModels = [];
    raw.tiers[0].models = ['gpt-5-mini', 'gemini-2.5-flash'];
    raw.tiers[1].models = ['claude-sonnet-4-6', 'gpt-5-mini', 'gemini-2.5-flash'];
    raw.floor.models = ['gpt-5-mini'];

    const errors = validateTierMapping(parseTierMapping(raw), context());
    expect(errors).toContain(
      'baselineModels must include titleModel "gemini-2.5-flash" or title, memory and activity-label generation fails for every tier',
    );
  });

  it('accepts a mapping whose baseline carries the title model', () => {
    const mapping = parseTierMapping(rawMapping());
    expect(validateTierMapping(mapping, { ...context(), titleModel: 'gemini-2.5-flash' })).toEqual(
      [],
    );
  });

  it('flags duplicate priorities as non-deterministic', () => {
    const raw = rawMapping();
    raw.tiers[1].priority = 10;

    const errors = validateTierMapping(parseTierMapping(raw), context());
    expect(errors.some((error) => error.includes('Duplicate priority 10'))).toBe(true);
  });

  it('flags two tiers targeting one Entra group', () => {
    const raw = rawMapping();
    raw.tiers[1].entraGroupId = 'guid-standard';

    const errors = validateTierMapping(parseTierMapping(raw), context());
    expect(errors.some((error) => error.includes('Duplicate entraGroupId'))).toBe(true);
  });

  it('flags a spec whose agent model the key does not allow', () => {
    const raw = rawMapping();
    raw.tiers[0].specs = ['anthropic-claude-sonnet-4-6'];

    const errors = validateTierMapping(parseTierMapping(raw), context());
    expect(errors).toContain(
      'Tier "standard" lists spec "anthropic-claude-sonnet-4-6" (model "claude-sonnet-4-6") that its key does not allow',
    );
  });

  it('flags an unknown spec name', () => {
    const raw = rawMapping();
    raw.tiers[0].specs = ['openai-o4-mini'];

    const errors = validateTierMapping(parseTierMapping(raw), context());
    expect(errors).toContain('Tier "standard" references unknown modelSpec "openai-o4-mini"');
  });

  it('flags a model LiteLLM does not serve', () => {
    const raw = rawMapping();
    raw.tiers[0].models = ['gpt-5-nano'];

    const errors = validateTierMapping(parseTierMapping(raw), context());
    expect(
      errors.some((error) => error.includes('references model "gpt-5-nano" that LiteLLM does not')),
    ).toBe(true);
  });

  it('flags a floor with no models at all', () => {
    const raw = rawMapping();
    raw.baselineModels = [];
    raw.floor.models = [];

    const errors = validateTierMapping(parseTierMapping(raw), context());
    expect(errors).toContain(
      'Floor key has no models: title generation would fail for ungrouped users',
    );
  });

  it('collects every problem rather than stopping at the first', () => {
    const raw = rawMapping();
    raw.tiers[1].priority = 10;
    raw.tiers[0].specs = ['does-not-exist'];

    const errors = validateTierMapping(parseTierMapping(raw), context());
    expect(errors.length).toBeGreaterThan(1);
  });
});
