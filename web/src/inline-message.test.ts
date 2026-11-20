import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inlineText,inlineImageCount,scopedInlineParts,MAX_INLINE_IMAGES,type InlineDraftPart} from './inline-message.ts';
import {managedRequest,managedImageURL} from './managed-codex.ts';
import {planComposerFiles} from './composer-files.ts';
const task='work-sample';
const prefix='/api/tasks/'+task+'/managed/images/';
const inline:InlineDraftPart[]=[{text:'before '},{image:{mime_type:'image/png',data_base64:'fixture'}},{text:' after'}];

test('inline follow-up sends ordered structured data, not a flattened duplicate',()=>{
 const receipt={action:'follow_up',mode:'no_sandbox',request_id:'request'} as const;
 assert.equal(inlineText(inline),'before  after');
 assert.equal(inlineImageCount(inline),1);
 assert.deepEqual(managedRequest(receipt,'r',inlineText(inline),undefined,inline),{...receipt,run_id:'r',parts:inline});
 assert.deepEqual(managedRequest({...receipt,action:'start'},'r','ignored',undefined,inline),{...receipt,action:'start',run_id:'r'});
});

test('inline rendering keeps exact order and rejects external or unscoped images',()=>{
 const first=prefix+'~initial:1',third=prefix+'~r-one:3';
 const parts=[{text:'A'},{image_url:first},{text:'B'},{image_url:third},{text:'C'}];
 assert.deepEqual(scopedInlineParts(task,parts),parts);
 assert.equal(managedImageURL(task,prefix+'initial'),prefix+'initial');
 for(const url of ['https://outside.invalid/file.png',prefix+'~initial:4',prefix+'../initial',prefix+'~r:0','/api/tasks/other/managed/images/~initial:1']){
  assert.equal(scopedInlineParts(task,[{text:'A'},{image_url:url}]),undefined);
 }
});

test('three managed images allowed, fourth never silently becomes a local attachment',()=>{
 const files=Array.from({length:4},(_,i)=>({name:i+'.png',type:'image/png',size:10}));
 const result=planComposerFiles([...files,{name:'local.txt',type:'text/plain',size:10}],0,0,MAX_INLINE_IMAGES);
 assert.deepEqual(result.accepted.map(x=>x.name),['0.png','1.png','2.png','local.txt']);
 assert.equal(result.errors.length,1);
});
