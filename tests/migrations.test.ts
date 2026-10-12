import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
const root=new URL('../migrations/',import.meta.url);
const migrationNames=['0001_initial.sql','0002_password_sessions.sql'];
const instance=()=>new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']});

it('keeps migration encoding and complete trigger boundaries compatible with Wrangler',async()=>{
 for(const name of migrationNames){
  const sql=await readFile(new URL(name,root),'utf8');
  expect(sql).not.toContain('\r');expect(sql.startsWith('\uFEFF')).toBe(false);
  const queries=unstable_splitSqlQuery(sql);
  expect(queries).toHaveLength(name.startsWith('0001')?16:5);
  for(const statement of queries.filter(q=>q.includes('CREATE TRIGGER'))){
   const trigger=statement.slice(statement.indexOf('CREATE TRIGGER'));
   expect(trigger).not.toContain('\n');
   expect(trigger).toMatch(/\bBEGIN\b.*\bEND$/);
   expect(trigger).not.toMatch(/(?<!\()\bCASE\b/);
  }
 }
});
it('reproduces the multiline exec incompatibility and accepts a complete single-line trigger',async()=>{
 // This is the real workerd exec line-splitting path, NOT a remote /query emulator.
 const mf=instance();try{
  const db=await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE example(id INTEGER PRIMARY KEY,value INTEGER)').run();
  const multiline='CREATE TRIGGER example_after AFTER INSERT ON example\nBEGIN\nUPDATE example SET value=1 WHERE id=NEW.id;\nEND;';
  await expect(db.exec(multiline)).rejects.toThrow(/incomplete input/);
  await db.exec(multiline.replace(/\n/g,' '));
  await db.prepare('INSERT INTO example(id,value) VALUES(1,0)').run();
  expect(await db.prepare('SELECT value FROM example WHERE id=1').first()).toMatchObject({value:1});
 }finally{await mf.dispose();}
});
it('executes both production triggers through native D1 exec with normal schema setup',async()=>{
 const mf=instance();try{
  const db=await mf.getD1Database('DB');
  const statements=unstable_splitSqlQuery(await readFile(new URL(migrationNames[0],root),'utf8'));
  for(const statement of statements){
   if(statement.includes('CREATE TRIGGER'))await db.exec(statement.slice(statement.indexOf('CREATE TRIGGER'))+';');
   else await db.prepare(statement).run();
  }
  expect((await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()).results).toHaveLength(2);
  await db.prepare("INSERT INTO hosts(id,name,created_at) VALUES('fixture-host','Fixture','2026-10-12T00:00:00.000Z')").run();
  const insert="INSERT INTO events(event_id,timestamp,received_at,host_id,agent_type,session_id,task_id,run_id,event_type,payload,fingerprint,clock) VALUES(?,'2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z','fixture-host',?,'fixture-session','fixture-task','fixture-run','turn_started','{}','synthetic',?)";
  await db.prepare(insert).bind('fixture-event','codex','2026-10-12T00:00:00.000Z:fixture-event').run();
  expect(await db.prepare("SELECT activity FROM tasks WHERE id='fixture-task'").first()).toMatchObject({activity:'running'});
  await expect(db.prepare(insert).bind('fixture-conflict','claude','2026-10-12T00:00:00.000Z:fixture-conflict').run()).rejects.toThrow(/identity_conflict:session/);
 }finally{await mf.dispose();}
});
it('applies SQL plus Wrangler-shaped ledger inserts using the actual client splitter',async()=>{
 const mf=instance();try{
  const db=await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE)').run();
  for(const name of migrationNames){
   const sql=await readFile(new URL(name,root),'utf8');
   // Mirrors buildMigrationQuery in Wrangler 4.149; remote acceptance still
   // requires an approved real deployment, not inference from this local test.
   const query=`${sql}\nINSERT INTO "d1_migrations" (name)\nvalues ('${name}');`;
   await db.batch(unstable_splitSqlQuery(query).map(statement=>db.prepare(statement)));
  }
  expect((await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results).toEqual(migrationNames.map(name=>({name})));
  expect((await db.prepare("SELECT name FROM sqlite_master WHERE name='host_credentials'").all()).results).toHaveLength(0);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
 }finally{await mf.dispose();}
});
