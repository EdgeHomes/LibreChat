import { logger } from '@librechat/data-schemas';
import {
  STATEFUL_CODE_ENVIRONMENTS,
  resolveAllowedStatefulCodeEnvironments,
} from 'librechat-data-provider';
import type { StatefulCodeEnvironment } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

interface UserPreferencesBody {
  statefulCodeEnvironment?: string;
  defaultModelSpec?: string;
}

const MAX_SPEC_NAME_LENGTH = 256;

function isStatefulCodeEnvironment(value: string): value is StatefulCodeEnvironment {
  return STATEFUL_CODE_ENVIRONMENTS.some((environment) => environment === value);
}

type UserPreferencesRequest = Omit<ServerRequest, 'body' | 'user'> & {
  body: UserPreferencesBody;
  user?: IUser;
};

export interface UserPreferencesHandlerDeps {
  updateStatefulCodeEnvironment: (
    userId: string,
    environment: StatefulCodeEnvironment,
  ) => Promise<IUser | null>;
  updateDefaultModelSpec: (userId: string, specName: string) => Promise<IUser | null>;
}

type Validation<T> = { value: T } | { status: number; message: string };

function validateEnvironment(
  environment: unknown,
  req: UserPreferencesRequest,
): Validation<StatefulCodeEnvironment> {
  if (typeof environment !== 'string' || !isStatefulCodeEnvironment(environment)) {
    return {
      status: 400,
      message: `statefulCodeEnvironment must be one of: ${STATEFUL_CODE_ENVIRONMENTS.join(', ')}`,
    };
  }
  const allowedEnvironments = resolveAllowedStatefulCodeEnvironments(
    req.config?.endpoints?.agents?.statefulCodeSessions?.allowedEnvironments,
  );
  if (!allowedEnvironments.includes(environment)) {
    return {
      status: 403,
      message: `statefulCodeEnvironment is not allowed by this deployment: ${environment}`,
    };
  }
  return { value: environment };
}

/** `''` clears the pick; any other name must be a spec this deployment configures. */
function validateSpecName(specName: unknown, req: UserPreferencesRequest): Validation<string> {
  if (typeof specName !== 'string' || specName.length > MAX_SPEC_NAME_LENGTH) {
    return {
      status: 400,
      message: `defaultModelSpec must be a string of at most ${MAX_SPEC_NAME_LENGTH} characters`,
    };
  }
  const known = req.config?.modelSpecs?.list?.some((spec) => spec?.name === specName) === true;
  if (specName !== '' && !known) {
    return { status: 400, message: `defaultModelSpec is not a configured model spec: ${specName}` };
  }
  return { value: specName };
}

export function createUserPreferencesHandler(
  deps: UserPreferencesHandlerDeps,
): (req: UserPreferencesRequest, res: Response) => Promise<Response> {
  return async (req: UserPreferencesRequest, res: Response): Promise<Response> => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const body = req.body ?? {};
    const hasEnvironment = body.statefulCodeEnvironment !== undefined;
    const hasSpec = body.defaultModelSpec !== undefined;
    if (!hasEnvironment && !hasSpec) {
      return res
        .status(400)
        .json({ message: 'Provide statefulCodeEnvironment and/or defaultModelSpec' });
    }

    const environment = hasEnvironment
      ? validateEnvironment(body.statefulCodeEnvironment, req)
      : undefined;
    if (environment && 'status' in environment) {
      return res.status(environment.status).json({ message: environment.message });
    }
    const specName = hasSpec ? validateSpecName(body.defaultModelSpec, req) : undefined;
    if (specName && 'status' in specName) {
      return res.status(specName.status).json({ message: specName.message });
    }

    try {
      let updatedUser: IUser | null = null;
      if (environment) {
        updatedUser = await deps.updateStatefulCodeEnvironment(userId, environment.value);
      }
      if (specName) {
        updatedUser = await deps.updateDefaultModelSpec(userId, specName.value);
      }
      if (!updatedUser) {
        return res.status(404).json({ message: 'User not found' });
      }

      const personalization = updatedUser.personalization;
      return res.status(200).json({
        updated: true,
        preferences: {
          ...(environment && {
            statefulCodeEnvironment: personalization?.statefulCodeEnvironment ?? environment.value,
          }),
          ...(specName && { defaultModelSpec: personalization?.defaultModelSpec ?? '' }),
        },
      });
    } catch (error) {
      logger.error('[UserPreferences] Error updating preferences:', error);
      return res.status(500).json({ message: 'Failed to update user preferences' });
    }
  };
}
