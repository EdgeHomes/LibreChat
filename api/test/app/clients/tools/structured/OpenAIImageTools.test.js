const axios = require('axios');
const OpenAI = require('openai');
const FormData = require('form-data');
const { Readable } = require('stream');
const createOpenAIImageTools = require('~/app/clients/tools/structured/OpenAIImageTools');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');

jest.mock('axios');
jest.mock('openai');
jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  logAxiosError: jest.fn(),
  oaiToolkit: {
    image_gen_oai: {
      name: 'image_gen_oai',
      description: 'Generate an image',
      schema: {},
    },
    image_edit_oai: {
      name: 'image_edit_oai',
      description: 'Edit an image',
      schema: {},
    },
  },
  extractBaseURL: jest.fn((url) => url),
  getProxyDispatcher: jest.fn(() => undefined),
  applyAxiosProxyConfig: jest.fn(),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn().mockResolvedValue([]),
}));

describe('OpenAIImageTools - IMAGE_GEN_OAI_MODEL environment variable', () => {
  let originalEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };

    process.env.IMAGE_GEN_OAI_API_KEY = 'test-api-key';
    delete process.env.IMAGE_GEN_OAI_MODEL;
    delete process.env.IMAGE_GEN_OAI_BASEURL;
    delete process.env.IMAGE_GEN_OAI_AZURE_API_VERSION;

    axios.post.mockResolvedValue({
      data: { data: [{ b64_json: 'base64-encoded-image-data' }] },
    });
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: jest.fn(async () => Readable.from([Buffer.from('image-data')])),
    });

    OpenAI.mockImplementation(() => ({
      images: {
        generate: jest.fn().mockResolvedValue({
          data: [
            {
              b64_json: 'base64-encoded-image-data',
            },
          ],
        }),
      },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  const createTools = () =>
    createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
      imageFiles: [
        {
          file_id: 'source-image',
          source: 'local',
          filepath: 'source-image.png',
          filename: 'source-image.png',
          type: 'image/png',
        },
      ],
    });

  it.each([undefined, ''])('defaults generation when IMAGE_GEN_OAI_MODEL=%j', async (model) => {
    if (model !== undefined) {
      process.env.IMAGE_GEN_OAI_MODEL = model;
    }

    const [imageGenTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
    });

    const mockGenerate = jest.fn().mockResolvedValue({
      data: [
        {
          b64_json: 'base64-encoded-image-data',
        },
      ],
    });

    OpenAI.mockImplementation(() => ({
      images: {
        generate: mockGenerate,
      },
    }));

    await imageGenTool.func({ prompt: 'test prompt' });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-2.5-flare',
      }),
      expect.any(Object),
    );
  });

  it.each(['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', ' '])(
    'should preserve the configured generation model %j',
    async (model) => {
      process.env.IMAGE_GEN_OAI_MODEL = model;

      const mockGenerate = jest.fn().mockResolvedValue({
        data: [
          {
            b64_json: 'base64-encoded-image-data',
          },
        ],
      });

      OpenAI.mockImplementation(() => ({
        images: {
          generate: mockGenerate,
        },
      }));

      const [imageGenTool] = createOpenAIImageTools({
        isAgent: true,
        override: false,
        req: { user: { id: 'test-user' } },
      });

      await imageGenTool.func({ prompt: 'test prompt' });

      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          model,
        }),
        expect.any(Object),
      );
    },
  );

  it('should use custom model name from IMAGE_GEN_OAI_MODEL environment variable', async () => {
    process.env.IMAGE_GEN_OAI_MODEL = 'custom-image-model';

    const mockGenerate = jest.fn().mockResolvedValue({
      data: [
        {
          b64_json: 'base64-encoded-image-data',
        },
      ],
    });

    OpenAI.mockImplementation(() => ({
      images: {
        generate: mockGenerate,
      },
    }));

    const [imageGenTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
    });

    await imageGenTool.func({ prompt: 'test prompt' });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'custom-image-model',
      }),
      expect.any(Object),
    );
  });

  it.each([
    [undefined, 'gpt-image-2.5-flare'],
    ['', 'gpt-image-2.5-flare'],
    ['gpt-image-1', 'gpt-image-1'],
    ['gpt-image-1.5', 'gpt-image-1.5'],
    ['gpt-image-2.5-flare', 'gpt-image-2.5-flare'],
    ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst'],
    ['custom-image-model', 'custom-image-model'],
    [' ', ' '],
  ])('preserves the editing model for IMAGE_GEN_OAI_MODEL=%j', async (model, expectedModel) => {
    if (model !== undefined) {
      process.env.IMAGE_GEN_OAI_MODEL = model;
    }
    const append = jest.spyOn(FormData.prototype, 'append');
    const [, imageEditTool] = createTools();

    await imageEditTool.func({ prompt: 'test prompt', image_ids: ['source-image'] });

    expect(append).toHaveBeenCalledWith('model', expectedModel);
    expect(axios.post).toHaveBeenCalledWith(
      '/images/edits',
      expect.any(FormData),
      expect.any(Object),
    );
  });

  it('should preserve the configured Azure deployment for generation and editing', async () => {
    const model = 'azure-image-deployment';
    const baseURL = 'https://azure.test/openai/deployments/azure-image-deployment';
    const apiVersion = '2025-04-01-preview';
    process.env.IMAGE_GEN_OAI_MODEL = model;
    process.env.IMAGE_GEN_OAI_BASEURL = baseURL;
    process.env.IMAGE_GEN_OAI_AZURE_API_VERSION = apiVersion;

    const mockGenerate = jest.fn().mockResolvedValue({
      data: [{ b64_json: 'base64-encoded-image-data' }],
    });
    OpenAI.mockImplementation(() => ({ images: { generate: mockGenerate } }));
    const append = jest.spyOn(FormData.prototype, 'append');
    const [imageGenTool, imageEditTool] = createTools();

    await imageGenTool.func({ prompt: 'test prompt' });
    await imageEditTool.func({ prompt: 'test prompt', image_ids: ['source-image'] });

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ model }),
      expect.any(Object),
    );
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL,
        defaultQuery: { 'api-version': apiVersion },
      }),
    );
    expect(append).toHaveBeenCalledWith('model', model);
    expect(axios.post).toHaveBeenCalledWith(
      '/images/edits',
      expect.any(FormData),
      expect.objectContaining({
        baseURL,
        params: { 'api-version': apiVersion },
        headers: expect.objectContaining({ 'api-key': 'test-api-key' }),
      }),
    );
  });
});

describe('OpenAIImageTools - end-user attribution', () => {
  const originalEnv = { ...process.env };
  const req = { user: { id: 'mongo-id', idOnTheSource: 'entra-oid' } };

  /** @returns {jest.Mock} the mocked `images.generate` */
  const mockImagesGenerate = () => {
    const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: 'aW1n' }] });
    OpenAI.mockImplementation(() => ({ images: { generate } }));
    return generate;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.IMAGE_GEN_OAI_API_KEY = 'test-api-key';
    process.env.IMAGE_GEN_OAI_USER_HEADER = 'X-Edge-Entra-OID';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sends the configured header on generate, and the LibreChat id as `user`', async () => {
    const generate = mockImagesGenerate();
    const [imageGenTool] = createOpenAIImageTools({ isAgent: true, override: false, req });

    await imageGenTool.func({ prompt: 'a cat' });

    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ defaultHeaders: { 'X-Edge-Entra-OID': 'entra-oid' } }),
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'mongo-id' }),
      expect.any(Object),
    );
  });

  it('sends no header when IMAGE_GEN_OAI_USER_HEADER is unset', async () => {
    delete process.env.IMAGE_GEN_OAI_USER_HEADER;
    const generate = mockImagesGenerate();
    const [imageGenTool] = createOpenAIImageTools({ isAgent: true, override: false, req });

    await imageGenTool.func({ prompt: 'a cat' });

    expect(OpenAI.mock.calls[0][0]).not.toHaveProperty('defaultHeaders');
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'mongo-id' }),
      expect.any(Object),
    );
  });

  it('omits the header for a user without an upstream id, keeping the `user` fallback', async () => {
    const generate = mockImagesGenerate();
    const [imageGenTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'mongo-id', idOnTheSource: null } },
    });

    await imageGenTool.func({ prompt: 'a cat' });

    expect(OpenAI.mock.calls[0][0]).not.toHaveProperty('defaultHeaders');
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'mongo-id' }),
      expect.any(Object),
    );
  });

  it('layers the header alongside Azure headers instead of clobbering them', async () => {
    process.env.IMAGE_GEN_OAI_BASEURL = 'https://example.openai.azure.com/openai/v1';
    process.env.IMAGE_GEN_OAI_AZURE_API_VERSION = '2025-04-01-preview';
    mockImagesGenerate();
    const [imageGenTool] = createOpenAIImageTools({ isAgent: true, override: false, req });

    await imageGenTool.func({ prompt: 'a cat' });

    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: {
          'api-key': 'test-api-key',
          'Content-Type': 'application/json',
          'X-Edge-Entra-OID': 'entra-oid',
        },
      }),
    );
  });

  it('sends the header and a `user` form field on edits', async () => {
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Buffer.from('png-bytes')),
    });
    axios.post.mockResolvedValue({ data: { data: [{ b64_json: 'aW1n' }] } });

    const [, imageEditTool] = createOpenAIImageTools({
      isAgent: true,
      override: false,
      req,
      imageFiles: [{ file_id: 'file-1', filename: 'cat.png', type: 'image/png', source: 'local' }],
    });

    await imageEditTool.func({ prompt: 'add a hat', image_ids: ['file-1'] });

    const [, formData, config] = axios.post.mock.calls[0];
    expect(config.headers).toEqual(expect.objectContaining({ 'X-Edge-Entra-OID': 'entra-oid' }));
    expect(formData.getBuffer().toString()).toContain('name="user"');
    expect(formData.getBuffer().toString()).toContain('mongo-id');
  });
});

describe('OpenAIImageTools - approved error text', () => {
  const { logger } = require('@librechat/data-schemas');
  const { logAxiosError } = require('@librechat/api');
  const SECRET = 'PRIVATE-PROVIDER-DETAIL';
  const FALLBACK = 'Error: The tool request failed.';
  let originalEnv;

  const providerError = (status) =>
    Object.assign(new Error(`${status} ${SECRET}`), {
      status,
      response: { status, data: { error: { message: SECRET } } },
    });

  const createTools = () =>
    createOpenAIImageTools({
      isAgent: true,
      override: false,
      req: { user: { id: 'test-user' } },
      imageFiles: [
        {
          file_id: 'source-image',
          source: 'local',
          filepath: 'source-image.png',
          filename: 'source-image.png',
          type: 'image/png',
        },
      ],
    });

  const failGeneration = (error) =>
    OpenAI.mockImplementation(() => ({
      images: { generate: jest.fn().mockRejectedValue(error) },
    }));

  /** True when any logged argument, including an error message, carries the text. */
  const logged = (text) =>
    [logger.warn, logger.error, logger.debug, logAxiosError]
      .flatMap((method) => method.mock.calls.flat())
      .some((arg) => `${arg instanceof Error ? arg.message : JSON.stringify(arg)}`.includes(text));

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = { ...process.env };
    process.env.IMAGE_GEN_OAI_API_KEY = 'test-api-key';
    delete process.env.IMAGE_GEN_OAI_BASEURL;
    delete process.env.IMAGE_GEN_OAI_AZURE_API_VERSION;
    getStrategyFunctions.mockReturnValue({
      getDownloadStream: jest.fn(async () => Readable.from([Buffer.from('image-data')])),
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('words a failing generation from its status, never the provider message', async () => {
    failGeneration(providerError(400));
    const [imageGenTool] = createTools();

    const [text] = await imageGenTool.func({ prompt: 'test prompt' });

    expect(text).toBe(
      'Error: OpenAI image generation rejected the request parameters; check them and try again (status 400).',
    );
    expect(logger.warn).toHaveBeenCalledWith('[OpenAI image generation] Tool request failed', {
      status: 400,
    });
    expect(logged(SECRET)).toBe(false);
  });

  it('returns the stable fallback for a generation failure without a status', async () => {
    failGeneration(new Error(`connect ECONNREFUSED ${SECRET}`));
    const [imageGenTool] = createTools();

    const [text] = await imageGenTool.func({ prompt: 'test prompt' });

    expect(text).toBe(FALLBACK);
    expect(logged(SECRET)).toBe(false);
  });

  it('words a failing edit from its status, never the provider message', async () => {
    axios.post.mockRejectedValue(providerError(401));
    const [, imageEditTool] = createTools();

    const [text] = await imageEditTool.func({ prompt: 'test prompt', image_ids: ['source-image'] });

    expect(text).toBe(
      'Error: OpenAI image editing rejected the configured credentials (status 401).',
    );
    expect(logged(SECRET)).toBe(false);
  });

  it('returns the stable fallback for an edit failure without a status', async () => {
    axios.post.mockRejectedValue(new Error(`socket hang up ${SECRET}`));
    const [, imageEditTool] = createTools();

    const [text] = await imageEditTool.func({ prompt: 'test prompt', image_ids: ['source-image'] });

    expect(text).toBe(FALLBACK);
    expect(logged(SECRET)).toBe(false);
  });
});
