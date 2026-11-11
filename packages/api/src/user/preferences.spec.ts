import type { IUser } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { createUserPreferencesHandler } from './preferences';

interface MockResponse extends Partial<Response> {
  statusCode: number;
  body?: object;
  status: jest.Mock;
  json: jest.Mock;
}

function createResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: 200,
    status: jest.fn((statusCode: number) => {
      response.statusCode = statusCode;
      return response;
    }),
    json: jest.fn((body: object) => {
      response.body = body;
      return response;
    }),
  };
  return response;
}

function createRequest(body: object, authenticated = true): Request & { user?: Partial<IUser> } {
  return {
    body,
    user: authenticated ? { id: 'user-1' } : undefined,
  } as Request & { user?: Partial<IUser> };
}

describe('createUserPreferencesHandler', () => {
  it.each(['user', 'agent-user', 'conversation'] as const)(
    'persists the %s stateful workspace default',
    async (statefulCodeEnvironment) => {
      const updateStatefulCodeEnvironment = jest.fn().mockResolvedValue({
        personalization: { statefulCodeEnvironment },
      });
      const handler = createUserPreferencesHandler({
        updateStatefulCodeEnvironment,
        updateDefaultModelSpec: jest.fn(),
      });
      const response = createResponse();

      await handler(
        createRequest({ statefulCodeEnvironment }) as Parameters<typeof handler>[0],
        response as Response,
      );

      expect(updateStatefulCodeEnvironment).toHaveBeenCalledWith('user-1', statefulCodeEnvironment);
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        updated: true,
        preferences: { statefulCodeEnvironment },
      });
    },
  );

  it('rejects an invalid stateful workspace default', async () => {
    const updateStatefulCodeEnvironment = jest.fn();
    const handler = createUserPreferencesHandler({
      updateStatefulCodeEnvironment,
      updateDefaultModelSpec: jest.fn(),
    });
    const response = createResponse();

    await handler(
      createRequest({ statefulCodeEnvironment: 'agent' }) as Parameters<typeof handler>[0],
      response as Response,
    );

    expect(updateStatefulCodeEnvironment).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(400);
  });

  it('rejects a valid scope excluded by deployment policy', async () => {
    const updateStatefulCodeEnvironment = jest.fn();
    const handler = createUserPreferencesHandler({
      updateStatefulCodeEnvironment,
      updateDefaultModelSpec: jest.fn(),
    });
    const response = createResponse();
    const request = createRequest({ statefulCodeEnvironment: 'conversation' }) as Parameters<
      typeof handler
    >[0];
    request.config = {
      endpoints: {
        agents: {
          statefulCodeSessions: { allowedEnvironments: ['user', 'agent-user'] },
        },
      },
    } as NonNullable<typeof request.config>;

    await handler(request, response as Response);

    expect(updateStatefulCodeEnvironment).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
  });

  it('requires an authenticated user', async () => {
    const updateStatefulCodeEnvironment = jest.fn();
    const handler = createUserPreferencesHandler({
      updateStatefulCodeEnvironment,
      updateDefaultModelSpec: jest.fn(),
    });
    const response = createResponse();

    await handler(
      createRequest({ statefulCodeEnvironment: 'user' }, false) as Parameters<typeof handler>[0],
      response as Response,
    );

    expect(updateStatefulCodeEnvironment).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  it('returns not found when the user no longer exists', async () => {
    const updateStatefulCodeEnvironment = jest.fn().mockResolvedValue(null);
    const handler = createUserPreferencesHandler({
      updateStatefulCodeEnvironment,
      updateDefaultModelSpec: jest.fn(),
    });
    const response = createResponse();

    await handler(
      createRequest({ statefulCodeEnvironment: 'user' }) as Parameters<typeof handler>[0],
      response as Response,
    );

    expect(response.statusCode).toBe(404);
  });

  describe('defaultModelSpec', () => {
    const withSpecs = (body: object) => {
      const request = createRequest(body) as Parameters<
        ReturnType<typeof createUserPreferencesHandler>
      >[0];
      request.config = {
        modelSpecs: { list: [{ name: 'haiku' }, { name: 'opus' }] },
      } as NonNullable<typeof request.config>;
      return request;
    };

    it('persists a configured spec without touching the workspace default', async () => {
      const updateStatefulCodeEnvironment = jest.fn();
      const updateDefaultModelSpec = jest
        .fn()
        .mockResolvedValue({ personalization: { defaultModelSpec: 'opus' } });
      const handler = createUserPreferencesHandler({
        updateStatefulCodeEnvironment,
        updateDefaultModelSpec,
      });
      const response = createResponse();

      await handler(withSpecs({ defaultModelSpec: 'opus' }), response as Response);

      expect(updateDefaultModelSpec).toHaveBeenCalledWith('user-1', 'opus');
      expect(updateStatefulCodeEnvironment).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({ updated: true, preferences: { defaultModelSpec: 'opus' } });
    });

    it('clears the pick with an empty name', async () => {
      const updateDefaultModelSpec = jest.fn().mockResolvedValue({ personalization: {} });
      const handler = createUserPreferencesHandler({
        updateStatefulCodeEnvironment: jest.fn(),
        updateDefaultModelSpec,
      });
      const response = createResponse();

      await handler(withSpecs({ defaultModelSpec: '' }), response as Response);

      expect(updateDefaultModelSpec).toHaveBeenCalledWith('user-1', '');
      expect(response.body).toEqual({ updated: true, preferences: { defaultModelSpec: '' } });
    });

    it.each([['not-configured'], [42], ['x'.repeat(257)]])(
      'rejects %p',
      async (defaultModelSpec) => {
        const updateDefaultModelSpec = jest.fn();
        const handler = createUserPreferencesHandler({
          updateStatefulCodeEnvironment: jest.fn(),
          updateDefaultModelSpec,
        });
        const response = createResponse();

        await handler(withSpecs({ defaultModelSpec }), response as Response);

        expect(updateDefaultModelSpec).not.toHaveBeenCalled();
        expect(response.statusCode).toBe(400);
      },
    );

    it('rejects an empty body', async () => {
      const handler = createUserPreferencesHandler({
        updateStatefulCodeEnvironment: jest.fn(),
        updateDefaultModelSpec: jest.fn(),
      });
      const response = createResponse();

      await handler(withSpecs({}), response as Response);

      expect(response.statusCode).toBe(400);
    });
  });
});
