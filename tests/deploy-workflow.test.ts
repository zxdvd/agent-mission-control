import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
// @ts-expect-error The deployment guard runs directly in Node, outside application TypeScript.
import { checkDeployHead } from '../scripts/check-deploy-head.mjs';

const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const validate = workflow.split('\n  validate:\n')[1].split('\n  deploy:\n')[0];
const deploy = workflow.split('\n  deploy:\n')[1];
const sha = 'a'.repeat(40);

describe('production workflow boundaries', () => {
  it('triggers on main pushes and retains the manually confirmed entry only', () => {
    expect(workflow).toMatch(/on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:/);
    expect(workflow).not.toMatch(/\n {2}(pull_request|pull_request_target|workflow_run):/);
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n/);
    expect(workflow).toMatch(/group: production-deploy\n {2}cancel-in-progress: false/);
    expect(deploy).toContain('    needs: validate\n');
    expect(deploy).toContain('    environment: production\n');
    expect(deploy.split('    steps:\n')[0]).not.toContain('always()');
  });

  it.each([validate, deploy])('allows only original-repository main pushes or confirmed manual runs', job => {
    // These job-level guards intentionally use only boolean expressions shared
    // by GitHub Actions and JavaScript; exercise the actual workflow expression.
    const guard = job.match(/(?:^|\n) {4}if: >-\n((?: {6}.+\n)+)/)?.[1].trim();
    expect(guard).toBeTruthy();
    const allowed = (event: string, inputs = {}, repository = 'zxdvd/agent-mission-control', ref = 'refs/heads/main') =>
      Boolean(runInNewContext(guard!, { github: { event_name: event, repository, ref }, inputs }));
    expect(allowed('push')).toBe(true);
    expect(allowed('workflow_dispatch', { confirmation: 'DEPLOY', auth_secrets_configured: true })).toBe(true);
    expect(allowed('workflow_dispatch')).toBe(false);
    expect(allowed('workflow_dispatch', { confirmation: 'DEPLOY', auth_secrets_configured: false })).toBe(false);
    expect(allowed('workflow_dispatch', { confirmation: 'wrong', auth_secrets_configured: true })).toBe(false);
    for (const event of ['pull_request', 'pull_request_target', 'workflow_run']) {
      expect(allowed(event, { confirmation: 'DEPLOY', auth_secrets_configured: true })).toBe(false);
    }
    for (const event of ['push', 'workflow_dispatch']) {
      const confirmed = { confirmation: 'DEPLOY', auth_secrets_configured: true };
      expect(allowed(event, confirmed, 'someone/fork')).toBe(false);
      expect(allowed(event, confirmed, undefined, 'refs/heads/feature')).toBe(false);
      expect(allowed(event, confirmed, undefined, 'refs/tags/main')).toBe(false);
    }
  });

  it('checks exactly the same SHA with every CI command before exposing production credentials', () => {
    const commands = (text: string) => [...text.matchAll(/^ {6}- run: (.+)$/gm)].map(match => match[1]);
    expect(commands(validate)).toEqual(commands(ci));
    expect(commands(validate)).toEqual(['npm ci', 'npm run typecheck', 'npm run lint', 'npm test', 'npm run build']);
    for (const job of [validate, deploy]) {
      expect(job).toContain('          ref: ${{ github.sha }}\n          persist-credentials: false');
      expect(job).not.toContain('continue-on-error');
    }
    expect(validate).not.toContain('secrets.');
    expect(validate).not.toContain('environment:');
    expect(deploy.indexOf('secrets.CLOUDFLARE_API_TOKEN')).toBeGreaterThan(deploy.indexOf('- run: npm run build'));
    expect([...workflow.matchAll(/uses: (\S+)/g)].every(([, action]) => /@[a-f0-9]{40}$/.test(action))).toBe(true);
  });

  it('never automatically migrates and rechecks freshness immediately before every cloud write', () => {
    expect(deploy).toContain("if: github.event_name == 'workflow_dispatch' && inputs.apply_migrations");
    expect(workflow).toMatch(/apply_migrations:\n(?: {8}.+\n)*? {8}default: false\n/);
    const cloudWrites = [...deploy.matchAll(/\n {10}(npx --no-install wrangler (?:d1 migrations apply|deploy)[^\n]+)/g)];
    expect(cloudWrites).toHaveLength(2);
    for (const [line] of cloudWrites) {
      expect(deploy).toContain(`          node scripts/check-deploy-head.mjs${line}`);
    }
    expect(deploy).toContain('      - name: Remove temporary configuration\n        if: always()\n        run: rm -f .wrangler.deploy.json');
  });

  it('requires a read-only live migration check after optional manual migration and before deployment', () => {
    expect(deploy).toContain('      - name: Verify remote migration ledger without changing the database\n        run: node scripts/check-deploy-migrations.mjs');
    const checkPosition = deploy.indexOf('run: node scripts/check-deploy-migrations.mjs');
    expect(checkPosition).toBeGreaterThan(deploy.indexOf('wrangler d1 migrations apply'));
    expect(checkPosition).toBeLessThan(deploy.indexOf('wrangler deploy'));
  });
});

describe('latest-main deployment guard', () => {
  it('accepts only the exact checked-out SHA still at remote main', () => {
    const git = vi.fn((args: string[]) => args[0] === 'rev-parse' ? `${sha}\n` : `${sha}\trefs/heads/main\n`);
    expect(() => checkDeployHead(sha, git)).not.toThrow();
    expect(git.mock.calls).toEqual([[['rev-parse', 'HEAD']], [['ls-remote', '--exit-code', 'origin', 'refs/heads/main']]]);
  });

  it.each([undefined, '', 'main', 'a'.repeat(39), 'a'.repeat(41), '$(echo unsafe)'])('rejects invalid SHA %s without running git', value => {
    const git = vi.fn();
    expect(() => checkDeployHead(value, git)).toThrow('Missing or invalid');
    expect(git).not.toHaveBeenCalled();
  });

  it('rejects a mismatched checkout before consulting remote main', () => {
    const git = vi.fn(() => 'b'.repeat(40));
    expect(() => checkDeployHead(sha, git)).toThrow('Checkout does not match');
    expect(git).toHaveBeenCalledOnce();
  });

  it.each(['', `${'b'.repeat(40)}\trefs/heads/main`, `${sha}\trefs/heads/feature`, `${sha}\trefs/heads/main\n${sha}\trefs/heads/other`])('rejects stale or ambiguous remote main %s', remote => {
    const git = vi.fn((args: string[]) => args[0] === 'rev-parse' ? sha : remote);
    expect(() => checkDeployHead(sha, git)).toThrow('no longer current main');
  });

  it('fails closed when git cannot query main', () => {
    const git = vi.fn(() => { throw new Error('offline'); });
    expect(() => checkDeployHead(sha, git)).toThrow();
  });

  it('stops an old checked-out run after real remote main advances', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-head-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const script = resolve('scripts/check-deploy-head.mjs');
    try {
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'Synthetic Test');
      git('config', 'user.email', 'fixture@example.invalid');
      git('commit', '--allow-empty', '-m', 'first');
      git('remote', 'add', 'origin', directory);
      const originalSha = git('rev-parse', 'HEAD');
      const run = () => spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: originalSha } });
      expect(run().status).toBe(0);
      git('commit', '--allow-empty', '-m', 'new main');
      git('checkout', '--detach', originalSha);
      const stale = run();
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('could not verify');
      git('remote', 'set-url', 'origin', join(directory, 'unreachable-synthetic-credential'));
      const unavailable = run();
      expect(unavailable.status).toBe(1);
      expect(unavailable.stdout + unavailable.stderr).not.toContain('unreachable-synthetic-credential');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
