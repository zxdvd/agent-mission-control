import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "amc bootstrap ' space $HOME $(echo wrong) `printf wrong` "));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), home = path.join(dir, 'home'), state = path.join(dir, 'state'), root = path.join(dir, 'installed'), codex = path.join(dir, 'codex'), token = path.join(dir, 'private token');
  await fs.mkdir(bin); await fs.mkdir(home); await fs.mkdir(codex);
  await fs.writeFile(token, `${'fixture-token-'.repeat(5)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(bin, 'curl'), `#!/bin/sh\n[ "\${FAKE_FAIL:-}" != yes ] || exit 22\nwhile [ "$#" -gt 0 ]; do case "$1" in https:*) url=$1;; -o) shift; output=$1;; esac; shift; done\nfile=\${url##*/}\ncp "$AMC_FIXTURE_SOURCE/$file" "$output"\n[ "\${FAKE_CORRUPT:-}" != yes ] || printf 'bad' >> "$output"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, AMC_FIXTURE_SOURCE: path.join(repo, 'adapters') };
  const base = ['--install-dir', root, '--state-dir', state, '--codex-home', codex];
  const run = (args = [], extra = {}) => spawnSync('/bin/sh', [path.join(repo, 'install.sh'), ...base, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const init = ['--server', 'https://example.com', '--host-id', 'fixture-host', '--token-file', token];
  return { dir, bin, home, state, root, codex, token, env, base, run, init };
}
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
test('bootstrap installs four pinned files, safely merges hooks, reuses token, upgrades and uninstalls', async t => {
  const f = await fixture(t), settingsFile = path.join(f.codex, 'hooks.json');
  const unrelated = { hooks: [{ type: 'command', command: 'echo unrelated' }] };
  await fs.writeFile(settingsFile, JSON.stringify({ custom: 'keep', hooks: { Stop: [unrelated] } }));
  let result = f.run(f.init); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('fixture-token-'), false);
  const first = await fs.readFile(settingsFile, 'utf8'), config = await fs.readFile(path.join(f.state, 'config.json'), 'utf8');
  assert.equal((await json(settingsFile)).hooks.Stop.length, 2);
  assert.deepEqual((await json(settingsFile)).hooks.Stop[0], unrelated);
  assert.equal((await json(settingsFile)).custom, 'keep');
  const command = (await json(settingsFile)).hooks.Stop[1].hooks[0].command;
  assert.ok(command.includes('amc-managed-v1'));
  assert.deepEqual((await fs.readdir(path.join(f.root, 'adapters'))).sort(), ['amc.mjs', 'core.mjs', 'install.mjs', 'storage.mjs']);
  result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), first);
  assert.equal(await fs.readFile(path.join(f.state, 'config.json'), 'utf8'), config);
  await fs.appendFile(path.join(f.root, 'adapters', 'core.mjs'), '\n// older installed release\n');
  result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), first);
  assert.equal(await fs.readFile(path.join(f.root, 'adapters', 'core.mjs'), 'utf8'), await fs.readFile(path.join(repo, 'adapters/core.mjs'), 'utf8'));
  const bootstrapOutput = result.stdout;
  result = spawnSync('/bin/sh', ['-c', command], { input: '{}', encoding: 'utf8', env: f.env });
  assert.equal(result.status, 0); assert.equal(result.stdout, '{}\n');
  const uninstallCommand = bootstrapOutput.match(/Uninstall hooks: (.+)/)[1];
  result = spawnSync('/bin/sh', ['-c', uninstallCommand], { encoding: 'utf8', env: f.env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await json(settingsFile), { custom: 'keep', hooks: { Stop: [unrelated] } });
  assert.equal(await fs.readFile(path.join(f.state, 'config.json'), 'utf8'), config);
  assert.ok(await fs.stat(f.token));
});
test('download and checksum failures never install or touch settings', async t => {
  const f = await fixture(t);
  for (const extra of [{ FAKE_FAIL: 'yes' }, { FAKE_CORRUPT: 'yes' }]) {
    const result = f.run(f.init, extra); assert.notEqual(result.status, 0);
    await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(f.codex, 'hooks.json')), { code: 'ENOENT' });
  }
});
test('upgrade failures restore old binaries; unknown files and conflicting connections are preserved', async t => {
  const f = await fixture(t); assert.equal(f.run(f.init).status, 0);
  const file = path.join(f.root, 'adapters/core.mjs'); await fs.appendFile(file, '\n// previous\n');
  const before = await fs.readFile(file, 'utf8');
  await fs.writeFile(path.join(f.codex, 'hooks.json'), '{invalid');
  let result = f.run(); assert.notEqual(result.status, 0); assert.equal(await fs.readFile(file, 'utf8'), before);
  result = f.run(['--host-id', 'other']); assert.notEqual(result.status, 0); assert.equal(await fs.readFile(file, 'utf8'), before);
  const unknown = path.join(f.root, 'adapters', 'keep.txt'); await fs.writeFile(unknown, 'keep');
  result = f.run(); assert.notEqual(result.status, 0); assert.equal(await fs.readFile(unknown, 'utf8'), 'keep');
});
test('no terminal requires token-file; unsupported Node stops before download', async t => {
  const f = await fixture(t);
  const result = f.run(['--server', 'https://example.com', '--host-id', 'fixture']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /No interactive terminal/);
  await fs.writeFile(path.join(f.bin, 'node'), '#!/bin/sh\necho "Mission Control requires Node.js 20+" >&2\nexit 1\n', { mode: 0o755 });
  const oldNode = f.run(f.init); assert.notEqual(oldNode.status, 0); assert.match(oldNode.stderr, /20\+/);
  await assert.rejects(fs.stat(path.join(f.root, 'adapters')), { code: 'ENOENT' });
});
test('checked-in entrypoint is reproducible from template and adapters', async t => {
  const f = await fixture(t), output = path.join(f.dir, 'generated.sh');
  const result = spawnSync(process.execPath, [path.join(repo, 'scripts/build-installer.mjs'), 'dd7c7a474651a2fd458c93e58cc36b67ec1c2998', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), await fs.readFile(path.join(repo, 'install.sh'), 'utf8'));
});
test('busy state lock is a failed install, not a false success', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.state); await fs.mkdir(path.join(f.state, 'install.lock'));
  const result = f.run(f.init); assert.notEqual(result.status, 0); assert.match(result.stderr, /not installed/);
  assert.ok(await fs.stat(path.join(f.root, 'adapters/amc.mjs')));
  await assert.rejects(fs.stat(path.join(f.codex, 'hooks.json')), { code: 'ENOENT' });
});
test('version symlink does not overwrite another file', async t => {
  const f = await fixture(t); await fs.mkdir(f.root);
  const target = path.join(f.dir, 'do-not-overwrite'); await fs.writeFile(target, 'keep');
  await fs.symlink(target, path.join(f.root, 'version.json'));
  const result = f.run(f.init); assert.notEqual(result.status, 0); assert.equal(await fs.readFile(target, 'utf8'), 'keep');
});
test('partial configuration failure retains usable verified binaries for already-written hooks', async t => {
  const f = await fixture(t); await fs.mkdir(f.state);
  const target = path.join(f.dir, 'manifest-target.json'); await fs.writeFile(target, '{}');
  await fs.symlink(target, path.join(f.state, 'installations.json'));
  const result = f.run(f.init); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /may be partially written/);
  assert.ok(await fs.stat(path.join(f.codex, 'hooks.json')));
  assert.ok(await fs.stat(path.join(f.root, 'adapters/amc.mjs')));
  assert.equal(await fs.readFile(target, 'utf8'), '{}');
});
