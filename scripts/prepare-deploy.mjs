import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export function productionConfig(base, env) {
  const required = key => { const value = env[key]?.trim(); if (!value) throw new Error(`Missing required deployment variable: ${key}`); return value; };
  const account = required('CLOUDFLARE_ACCOUNT_ID');
  const database = required('D1_DATABASE_ID');
  const team = required('ACCESS_TEAM_DOMAIN');
  const audience = required('ACCESS_AUD');
  const admins = required('ADMIN_EMAILS');
  if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error('Invalid CLOUDFLARE_ACCOUNT_ID');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(database)) throw new Error('Invalid D1_DATABASE_ID');
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team)) throw new Error('Invalid ACCESS_TEAM_DOMAIN');
  if (!/^[a-f0-9]{64}$/i.test(audience)) throw new Error('Invalid ACCESS_AUD');
  if (!admins.split(',').every(value => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value.trim()))) throw new Error('Invalid ADMIN_EMAILS');
  return { ...base, account_id: account, preview_urls: false,
    assets: { ...base.assets, run_worker_first: true },
    d1_databases: [{ binding:'DB', database_name:'mission-control', database_id:database, migrations_dir:'migrations' }],
    vars:{LOCAL_DEV:'false',ACCESS_TEAM_DOMAIN:team,ACCESS_AUD:audience,ADMIN_EMAILS:admins,STALE_SECONDS:'300',OFFLINE_SECONDS:'180'},
    observability:{enabled:false} };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const base=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
    const config=productionConfig(base,process.env);
    await writeFile(new URL('../.wrangler.deploy.json',import.meta.url),JSON.stringify(config,null,2)+'\n',{mode:0o600});
    console.log('Production configuration validated. Local bypass disabled; authenticated assets enabled.');
  } catch(error) { console.error(error.message);process.exitCode=1; }
}
