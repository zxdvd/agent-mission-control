import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 MAX_SCREENSHOT_BYTES, managedImageURL, managedPath, managedRequest, managedRequestModeMatches, managedStateLabel, parseManagedReceipt,
 receiptConfirmed, screenshotError, screenshotFromDataURL, screenshotPreview, type ManagedReceipt, type ManagedSnapshot,
} from './managed-codex.ts';

const receipt: ManagedReceipt = {action:'follow_up',request_id:'12345678-1234-4321-a123-12345678abcd'};
const image = {mime_type:'image/png',data_base64:'YQ=='} as const;
const snapshot: ManagedSnapshot = {run_id:'r1',enabled:true,managed:true,can_start:false,can_follow_up:true,turns:[]};

test('screenshot drafts preserve the original encoded bytes, only for bounded PNG/JPEG choices',()=>{
 assert.equal(screenshotError({type:'image/png',size:MAX_SCREENSHOT_BYTES}),'');
 assert.equal(screenshotError({type:'image/jpeg',size:100}),'');
 assert.ok(screenshotError({type:'image/svg+xml',size:100}));
 assert.ok(screenshotError({type:'image/png',size:MAX_SCREENSHOT_BYTES+1}));
 assert.ok(screenshotError({type:'image/png',size:0}));
 assert.deepEqual(screenshotFromDataURL('image/png',screenshotPreview(image)),image);
 assert.throws(()=>screenshotFromDataURL('image/png','data:image/jpeg;base64,YQ=='));
 assert.throws(()=>screenshotFromDataURL('image/png','data:image/png;base64,'));
 assert.throws(()=>screenshotFromDataURL('image/svg+xml','data:image/svg+xml;base64,YQ=='));
});

test('task screenshot source only permits its server-local image endpoint',()=>{
 const prefix=managedPath('work-a')+'/images/';
 assert.equal(managedImageURL('work-a',prefix+'initial'),prefix+'initial');
 assert.equal(managedImageURL('work-a',prefix+receipt.request_id),prefix+receipt.request_id);
 for(const url of [
  undefined, 'https://example.com'+prefix+'initial', '/api/tasks/work-b/managed/images/initial',
  prefix+'../initial',prefix+'initial?proxy=example',prefix+'a%2Fb',prefix+'%2e%2e',prefix+'123#other', 'file:///tmp/example.png',
 ]) assert.equal(managedImageURL('work-a',url),undefined);
});

test('managed POST pins exact run and receipt; start never submits a second image, image-only supplement can send',()=>{
 assert.deepEqual(managedRequest({...receipt,action:'start'},'r1',' ignored ',image),{action:'start',request_id:receipt.request_id,run_id:'r1'});
 assert.deepEqual(managedRequest(receipt,'r1','  查下截图  ',image),{...receipt,run_id:'r1',message:'查下截图',image});
 assert.deepEqual(managedRequest(receipt,'r1','   ',image),{...receipt,run_id:'r1',image});
});

test('saved receipt keeps only request identity and requires exact server turn to release it',()=>{
 assert.deepEqual(parseManagedReceipt(JSON.stringify({...receipt,image,message:'private'})),receipt);
 assert.equal(parseManagedReceipt(JSON.stringify({...receipt,action:'other'})),undefined);
 assert.equal(parseManagedReceipt('{'),undefined);
 assert.equal(parseManagedReceipt(null),undefined);
 assert.equal(receiptConfirmed(snapshot,receipt),false);
 assert.equal(receiptConfirmed({...snapshot,turns:[{id:receipt.request_id,kind:'start',state:'running'}]},receipt),false);
 assert.equal(receiptConfirmed({...snapshot,turns:[{id:receipt.request_id,kind:'follow_up',state:'pending'}]},receipt),true);
 assert.match(managedStateLabel.pending,/排队/);
 assert.match(managedStateLabel.completed,/未验收/);
 assert.match(managedStateLabel.uncertain,/待核实/);
});


test('no-sandbox request receipt pins the displayed mode without retaining unrelated fields',()=>{
 const full: ManagedReceipt = {...receipt,mode:'no_sandbox'};
 assert.deepEqual(parseManagedReceipt(JSON.stringify({...full,unexpected:'ignore'})),full);
 assert.deepEqual(managedRequest(full,'r1',' explicit instructions '),{...full,run_id:'r1',message:'explicit instructions'});
 const noSandboxMode = {...snapshot,mode:'no_sandbox'} as const;
 assert.equal(managedRequestModeMatches(noSandboxMode,full),true);
 assert.equal(managedRequestModeMatches(noSandboxMode,receipt),false);
 assert.equal(managedRequestModeMatches(snapshot,full),false);
 assert.equal(managedRequestModeMatches(snapshot,receipt),true);
});
