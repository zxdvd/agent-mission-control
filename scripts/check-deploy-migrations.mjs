import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function assertMigrationsApplied(output, localNames) {
  const response = JSON.parse(output);
  if (!Array.isArray(response) || response.length !== 1 || response[0]?.success !== true || !Array.isArray(response[0].results)) {
    throw new Error('Remote migration ledger response was not successful.');
  }
  const rows = response[0].results;
  if (!rows.every(row => row && Object.keys(row).length === 1 && typeof row.name === 'string')) {
    throw new Error('Remote migration ledger response was malformed.');
  }
  const applied = rows.map(row => row.name).sort();
  const expected = [...localNames].sort();
  if (!expected.length || new Set(applied).size !== applied.length || JSON.stringify(applied) !== JSON.stringify(expected)) {
    throw new Error('Remote migration ledger differs from this commit. Review pending or unexpected migrations before deployment.');
  }
}

export function checkProductionMigrations(runWrangler = args => execFileSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), ...args,
], { encoding: 'utf8', timeout: 60000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] })) {
  const names = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql'));
  // Unlike `d1 migrations list`, this never initializes a missing migrations table.
  // Query only filenames, not application data; no stdout/stderr or credentials
  // from Wrangler are echoed. A missing table or API failure stops deployment.
  const output = runWrangler([
    'd1', 'execute', 'mission-control', '--remote', '--config', '.wrangler.deploy.json',
    '--command', 'SELECT name FROM d1_migrations ORDER BY id', '--json',
  ]);
  assertMigrationsApplied(output, names);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkProductionMigrations();
    console.log('Remote migration ledger matches this commit. No migrations were applied by this check.');
  } catch {
    console.error('Deployment stopped: remote migration state could not be verified. Review pending migrations and use an explicitly approved manual migration if needed; check D1 access if it persists. Database contents and credentials were not printed.');
    process.exitCode = 1;
  }
}
