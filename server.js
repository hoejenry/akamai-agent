import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { deliveryTools } from './src/tools/delivery.js';
import { securityTools } from './src/tools/security.js';
import { dnsTools } from './src/tools/dns.js';
import { reportingTools } from './src/tools/reporting.js';
import { akamaiRequest } from './src/auth.js';

const EDGERC_PATH = join(homedir(), '.edgerc');

// Parse an .edgerc file into sections
function parseEdgerc(content) {
  const sections = {};
  let current = null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) { current = sectionMatch[1]; sections[current] = {}; continue; }
    if (current) {
      const eq = line.indexOf('=');
      if (eq !== -1) sections[current][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return sections;
}

// Serialize section data back to .edgerc format
function serializeEdgerc(sections) {
  return Object.entries(sections).map(([name, vals]) =>
    `[${name}]\n` + Object.entries(vals).map(([k, v]) => `${k} = ${v}`).join('\n')
  ).join('\n\n') + '\n';
}

const PORT = process.env.PORT || 3000;

const ALL_TOOLS = [...deliveryTools, ...securityTools, ...dnsTools, ...reportingTools];
const toolMap = Object.fromEntries(ALL_TOOLS.map(t => [t.name, t]));

// Build Anthropic-format tool definitions from the tool registry
const anthropicTools = ALL_TOOLS.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

const anthropic = new Anthropic({
  apiKey:  process.env.ANTHROPIC_FOUNDRY_API_KEY || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_FOUNDRY_BASE_URL,
  defaultHeaders: process.env.ANTHROPIC_CUSTOM_HEADERS
    ? Object.fromEntries(
        process.env.ANTHROPIC_CUSTOM_HEADERS.split(',').map(h => {
          const [k, ...v] = h.split(':');
          return [k.trim(), v.join(':').trim()];
        })
      )
    : {},
});

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are an Akamai operations AI agent with full access to tools for managing CDN delivery, WAF security, Edge DNS, and reporting.

You can:
- List and manage CDN properties (Property Manager / PAPI)
- Activate property versions to staging or production
- Purge cached content by URL, CP code, or cache tag
- View and manage WAF security configurations and policies
- Add/remove IPs from network lists (allow/block lists)
- Manage Edge DNS zones and records
- Pull traffic, error, security, and offload reports

Each tool returns a howTo array with guidance on interpreting results. Always share relevant how-to guidance with the user.

When credentials are not configured (~/.edgerc missing or incomplete), explain what needs to be set up and why.`;

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Extract the active customer section from a request (header takes precedence)
function getSection(req) {
  return (req.headers['x-akamai-section'] || 'default').trim();
}

// --- Credentials: status ---
app.get('/api/credentials/status', (req, res) => {
  if (!existsSync(EDGERC_PATH)) {
    return res.json({ configured: false, sections: [] });
  }
  try {
    const sections = parseEdgerc(readFileSync(EDGERC_PATH, 'utf8'));
    const summary = Object.entries(sections).map(([name, vals]) => ({
      section: name,
      host: vals.host ? vals.host.replace(/^(.{6}).*(.{4})$/, '$1…$2') : null,
      hasClientToken:  !!vals.client_token,
      hasClientSecret: !!vals.client_secret,
      hasAccessToken:  !!vals.access_token,
      hasHost:         !!vals.host,
      complete: !!(vals.client_token && vals.client_secret && vals.access_token && vals.host),
    }));
    res.json({ configured: summary.some(s => s.complete), sections: summary });
  } catch (err) {
    res.json({ configured: false, sections: [], error: err.message });
  }
});

// --- Credentials: save from form fields ---
app.post('/api/credentials/save', (req, res) => {
  const { section = 'default', client_token, client_secret, access_token, host, account_key } = req.body;
  if (!client_token || !client_secret || !access_token || !host) {
    return res.status(400).json({ error: 'client_token, client_secret, access_token, and host are all required.' });
  }
  try {
    const existing = existsSync(EDGERC_PATH)
      ? parseEdgerc(readFileSync(EDGERC_PATH, 'utf8'))
      : {};
    existing[section] = { client_token, client_secret, access_token, host: host.replace(/^https?:\/\//, '') };
    if (account_key) existing[section].account_key = account_key;
    writeFileSync(EDGERC_PATH, serializeEdgerc(existing), { mode: 0o600 });
    res.json({ ok: true, path: EDGERC_PATH, section });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Credentials: upload raw .edgerc file content ---
app.post('/api/credentials/upload', (req, res) => {
  const { content } = req.body;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content field required.' });
  }
  try {
    const sections = parseEdgerc(content);
    if (!Object.keys(sections).length) {
      return res.status(400).json({ error: 'No valid sections found in the file. Check the .edgerc format.' });
    }
    writeFileSync(EDGERC_PATH, content.trim() + '\n', { mode: 0o600 });
    const summary = Object.entries(sections).map(([name, vals]) => ({
      section: name,
      complete: !!(vals.client_token && vals.client_secret && vals.access_token && vals.host),
    }));
    res.json({ ok: true, path: EDGERC_PATH, sections: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Credentials: clear entire ~/.edgerc ---
app.delete('/api/credentials', (req, res) => {
  try {
    if (existsSync(EDGERC_PATH)) {
      writeFileSync(EDGERC_PATH, '', { mode: 0o600 });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Credentials: delete a single customer section ---
app.delete('/api/credentials/section', (req, res) => {
  const { section } = req.body;
  if (!section) return res.status(400).json({ error: 'section is required.' });
  try {
    const existing = existsSync(EDGERC_PATH)
      ? parseEdgerc(readFileSync(EDGERC_PATH, 'utf8'))
      : {};
    if (!existing[section]) {
      return res.status(404).json({ error: `Section [${section}] not found.` });
    }
    delete existing[section];
    if (Object.keys(existing).length === 0) {
      writeFileSync(EDGERC_PATH, '', { mode: 0o600 });
    } else {
      writeFileSync(EDGERC_PATH, serializeEdgerc(existing), { mode: 0o600 });
    }
    res.json({ ok: true, section });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Credentials: test by calling a lightweight Akamai API ---
app.post('/api/credentials/test', async (req, res) => {
  const { section = 'default' } = req.body;
  if (!existsSync(EDGERC_PATH)) {
    return res.status(400).json({ ok: false, error: 'No ~/.edgerc file found.' });
  }
  try {
    // Set env so the auth module picks up the right section
    process.env.AKAMAI_EDGERC_SECTION = section;
    // Use list_cp_codes as a lightweight test — PAPI is always provisioned
    const { deliveryTools: dt } = await import('./src/tools/delivery.js');
    const cpTool = dt.find(t => t.name === 'list_cp_codes');
    const result = await cpTool.handler({});
    res.json({ ok: true, section, message: `Connection successful — found ${result.count} CP codes.` });
  } catch (err) {
    res.json({ ok: false, section, error: err.message });
  }
});

// --- Account discovery: contracts, groups, products, CP codes ---
app.get('/api/account/discover', async (req, res) => {
  const section = getSection(req);
  try {
    // Contracts and groups in parallel
    const [contractsRes, groupsRes] = await Promise.allSettled([
      akamaiRequest('/papi/v1/contracts', {}, section),
      akamaiRequest('/papi/v1/groups', {}, section),
    ]);

    const contracts = contractsRes.status === 'fulfilled'
      ? (contractsRes.value.contracts?.items || []) : [];
    const accountId = contractsRes.status === 'fulfilled'
      ? contractsRes.value.accountId : null;
    const groups = groupsRes.status === 'fulfilled'
      ? (groupsRes.value.groups?.items || []) : [];

    // Products for each contract in parallel (cap at 10 contracts)
    const productResults = await Promise.all(
      contracts.slice(0, 10).map(c =>
        akamaiRequest('/papi/v1/products', { params: { contractId: c.contractId } }, section)
          .then(d => ({ contractId: c.contractId, products: d.products?.items || [] }))
          .catch(() => ({ contractId: c.contractId, products: [] }))
      )
    );
    const products = {};
    for (const p of productResults) products[p.contractId] = p.products;

    // CP codes — use first contract + first matching group
    let cpCodes = [];
    if (contracts.length) {
      const firstContract = contracts[0].contractId;
      const firstGroup = groups.find(g => g.contractIds?.includes(firstContract));
      try {
        const cpData = await akamaiRequest('/papi/v1/cpcodes', {
          params: { contractId: firstContract, groupId: firstGroup?.groupId },
        }, section);
        cpCodes = cpData.cpcodes?.items || [];
      } catch { /* not all accounts expose CP codes */ }
    }

    res.json({
      accountId,
      contracts: contracts.map(c => ({
        contractId:       c.contractId,
        contractTypeName: c.contractTypeName,
      })),
      groups: groups.map(g => ({
        groupId:     g.groupId,
        groupName:   g.groupName,
        contractIds: g.contractIds,
      })),
      products,
      cpCodes: {
        count: cpCodes.length,
        items: cpCodes.slice(0, 30).map(c => ({
          cpcodeId:   c.cpcodeId,
          cpcodeName: c.cpcodeName,
          products:   c.productIds,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Tool execution endpoint (used by dashboard) ---
app.post('/api/tool/:name', async (req, res) => {
  const tool = toolMap[req.params.name];
  if (!tool) return res.status(404).json({ error: `Unknown tool: ${req.params.name}` });
  try {
    const result = await tool.handler({ ...(req.body || {}), _section: getSection(req) });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch all CP codes across every group × contract combo, deduplicated by cpcodeId
async function fetchAllCPCodes(section) {
  const groupsData = await akamaiRequest('/papi/v1/groups', {}, section);
  const groups = groupsData.groups?.items || [];

  // Build every group × contractId pair
  const combos = groups.flatMap(g =>
    (g.contractIds || []).map(contractId => ({ groupId: g.groupId, contractId, groupName: g.groupName }))
  );

  const results = await Promise.allSettled(
    combos.map(({ groupId, contractId, groupName }) =>
      akamaiRequest('/papi/v1/cpcodes', { params: { groupId, contractId } }, section)
        .then(d => (d.cpcodes?.items || []).map(c => ({ ...c, groupName, contractId })))
        .catch(() => [])
    )
  );

  const seen = new Set();
  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const cp of r.value) {
        if (!seen.has(cp.cpcodeId)) {
          seen.add(cp.cpcodeId);
          all.push(cp);
        }
      }
    }
  }
  all.sort((a, b) => a.cpcodeName.localeCompare(b.cpcodeName));

  return {
    count: all.length,
    cpCodes: all.map(c => ({
      cpcodeId:   c.cpcodeId,
      cpcodeName: c.cpcodeName,
      products:   c.productIds || [],
      groupName:  c.groupName,
      contractId: c.contractId,
    })),
    howTo: [
      'Use a CP code number with purge_cache (type: "cpcode") to purge all cached content under that code.',
      'Pass CP code numbers to get_traffic_report or get_offload_report to see performance metrics.',
      'CP codes drive billing — each code tracks traffic separately on your invoice.',
    ],
  };
}

// --- Dashboard data endpoint (parallel fetch of overview data) ---
app.get('/api/dashboard', async (req, res) => {
  const results = {};
  const section = getSection(req);
  const fetches = [
    { key: 'properties',   tool: 'list_properties',      args: {} },
    { key: 'secConfigs',   tool: 'list_security_configs', args: {} },
    { key: 'dnsZones',     tool: 'list_dns_zones',        args: {} },
    { key: 'networkLists', tool: 'list_network_lists',    args: { extended: true } },
  ];
  await Promise.allSettled([
    ...fetches.map(async ({ key, tool: name, args }) => {
      try {
        results[key] = await toolMap[name].handler({ ...args, _section: section });
      } catch (err) {
        results[key] = { error: err.message };
      }
    }),
    fetchAllCPCodes(section)
      .then(d => { results.cpCodes = d; })
      .catch(err => { results.cpCodes = { error: err.message }; }),
  ]);
  res.json(results);
});

// --- Reporting endpoint ---
app.post('/api/report', async (req, res) => {
  const { type, cpCodes, configId, startDate, endDate, interval } = req.body;
  const toolName = {
    traffic:  'get_traffic_report',
    errors:   'get_error_report',
    security: 'get_security_event_report',
    offload:  'get_offload_report',
  }[type];
  if (!toolName) return res.status(400).json({ error: `Unknown report type: ${type}` });
  try {
    const result = await toolMap[toolName].handler({ cpCodes, configId, startDate, endDate, interval, _section: getSection(req) });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Agentic chat endpoint ---
app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { messages } = req.body;
  const section = getSection(req);

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const history = [...(messages || [])];

    // Agentic loop: keep calling until no more tool_use
    while (true) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: `${SYSTEM_PROMPT}\n\nActive customer account: [${section}]`,
        tools: anthropicTools,
        messages: history,
      });

      // Stream each content block to the client
      for (const block of response.content) {
        if (block.type === 'text') {
          send({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          send({ type: 'tool_call', name: block.name, input: block.input });
        }
      }

      // No tool calls → we're done
      if (response.stop_reason !== 'tool_use') {
        send({ type: 'done', stop_reason: response.stop_reason });
        break;
      }

      // Execute all tool calls
      history.push({ role: 'assistant', content: response.content });

      const toolResults = await Promise.all(
        response.content
          .filter(b => b.type === 'tool_use')
          .map(async (block) => {
            const tool = toolMap[block.name];
            let result;
            if (!tool) {
              result = { error: `Unknown tool: ${block.name}` };
            } else {
              try {
                result = await tool.handler({ ...(block.input || {}), _section: section });
              } catch (err) {
                result = { error: err.message };
              }
            }
            send({ type: 'tool_result', name: block.name, result });
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            };
          })
      );

      history.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    send({ type: 'error', message: err.message });
    res.end();
  }

  res.end();
});

app.listen(PORT, () => {
  console.log(`Akamai Agent web UI running at http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Chat:      http://localhost:${PORT}/#chat`);
});
