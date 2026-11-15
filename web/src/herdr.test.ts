import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHerdrObservation } from './herdr.ts';
const response=(entries:unknown[])=>({available:true,mode:'read_only',compatibility:'verified',entries,observed_at:'2026-11-13T09:20:00Z'});
test('unavailable is not a successful empty observation',()=>assert.equal(parseHerdrObservation({available:false,error:'private stderr'}).kind,'unavailable'));
test('verified empty list is distinctly empty',()=>assert.equal(parseHerdrObservation(response([])).kind,'empty'));
test('raw CLI output and unverified structures fail closed',()=>{
 for(const value of [null,[],{available:true,data:[]},{...response([]),compatibility:'unverified'},{...response([]),mode:'write'}])assert.equal(parseHerdrObservation(value).kind,'incompatible');
});
test('observation projection excludes transcript, paths, names and errors',()=>{
 const result=parseHerdrObservation({...response([{id:'%2',status:'working',name:'secret title',cwd:'/private',transcript:'secret text',observed_at:'2026-11-13T09:19:00Z'}]),error:'private error',version:'1.2.3'});
 assert.equal(result.kind,'observed');
 assert.deepEqual(result.entries,[{id:'%2',status:'working',observed_at:'2026-11-13T09:19:00Z'}]);
 assert.equal(JSON.stringify(result).includes('secret'),false);
 assert.equal(result.version,'1.2.3');
});
test('unknown status stays unknown and arbitrary versions stay hidden',()=>{
 const result=parseHerdrObservation({...response([{id:'agent-1',status:'private transcript',observed_at:'not a date'}]),version:'private path'});
 assert.deepEqual(result.entries,[{id:'agent-1',status:'unknown',observed_at:undefined}]);
 assert.equal(result.version,undefined);
});
test('malformed identifiers, entries and duplicates cannot imply a valid empty or partial list',()=>{
 for(const entries of [[null],[{id:''}],[{id:'/private/path'}],[{id:'with spaces'}],[{id:'%2'},{id:'%2'}],[{id:'valid'},{}]])assert.equal(parseHerdrObservation(response(entries)).kind,'incompatible');
});
test('prototype member status is not treated as a known state',()=>assert.equal(parseHerdrObservation(response([{id:'%2',status:'toString'}])).entries[0].status,'unknown'));
