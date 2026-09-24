import EdgeGrid from 'akamai-edgegrid';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function resolveCredentials(section) {
  const edgercPath = process.env.AKAMAI_EDGERC_PATH || join(homedir(), '.edgerc');
  const sectionName = section || process.env.AKAMAI_EDGERC_SECTION || 'default';

  // Prefer explicit env vars over .edgerc
  if (process.env.AKAMAI_CLIENT_TOKEN && process.env.AKAMAI_CLIENT_SECRET &&
      process.env.AKAMAI_ACCESS_TOKEN && process.env.AKAMAI_HOST) {
    return {
      client_token: process.env.AKAMAI_CLIENT_TOKEN,
      client_secret: process.env.AKAMAI_CLIENT_SECRET,
      access_token: process.env.AKAMAI_ACCESS_TOKEN,
      host: process.env.AKAMAI_HOST.replace(/^https?:\/\//, ''),
      account_key: process.env.AKAMAI_ACCOUNT_KEY,
    };
  }

  if (!existsSync(edgercPath)) {
    throw new Error(
      `No Akamai credentials found. Create ~/.edgerc or set AKAMAI_CLIENT_TOKEN, ` +
      `AKAMAI_CLIENT_SECRET, AKAMAI_ACCESS_TOKEN, AKAMAI_HOST environment variables.\n\n` +
      `HOW TO GET CREDENTIALS:\n` +
      `1. Log in to Akamai Control Center (control.akamai.com)\n` +
      `2. Go to Identity & Access Management → API Clients\n` +
      `3. Create a new API client with access to: PAPI, Fast Purge, App Security, Edge DNS, Reporting\n` +
      `4. Download credentials and save to ~/.edgerc`
    );
  }

  const eg = new EdgeGrid({ path: edgercPath, section: sectionName });
  const cfg = eg.config;
  if (!cfg || !cfg.host) {
    throw new Error(
      `Section [${sectionName}] not found or incomplete in ${edgercPath}. ` +
      `Ensure client_token, client_secret, access_token, and host are all present.`
    );
  }
  return cfg;
}

// Make an authenticated request to an Akamai API
export async function akamaiRequest(path, { method = 'GET', body, params } = {}, section = null) {
  const creds = resolveCredentials(section);
  const host = creds.host.startsWith('https://') ? creds.host : `https://${creds.host}`;

  const url = new URL(path, host);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }

  const eg = new EdgeGrid({
    client_token: creds.client_token,
    client_secret: creds.client_secret,
    access_token: creds.access_token,
    host: creds.host,
  });

  return new Promise((resolve, reject) => {
    const req = {
      url: url.toString(),
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) req.body = JSON.stringify(body);

    eg.auth(req);
    eg.send((error, response, responseBody) => {
      if (error) return reject(error);
      try {
        const data = responseBody ? JSON.parse(responseBody) : {};
        if (response.statusCode >= 400) {
          reject(new Error(`Akamai API error ${response.statusCode}: ${JSON.stringify(data)}`));
        } else {
          resolve(data);
        }
      } catch {
        resolve(responseBody);
      }
    });
  });
}

export function getAccountKey(section = null) {
  return process.env.AKAMAI_ACCOUNT_KEY || resolveCredentials(section).account_key || '';
}
