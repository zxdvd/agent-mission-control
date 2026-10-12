import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { atomicWrite, readJson, withLock } from './storage.mjs';
import { HOOK_EVENTS } from './core.mjs';

const SCRIPT = fileURLToPath(new URL('./amc.mjs', import.meta.url));
const BEGIN = '# BEGIN agent-mission-control notify v1';
const END = '# END agent-mission-control notify v1';
export function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
export function hookCommand(stateDir, agent) {
  if (process.platform === 'win32') throw new Error('Hook installation supports POSIX shells (macOS/Linux/WSL). Windows native shells require a reviewed manual configuration.');
  return [process.execPath, SCRIPT, 'hook', '--agent', agent, '--state-dir', path.resolve(stateDir), '--amc-managed-v1'].map(shellQuote).join(' ');
}
function notifyBlock(stateDir) {
  return `${BEGIN}\nnotify = ${JSON.stringify([process.execPath, SCRIPT, 'notify', '--state-dir', path.resolve(stateDir), '--amc-managed-v1'])}\n${END}\n`;
}
async function readText(file) {
  try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Settings must be a regular file, not a symlink.'); return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function replaceIfUnchanged(file, before, after) {
  if (before === after) return;
  if ((await readText(file)) !== before) throw new Error('Settings changed during installation; retry after saving the other editor.');
  let mode = 0o600; try { mode = (await fs.stat(file)).mode & 0o777; } catch {}
  // One private first-change backup; never overwrite an existing backup.
  if (before) { try { await fs.writeFile(`${file}.amc-backup`, before, { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  await atomicWrite(file, after, mode);
}
async function manifest(stateDir) { return readJson(path.join(stateDir, 'installations.json'), {}); }
async function saveManifest(stateDir, value) { await atomicWrite(path.join(stateDir, 'installations.json'), `${JSON.stringify(value, null, 2)}\n`); }
export function detectAgent(agent, runner = spawnSync) {
  const invoke = args => {
    try {
      const result = runner(agent, args, { encoding: 'utf8', timeout: 1000, maxBuffer: 128 * 1024, windowsHide: true });
      return result.status === 0 ? String(result.stdout || '') : '';
    } catch { return ''; }
  };
  const versionOutput = invoke(['--version']);
  const version = versionOutput.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0] || null;
  if (agent !== 'codex') return { agent, available: !!versionOutput, version, hook_capability: 'consult-installed-version-docs' };
  const help = invoke(['--help']);
  const features = invoke(['features', 'list']);
  const evidence = /(?:^|\n)\s*(?:hooks|codex_hooks)\s+\S+\s+(?:true|false)\b/.test(features) || help.includes('--dangerously-bypass-hook-trust');
  const disabled = /(?:^|\n)\s*(?:hooks|codex_hooks)\s+\S+\s+false\b/.test(features);
  return { agent, available: !!versionOutput, version, hook_capability: evidence ? (disabled ? 'detected-disabled' : 'detected-review-required') : 'unknown', notify_capability: 'documented-agent-turn-complete-only' };
}
export async function installNotify(stateDir, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  return withLock(stateDir, 'install', async () => {
    const file = path.resolve(codexHome, 'config.toml'); const before = await readText(file);
    const installs = await manifest(stateDir); const expected = notifyBlock(stateDir);
    if (installs['codex-notify'] && installs['codex-notify'].file !== file) throw new Error('Codex is already installed at another location; uninstall that target first.');
    if (before.includes(BEGIN) || before.includes(END)) {
      if (!before.startsWith(expected) || before.split(BEGIN).length !== 2 || before.split(END).length !== 2) throw new Error('Managed Codex notify block changed or belongs to another install. Review it manually; no changes made.');
      const rest = before.slice(expected.length);
      if (/^\s*(?:notify|"notify"|'notify')\s*[=.]/m.test(rest)) throw new Error('Another notify setting exists. No changes made.');
    } else {
      // Conservative across tables and quoted keys: never replace or compose another program.
      if (/^\s*["'][^\n]*\\[^\n]*["']\s*=/m.test(before)) throw new Error('Escaped quoted TOML keys require manual review; no changes made.');
      if (/^\s*(?:notify|"notify"|'notify')\s*[=.]/m.test(before)) throw new Error('Codex already has notify configured. Existing notify was preserved. Use the wrapper, optional lifecycle hooks, or manually compose a reviewed dispatcher.');
      await replaceIfUnchanged(file, before, expected + before);
    }
    installs['codex-notify'] = { file, block: expected }; await saveManifest(stateDir, installs);
    return { installed: 'codex-notify', settings: file, limitation: 'Only turn completion is observed. Approval, turn start, and task completion are unavailable through notify.' };
  });
}
function parseSettings(text) {
  const value = text.trim() ? JSON.parse(text) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must contain a JSON object.');
  if (value.hooks !== undefined && (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks))) throw new Error('Existing hooks configuration is invalid; no changes made.');
  return value;
}
export async function installHooks(stateDir, agent, home, { prepareOnly = false } = {}) {
  if (!['codex', 'claude'].includes(agent)) throw new Error('Unsupported agent.');
  const file = path.resolve(home || (agent === 'codex' ? process.env.CODEX_HOME || path.join(os.homedir(), '.codex') : path.join(os.homedir(), '.claude')), agent === 'codex' ? 'hooks.json' : 'settings.json');
  const command = hookCommand(stateDir, agent);
  const events = [...HOOK_EVENTS, ...(agent === 'claude' ? ['Notification'] : ['Interrupt'])];
  const makeGroup = name => ({ ...(name === 'Notification' ? { matcher: 'permission_prompt' } : {}), hooks: [{ type: 'command', command, timeout: 4 }] });
  const candidate = { hooks: Object.fromEntries(events.map(name => [name, [makeGroup(name)]])) };
  if (prepareOnly) {
    const candidateFile = path.join(stateDir, `${agent}-hooks.candidate.json`);
    await atomicWrite(candidateFile, `${JSON.stringify(candidate, null, 2)}\n`);
    return { prepared: candidateFile, installed: false, next: 'Review the candidate, install explicitly with --codex-hooks, then open /hooks in Codex to review and trust. No trust or feature settings were changed.' };
  }
  return withLock(stateDir, 'install', async () => {
    const before = await readText(file), settings = parseSettings(before), installs = await manifest(stateDir);
    const key = `${agent}-hooks`;
    if (agent === 'codex' && installs['codex-notify']) throw new Error('This install already uses Codex notify. Uninstall --target codex-notify before switching to lifecycle hooks to avoid duplicate turn observations.');
    if (installs[key] && (installs[key].file !== file || installs[key].command !== command)) throw new Error('Hooks were installed at another location; uninstall the old target first.');
    settings.hooks ||= {};
    for (const event of events) {
      if (settings.hooks[event] !== undefined && !Array.isArray(settings.hooks[event])) throw new Error(`Existing ${event} hooks are not an array; no changes made.`);
      const groups = settings.hooks[event] || [];
      if (groups.some(group => !group || typeof group !== 'object' || !Array.isArray(group.hooks))) throw new Error(`Existing ${event} hook group is invalid; no changes made.`);
      if (!groups.some(group => group.hooks.some(handler => handler?.type === 'command' && handler.command === command))) groups.push(makeGroup(event));
      settings.hooks[event] = groups;
    }
    const after = `${JSON.stringify(settings, null, 2)}\n`;
    await replaceIfUnchanged(file, before, after);
    installs[key] = { file, command, events }; await saveManifest(stateDir, installs);
    return { installed: key, settings: file, ...(agent === 'codex' ? { next: 'Restart or reload Codex, then open /hooks to review and trust each exact hook. Hooks remain subject to local feature/admin policy. No trust, bypass flags, or feature settings were changed.' } : { next: 'Review hooks in Claude Code and restart the session if needed. Hooks only observe; permission decisions remain in Claude Code.' }) };
  });
}
export async function uninstall(stateDir, selection = 'all') {
  return withLock(stateDir, 'install', async () => {
    const installs = await manifest(stateDir), removed = [], preserved = [];
    for (const [key, entry] of Object.entries(installs)) {
      if (selection !== 'all' && selection !== key) continue;
      const before = await readText(entry.file);
      if (key === 'codex-notify') {
        if (before.startsWith(entry.block)) { await replaceIfUnchanged(entry.file, before, before.slice(entry.block.length)); removed.push(key); delete installs[key]; }
        else if (!before.includes(BEGIN)) { removed.push(key); delete installs[key]; }
        else preserved.push(`${key}: edited block preserved for manual review`);
      } else {
        const value = parseSettings(before); let found = false;
        for (const event of entry.events) {
          if (!Array.isArray(value.hooks?.[event])) continue;
          value.hooks[event] = value.hooks[event].flatMap(group => {
            if (!Array.isArray(group?.hooks)) return [group];
            const handlers = group.hooks.filter(handler => {
              const ours = handler?.type === 'command' && handler.command === entry.command;
              found ||= ours; return !ours;
            });
            // Preserve unrelated group keys and handlers exactly; remove only empty owned group.
            return handlers.length ? [{ ...group, hooks: handlers }] : (group.hooks.length ? [] : [group]);
          });
          if (!value.hooks[event].length) delete value.hooks[event];
        }
        if (value.hooks && !Object.keys(value.hooks).length) delete value.hooks;
        if (found) await replaceIfUnchanged(entry.file, before, `${JSON.stringify(value, null, 2)}\n`);
        removed.push(key); delete installs[key];
      }
    }
    await saveManifest(stateDir, installs);
    return { removed, preserved, note: 'Local connection settings, token files, and buffered events are retained. Revoke the host credential in Mission Control if this computer should lose access.' };
  });
}
