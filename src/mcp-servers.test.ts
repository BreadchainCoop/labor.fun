import { describe, it, expect } from 'vitest';

import {
  mcpServerEnvVarNames,
  RESERVED_MCP_SERVER_NAMES,
  validateMcpServerConfigs,
} from './mcp-servers.js';

// --- validateMcpServerConfigs ---

describe('validateMcpServerConfigs', () => {
  it('returns [] for undefined/null/empty input', () => {
    expect(validateMcpServerConfigs(undefined)).toEqual([]);
    expect(validateMcpServerConfigs(null)).toEqual([]);
    expect(validateMcpServerConfigs([])).toEqual([]);
  });

  it('throws when the top-level value is not an array', () => {
    expect(() => validateMcpServerConfigs({ foo: 'bar' })).toThrow(
      /must be an array/,
    );
    expect(() => validateMcpServerConfigs('nope')).toThrow(/must be an array/);
  });

  it('accepts a valid http config with bearerEnvVar', () => {
    const out = validateMcpServerConfigs([
      {
        name: 'zapier',
        type: 'http',
        url: 'https://mcp.zapier.com/api/mcp/abc',
        bearerEnvVar: 'ZAPIER_MCP_TOKEN',
      },
    ]);
    expect(out).toEqual([
      {
        name: 'zapier',
        type: 'http',
        url: 'https://mcp.zapier.com/api/mcp/abc',
        bearerEnvVar: 'ZAPIER_MCP_TOKEN',
      },
    ]);
  });

  it('accepts a valid http config with headerEnvVars and no bearer', () => {
    const out = validateMcpServerConfigs([
      {
        name: 'notion',
        type: 'http',
        url: 'https://mcp.notion.com/sse',
        headerEnvVars: { 'X-Api-Key': 'NOTION_API_KEY' },
      },
    ]);
    expect(out).toEqual([
      {
        name: 'notion',
        type: 'http',
        url: 'https://mcp.notion.com/sse',
        headerEnvVars: { 'X-Api-Key': 'NOTION_API_KEY' },
      },
    ]);
  });

  it('accepts a valid http config with neither bearer nor headers (public/no-auth)', () => {
    const out = validateMcpServerConfigs([
      { name: 'public-tool', type: 'http', url: 'https://example.com/mcp' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('accepts a valid stdio config with command/args/envVars', () => {
    const out = validateMcpServerConfigs([
      {
        name: 'my-tool',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'some-mcp-server'],
        envVars: ['SOME_TOOL_API_KEY'],
      },
    ]);
    expect(out).toEqual([
      {
        name: 'my-tool',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'some-mcp-server'],
        envVars: ['SOME_TOOL_API_KEY'],
      },
    ]);
  });

  it('accepts a minimal stdio config (no args/envVars)', () => {
    const out = validateMcpServerConfigs([
      { name: 'local-tool', type: 'stdio', command: 'my-mcp-binary' },
    ]);
    expect(out).toEqual([
      { name: 'local-tool', type: 'stdio', command: 'my-mcp-binary' },
    ]);
  });

  it.each([
    ['UPPERCASE', 'Zapier'],
    ['spaces', 'my tool'],
    ['dots', 'my.tool'],
    ['empty string', ''],
    ['non-string', 123],
  ])('rejects an invalid name (%s: %j)', (_label, badName) => {
    expect(() =>
      validateMcpServerConfigs([
        { name: badName, type: 'http', url: 'https://example.com' },
      ]),
    ).toThrow(/name must match/);
  });

  it.each(['my-tool', 'my_tool', 'tool123', 'a'])(
    'accepts a valid name (%s)',
    (goodName) => {
      expect(() =>
        validateMcpServerConfigs([
          { name: goodName, type: 'http', url: 'https://example.com' },
        ]),
      ).not.toThrow();
    },
  );

  it('rejects a reserved built-in name', () => {
    for (const reserved of RESERVED_MCP_SERVER_NAMES) {
      expect(() =>
        validateMcpServerConfigs([
          { name: reserved, type: 'http', url: 'https://example.com' },
        ]),
      ).toThrow(/reserved built-in/);
    }
  });

  it('rejects a duplicate name across entries', () => {
    expect(() =>
      validateMcpServerConfigs([
        { name: 'dup', type: 'http', url: 'https://a.example.com' },
        { name: 'dup', type: 'http', url: 'https://b.example.com' },
      ]),
    ).toThrow(/Duplicate mcpServers name/);
  });

  it('rejects an unknown type', () => {
    expect(() =>
      validateMcpServerConfigs([
        { name: 'weird', type: 'websocket', url: 'wss://example.com' },
      ]),
    ).toThrow(/type must be "http" or "stdio"/);
  });

  it('rejects an http entry with a missing/empty url', () => {
    expect(() =>
      validateMcpServerConfigs([{ name: 'no-url', type: 'http' }]),
    ).toThrow(/requires a non-empty "url"/);
    expect(() =>
      validateMcpServerConfigs([
        { name: 'blank-url', type: 'http', url: '  ' },
      ]),
    ).toThrow(/requires a non-empty "url"/);
  });

  it('rejects an http entry with a non-string bearerEnvVar', () => {
    expect(() =>
      validateMcpServerConfigs([
        {
          name: 'bad-bearer',
          type: 'http',
          url: 'https://example.com',
          bearerEnvVar: 123,
        },
      ]),
    ).toThrow(/bearerEnvVar must be a string/);
  });

  it('rejects an http entry with malformed headerEnvVars', () => {
    expect(() =>
      validateMcpServerConfigs([
        {
          name: 'bad-headers',
          type: 'http',
          url: 'https://example.com',
          headerEnvVars: ['not', 'an', 'object'],
        },
      ]),
    ).toThrow(/headerEnvVars must be an object/);
    expect(() =>
      validateMcpServerConfigs([
        {
          name: 'bad-header-value',
          type: 'http',
          url: 'https://example.com',
          headerEnvVars: { 'X-Header': 123 },
        },
      ]),
    ).toThrow(/must be a string \(an env var name\)/);
  });

  it('rejects a stdio entry with a missing/empty command', () => {
    expect(() =>
      validateMcpServerConfigs([{ name: 'no-cmd', type: 'stdio' }]),
    ).toThrow(/requires a non-empty "command"/);
  });

  it('rejects a stdio entry with non-string-array args or envVars', () => {
    expect(() =>
      validateMcpServerConfigs([
        { name: 'bad-args', type: 'stdio', command: 'x', args: [1, 2] },
      ]),
    ).toThrow(/args must be an array of strings/);
    expect(() =>
      validateMcpServerConfigs([
        {
          name: 'bad-envvars',
          type: 'stdio',
          command: 'x',
          envVars: 'NOT_AN_ARRAY',
        },
      ]),
    ).toThrow(/envVars must be an array of strings/);
  });

  it('rejects a non-object entry', () => {
    expect(() => validateMcpServerConfigs(['nope'])).toThrow(
      /must be an object/,
    );
    expect(() => validateMcpServerConfigs([null])).toThrow(/must be an object/);
  });
});

// --- mcpServerEnvVarNames ---

describe('mcpServerEnvVarNames', () => {
  it('returns [] for an empty list', () => {
    expect(mcpServerEnvVarNames([])).toEqual([]);
  });

  it('collects bearerEnvVar and headerEnvVars values from http configs', () => {
    const names = mcpServerEnvVarNames([
      {
        name: 'zapier',
        type: 'http',
        url: 'https://mcp.zapier.com/api/mcp/abc',
        bearerEnvVar: 'ZAPIER_MCP_TOKEN',
      },
      {
        name: 'notion',
        type: 'http',
        url: 'https://mcp.notion.com/sse',
        headerEnvVars: { 'X-Api-Key': 'NOTION_API_KEY', 'X-Org': 'NOTION_ORG' },
      },
    ]);
    expect(names).toEqual(['NOTION_API_KEY', 'NOTION_ORG', 'ZAPIER_MCP_TOKEN']);
  });

  it('collects envVars from stdio configs', () => {
    const names = mcpServerEnvVarNames([
      {
        name: 'my-tool',
        type: 'stdio',
        command: 'npx',
        envVars: ['SOME_TOOL_API_KEY', 'SOME_TOOL_REGION'],
      },
    ]);
    expect(names).toEqual(['SOME_TOOL_API_KEY', 'SOME_TOOL_REGION']);
  });

  it('dedupes names shared across servers and sorts the result', () => {
    const names = mcpServerEnvVarNames([
      {
        name: 'a',
        type: 'http',
        url: 'https://a.example.com',
        bearerEnvVar: 'SHARED_TOKEN',
      },
      {
        name: 'b',
        type: 'stdio',
        command: 'x',
        envVars: ['SHARED_TOKEN', 'AAA_FIRST'],
      },
    ]);
    expect(names).toEqual(['AAA_FIRST', 'SHARED_TOKEN']);
  });

  it('returns [] for servers referencing no env vars', () => {
    expect(
      mcpServerEnvVarNames([
        { name: 'public', type: 'http', url: 'https://example.com' },
        { name: 'local', type: 'stdio', command: 'x' },
      ]),
    ).toEqual([]);
  });
});
