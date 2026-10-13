// Generate a reviewable shell entrypoint pinned to an immutable source commit.
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
const [ref, output = 'install.sh'] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(ref || '')) throw new Error('Usage: node scripts/build-installer.mjs FULL_SOURCE_COMMIT [OUTPUT]');
const files = ['amc.mjs', 'install.mjs', 'core.mjs', 'storage.mjs'];
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await fs.readFile(new URL(`../adapters/${file}`, import.meta.url))).digest('hex')])));
const template = await fs.readFile(new URL('./install.sh.in', import.meta.url), 'utf8');
const temporary = `${output}.${randomUUID()}.tmp`;
try {
  await fs.writeFile(temporary, template.replaceAll('@REF@', ref).replace('@HASHES@', JSON.stringify(hashes, null, 2)), { mode: 0o755, flag: 'wx' });
  await fs.rename(temporary, output);
} finally { await fs.rm(temporary, { force: true }); }
console.log(`Wrote ${output}; before publishing, verify the four files at ${ref} match the embedded hashes.`);
