import { describe, it, expect } from 'vitest';

import { buildDynamicMcpServers } from './mcp-servers.js';

describe('buildDynamicMcpServers', () => {
  it('returns empty results for undefined/empty config', () => {
    expect(buildDynamicMcpServers(undefined, {})).toEqual({
      mcpServers: {},
      allowedToolTokens: [],
    });
    expect(buildDynamicMcpServers([], {})).toEqual({
      mcpServers: {},
      allowedToolTokens: [],
    });
  });

  describe('http servers', () => {
    it('builds an SDK http entry with a Bearer header and allowlist token when bearerEnvVar is set', () => {
      const result = buildDynamicMcpServers(
        [
          {
            name: 'zapier',
            type: 'http',
            url: 'https://mcp.zapier.com/api/mcp/abc',
            bearerEnvVar: 'ZAPIER_MCP_TOKEN',
          },
        ],
        { ZAPIER_MCP_TOKEN: 'secret-value' },
      );
      expect(result.mcpServers.zapier).toEqual({
        type: 'http',
        url: 'https://mcp.zapier.com/api/mcp/abc',
        headers: { Authorization: 'Bearer secret-value' },
      });
      expect(result.allowedToolTokens).toEqual(['mcp__zapier__*']);
    });

    it('builds custom headers from headerEnvVars', () => {
      const result = buildDynamicMcpServers(
        [
          {
            name: 'notion',
            type: 'http',
            url: 'https://mcp.notion.com/sse',
            headerEnvVars: { 'X-Api-Key': 'NOTION_API_KEY' },
          },
        ],
        { NOTION_API_KEY: 'notion-secret' },
      );
      expect(result.mcpServers.notion).toEqual({
        type: 'http',
        url: 'https://mcp.notion.com/sse',
        headers: { 'X-Api-Key': 'notion-secret' },
      });
      expect(result.allowedToolTokens).toEqual(['mcp__notion__*']);
    });

    it('combines bearerEnvVar and headerEnvVars into one headers object', () => {
      const result = buildDynamicMcpServers(
        [
          {
            name: 'combo',
            type: 'http',
            url: 'https://example.com/mcp',
            bearerEnvVar: 'COMBO_TOKEN',
            headerEnvVars: { 'X-Org-Id': 'COMBO_ORG_ID' },
          },
        ],
        { COMBO_TOKEN: 'tok', COMBO_ORG_ID: 'org-1' },
      );
      expect(result.mcpServers.combo).toEqual({
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-Org-Id': 'org-1', Authorization: 'Bearer tok' },
      });
    });

    it('enables a server with no auth (no bearerEnvVar/headerEnvVars) unconditionally', () => {
      const result = buildDynamicMcpServers(
        [{ name: 'public', type: 'http', url: 'https://example.com/mcp' }],
        {},
      );
      expect(result.mcpServers.public).toEqual({
        type: 'http',
        url: 'https://example.com/mcp',
      });
      expect(result.allowedToolTokens).toEqual(['mcp__public__*']);
    });

    it('omits the server (no entry, no allowlist token) when bearerEnvVar is referenced but unset', () => {
      const result = buildDynamicMcpServers(
        [
          {
            name: 'zapier',
            type: 'http',
            url: 'https://mcp.zapier.com/api/mcp/abc',
            bearerEnvVar: 'ZAPIER_MCP_TOKEN',
          },
        ],
        {},
      );
      expect(result.mcpServers).toEqual({});
      expect(result.allowedToolTokens).toEqual([]);
    });

    it('omits the server when only one of several referenced headerEnvVars is set', () => {
      const result = buildDynamicMcpServers(
        [
          {
            name: 'partial',
            type: 'http',
            url: 'https://example.com/mcp',
            headerEnvVars: { 'X-A': 'PARTIAL_A', 'X-B': 'PARTIAL_B' },
          },
        ],
        { PARTIAL_A: 'set' },
      );
      expect(result.mcpServers).toEqual({});
      expect(result.allowedToolTokens).toEqual([]);
    });

    it('omits the server when the env var is set to an empty string', () => {
      const result = buildDynamicMcpServers(
        [
          {
            name: 'zapier',
            type: 'http',
            url: 'https://mcp.zapier.com/api/mcp/abc',
            bearerEnvVar: 'ZAPIER_MCP_TOKEN',
          },
        ],
        { ZAPIER_MCP_TOKEN: '' },
      );
      expect(result.mcpServers).toEqual({});
    });
  });

  describe('stdio servers', () => {
    it('builds an SDK stdio entry with command/args and allowlist token', () => {
      const result = buildDynamicMcpServers(
        [
          {
            name: 'my-tool',
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'some-mcp-server'],
            envVars: ['SOME_TOOL_API_KEY'],
          },
        ],
        { SOME_TOOL_API_KEY: 'key-value' },
      );
      expect(result.mcpServers['my-tool']).toEqual({
        command: 'npx',
        args: ['-y', 'some-mcp-server'],
        env: { SOME_TOOL_API_KEY: 'key-value' },
      });
      expect(result.allowedToolTokens).toEqual(['mcp__my-tool__*']);
    });

    it('enables a stdio server with no envVars unconditionally (no env key in output)', () => {
      const result = buildDynamicMcpServers(
        [{ name: 'local-tool', type: 'stdio', command: 'my-binary' }],
        {},
      );
      expect(result.mcpServers['local-tool']).toEqual({
        command: 'my-binary',
      });
      expect(result.allowedToolTokens).toEqual(['mcp__local-tool__*']);
    });

    it('omits the stdio server when a referenced envVar is unset', () => {
      const result = buildDynamicMcpServers(
        [
          {
            name: 'my-tool',
            type: 'stdio',
            command: 'npx',
            envVars: ['SOME_TOOL_API_KEY'],
          },
        ],
        {},
      );
      expect(result.mcpServers).toEqual({});
      expect(result.allowedToolTokens).toEqual([]);
    });
  });

  it('handles multiple servers, mixing enabled and gated-off entries', () => {
    const result = buildDynamicMcpServers(
      [
        {
          name: 'zapier',
          type: 'http',
          url: 'https://mcp.zapier.com/api/mcp/abc',
          bearerEnvVar: 'ZAPIER_MCP_TOKEN',
        },
        {
          name: 'unset-tool',
          type: 'http',
          url: 'https://example.com/mcp',
          bearerEnvVar: 'MISSING_TOKEN',
        },
        { name: 'local', type: 'stdio', command: 'my-binary' },
      ],
      { ZAPIER_MCP_TOKEN: 'tok' },
    );
    expect(Object.keys(result.mcpServers).sort()).toEqual(['local', 'zapier']);
    expect(result.allowedToolTokens.sort()).toEqual([
      'mcp__local__*',
      'mcp__zapier__*',
    ]);
  });
});
