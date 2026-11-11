import { createStorageAtom } from './jotai-utils';

export const DEFAULT_MODEL_SPEC_KEY = 'defaultModelSpec';

/** Spec name the user picked as their new-chat default; `''` follows the config default. */
export const defaultModelSpecAtom = createStorageAtom<string>(DEFAULT_MODEL_SPEC_KEY, '');
