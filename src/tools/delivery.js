import { akamaiRequest, getAccountKey } from '../auth.js';

function accountParam(section) {
  const key = getAccountKey(section);
  return key ? { accountSwitchKey: key } : {};
}

export const deliveryTools = [
  {
    name: 'list_properties',
    description: 'List all CDN properties (configurations) in the account. Shows property name, ID, staging/production activation status, and latest version.',
    inputSchema: {
      type: 'object',
      properties: {
        contractId: { type: 'string', description: 'Filter by contract ID (e.g. ctr_1-XXXXX). Optional.' },
        groupId:    { type: 'string', description: 'Filter by group ID (e.g. grp_12345). Optional.' },
        search:     { type: 'string', description: 'Filter properties by name substring. Optional.' },
      },
    },
    handler: async ({ contractId, groupId, search, _section } = {}) => {
      const data = await akamaiRequest('/papi/v1/properties', {
        params: { contractId, groupId, ...accountParam(_section) },
      }, _section);
      let items = data.properties?.items || [];
      if (search) items = items.filter(p => p.propertyName.toLowerCase().includes(search.toLowerCase()));
      const result = items.map(p => ({
        propertyId:         p.propertyId,
        propertyName:       p.propertyName,
        latestVersion:      p.latestVersion,
        stagingVersion:     p.stagingVersion,
        productionVersion:  p.productionVersion,
        contractId:         p.contractId,
        groupId:            p.groupId,
      }));
      return {
        count: result.length,
        properties: result,
        howTo: [
          'Use get_property_version to inspect the rules of a specific version.',
          'Use activate_property to push a version to staging or production.',
          "Use purge_cache to invalidate cached content for a property's CP code.",
        ],
      };
    },
  },

  {
    name: 'get_property_version',
    description: 'Get details and rules for a specific property version. Returns the full rules tree, origin, behaviors, and match criteria.',
    inputSchema: {
      type: 'object',
      required: ['propertyId', 'version'],
      properties: {
        propertyId:  { type: 'string', description: 'Property ID (e.g. prp_123456).' },
        version:     { type: 'number', description: 'Version number. Use -1 for latest, -2 for staging version, -3 for production version.' },
        contractId:  { type: 'string', description: 'Contract ID. Required by PAPI.' },
        groupId:     { type: 'string', description: 'Group ID. Required by PAPI.' },
      },
    },
    handler: async ({ propertyId, version, contractId, groupId, _section }) => {
      const data = await akamaiRequest(`/papi/v1/properties/${propertyId}/versions/${version}/rules`, {
        params: { contractId, groupId, ...accountParam(_section) },
      }, _section);
      return {
        propertyId,
        version,
        rules: data.rules,
        warnings: data.warnings || [],
        howTo: [
          'Modify the rules object and call activate_property to deploy changes.',
          'Look for "origin" behaviors to find where traffic is being sent.',
          'Check "caching" behaviors to understand TTLs currently in effect.',
        ],
      };
    },
  },

  {
    name: 'activate_property',
    description: 'Activate a property version to staging or production. Returns an activation ID you can poll for status.',
    inputSchema: {
      type: 'object',
      required: ['propertyId', 'version', 'network'],
      properties: {
        propertyId:       { type: 'string', description: 'Property ID (e.g. prp_123456).' },
        version:          { type: 'number', description: 'Version number to activate.' },
        network:          { type: 'string', enum: ['STAGING', 'PRODUCTION'], description: 'Target network.' },
        note:             { type: 'string', description: 'Activation note/reason. Recommended.' },
        notifyEmails:     { type: 'array', items: { type: 'string' }, description: 'Email addresses to notify on completion.' },
        acknowledgeAllWarnings: { type: 'boolean', description: 'Auto-acknowledge warnings. Default false.' },
        contractId:  { type: 'string' },
        groupId:     { type: 'string' },
      },
    },
    handler: async ({ propertyId, version, network, note, notifyEmails, acknowledgeAllWarnings, contractId, groupId, _section }) => {
      const data = await akamaiRequest(`/papi/v1/properties/${propertyId}/activations`, {
        method: 'POST',
        params: { contractId, groupId, ...accountParam(_section) },
        body: {
          propertyVersion: version,
          network,
          note: note || `Activated via Akamai Agent on ${new Date().toISOString()}`,
          notifyEmails: notifyEmails || [],
          acknowledgeAllWarnings: acknowledgeAllWarnings || false,
        },
      }, _section);
      return {
        activationId: data.activationLink?.split('/').pop(),
        activationLink: data.activationLink,
        status: 'PENDING',
        howTo: [
          `Activation to ${network} is in progress. It typically takes 5–15 minutes for STAGING, 15–45 minutes for PRODUCTION.`,
          'Check activation status in Akamai Control Center → Property Manager → Activations tab.',
          'You can also call the PAPI activations endpoint to poll status programmatically.',
        ],
      };
    },
  },

  {
    name: 'purge_cache',
    description: 'Invalidate or delete cached content on the Akamai edge network. Supports URL-based, tag-based, and CP code-based purges.',
    inputSchema: {
      type: 'object',
      required: ['type', 'network'],
      properties: {
        type:     { type: 'string', enum: ['url', 'cpcode', 'tag'], description: 'Purge target type.' },
        network:  { type: 'string', enum: ['staging', 'production'], description: 'Target edge network.' },
        action:   { type: 'string', enum: ['invalidate', 'delete'], description: 'invalidate (soft, re-fetches on next request) or delete (hard, removes immediately). Default: invalidate.' },
        objects:  { type: 'array', items: { type: 'string' }, description: 'List of URLs, CP codes (as strings), or cache tags to purge.' },
      },
    },
    handler: async ({ type, network, action = 'invalidate', objects, _section }) => {
      const endpoint = `/ccu/v3/${action}/${type}/${network}`;
      const data = await akamaiRequest(endpoint, {
        method: 'POST',
        body: { objects },
      }, _section);
      return {
        purgeId:          data.purgeId,
        httpStatus:       data.httpStatus,
        detail:           data.detail,
        estimatedSeconds: data.estimatedSeconds,
        howTo: [
          `Purge submitted (${action} by ${type} on ${network}). Estimated propagation: ${data.estimatedSeconds || '~5'} seconds.`,
          'Invalidate is preferred: edges serve stale content while re-fetching from origin. Delete forces a cold miss.',
          'For CP code purges, the CP code number should be passed as a string (e.g. "12345").',
          'Tag-based purge requires surrogate-control or edge-cache-tag headers on origin responses.',
        ],
      };
    },
  },

  {
    name: 'list_cp_codes',
    description: 'List CP codes (Content Provider codes) for a contract/group. CP codes are used for billing, traffic reporting, and cache purging.',
    inputSchema: {
      type: 'object',
      properties: {
        contractId: { type: 'string' },
        groupId:    { type: 'string' },
        search:     { type: 'string', description: 'Filter by CP code name substring.' },
      },
    },
    handler: async ({ contractId, groupId, search, _section } = {}) => {
      const data = await akamaiRequest('/papi/v1/cpcodes', {
        params: { contractId, groupId, ...accountParam(_section) },
      }, _section);
      let items = data.cpcodes?.items || [];
      if (search) items = items.filter(c => c.cpcodeName.toLowerCase().includes(search.toLowerCase()));
      return {
        count: items.length,
        cpCodes: items.map(c => ({
          cpcodeId:   c.cpcodeId,
          cpcodeName: c.cpcodeName,
          products:   c.productIds,
          createdDate: c.createdDate,
        })),
        howTo: [
          'CP codes appear in traffic reports as billing and reporting dimensions.',
          'Use the cpcodeId (numeric part only) as the object in a purge_cache call with type "cpcode".',
          'Assign CP codes to property rules via the Content Provider Code behavior in Property Manager.',
        ],
      };
    },
  },
];
