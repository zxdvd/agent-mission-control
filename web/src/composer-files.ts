import {MAX_SCREENSHOT_BYTES, type ScreenshotInput} from './managed-codex.ts';

export const MAX_LOCAL_FILES = 3;
export const MAX_LOCAL_FILE_BYTES = 2 * 1024 * 1024;
type InputFile = {name:string;type:string;size:number};
type ImageMime = ScreenshotInput['mime_type'];
export type LocalFileInput = {name:string;data_base64:string};

function imageMime(file:InputFile):ImageMime|undefined {
 if(file.type==='image/png'||file.type==='image/jpeg')return file.type;
 // Some native drag sources do not populate MIME; bytes are verified server-side.
 if(!file.type||file.type==='application/octet-stream'){
  if(/\.png$/i.test(file.name))return 'image/png';
  if(/\.jpe?g$/i.test(file.name))return 'image/jpeg';
 }
}

export function planComposerFiles<T extends InputFile>(files:Iterable<T>,hasImage:boolean,localCount:number) {
 const accepted:{file:T;name:string;mime?:ImageMime}[]=[];
 const errors=new Set<string>();
 for(const file of files){
  const mime=imageMime(file),name=file.name.trim()||(mime?'截图':'');
  if(!name||name==='.'||name==='..'||Array.from(name).length>160||/[/\\\p{Cc}\p{Bidi_Control}]/u.test(name)){
   errors.add('有附件的文件名无效，未添加。');continue;
  }
  if(!file.size){errors.add('空文件未添加。');continue;}
  if(mime&&!hasImage){
   if(file.size>MAX_SCREENSHOT_BYTES){errors.add('截图超过 4 MiB，未添加。');continue;}
   accepted.push({file,name,mime});hasImage=true;continue;
  }
  if(localCount>=MAX_LOCAL_FILES){errors.add('本地文件最多 3 个，超出的未添加。');continue;}
  if(file.size>MAX_LOCAL_FILE_BYTES){errors.add('本地文件超过 2 MiB，未添加。');continue;}
  accepted.push({file,name});localCount++;
 }
 return {accepted,errors:Array.from(errors)};
}

export function composerTransferFiles(transfer:Pick<DataTransfer,'files'|'items'>):File[] {
 const files=Array.from(transfer.files);
 return files.length?files:Array.from(transfer.items).flatMap(item=>{
  const file=item.kind==='file'?item.getAsFile():null;
  return file?[file]:[];
 });
}

export function composerHasFiles(transfer:Pick<DataTransfer,'types'|'items'>):boolean {
 return Array.from(transfer.types).includes('Files')||Array.from(transfer.items).some(item=>item.kind==='file');
}

export function composerAttachmentPath(taskID:string,index:number):string|undefined {
 if(!/^work-[a-f0-9]{32}$/.test(taskID)||!Number.isInteger(index)||index<0||index>=MAX_LOCAL_FILES)return;
 return '/api/tasks/'+taskID+'/attachments/'+(index+1);
}

export function composerFileBase64(file:File):Promise<string> {
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  const failed=()=>reject(new Error('附件无法读取。'));
  reader.onerror=reader.onabort=failed;
  reader.onload=()=>{
   const data=typeof reader.result==='string'?reader.result:'',sep=data.indexOf(',');
   if(!data.startsWith('data:')||sep<0||!data.slice(0,sep).endsWith(';base64')||sep===data.length-1){failed();return;}
   resolve(data.slice(sep+1));
  };
  try{reader.readAsDataURL(file)}catch{failed();}
 });
}
