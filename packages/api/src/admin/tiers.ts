import { z } from 'zod';
import type { TModelSpec } from 'librechat-data-provider';
import { encryptConfigSecrets } from './secrets';

const KEY_ALIAS_PREFIX = 'librechat-tier-';

export const FLOOR_TIER_NAME = 'floor';
export const TIER_MANAGED_BY = 'litellm-tiers';

export interface ModelTier {
  name: string;
  /** Entra group object id; resolved to a LibreChat group at sync time. */
  entraGroupId: string;
  /** Ascends with privilege. Overrides fold in ascending priority, so the
   *  highest value wins for a user who belongs to several tiers' groups. */
  priority: number;
  /** Models the tier's LiteLLM key may call, before the baseline is added. */
  models: string[];
  /** `modelSpecs` names from the base config this tier may see. */
  specs: string[];
}

export interface TierMapping {
  /** `endpoints.custom[].name` the tier key is written to. */
  endpointName: string;
  /** Models every key carries regardless of tier, e.g. the endpoint's `titleModel`. */
  baselineModels: string[];
  /** Entitlements for users matching no tier group. */
  floor: { models: string[] };
  tiers: ModelTier[];
}

const tierSchema = z.object({
  name: z.string().min(1),
  entraGroupId: z.string().min(1),
  priority: z.number().int().nonnegative(),
  models: z.array(z.string().min(1)).min(1),
  specs: z.array(z.string().min(1)).min(1),
});

const tierMappingSchema = z.object({
  endpointName: z.string().min(1),
  baselineModels: z.array(z.string().min(1)).default([]),
  floor: z.object({ models: z.array(z.string().min(1)).default([]) }),
  tiers: z.array(tierSchema).min(1),
});

/** LiteLLM `/key/generate` and `/key/update` request shape (its own snake_case contract). */
export interface LiteLLMKeyRequest {
  key_alias: string;
  models: string[];
  metadata: {
    tier: string;
    managed_by: string;
    entra_group_id?: string;
  };
}

/**
 * The override document shape written per group: only the fields a tier changes.
 * `endpoints.custom` is merged by `name` (see `ARRAY_MERGE_KEYS` in
 * `packages/data-schemas/src/app/resolution.ts`), so the entry carries the key
 * alone and inherits `baseURL`, `headers` and `titleModel` from the YAML base.
 * `modelSpecs.list` has no such merge key and is replaced wholesale.
 */
export interface TierConfigOverrides {
  endpoints: {
    custom: Array<{ name: string; apiKey: string }>;
  };
  modelSpecs: {
    enforce: boolean;
    prioritize: boolean;
    list: TModelSpec[];
  };
}

export interface TierPlanEntry {
  tier: ModelTier;
  keyRequest: LiteLLMKeyRequest;
  specs: TModelSpec[];
}

export interface TierValidationContext {
  baseSpecs: TModelSpec[];
  /** Model aliases LiteLLM actually serves, from its `/v1/models` or `model_list`. */
  knownModels?: string[];
  /** Spec name to the model its agent runs, for specs whose preset targets an agent. */
  specModels?: Map<string, string>;
  /** The endpoint's configured `titleModel`, which every key must be able to call. */
  titleModel?: string;
}

export function parseTierMapping(raw: unknown): TierMapping {
  return tierMappingSchema.parse(raw);
}

export function keyAlias(tierName: string): string {
  return `${KEY_ALIAS_PREFIX}${tierName}`;
}

/** Tier models plus the baseline every key carries, de-duplicated, tier order first. */
export function resolveTierModels(models: string[], baselineModels: string[]): string[] {
  return [...new Set([...models, ...baselineModels])];
}

export function buildKeyRequest(tier: ModelTier, baselineModels: string[]): LiteLLMKeyRequest {
  return {
    key_alias: keyAlias(tier.name),
    models: resolveTierModels(tier.models, baselineModels),
    metadata: {
      tier: tier.name,
      managed_by: TIER_MANAGED_BY,
      entra_group_id: tier.entraGroupId,
    },
  };
}

export function buildFloorKeyRequest(mapping: TierMapping): LiteLLMKeyRequest {
  return {
    key_alias: keyAlias(FLOOR_TIER_NAME),
    models: resolveTierModels(mapping.floor.models, mapping.baselineModels),
    metadata: {
      tier: FLOOR_TIER_NAME,
      managed_by: TIER_MANAGED_BY,
    },
  };
}

/**
 * Base specs narrowed to a tier, in base order, with exactly one marked default.
 * A tier that excludes the base default would otherwise ship a list where no
 * spec is default and the client has nothing to select on a new conversation.
 */
export function selectSpecs(baseSpecs: TModelSpec[], names: string[]): TModelSpec[] {
  const wanted = new Set(names);
  const selected = baseSpecs.filter((spec) => wanted.has(spec.name));
  if (selected.length === 0) {
    return selected;
  }

  const declaredDefault = selected.findIndex((spec) => spec.default === true);
  const defaultIndex = declaredDefault === -1 ? 0 : declaredDefault;
  return selected.map((spec, index) => ({ ...spec, default: index === defaultIndex }));
}

export function buildGroupOverrides(params: {
  endpointName: string;
  apiKey: string;
  specs: TModelSpec[];
}): TierConfigOverrides {
  const { endpointName, apiKey, specs } = params;
  return {
    endpoints: {
      custom: [{ name: endpointName, apiKey }],
    },
    modelSpecs: {
      enforce: false,
      prioritize: true,
      list: specs,
    },
  };
}

/** Encrypts `endpoints.custom[].apiKey` exactly as the admin config API stores it. */
export function encryptTierOverrides(overrides: TierConfigOverrides): TierConfigOverrides {
  return encryptConfigSecrets(overrides);
}

export function buildTierPlan(mapping: TierMapping, baseSpecs: TModelSpec[]): TierPlanEntry[] {
  return mapping.tiers.map((tier) => ({
    tier,
    keyRequest: buildKeyRequest(tier, mapping.baselineModels),
    specs: selectSpecs(baseSpecs, tier.specs),
  }));
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }
    seen.add(value);
  }
  return [...duplicates];
}

/**
 * Every way the two sides can disagree, collected rather than thrown one at a
 * time so an operator fixes the whole mapping in one pass. An empty array means
 * the LiteLLM keys and the LibreChat spec lists describe the same entitlements.
 */
export function validateTierMapping(
  mapping: TierMapping,
  context: TierValidationContext,
): string[] {
  const errors: string[] = [];
  const { baseSpecs, knownModels, specModels, titleModel } = context;

  const baseSpecNames = new Set(baseSpecs.map((spec) => spec.name));
  const knownModelSet = knownModels ? new Set(knownModels) : null;

  for (const duplicate of findDuplicates(mapping.tiers.map((tier) => tier.name))) {
    errors.push(`Duplicate tier name "${duplicate}"`);
  }
  for (const duplicate of findDuplicates(mapping.tiers.map((tier) => tier.entraGroupId))) {
    errors.push(`Duplicate entraGroupId "${duplicate}": two tiers would target one group`);
  }
  for (const duplicate of findDuplicates(mapping.tiers.map((tier) => String(tier.priority)))) {
    errors.push(
      `Duplicate priority ${duplicate}: a user in both groups would resolve non-deterministically`,
    );
  }

  const floorModels = resolveTierModels(mapping.floor.models, mapping.baselineModels);
  if (floorModels.length === 0) {
    errors.push('Floor key has no models: title generation would fail for ungrouped users');
  }

  /** Every key is built as tier models plus the baseline, so this is the one
   *  place a missing title model can hide: it would 401 on every tier at once. */
  if (titleModel != null && !mapping.baselineModels.includes(titleModel)) {
    errors.push(
      `baselineModels must include titleModel "${titleModel}" or title, memory and activity-label generation fails for every tier`,
    );
  }

  for (const tier of mapping.tiers) {
    const tierModels = new Set(resolveTierModels(tier.models, mapping.baselineModels));

    if (knownModelSet) {
      for (const model of tierModels) {
        if (!knownModelSet.has(model)) {
          errors.push(
            `Tier "${tier.name}" references model "${model}" that LiteLLM does not serve`,
          );
        }
      }
    }

    for (const specName of tier.specs) {
      if (!baseSpecNames.has(specName)) {
        errors.push(`Tier "${tier.name}" references unknown modelSpec "${specName}"`);
        continue;
      }
      const specModel = specModels?.get(specName);
      if (specModel != null && !tierModels.has(specModel)) {
        errors.push(
          `Tier "${tier.name}" lists spec "${specName}" (model "${specModel}") that its key does not allow`,
        );
      }
    }
  }

  if (knownModelSet) {
    for (const model of floorModels) {
      if (!knownModelSet.has(model)) {
        errors.push(`Floor references model "${model}" that LiteLLM does not serve`);
      }
    }
  }

  return errors;
}
