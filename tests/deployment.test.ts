import {describe,it,expect} from 'vitest';
// @ts-expect-error The deployment entry point is plain Node ESM, not application TypeScript.
import {productionConfig} from '../scripts/prepare-deploy.mjs';
const vars={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),D1_DATABASE_ID:'12345678-1234-1234-1234-123456789012',ACCESS_TEAM_DOMAIN:'example.cloudflareaccess.com',ACCESS_AUD:'b'.repeat(64),ADMIN_EMAILS:'owner@example.com'};
describe('manual deployment guard',()=>{
 it('forces fail-closed production settings and never serializes deployment credentials',()=>{const c=productionConfig({vars:{LOCAL_DEV:'true'},assets:{run_worker_first:false}},{...vars,LOCAL_DEV:'true',CLOUDFLARE_API_TOKEN:'synthetic-secret'});expect(c.vars.LOCAL_DEV).toBe('false');expect(c.assets.run_worker_first).toBe(true);expect(c.preview_urls).toBe(false);expect(JSON.stringify(c)).not.toContain('synthetic-secret');expect(c.d1_databases[0].database_id).toBe(vars.D1_DATABASE_ID);});
 it.each(Object.keys(vars))('rejects missing required %s before a cloud command',key=>{expect(()=>productionConfig({}, {...vars,[key]:''})).toThrow();});
 it.each([['D1_DATABASE_ID','00000000-0000-0000-0000-000000000000'],['ACCESS_TEAM_DOMAIN','evil.invalid'],['ACCESS_AUD','missing-audience'],['ADMIN_EMAILS','bad\naddress'],['CLOUDFLARE_ACCOUNT_ID','$(echo injected)']])('rejects invalid %s without copying its value into the error',(key,value)=>{expect(()=>productionConfig({}, {...vars,[key]:value})).toThrow(`Invalid ${key}`);});
});
