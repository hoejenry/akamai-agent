import { akamaiRequest, getAccountKey } from '../auth.js';

function accountParam(section) {
  const key = getAccountKey(section);
  return key ? { accountSwitchKey: key } : {};
}

export const dnsTools = [
  {
    name: 'list_dns_zones',
    description: 'List all Edge DNS zones managed in the account. Shows zone name, type (primary/secondary), contract, and activation status.',
    inputSchema: {
      type: 'object',
      properties: {
        search:     { type: 'string', description: 'Filter by zone name substring.' },
        contractIds:{ type: 'array', items: { type: 'string' }, description: 'Filter by contract IDs.' },
        showAll:    { type: 'boolean', description: 'Show all zones across all accounts (requires access). Default false.' },
      },
    },
    handler: async ({ search, contractIds, showAll, _section } = {}) => {
      const data = await akamaiRequest('/config-dns/v2/zones', {
        params: {
          search,
          contractIds: contractIds?.join(','),
          showAll,
          ...accountParam(_section),
        },
      }, _section);
      const zones = data.zones || [];
      return {
        count: zones.length,
        zones: zones.map(z => ({
          zone:         z.zone,
          type:         z.type,
          contractId:   z.contractId,
          activationState: z.activationState,
          lastModifiedDate: z.lastModifiedDate,
          signAndServe: z.signAndServe,
        })),
        howTo: [
          'Use list_dns_records to view all records within a specific zone.',
          'Use create_dns_record to add A, CNAME, MX, TXT, or other record types.',
          'DNSSEC (signAndServe: true) means Akamai signs all responses — changes propagate automatically.',
        ],
      };
    },
  },

  {
    name: 'list_dns_records',
    description: 'List all DNS records in a specific Edge DNS zone. Returns the full record set including type, name, TTL, and data.',
    inputSchema: {
      type: 'object',
      required: ['zone'],
      properties: {
        zone: { type: 'string', description: 'Zone name (e.g. "example.com").' },
        type: { type: 'string', description: 'Filter by record type (A, AAAA, CNAME, MX, TXT, NS, etc.). Optional.' },
        name: { type: 'string', description: 'Filter by record name. Optional.' },
      },
    },
    handler: async ({ zone, type, name, _section }) => {
      const data = await akamaiRequest(`/config-dns/v2/zones/${zone}/recordsets`, {
        params: { types: type, search: name, ...accountParam(_section) },
      }, _section);
      const records = data.recordsets || [];
      return {
        zone,
        count: records.length,
        records: records.map(r => ({
          name:  r.name,
          type:  r.type,
          ttl:   r.ttl,
          rdata: r.rdata,
        })),
        howTo: [
          'Use create_dns_record to add new records to this zone.',
          'Use delete_dns_record to remove a record by name and type.',
          'TTL values control DNS caching — lower TTLs allow faster propagation of changes (minimum 60 seconds).',
          'For failover or load balancing, use multiple A/AAAA records (round-robin) or consider Akamai GTM.',
        ],
      };
    },
  },

  {
    name: 'create_dns_record',
    description: 'Create a new DNS record in an Edge DNS zone. Supports all standard record types.',
    inputSchema: {
      type: 'object',
      required: ['zone', 'name', 'type', 'ttl', 'rdata'],
      properties: {
        zone:  { type: 'string', description: 'Zone name (e.g. "example.com").' },
        name:  { type: 'string', description: 'Record name (e.g. "www.example.com" or "www").' },
        type:  { type: 'string', description: 'Record type: A, AAAA, CNAME, MX, TXT, NS, SRV, CAA, etc.' },
        ttl:   { type: 'number', description: 'Time-to-live in seconds. Minimum 60.' },
        rdata: { type: 'array', items: { type: 'string' }, description: 'Record data. For A: ["1.2.3.4"]. For MX: ["10 mail.example.com."]. For TXT: ["v=spf1 include:... ~all"].' },
      },
    },
    handler: async ({ zone, name, type, ttl, rdata, _section }) => {
      await akamaiRequest(`/config-dns/v2/zones/${zone}/recordsets`, {
        method: 'POST',
        params: accountParam(_section),
        body: { name, type, ttl, rdata },
      }, _section);
      return {
        zone,
        created: { name, type, ttl, rdata },
        howTo: [
          `Record ${name} (${type}) created in zone ${zone}. Changes are live within the TTL propagation window.`,
          'Edge DNS changes propagate globally within seconds to minutes.',
          'For CNAME records, the rdata must be a fully qualified domain name ending with a dot (e.g. "target.example.com.").',
          'MX record format: "priority hostname." — e.g. "10 mail.example.com."',
        ],
      };
    },
  },

  {
    name: 'delete_dns_record',
    description: 'Delete a specific DNS record from an Edge DNS zone by name and type.',
    inputSchema: {
      type: 'object',
      required: ['zone', 'name', 'type'],
      properties: {
        zone: { type: 'string', description: 'Zone name.' },
        name: { type: 'string', description: 'Record name to delete.' },
        type: { type: 'string', description: 'Record type to delete.' },
      },
    },
    handler: async ({ zone, name, type, _section }) => {
      await akamaiRequest(`/config-dns/v2/zones/${zone}/recordsets/${name}/${type}`, {
        method: 'DELETE',
        params: accountParam(_section),
      }, _section);
      return {
        zone,
        deleted: { name, type },
        howTo: [
          `Record ${name} (${type}) deleted from zone ${zone}.`,
          'Deleted records are removed from DNS resolution within 60 seconds globally.',
          'If you deleted a record in error, you can recreate it immediately with create_dns_record.',
        ],
      };
    },
  },

  {
    name: 'get_dns_zone_status',
    description: 'Check the activation state and TSIG key configuration of a DNS zone. Useful for troubleshooting secondary zones and DNSSEC.',
    inputSchema: {
      type: 'object',
      required: ['zone'],
      properties: {
        zone: { type: 'string', description: 'Zone name.' },
      },
    },
    handler: async ({ zone, _section }) => {
      const data = await akamaiRequest(`/config-dns/v2/zones/${zone}`, {
        params: accountParam(_section),
      }, _section);
      return {
        zone:             data.zone,
        type:             data.type,
        activationState:  data.activationState,
        signAndServe:     data.signAndServe,
        contractId:       data.contractId,
        masters:          data.masters,
        tsigKey:          data.tsigKey ? { name: data.tsigKey.name, algorithm: data.tsigKey.algorithm } : null,
        comment:          data.comment,
        howTo: [
          'activationState: ACTIVE means the zone is serving DNS traffic.',
          'signAndServe: true means DNSSEC is enabled — do not change NS records manually.',
          'For SECONDARY zones, "masters" lists the primary nameserver IPs that Edge DNS pulls from via AXFR/IXFR.',
          'TSIG is required for secure zone transfers on secondary zones.',
        ],
      };
    },
  },
];
