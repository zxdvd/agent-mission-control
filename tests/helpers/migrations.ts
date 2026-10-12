import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';

// Match Wrangler's local migration execution instead of a handwritten SQL parser.
// Remote migrations use a distinct /query path; see migration compatibility tests.
export async function applyTestMigrations(db:D1Database):Promise<void>{
 const root=new URL('../../migrations/',import.meta.url);
 for(const name of (await readdir(root)).filter(name=>name.endsWith('.sql')).sort()){
  const sql=await readFile(new URL(name,root),'utf8');
  await db.batch(unstable_splitSqlQuery(sql).map(statement=>db.prepare(statement)));
 }
}
