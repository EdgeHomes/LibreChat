process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { PrincipalType } from 'librechat-data-provider';
import type { TModelSpec, TEndpoint } from 'librechat-data-provider';
import type { AppConfig, IConfig } from '@librechat/data-schemas';

let mergeConfigOverrides: typeof import('@librechat/data-schemas').mergeConfigOverrides;
let buildGroupOverrides: typeof import('./tiers').buildGroupOverrides;
let encryptTierOverrides: typeof import('./tiers').encryptTierOverrides;
let selectSpecs: typeof import('./tiers').selectSpecs;
let resolveConfigSecret: typeof import('./secrets').resolveConfigSecret;

beforeAll(async () => {
  ({ mergeConfigOverrides } = await import('@librechat/data-schemas'));
  ({ buildGroupOverrides, encryptTierOverrides, selectSpecs } = await import('./tiers'));
  ({ resolveConfigSecret } = await import('./secrets'));
});

const ENDPOINT_NAME = 'LiteLLM';

const agentSpec = (name: string, isDefault = false): TModelSpec => ({
  name,
  label: name,
  default: isDefault,
  group: 'Edge',
  preset: { endpoint: 'agents', agent_id: `agent_${name}` },
});

const baseSpecs = (): TModelSpec[] => [
  agentSpec('anthropic-claude-sonnet-4-6', true),
  agentSpec('google-gemini-2.5-flash'),
  agentSpec('openai-o4-mini'),
  agentSpec('openai-gpt-5-mini'),
];

/** Mirrors the shape of the deployed `librechat.production.yaml` after AppService. */
const baseConfig = (): AppConfig =>
  ({
    modelSpecs: { enforce: false, prioritize: true, list: baseSpecs() },
    endpoints: {
      custom: [
        {
          name: ENDPOINT_NAME,
          apiKey: 'sk-floor-key',
          baseURL: 'http://litellm:4000/v1',
          headers: {
            'X-Edge-Application': 'librechat',
            'X-Edge-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
          },
          models: { default: ['gemini-2.5-flash'], fetch: true },
          titleConvo: true,
          titleModel: 'gemini-2.5-flash',
          modelDisplayLabel: 'LiteLLM',
        } as unknown as TEndpoint,
      ],
    },
  }) as AppConfig;

const tierDocument = (params: {
  groupId: string;
  apiKey: string;
  specNames: string[];
  priority: number;
}): IConfig =>
  ({
    principalType: PrincipalType.GROUP,
    principalId: params.groupId,
    priority: params.priority,
    isActive: true,
    overrides: encryptTierOverrides(
      buildGroupOverrides({
        endpointName: ENDPOINT_NAME,
        apiKey: params.apiKey,
        specs: selectSpecs(baseSpecs(), params.specNames),
      }),
    ),
  }) as unknown as IConfig;

/** `AppConfig` carries specs in partial form, so read them at that type rather than `TModelSpec`. */
type MergedSpec = NonNullable<NonNullable<AppConfig['modelSpecs']>['list']>[number];

const mergedSpecs = (config: AppConfig): MergedSpec[] => {
  const list = config.modelSpecs?.list;
  if (!list) {
    throw new Error('modelSpecs missing from merged config');
  }
  return list;
};

const mergedSpecNames = (config: AppConfig): Array<string | undefined> =>
  mergedSpecs(config).map((spec) => spec.name);

const mergedEndpoint = (config: AppConfig): TEndpoint => {
  const custom = (config.endpoints?.custom ?? []) as TEndpoint[];
  const endpoint = custom.find((entry) => entry.name === ENDPOINT_NAME);
  if (!endpoint) {
    throw new Error('LiteLLM endpoint missing from merged config');
  }
  return endpoint;
};

describe('tier overrides merged by the real config resolver', () => {
  it('replaces only the endpoint key and inherits the rest of the entry', () => {
    const merged = mergeConfigOverrides(baseConfig(), [
      tierDocument({
        groupId: 'group-standard',
        apiKey: 'sk-standard-key',
        specNames: ['google-gemini-2.5-flash', 'openai-gpt-5-mini'],
        priority: 10,
      }),
    ]);

    const endpoint = mergedEndpoint(merged);
    expect(resolveConfigSecret(endpoint.apiKey)).toBe('sk-standard-key');
    expect(endpoint.baseURL).toBe('http://litellm:4000/v1');
    expect(endpoint.titleModel).toBe('gemini-2.5-flash');
    expect(endpoint.headers).toEqual({
      'X-Edge-Application': 'librechat',
      'X-Edge-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
    });
    expect(endpoint.models.fetch).toBe(true);
  });

  it('does not add a second endpoint entry', () => {
    const merged = mergeConfigOverrides(baseConfig(), [
      tierDocument({
        groupId: 'group-standard',
        apiKey: 'sk-standard-key',
        specNames: ['openai-gpt-5-mini'],
        priority: 10,
      }),
    ]);

    expect(merged.endpoints?.custom).toHaveLength(1);
  });

  it('narrows the spec list to the tier', () => {
    const merged = mergeConfigOverrides(baseConfig(), [
      tierDocument({
        groupId: 'group-standard',
        apiKey: 'sk-standard-key',
        specNames: ['google-gemini-2.5-flash', 'openai-gpt-5-mini'],
        priority: 10,
      }),
    ]);

    expect(mergedSpecNames(merged)).toEqual(['google-gemini-2.5-flash', 'openai-gpt-5-mini']);
    expect(mergedSpecs(merged).filter((spec) => spec.default)).toHaveLength(1);
  });

  it('leaves the base config untouched for a user with no group override', () => {
    const merged = mergeConfigOverrides(baseConfig(), []);

    expect(mergedEndpoint(merged).apiKey).toBe('sk-floor-key');
    expect(mergedSpecs(merged)).toHaveLength(4);
  });

  it('resolves a user in two tier groups to the higher priority, whatever the input order', () => {
    const standard = tierDocument({
      groupId: 'group-standard',
      apiKey: 'sk-standard-key',
      specNames: ['google-gemini-2.5-flash', 'openai-gpt-5-mini'],
      priority: 10,
    });
    const premium = tierDocument({
      groupId: 'group-premium',
      apiKey: 'sk-premium-key',
      specNames: ['anthropic-claude-sonnet-4-6', 'google-gemini-2.5-flash', 'openai-gpt-5-mini'],
      priority: 20,
    });

    for (const configs of [
      [standard, premium],
      [premium, standard],
    ]) {
      const merged = mergeConfigOverrides(baseConfig(), configs);
      expect(resolveConfigSecret(mergedEndpoint(merged).apiKey)).toBe('sk-premium-key');
      expect(mergedSpecNames(merged)).toEqual([
        'anthropic-claude-sonnet-4-6',
        'google-gemini-2.5-flash',
        'openai-gpt-5-mini',
      ]);
    }
  });

  it('keeps an inactive-free base when a tier document carries no specs for a model', () => {
    const merged = mergeConfigOverrides(baseConfig(), [
      tierDocument({
        groupId: 'group-premium',
        apiKey: 'sk-premium-key',
        specNames: ['anthropic-claude-sonnet-4-6'],
        priority: 20,
      }),
    ]);

    expect(mergedSpecNames(merged)).toEqual(['anthropic-claude-sonnet-4-6']);
    expect(merged.modelSpecs?.enforce).toBe(false);
  });
});
