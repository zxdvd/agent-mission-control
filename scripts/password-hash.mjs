#!/usr/bin/env node
import { randomBytes, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

// Standard PBKDF2 only: Workers production has a 100,000-iteration ceiling.
// https://github.com/cloudflare/workerd/issues/1346
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 16 || Buffer.byteLength(password, 'utf8') > 1024) throw new Error('Use a password of at least 16 characters and at most 1024 UTF-8 bytes; a long randomly generated password is recommended.');
  const salt = randomBytes(16);
  const hash = await promisify(pbkdf2)(password, salt, 100_000, 32, 'sha256');
  return `pbkdf2-sha256$100000$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
async function readPassword() {
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > 2048) throw new Error('Password input too long.');
    }
    return input.replace(/\r?\n$/, '');
  }
  process.stderr.write('Dashboard password (hidden, minimum 16 characters): ');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error); else resolve(password);
    };
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') { finish(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') password = [...password].slice(0, -1).join('');
        else if (char >= ' ') password += char;
        if (Buffer.byteLength(password, 'utf8') > 1024) { finish(new Error('Password input too long.')); return; }
      }
    };
    process.stdin.on('data', onData);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('No arguments accepted. Run this helper for a hidden prompt, or pipe the password through stdin.');
    process.stdout.write(`${await passwordHash(await readPassword())}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
