import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_LOCAL_FILES,MAX_LOCAL_FILE_BYTES,composerAttachmentPath,composerHasFiles,composerTransferFiles,planComposerFiles} from './composer-files.ts';
import {MAX_SCREENSHOT_BYTES} from './managed-codex.ts';

const file=(name:string,type='',size=100)=>({name,type,size});

test('only the first accepted PNG/JPEG is managed; other files are explicitly local',()=>{
 const input=[file('fixture.txt'),file('clipboard.png','image/png'),file('second.jpg'),file('preview.svg','image/svg+xml')];
 const {accepted,errors}=planComposerFiles(input,false,0);
 assert.deepEqual(accepted.map(({name,mime})=>[name,mime]),[
  ['fixture.txt',undefined],['clipboard.png','image/png'],['second.jpg',undefined],['preview.svg',undefined],
 ]);
 assert.deepEqual(errors,[]);
 const unnamed=planComposerFiles([file('','image/jpeg')],false,0);
 assert.deepEqual(unnamed.accepted.map(({name,mime})=>[name,mime]),[['截图','image/jpeg']]);
});

test('excess, empty and invalid files are surfaced without displacing accepted items',()=>{
 const input=[file('big.png','image/png',MAX_SCREENSHOT_BYTES+1),file('../bad.txt'),file('bidi\u202ef.txt'),file('empty.txt','',0),file('big.txt','',MAX_LOCAL_FILE_BYTES+1),file('okay.jpeg','application/octet-stream',MAX_SCREENSHOT_BYTES),file('okay.txt','',MAX_LOCAL_FILE_BYTES),file('excess.txt')];
 const {accepted,errors}=planComposerFiles(input,false,MAX_LOCAL_FILES-1);
 assert.deepEqual(accepted.map(({name,mime})=>[name,mime]),[['okay.jpeg','image/jpeg'],['okay.txt',undefined]]);
 assert.equal(errors.length,5);
 assert.deepEqual(planComposerFiles([file('another.png','image/png')],true,0).accepted.map(f=>f.mime),[undefined]);
});

test('mixed transfer prefers actual files and browser item fallback handles clipboard files',()=>{
 const png = new File(['fixture'],'screen.png',{type:'image/png'});
 const imageItem={kind:'file',getAsFile:()=>png};
 const stringItem={kind:'string',getAsFile:()=>{throw new Error('text is not a file');}};
 const fallback={files:[],items:[stringItem,imageItem]};
 assert.deepEqual(composerTransferFiles(fallback as unknown as DataTransfer),[png]);
 assert.equal(composerHasFiles({...fallback,types:['text/plain']} as unknown as DataTransfer),true);
 const actual={files:[png],items:[imageItem]};
 assert.deepEqual(composerTransferFiles(actual as unknown as DataTransfer),[png]);
 assert.equal(composerHasFiles({types:['text/plain'],items:[stringItem]} as unknown as DataTransfer),false);
});

test('download paths use the local task identity and a bounded slot, never the document name',()=>{
 const id='work-'+'a'.repeat(32);
 assert.equal(composerAttachmentPath(id,0),'/api/tasks/'+id+'/attachments/1');
 for(const bad of [-1,1.5,MAX_LOCAL_FILES,Infinity])assert.equal(composerAttachmentPath(id,bad),undefined);
 assert.equal(composerAttachmentPath('../public',0),undefined);
});
