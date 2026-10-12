#!/usr/bin/env node
// Deterministic, public test-only credentials. Never use these on a deployed Worker.
// Output is exclusively created; the real .dev.vars is never opened or overwritten.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const SYNTHETIC_TEST_HOSTS = [
  { host_id: 'synthetic-host-a', name: 'Synthetic studio · macOS', token: 'amc_synthetic_test_only_host_a_0123456789abcdef' },
  { host_id: 'synthetic-host-b', name: 'Synthetic build node · Linux', token: 'amc_synthetic_test_only_host_b_0123456789abcdef' },
  { host_id: 'synthetic-host-c', name: 'Synthetic travel laptop', token: 'amc_synthetic_test_only_host_c_0123456789abcdef' },
];

export function localOrigin(value = process.env.AMC_URL || 'http://127.0.0.1:8787') {
  let url;
  try { url = new URL(value); } catch { throw new Error('AMC_URL must be a loopback HTTP origin.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Synthetic checks require a loopback HTTP origin and never support production servers.');
  }
  return url.origin;
}

export function readTestHosts(minimum = 1, env = process.env) {
  let hosts;
  try { hosts = JSON.parse(env.AMC_TEST_HOSTS_JSON); } catch {
    throw new Error('Provide AMC_TEST_HOSTS_JSON using the isolated .env.test-hosts file. Run scripts/local-fixtures.mjs first.');
  }
  if (!Array.isArray(hosts) || hosts.length < minimum || hosts.length > 100) {
    throw new Error(`AMC_TEST_HOSTS_JSON must contain at least ${minimum} configured local test hosts (maximum 100).`);
  }
  const ids = new Set(), tokens = new Set();
  for (const host of hosts) {
    if (!host || typeof host !== 'object' || Array.isArray(host)
      || typeof host.host_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(host.host_id)
      || typeof host.name !== 'string' || !host.name.trim() || host.name.length > 160 || /[\x00-\x1f\x7f]/.test(host.name)
      || typeof host.token !== 'string' || !/^[A-Za-z0-9_.-]{32,256}$/.test(host.token)
      || ids.has(host.host_id) || tokens.has(host.token)) {
      throw new Error('AMC_TEST_HOSTS_JSON contains an invalid or duplicate host configuration.');
    }
    ids.add(host.host_id); tokens.add(host.token);
  }
  return hosts.map(({ host_id, name, token }) => ({ host_id, name, token }));
}

export async function assertLocalWorker(base) {
  const response = await fetch(`${localOrigin(base)}/api/me`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  const identity = response.ok ? await response.json() : null;
  if (identity?.local !== true) throw new Error('Synthetic checks require an isolated Worker with LOCAL_DEV=true.');
  return identity;
}

export function fixtureContents() {
  const hashes = SYNTHETIC_TEST_HOSTS.map(({ host_id, name, token }) => ({ host_id, name, token_hash: createHash('sha256').update(token).digest('hex') }));
  return {
    '.dev.vars.test': `# SYNTHETIC LOCAL TEST FIXTURES ONLY. Never deploy.\nLOCAL_DEV=true\nAGENT_TOKENS_JSON='${JSON.stringify(hashes)}'\n`,
    '.env.test-hosts': `# SYNTHETIC LOCAL TEST FIXTURES ONLY. Never deploy.\nAMC_TEST_HOSTS_JSON='${JSON.stringify(SYNTHETIC_TEST_HOSTS)}'\n`,
  };
}

export async function writeLocalFixtures(directory = root) {
  const created = [];
  try {
    for (const [name, content] of Object.entries(fixtureContents())) {
      const file = path.join(directory, name);
      await fs.writeFile(file, content, { mode: 0o600, flag: 'wx' });
      created.push(file);
    }
  } catch (error) {
    for (const file of created) await fs.rm(file, { force: true });
    if (error.code === 'EEXIST') throw new Error('Fixture file already exists; refusing to overwrite it. Reuse it or choose an empty output directory.');
    throw error;
  }
  return created;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/local-fixtures.mjs [existing-output-directory]');
    await writeLocalFixtures(process.argv[2] ? path.resolve(process.argv[2]) : root);
    console.log('Created .dev.vars.test and .env.test-hosts with public synthetic fixtures (mode 0600).');
    console.log('Start Wrangler with --env-file .dev.vars.test and a separate --persist-to directory; this skips the real .dev.vars.');
    console.log('Run local scripts with node --env-file=.env.test-hosts. No credential values are printed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
