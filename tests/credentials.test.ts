import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

describe('local credential preparation utilities (synthetic only)',()=>{
 it('hashes a synthetic host token from stdin without reflecting it',()=>{
  const token='synthetic-only-credential-'.repeat(3);
  const result=spawnSync(process.execPath,['scripts/token-hash.mjs'],{input:token+'\n',encoding:'utf8'});
  expect(result.status).toBe(0);expect(result.stdout.trim()).toBe(createHash('sha256').update(token).digest('hex'));expect(result.stderr).not.toContain(token);
 });
 it('refuses argv token/password values without echoing them',()=>{
  for(const script of ['scripts/token-hash.mjs','scripts/password-hash.mjs']){
   const secret='synthetic-not-real-argv-secret';
   const result=spawnSync(process.execPath,[script,secret],{encoding:'utf8'});
   expect(result.status).not.toBe(0);expect(result.stdout+result.stderr).not.toContain(secret);
  }
 });
 it('refuses short passwords and oversized host tokens',()=>{
  expect(spawnSync(process.execPath,['scripts/password-hash.mjs'],{input:'short\n'}).status).not.toBe(0);
  expect(spawnSync(process.execPath,['scripts/token-hash.mjs'],{input:'x'.repeat(2048)}).status).not.toBe(0);
 });
});
