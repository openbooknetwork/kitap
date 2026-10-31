#!/usr/bin/env node
// Sends an old zone to a new one by 301, the apex and the assets host alike, path and query kept:
//
//   CF_TOKEN=<token> node node_modules/@openbooknetwork/kitap/scripts/cloudflare-redirect.mjs openhistoryatlas.org openhistorybook.org [--dry-run]
//
// The token needs Zone Read and Single Redirect Edit on the old zone. The rule replaces the zone's own redirect
// rules, so run it on a zone that has none or that this script made.
import { parseArgs } from 'node:util';

const API = 'https://api.cloudflare.com/client/v4';
const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' } } });
const [from, to] = positionals;
if (!from || !to) fail('usage: CF_TOKEN=<token> node cloudflare-redirect.mjs <old zone> <new zone> [--dry-run]');
const token = process.env.CF_TOKEN;
if (!token && !values['dry-run']) fail('set CF_TOKEN to a Cloudflare API token with Zone Read and Single Redirect Edit');

const body = redirectRules(from, to);
if (values['dry-run']) console.log(JSON.stringify(body, null, 2));
else {
  await call('PUT', `/zones/${await zoneId(from)}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, body);
  console.log(`${from} redirects to ${to}`);
}

// One rule per hostname: the apex to the new apex, the assets host to the new assets host, path and query kept.
function redirectRules(from, to) {
  const rule = (fromHost, toHost) => ({
    description: `${fromHost} to ${toHost}`,
    expression: `(http.host eq "${fromHost}")`,
    action: 'redirect',
    action_parameters: { from_value: {
      status_code: 301,
      target_url: { expression: `concat("https://${toHost}", http.request.uri.path)` },
      preserve_query_string: true,
    } },
  });
  return { rules: [rule(from, to), rule(`assets.${from}`, `assets.${to}`)] };
}

async function zoneId(name) {
  const res = await fetch(`${API}/zones?name=${name}`, { headers: { Authorization: `Bearer ${token}` } });
  const out = await res.json();
  if (!out.success) fail(`zone lookup failed: ${JSON.stringify(out.errors, null, 2)}`);
  if (!out.result.length) {
    fail(`the token sees no zone named ${name}: give it Zone Read on that zone`);
  }
  return out.result[0].id;
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method, body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const out = await res.json();
  if (!out.success) fail(`${method} ${path} failed: ${JSON.stringify(out.errors, null, 2)}`);
  return out.result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
