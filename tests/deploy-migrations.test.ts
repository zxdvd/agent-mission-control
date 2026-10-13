import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error The migration guard is a plain Node deployment utility.
import { assertMigrationsApplied, checkProductionMigrations } from '../scripts/check-deploy-migrations.mjs';

const names = readdirSync('migrations').filter(name => name.endsWith('.sql')).sort();
const ledger = (applied: string[]) => JSON.stringify([{ success: true, results: applied.map(name => ({ name })), meta: { rows_read: applied.length } }]);

describe('read-only production migration ledger gate', () => {
  it('queries only the migration filenames with a fixed SELECT and machine-readable JSON', () => {
    const execute = vi.fn(() => ledger(names));
    expect(() => checkProductionMigrations(execute)).not.toThrow();
    expect(execute.mock.calls).toEqual([[
      ['d1', 'execute', 'mission-control', '--remote', '--config', '.wrangler.deploy.json', '--command', 'SELECT name FROM d1_migrations ORDER BY id', '--json'],
    ]]);
  });

  it('accepts the exact migration set independently of ledger row order', () => {
    expect(() => assertMigrationsApplied(ledger([...names].reverse()), names)).not.toThrow();
  });

  it.each([
    ['empty ledger', []],
    ['pending migration', names.slice(1)],
    ['unexpected migration', [...names, '9999_unexpected.sql']],
    ['duplicate migration', [...names, names[0]]],
  ])('stops deployment for %s', (_description, applied) => {
    expect(() => assertMigrationsApplied(ledger(applied as string[]), names)).toThrow();
  });

  it.each([
    '', 'not JSON', '[]', '{}',
    JSON.stringify([{ success: false, results: names.map(name => ({ name })) }]),
    JSON.stringify([{ results: names.map(name => ({ name })) }]),
    JSON.stringify([{ success: true, results: null }]),
    JSON.stringify([{ success: true, results: [null] }]),
    JSON.stringify([{ success: true, results: [{ name: 123 }] }]),
    JSON.stringify([{ success: true, results: names.map(name => ({ name, unexpected: 'synthetic-data' })) }]),
    JSON.stringify([{ success: true, results: [] }, { success: true, results: [] }]),
  ])('fails closed on malformed or unsuccessful output %s', output => {
    expect(() => assertMigrationsApplied(output, names)).toThrow();
  });

  it('never accepts a repository with no migration files', () => {
    expect(() => assertMigrationsApplied(ledger([]), [])).toThrow();
  });

  it('fails closed if the remote query fails or its table is missing', () => {
    const execute = vi.fn(() => { throw new Error('synthetic-query-failure'); });
    expect(() => checkProductionMigrations(execute)).toThrow();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('parses the installed Wrangler JSON format using only an isolated synthetic local D1 database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-ledger-'));
    const cli = resolve('node_modules/wrangler/bin/wrangler.js');
    const config = join(directory, 'wrangler.json');
    writeFileSync(config, JSON.stringify({
      name: 'synthetic-ledger-check', compatibility_date: '2026-10-01',
      d1_databases: [{ binding: 'DB', database_name: 'synthetic-ledger', database_id: '00000000-0000-0000-0000-000000000000' }],
    }));
    const execute = (command: string) => execFileSync(process.execPath, [
      cli, 'd1', 'execute', 'synthetic-ledger', '--local', '--config', config,
      '--persist-to', join(directory, 'state'), '--command', command, '--json',
    ], {
      cwd: directory, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLOUDFLARE_API_TOKEN: '', WRANGLER_SEND_METRICS: 'false', CI: 'true', HOME: directory,
        XDG_CONFIG_HOME: directory, WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
    });
    try {
      execute(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT); ${names.map(name => `INSERT INTO d1_migrations (name) VALUES ('${name.replaceAll("'", "''")}');`).join(' ')}`);
      const output = execute('SELECT name FROM d1_migrations ORDER BY id');
      expect(() => assertMigrationsApplied(output, names)).not.toThrow();
      expect(() => assertMigrationsApplied(output, [...names, '9999_pending.sql'])).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
