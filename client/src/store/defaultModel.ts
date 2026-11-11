import { createStorageAtom } from './jotai-utils';

export const DEFAULT_MODEL_SPEC_KEY = 'defaultModelSpec';

/**
 * Local mirror of `user.personalization.defaultModelSpec` (the account is the source of
 * truth; `AuthContext` writes this whenever the user loads), so the synchronous new-chat
 * resolver can read it. `''` follows the config default.
 */
export const defaultModelSpecAtom = createStorageAtom<string>(DEFAULT_MODEL_SPEC_KEY, '');
