# Akamai AI Agent

An AI-powered agent for managing Akamai delivery, security, DNS, and reporting — via a web UI with a live dashboard and natural language chat, or as an MCP server inside Claude Code.

---

## Features

- **Dashboard** — live overview of CDN properties, WAF security configs, Edge DNS zones, and network lists; run traffic, error, and cache offload reports
- **Chat** — natural language interface powered by Claude; ask questions and issue commands in plain English
- **MCP server** — 20 tools usable directly inside Claude Code (no web server needed)
- **In-browser credential manager** — enter API keys manually or upload an existing `.edgerc` file

### Tool coverage

| Area | Tools |
|---|---|
| Delivery | List properties, get property version, activate property, purge cache (URL / CP code / tag), list CP codes |
| Security | List/get WAF configs, list/update/activate network lists, activate security configs |
| DNS | List zones, list/create/delete records, get zone status |
| Reporting | Traffic, error rates, security events, cache offload |
| Edge diagnostics | `curl_from_edge`, `dig_from_edge`, `url_health_check`, `grep_edge_logs`, `translate_error_string`, + 9 more (via `mcp-connector-for-akamai`) |

---

## Prerequisites

- Node.js 18+
- Akamai API credentials (EdgeGrid) — see [Credentials setup](#credentials-setup)

---

## Installation

```bash
git clone https://github.com/hoejenry/akamai-agent.git
cd akamai-agent
npm install
```

---

## Credentials setup

You need an Akamai EdgeGrid API client with access to:

| API | Access |
|---|---|
| Property Manager (PAPI) | READ-WRITE |
| Fast Purge | WRITE |
| Application Security | READ-WRITE |
| Network Lists | READ-WRITE |
| Edge DNS | READ-WRITE |
| Reporting API | READ |

**To create credentials:**

1. Log in to [Akamai Control Center](https://control.akamai.com)
2. Go to **Identity & Access Management → API Clients**
3. Create a new client with the permissions above
4. Download the `.edgerc` file

**Option A — via the web UI:**  
Click **API Keys** in the header and either paste the values or upload your `.edgerc` file directly.

**Option B — manually:**  
Save your credentials to `~/.edgerc`:

```ini
[default]
client_secret = YOUR_CLIENT_SECRET
host = akab-xxxxxxxxxxxx.luna.akamaiapis.net
access_token = YOUR_ACCESS_TOKEN
client_token = YOUR_CLIENT_TOKEN
```

---

## Usage

### Web UI

```bash
npm run web
```

Opens at **http://localhost:3000**

- **Dashboard tab** — live overview cards + report runner
- **Chat tab** — type natural language commands; the agent calls the right tools automatically

### MCP server (Claude Code)

```bash
# Register with Claude Code (run once)
claude mcp add akamai-agent \
  -e AKAMAI_EDGERC_PATH=~/.edgerc \
  -e AKAMAI_EDGERC_SECTION=default \
  -- node /path/to/akamai-agent/src/index.js

# Start specific service groups only (reduces memory usage)
npm run start:delivery
npm run start:security
npm run start:dns
npm run start:reporting
npm run start:all
```

### Environment variables

| Variable | Description |
|---|---|
| `AKAMAI_EDGERC_PATH` | Path to `.edgerc` file (default: `~/.edgerc`) |
| `AKAMAI_EDGERC_SECTION` | Section name to use (default: `default`) |
| `AKAMAI_CLIENT_TOKEN` | Override: EdgeGrid client token |
| `AKAMAI_CLIENT_SECRET` | Override: EdgeGrid client secret |
| `AKAMAI_ACCESS_TOKEN` | Override: EdgeGrid access token |
| `AKAMAI_HOST` | Override: EdgeGrid host |
| `AKAMAI_ACCOUNT_KEY` | Account switch key for multi-account setups |
| `PORT` | Web server port (default: `3000`) |
| `CLAUDE_MODEL` | Claude model to use for chat (default: `claude-sonnet-4-6`) |
| `ANTHROPIC_API_KEY` | Anthropic API key for chat |
| `ANTHROPIC_FOUNDRY_API_KEY` | Akamai Foundry API key (overrides `ANTHROPIC_API_KEY`) |
| `ANTHROPIC_FOUNDRY_BASE_URL` | Akamai Foundry base URL |

---

## Example chat prompts

```
List my CDN properties
Show WAF security configs
What's the status of my DNS zone example.com?
Purge cache for https://www.example.com/images/logo.png
Add 1.2.3.4 to the block list
Show traffic report for CP code 12345
What's my cache offload rate?
Activate property prp_123456 version 42 to staging
```

---

## Project structure

```
akamai-agent/
├── src/
│   ├── index.js          # MCP server entry point
│   ├── auth.js           # EdgeGrid authentication
│   └── tools/
│       ├── delivery.js   # CDN property, cache purge tools
│       ├── security.js   # WAF, network list tools
│       ├── dns.js        # Edge DNS tools
│       └── reporting.js  # Traffic & security report tools
├── server.js             # Express web server + Claude chat API
├── public/
│   └── index.html        # Web UI (dashboard + chat)
└── package.json
```

---

## License

MIT
