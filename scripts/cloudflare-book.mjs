#!/usr/bin/env node
// Sets a book up on Cloudflare from its site.yaml: the zone of `url`, the assets bucket with its custom domain and
// CORS, the site bucket, the cache rule and the SVG header rule on the assets host, and tiered cache. Every step
// is skipped when it is already done, so the script can run again after the zone goes active.
//
//   CF_TOKEN=<token> node node_modules/@openbooknetwork/kitap/scripts/cloudflare-book.mjs [--lock] [--dry-run]
//
// The token needs, on the account: Zone Edit, Workers R2 Storage Edit, DNS Edit; on the zone: Zone Read, Zone
// Settings Edit, Cache Rules Edit, Transform Rules Edit. --lock adds the bucket lock on images/, for after the
// first upload is checked. What stays manual: the nameservers at the registrar, and the R2 and wrangler tokens.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import yaml from 'js-yaml';

const API = 'https://api.cloudflare.com/client/v4';
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const { values } = parseArgs({ options: { lock: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, account: { type: 'string' } } });
const site = yaml.load(fs.readFileSync('site.yaml', 'utf8'));
for (const k of ['url', 'assets', 'pages']) if (!site[k]) fail(`site.yaml has no ${k}, see kitap's README under Deploy`);
const zoneName = new URL(site.url).hostname.replace(/^www\./, '');
const assetsHost = new URL(site.assets.url).hostname;
const assetsBucket = site.assets.bucket, siteBucket = site.pages.bucket;
const token = process.env.CF_TOKEN, dry = values['dry-run'];
if (!token && !dry) fail('set CF_TOKEN to a Cloudflare API token, see the head of this script for its permissions');

console.log(`${zoneName}: assets ${assetsBucket} at ${assetsHost}, site ${siteBucket}`);
if (dry) { console.log('dry run: nothing is sent'); process.exit(0); }

const account = values.account ?? await accountId();
const zone = await ensureZone();
await ensureBucket(assetsBucket);
await ensureBucket(siteBucket);
await cors(assetsBucket);
await managedDomainOff(assetsBucket);
await customDomain(assetsBucket);
await rules();
if (values.lock) await lock(assetsBucket);
console.log(zone.status === 'active' ? `${zoneName} is set up` : `${zoneName} is ${zone.status}: point the registrar at ${zone.name_servers.join(' and ')}, then run this again`);

async function accountId() {
  const list = await call('GET', '/accounts');
  if (list.length !== 1) fail(`the token sees ${list.length} accounts, pass --account <id>`);
  return list[0].id;
}

async function ensureZone() {
  const found = await call('GET', `/zones?name=${zoneName}`);
  if (found.length) { console.log(`zone ${zoneName}: ${found[0].status}`); return found[0]; }
  const z = await call('POST', '/zones', { name: zoneName, account: { id: account }, type: 'full' });
  console.log(`zone ${zoneName}: added, nameservers ${z.name_servers.join(' and ')}`);
  return z;
}

async function ensureBucket(name) {
  const res = await fetch(`${API}/accounts/${account}/r2/buckets/${name}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.ok) { console.log(`bucket ${name}: exists`); return; }
  await call('POST', `/accounts/${account}/r2/buckets`, { name });
  console.log(`bucket ${name}: created`);
}

async function cors(bucket) {
  await call('PUT', `/accounts/${account}/r2/buckets/${bucket}/cors`, { rules: [{ allowed: { origins: ['*'], methods: ['GET', 'HEAD'] } }] });
  console.log(`bucket ${bucket}: CORS GET and HEAD from anywhere`);
}

// the r2.dev URL skips the cache, so the custom domain is the only way in
async function managedDomainOff(bucket) {
  await call('PUT', `/accounts/${account}/r2/buckets/${bucket}/domains/managed`, { enabled: false });
}

async function customDomain(bucket) {
  const { domains } = await call('GET', `/accounts/${account}/r2/buckets/${bucket}/domains/custom`);
  if (domains.some(d => d.domain === assetsHost)) { console.log(`bucket ${bucket}: ${assetsHost} attached`); return; }
  if (zone.status !== 'active') { console.log(`bucket ${bucket}: ${assetsHost} waits for the zone to go active`); return; }
  await call('POST', `/accounts/${account}/r2/buckets/${bucket}/domains/custom`, { domain: assetsHost, zoneId: zone.id, enabled: true, minTLS: '1.2' });
  console.log(`bucket ${bucket}: ${assetsHost} attached`);
}

async function rules() {
  await call('PUT', `/zones/${zone.id}/rulesets/phases/http_request_cache_settings/entrypoint`, { rules: [{
    description: 'assets',
    expression: `(http.host eq "${assetsHost}")`,
    action: 'set_cache_settings',
    action_parameters: {
      cache: true,
      cache_key: { custom_key: { query_string: { exclude: { all: true } } } },
      // a 404 stays uncached, so a strict build right after an upload sees the new keys
      edge_ttl: { mode: 'respect_origin', status_code_ttl: [{ status_code: 404, value: -1 }] },
    },
  }] });
  await call('PUT', `/zones/${zone.id}/rulesets/phases/http_response_headers_transform/entrypoint`, { rules: [{
    description: 'svg csp',
    expression: `(http.host eq "${assetsHost}" and ends_with(http.request.uri.path, ".svg"))`,
    action: 'rewrite',
    action_parameters: { headers: { 'Content-Security-Policy': { operation: 'set', value: CSP } } },
  }] });
  await call('PATCH', `/zones/${zone.id}/cache/tiered_cache_smart_topology_enable`, { value: 'on' });
  console.log(`zone ${zoneName}: cache rule, SVG header rule and tiered cache`);
}

// the store then refuses to delete or overwrite an image, whoever asks
async function lock(bucket) {
  await call('PUT', `/accounts/${account}/r2/buckets/${bucket}/lock`, { rules: [{ id: 'images', enabled: true, prefix: 'images/', condition: { type: 'Indefinite' } }] });
  console.log(`bucket ${bucket}: images/ locked`);
}

async function call(method, path, body) {
  const res = await fetch(API + path, { method, body: body && JSON.stringify(body), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const out = await res.json();
  if (!out.success) fail(`${method} ${path} failed: ${JSON.stringify(out.errors, null, 2)}`);
  return out.result;
}

function fail(message) { console.error(message); process.exit(1); }
