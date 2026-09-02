const axios = require('axios');
const OpenAI = require('openai');
const createOpenAIImageTools = require('~/app/clients/tools/structured/OpenAIImageTools');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');

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
    process.env = originalEnv;
  });

  it('should use default model "gpt-image-1" when IMAGE_GEN_OAI_MODEL is not set', async () => {
    delete process.env.IMAGE_GEN_OAI_MODEL;

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
        model: 'gpt-image-1',
      }),
      expect.any(Object),
    );
  });

  it('should use "gpt-image-1.5" when IMAGE_GEN_OAI_MODEL is set to "gpt-image-1.5"', async () => {
    process.env.IMAGE_GEN_OAI_MODEL = 'gpt-image-1.5';

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
        model: 'gpt-image-1.5',
      }),
      expect.any(Object),
    );
  });

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
