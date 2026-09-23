#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { deliveryTools } from './tools/delivery.js';
import { securityTools } from './tools/security.js';
import { dnsTools } from './tools/dns.js';
import { reportingTools } from './tools/reporting.js';

// Parse --services flag: node index.js --services delivery,security
const args = process.argv.slice(2);
const svcIdx = args.indexOf('--services');
const enabledServices = svcIdx !== -1
  ? args[svcIdx + 1].split(',').map(s => s.trim().toLowerCase())
  : ['delivery', 'security', 'dns', 'reporting'];

const ALL_TOOLS = [
  ...( enabledServices.includes('delivery')  ? deliveryTools  : []),
  ...( enabledServices.includes('security')  ? securityTools  : []),
  ...( enabledServices.includes('dns')       ? dnsTools       : []),
  ...( enabledServices.includes('reporting') ? reportingTools : []),
];

const server = new Server(
  { name: 'akamai-agent', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS.map(t => ({
    name:        t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = ALL_TOOLS.find(t => t.name === request.params.name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${request.params.name}` }) }],
      isError: true,
    };
  }
  try {
    const result = await tool.handler(request.params.arguments || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: err.message,
          howTo: [
            'Check that your ~/.edgerc credentials have access to this API.',
            'Verify the required API permissions are enabled in Akamai Control Center → Identity & Access Management.',
            'Ensure the contractId, groupId, or configId values are correct for your account.',
          ],
        }, null, 2),
      }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `Akamai Agent MCP server started — services: ${enabledServices.join(', ')}, tools: ${ALL_TOOLS.length}\n`
);
