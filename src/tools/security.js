import { akamaiRequest, getAccountKey } from '../auth.js';

function accountParam() {
  const key = getAccountKey();
  return key ? { accountSwitchKey: key } : {};
}

export const securityTools = [
  {
    name: 'list_security_configs',
    description: 'List all Application Security (WAF/bot protection) configurations in the account. Shows config name, ID, and active versions.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Filter by config name substring.' },
      },
    },
    handler: async ({ search } = {}) => {
      const data = await akamaiRequest('/appsec/v1/configs', {
        params: accountParam(),
      });
      let items = data.configurations || [];
      if (search) items = items.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
      return {
        count: items.length,
        configurations: items.map(c => ({
          id:                c.id,
          name:              c.name,
          description:       c.description,
          latestVersion:     c.latestVersion,
          stagingVersion:    c.stagingVersion,
          productionVersion: c.productionVersion,
          targetHosts:       c.targetHosts,
        })),
        howTo: [
          'Use get_security_config to inspect policies, rate limits, and WAF rule sets within a config.',
          'Use update_network_list to add/remove IPs from allow or block lists attached to a security config.',
          'Use activate_security_config to push changes to staging or production.',
        ],
      };
    },
  },

  {
    name: 'get_security_config',
    description: 'Get details of a security configuration version, including security policies, WAF rules, rate limits, and bot protection settings.',
    inputSchema: {
      type: 'object',
      required: ['configId', 'version'],
      properties: {
        configId: { type: 'number', description: 'Security config ID (from list_security_configs).' },
        version:  { type: 'number', description: 'Config version number. Use the latestVersion from list_security_configs.' },
      },
    },
    handler: async ({ configId, version }) => {
      const [config, policies] = await Promise.all([
        akamaiRequest(`/appsec/v1/configs/${configId}/versions/${version}`, { params: accountParam() }),
        akamaiRequest(`/appsec/v1/configs/${configId}/versions/${version}/security-policies`, { params: accountParam() }),
      ]);
      return {
        configId,
        version,
        name:        config.configName,
        description: config.description,
        policies: (policies.policies || []).map(p => ({
          id:              p.id,
          name:            p.name,
          hasRateLimiting: p.hasRateLimiting,
          hasWaf:          p.hasWaf,
          hasBotProtection:p.hasBotProtection,
        })),
        howTo: [
          'Each security policy maps to one or more hostnames and controls WAF, rate limiting, and bot rules.',
          'To add an IP to an allow or block list, first call list_network_lists to find the right list, then update_network_list.',
          'WAF rule tune-up: use the App Security API policy → waf-attack-groups endpoint to adjust rule actions (alert, deny, or disabled).',
        ],
      };
    },
  },

  {
    name: 'list_network_lists',
    description: 'List network lists (IP/geo allow and block lists) available in the account. These can be referenced in security configs and property rules.',
    inputSchema: {
      type: 'object',
      properties: {
        type:       { type: 'string', enum: ['IP', 'GEO'], description: 'Filter by list type. Omit for all.' },
        search:     { type: 'string', description: 'Filter by list name substring.' },
        extended:   { type: 'boolean', description: 'Include element count and last update info.' },
      },
    },
    handler: async ({ type, search, extended } = {}) => {
      const data = await akamaiRequest('/network-list/v2/network-lists', {
        params: { type, search, extended, ...accountParam() },
      });
      const items = data.networkLists || [];
      return {
        count: items.length,
        networkLists: items.map(l => ({
          uniqueId:       l.uniqueId,
          name:           l.name,
          type:           l.type,
          elementCount:   l.elementCount,
          syncPoint:      l.syncPoint,
          stagingStatus:  l.staging?.status,
          productionStatus: l.production?.status,
        })),
        howTo: [
          'Use update_network_list to add or remove IPs/CIDRs from a list.',
          'After updating, call activate_network_list to push changes to staging or production.',
          'Network lists referenced in security configs automatically apply their rules to incoming traffic.',
          'GEO lists use ISO 3166-1 alpha-2 country codes (e.g., "CN", "RU").',
        ],
      };
    },
  },

  {
    name: 'update_network_list',
    description: 'Add or remove IP addresses, CIDRs, or geo codes from an existing network list.',
    inputSchema: {
      type: 'object',
      required: ['uniqueId', 'action', 'elements'],
      properties: {
        uniqueId: { type: 'string', description: 'Network list unique ID (from list_network_lists).' },
        action:   { type: 'string', enum: ['ADD', 'REMOVE'], description: 'Whether to add or remove elements.' },
        elements: { type: 'array', items: { type: 'string' }, description: 'IPs, CIDRs (e.g. "1.2.3.0/24"), or ISO country codes to add/remove.' },
      },
    },
    handler: async ({ uniqueId, action, elements }) => {
      const endpoint = `/network-list/v2/network-lists/${uniqueId}/append`;
      let data;
      if (action === 'ADD') {
        data = await akamaiRequest(endpoint, {
          method: 'POST',
          body: { list: elements },
        });
      } else {
        // REMOVE: get current list, subtract elements, PUT full list
        const current = await akamaiRequest(`/network-list/v2/network-lists/${uniqueId}`, {
          params: accountParam(),
        });
        const remaining = (current.list || []).filter(e => !elements.includes(e));
        data = await akamaiRequest(`/network-list/v2/network-lists/${uniqueId}`, {
          method: 'PUT',
          body: { ...current, list: remaining },
        });
      }
      return {
        uniqueId,
        action,
        elements,
        syncPoint: data.syncPoint,
        message:   `${elements.length} element(s) ${action === 'ADD' ? 'added to' : 'removed from'} network list ${uniqueId}.`,
        howTo: [
          'Changes are staged locally until activated. Call activate_network_list to push to the edge.',
          'To block a range of IPs, use CIDR notation: "192.168.1.0/24" blocks the whole /24 subnet.',
          'Verify the list contents in Control Center: Security → Network Lists.',
        ],
      };
    },
  },

  {
    name: 'activate_network_list',
    description: 'Activate a network list to staging or production, applying any pending add/remove changes to live traffic.',
    inputSchema: {
      type: 'object',
      required: ['uniqueId', 'network'],
      properties: {
        uniqueId:     { type: 'string', description: 'Network list unique ID.' },
        network:      { type: 'string', enum: ['STAGING', 'PRODUCTION'], description: 'Target network.' },
        comment:      { type: 'string', description: 'Reason for activation.' },
        notifyEmails: { type: 'array', items: { type: 'string' }, description: 'Notification email addresses.' },
      },
    },
    handler: async ({ uniqueId, network, comment, notifyEmails }) => {
      const data = await akamaiRequest(`/network-list/v2/network-lists/${uniqueId}/environments/${network}/activate`, {
        method: 'POST',
        body: {
          comments:     comment || `Activated via Akamai Agent on ${new Date().toISOString()}`,
          notificationRecipients: notifyEmails || [],
        },
      });
      return {
        uniqueId,
        network,
        activationStatus: data.activationStatus,
        howTo: [
          `Network list activation to ${network} submitted. Changes propagate within 2–5 minutes.`,
          'You can poll GET /network-list/v2/network-lists/{uniqueId}/environments/{env}/status for completion.',
          'PRODUCTION activation requires a separate activation from STAGING — test on STAGING first.',
        ],
      };
    },
  },

  {
    name: 'activate_security_config',
    description: 'Activate a security configuration version to staging or production.',
    inputSchema: {
      type: 'object',
      required: ['configId', 'version', 'network'],
      properties: {
        configId:     { type: 'number', description: 'Security config ID.' },
        version:      { type: 'number', description: 'Version to activate.' },
        network:      { type: 'string', enum: ['STAGING', 'PRODUCTION'] },
        note:         { type: 'string', description: 'Reason for activation.' },
        notifyEmails: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: async ({ configId, version, network, note, notifyEmails }) => {
      const data = await akamaiRequest(`/appsec/v1/activations`, {
        method: 'POST',
        params: accountParam(),
        body: {
          action:            'ACTIVATE',
          network,
          note:              note || `Activated via Akamai Agent on ${new Date().toISOString()}`,
          notificationEmails: notifyEmails || [],
          activationConfigs: [{ configId, configVersion: version }],
        },
      });
      return {
        activationId: data.activationId,
        status:       data.status,
        network,
        howTo: [
          `Security config activation to ${network} submitted (ID: ${data.activationId}).`,
          'Activation typically completes in 10–15 minutes.',
          'Always activate to STAGING first to validate WAF rules without impacting production traffic.',
          'Monitor for false positives in the security event logs for 24–48 hours after PRODUCTION activation.',
        ],
      };
    },
  },
];
