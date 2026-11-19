#!/usr/bin/env node
/**
 * Push model providers from a JSON file into a running TrueForge (local mode, no auth).
 *   node trueforge/configure-models.mjs trueforge/models.local.json [http://localhost:8790]
 * The file format is trueforge/models.example.json. TrueForge stores the key locally and uses it with the provider.
 */
import fs from 'node:fs';

const [, , file, base = 'http://localhost:8790'] = process.argv;
if (!file) { console.error('usage: configure-models.mjs <models.json> [baseUrl]'); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const p of cfg.providers ?? []) {
  const m = p.manifest;
  if (JSON.stringify(m).includes('REPLACE_ME')) { console.log(`skip ${m.type}${m.name ? '/' + m.name : ''}: placeholder key`); continue; }
  const res = await fetch(`${base}/api/v1/settings/model-providers`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: m }) });
  console.log(`${res.ok ? 'ok ' : 'ERR'} ${m.type}${m.name ? '/' + m.name : ''} ${res.ok ? '' : 'HTTP ' + res.status}`);
  if (!res.ok) process.exitCode = 1;
}
const models = await fetch(`${base}/api/v1/models`).then(r => r.json());
console.log('models now available to Anvil:', models.data.map(m => m.name).join(', ') || '(none)');
