import { akamaiRequest, getAccountKey } from '../auth.js';

function accountParam(section) {
  const key = getAccountKey(section);
  return key ? { accountSwitchKey: key } : {};
}

// Helper to format a date for Akamai Reporting API (ISO 8601)
function toReportDate(d) {
  return d instanceof Date ? d.toISOString() : d;
}

// Default time range: last 24 hours
function defaultRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export const reportingTools = [
  {
    name: 'get_traffic_report',
    description: 'Get traffic volume and performance metrics for a CP code or set of properties. Returns edge hits, bytes delivered, offload rate, and origin hits by time interval.',
    inputSchema: {
      type: 'object',
      required: ['cpCodes'],
      properties: {
        cpCodes:   { type: 'array', items: { type: 'number' }, description: 'CP code numbers to report on.' },
        startDate: { type: 'string', description: 'Start of reporting window (ISO 8601). Default: 24 hours ago.' },
        endDate:   { type: 'string', description: 'End of reporting window (ISO 8601). Default: now.' },
        interval:  { type: 'string', enum: ['FIVE_MINUTES', 'ONE_HOUR', 'ONE_DAY'], description: 'Aggregation interval. Default: ONE_HOUR.' },
        metrics:   { type: 'array', items: { type: 'string' }, description: 'Metrics to include. Options: edgeHits, edgeBytes, originHits, originBytes, offloadRate. Default: all.' },
      },
    },
    handler: async ({ cpCodes, startDate, endDate, interval = 'ONE_HOUR', metrics, _section } = {}) => {
      const range = defaultRange();
      const body = {
        objectType: 'cpcode',
        objectIds:  cpCodes.map(String),
        metrics:    metrics || ['edgeHits', 'edgeBytes', 'originHits', 'originBytes', 'offloadRate'],
        startDate:  startDate || range.start,
        endDate:    endDate || range.end,
        interval,
      };
      const data = await akamaiRequest('/reporting-api/v1/reports/bytes-by-cpcode/versions/1/report-data', {
        method: 'POST',
        params: accountParam(_section),
        body,
      }, _section);
      const rows = data.data || [];
      const summary = rows.reduce((acc, r) => {
        acc.totalEdgeHits   = (acc.totalEdgeHits   || 0) + (r.edgeHits   || 0);
        acc.totalEdgeBytes  = (acc.totalEdgeBytes  || 0) + (r.edgeBytes  || 0);
        acc.totalOriginHits = (acc.totalOriginHits || 0) + (r.originHits || 0);
        return acc;
      }, {});
      const avgOffload = rows.length
        ? (rows.reduce((s, r) => s + (r.offloadRate || 0), 0) / rows.length).toFixed(2)
        : 0;

      return {
        cpCodes,
        interval,
        timeRange:        { start: body.startDate, end: body.endDate },
        summary: {
          totalEdgeHits:   summary.totalEdgeHits,
          totalEdgeBytes:  summary.totalEdgeBytes,
          totalOriginHits: summary.totalOriginHits,
          averageOffloadRate: `${avgOffload}%`,
        },
        data: rows,
        howTo: [
          'offloadRate is the percentage of traffic served from Akamai edge without hitting origin. >90% is healthy.',
          'A spike in originHits may indicate a cache miss storm — check if TTLs were reduced or cache was purged.',
          'Use shorter intervals (FIVE_MINUTES) to investigate incidents; ONE_DAY for trend analysis.',
          'Compare edgeBytes vs originBytes to understand bandwidth savings from CDN caching.',
        ],
      };
    },
  },

  {
    name: 'get_error_report',
    description: 'Get HTTP error rates (4xx and 5xx) broken down by error type, for a CP code or time range. Useful for identifying origin errors or misconfigurations.',
    inputSchema: {
      type: 'object',
      required: ['cpCodes'],
      properties: {
        cpCodes:   { type: 'array', items: { type: 'number' } },
        startDate: { type: 'string', description: 'ISO 8601 start. Default: 24 hours ago.' },
        endDate:   { type: 'string', description: 'ISO 8601 end. Default: now.' },
        interval:  { type: 'string', enum: ['FIVE_MINUTES', 'ONE_HOUR', 'ONE_DAY'], description: 'Default: ONE_HOUR.' },
      },
    },
    handler: async ({ cpCodes, startDate, endDate, interval = 'ONE_HOUR', _section }) => {
      const range = defaultRange();
      const data = await akamaiRequest('/reporting-api/v1/reports/error-summary-by-cpcode/versions/1/report-data', {
        method: 'POST',
        params: accountParam(_section),
        body: {
          objectType: 'cpcode',
          objectIds:  cpCodes.map(String),
          metrics:    ['errorRate4xx', 'errorRate5xx', 'edgeErrors', 'originErrors'],
          startDate:  startDate || range.start,
          endDate:    endDate || range.end,
          interval,
        },
      }, _section);
      const rows = data.data || [];
      const totals = rows.reduce((acc, r) => {
        acc.edgeErrors    = (acc.edgeErrors    || 0) + (r.edgeErrors    || 0);
        acc.originErrors  = (acc.originErrors  || 0) + (r.originErrors  || 0);
        return acc;
      }, {});

      return {
        cpCodes,
        timeRange: { start: startDate || range.start, end: endDate || range.end },
        totals,
        data: rows,
        howTo: [
          'edgeErrors are 4xx/5xx responses served from Akamai edge (may include 403s from WAF rules).',
          'originErrors are errors returned by your origin server — investigate if origin is healthy.',
          '5xx spikes at the edge without origin errors typically indicate a network or configuration issue.',
          'Use translate_error_string (from edge diagnostics) with a specific error reference code for root cause.',
        ],
      };
    },
  },

  {
    name: 'get_security_event_report',
    description: 'Get a summary of security events (WAF alerts, denies, rate limit triggers) for a security configuration over a time window.',
    inputSchema: {
      type: 'object',
      required: ['configId'],
      properties: {
        configId:    { type: 'number', description: 'Security config ID (from list_security_configs).' },
        startDate:   { type: 'string', description: 'ISO 8601 start. Default: 24 hours ago.' },
        endDate:     { type: 'string', description: 'ISO 8601 end. Default: now.' },
        policyId:    { type: 'string', description: 'Filter by specific security policy ID. Optional.' },
        attackGroup: { type: 'string', description: 'Filter by attack group (e.g. "SQL", "XSS", "CMDI"). Optional.' },
      },
    },
    handler: async ({ configId, startDate, endDate, policyId, attackGroup, _section }) => {
      const range = defaultRange();
      const params = {
        configId,
        from:   startDate || range.start,
        to:     endDate   || range.end,
        ...accountParam(_section),
      };
      if (policyId)    params.policyId    = policyId;
      if (attackGroup) params.attackGroup = attackGroup;

      const data = await akamaiRequest('/appsec/v1/security-events', { params }, _section);
      const events = data.data || data.events || [];
      const byAction = events.reduce((acc, e) => {
        acc[e.action] = (acc[e.action] || 0) + 1;
        return acc;
      }, {});

      return {
        configId,
        timeRange: { start: params.from, end: params.to },
        totalEvents: events.length,
        byAction,
        topAttackGroups: topN(events, 'attackGroup', 5),
        topIPs:          topN(events, 'clientIP', 5),
        topPaths:        topN(events, 'requestPath', 5),
        howTo: [
          'High "ALERT" counts with low "DENY" counts means WAF is in monitor mode — review and switch to block mode after tuning.',
          'Frequent hits from a single IP: add it to a block list with update_network_list.',
          'If legitimate traffic is being blocked (false positives), tune WAF rules in the App Security configuration.',
          'Rate limit events suggest an automated client or scraper — consider tightening rate limit thresholds.',
        ],
      };
    },
  },

  {
    name: 'get_offload_report',
    description: 'Get cache offload percentage and cache hit/miss breakdown to evaluate CDN efficiency for one or more CP codes.',
    inputSchema: {
      type: 'object',
      required: ['cpCodes'],
      properties: {
        cpCodes:   { type: 'array', items: { type: 'number' } },
        startDate: { type: 'string' },
        endDate:   { type: 'string' },
        interval:  { type: 'string', enum: ['FIVE_MINUTES', 'ONE_HOUR', 'ONE_DAY'], description: 'Default: ONE_HOUR.' },
      },
    },
    handler: async ({ cpCodes, startDate, endDate, interval = 'ONE_HOUR', _section }) => {
      const range = defaultRange();
      const data = await akamaiRequest('/reporting-api/v1/reports/hits-by-cpcode/versions/1/report-data', {
        method: 'POST',
        params: accountParam(_section),
        body: {
          objectType: 'cpcode',
          objectIds:  cpCodes.map(String),
          metrics:    ['cacheHits', 'cacheMisses', 'offloadRate'],
          startDate:  startDate || range.start,
          endDate:    endDate   || range.end,
          interval,
        },
      }, _section);
      const rows = data.data || [];
      const totals = rows.reduce((acc, r) => {
        acc.cacheHits    = (acc.cacheHits   || 0) + (r.cacheHits   || 0);
        acc.cacheMisses  = (acc.cacheMisses || 0) + (r.cacheMisses || 0);
        return acc;
      }, {});
      const avgOffload = rows.length
        ? (rows.reduce((s, r) => s + (r.offloadRate || 0), 0) / rows.length).toFixed(2)
        : 0;

      return {
        cpCodes,
        totals: { ...totals, averageOffloadRate: `${avgOffload}%` },
        data: rows,
        howTo: [
          'Target offload rate: >90% for static content, >70% for dynamic content with SureRoute.',
          'Low offload (cacheMisses >> cacheHits) causes: missing Cache-Control headers, query string variation not handled, short TTLs.',
          'Fix: add caching behavior in Property Manager with a TTL, and use the "Ignore Query String" option for static assets.',
          'Use purge_cache to reset cache after a config change so the new TTLs take effect immediately.',
        ],
      };
    },
  },
];

function topN(events, field, n) {
  const counts = events.reduce((acc, e) => {
    const val = e[field];
    if (val) acc[val] = (acc[val] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}
