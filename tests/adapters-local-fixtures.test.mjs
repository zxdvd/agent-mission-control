import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { assertLocalWorker, fixtureContents, localOrigin, readTestHosts, SYNTHETIC_TEST_HOSTS, writeLocalFixtures } from '../scripts/local-fixtures.mjs';

const env = hosts => ({ AMC_TEST_HOSTS_JSON: JSON.stringify(hosts) });
function envJson(content, name) {
  const line = content.split('\n').find(value => value.startsWith(`${name}=`));
  return JSON.parse(line.slice(name.length + 2, -1));
}
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amc-local-fixtures-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

test('Local fixture generation keeps raw synthetic tokens separate from Worker hashes', () => {
  const contents = fixtureContents();
  const worker = envJson(contents['.dev.vars.test'], 'AGENT_TOKENS_JSON');
  const clients = envJson(contents['.env.test-hosts'], 'AMC_TEST_HOSTS_JSON');
  assert.deepEqual(clients, SYNTHETIC_TEST_HOSTS);
  assert.match(contents['.dev.vars.test'], /^LOCAL_DEV=true$/m);
  assert.equal(worker.length, 3);
  for (const [index, host] of worker.entries()) {
    assert.deepEqual(Object.keys(host).sort(), ['host_id', 'name', 'token_hash']);
    assert.equal(host.token_hash, createHash('sha256').update(clients[index].token).digest('hex'));
    assert.ok(!contents['.dev.vars.test'].includes(clients[index].token));
  }
});

test('Local fixtures are mode 0600 and never overwrite existing files or actual .dev.vars', async t => {
  const dir = await temp(t);
  const original = 'LOCAL_DEV=false\nUNRELATED=preserve-this-test-sentinel\n';
  await fs.writeFile(path.join(dir, '.dev.vars'), original);
  const files = await writeLocalFixtures(dir);
  assert.deepEqual(files.map(file => path.basename(file)).sort(), ['.dev.vars.test', '.env.test-hosts']);
  for (const file of files) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const previous = await fs.readFile(files[0], 'utf8');
  await assert.rejects(writeLocalFixtures(dir), /refusing to overwrite/);
  assert.equal(await fs.readFile(files[0], 'utf8'), previous);
  assert.equal(await fs.readFile(path.join(dir, '.dev.vars'), 'utf8'), original);
});

test('A conflicting second fixture is preserved and a partial new first file is cleaned up', async t => {
  const dir = await temp(t), file = path.join(dir, '.env.test-hosts');
  await fs.writeFile(file, 'existing fixture sentinel');
  await assert.rejects(writeLocalFixtures(dir), /refusing to overwrite/);
  assert.equal(await fs.readFile(file, 'utf8'), 'existing fixture sentinel');
  await assert.rejects(fs.stat(path.join(dir, '.dev.vars.test')), { code: 'ENOENT' });
});

test('Local scripts require explicit distinct fixed credentials and never echo invalid values', () => {
  assert.deepEqual(readTestHosts(3, env(SYNTHETIC_TEST_HOSTS)), SYNTHETIC_TEST_HOSTS);
  assert.throws(() => readTestHosts(1, {}), /AMC_TEST_HOSTS_JSON/);
  assert.throws(() => readTestHosts(3, env(SYNTHETIC_TEST_HOSTS.slice(0, 2))), /at least 3/);
  for (const hosts of [null, {}, [], [null], [SYNTHETIC_TEST_HOSTS[0], SYNTHETIC_TEST_HOSTS[0]],
    [{ ...SYNTHETIC_TEST_HOSTS[0], token: 'MUST_NOT_ECHO_SECRET' }],
    [{ ...SYNTHETIC_TEST_HOSTS[0], host_id: '../escape' }],
    [{ ...SYNTHETIC_TEST_HOSTS[0], name: 'bad\nlabel' }]]) {
    assert.throws(() => readTestHosts(1, env(hosts)), error => !error.message.includes('MUST_NOT_ECHO_SECRET'));
  }
  assert.throws(() => readTestHosts(1, { AMC_TEST_HOSTS_JSON: 'MUST_NOT_ECHO_SECRET' }), error => !error.message.includes('MUST_NOT_ECHO_SECRET'));
});

test('Synthetic scripts refuse external origins, URL credentials, query strings and non-HTTP URLs', () => {
  for (const value of ['http://127.0.0.1:8787', 'http://localhost:8787/', 'http://[::1]:8787']) assert.equal(localOrigin(value), value.replace(/\/$/, ''));
  for (const value of ['https://example.com', 'http://example.com', 'https://localhost', 'http://user:secret@localhost', 'http://localhost/path', 'http://localhost/?token=secret', 'http://localhost/#secret', 'not a URL']) {
    assert.throws(() => localOrigin(value));
  }
});

test('Synthetic scripts verify LOCAL_DEV and refuse redirects before sending any credentials', async t => {
  const base = await server(t, (req, res) => {
    assert.equal(req.url, '/api/me');
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ local: true }));
  });
  await assertLocalWorker(base);
  const locked = await server(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"local":false}'); });
  await assert.rejects(assertLocalWorker(locked), /LOCAL_DEV=true/);
  const redirect = await server(t, (_req, res) => { res.writeHead(302, { Location: base }); res.end(); });
  await assert.rejects(assertLocalWorker(redirect));
});
