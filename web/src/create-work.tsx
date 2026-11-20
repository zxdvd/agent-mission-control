import {useId,useRef,useState,type ClipboardEvent,type DragEvent,type FormEvent} from 'react';
import {type Task,validProjectName} from './model';
import {screenshotPreview,type ScreenshotInput} from './managed-codex';
import {composerFileBase64,composerHasFiles,composerTransferFiles,planComposerFiles,type LocalFileInput} from './composer-files';

type DraftImage={name:string;input:ScreenshotInput};
type DraftFile=LocalFileInput&{key:number};

export function CreateWork({onCreated,defaultProjectName=''}:{onCreated:(task:Task)=>void;defaultProjectName?:string}) {
 const [goal,setGoal]=useState(''),[projectName,setProjectName]=useState('');
 const [image,setImage]=useState<DraftImage>(),[files,setFiles]=useState<DraftFile[]>([]);
 const [busy,setBusy]=useState(false),[reading,setReading]=useState(false),[dragging,setDragging]=useState(false);
 const [fileNotes,setFileNotes]=useState<string[]>([]),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const text=useRef<HTMLTextAreaElement>(null),picker=useRef<HTMLInputElement>(null),project=useRef<HTMLDetailsElement>(null);
 const submitting=useRef(false),picking=useRef(false),touched=useRef(false),dragDepth=useRef(0),fileKey=useRef(0);
 const headingID=useId(),hintID=useId(),limitsID=useId(),textID=useId();
 const goalTooLong=Array.from(goal.trim()).length>2000;
 const canSave=!uncertain&&!goalTooLong&&validProjectName(projectName)&&!!(goal.trim()||image||files.length);

 function open() {
  if(!dialog.current||dialog.current.open)return;
  if(!touched.current)setProjectName(defaultProjectName);
  dialog.current.showModal();
  text.current?.focus();
 }
 function close() {
  if(!dialog.current?.open||submitting.current)return;
  dragDepth.current=0;setDragging(false);
  dialog.current.close();trigger.current?.focus({preventScroll:true});
 }
 async function choose(incoming:File[]) {
  if(!incoming.length||submitting.current)return;
  if(picking.current){setFileNotes(['正在读取上一批附件，请稍后再添加。']);return;}
  const {accepted,errors}=planComposerFiles(incoming,!!image,files.length);
  setFileNotes(errors);
  if(!accepted.length)return;
  picking.current=true;setReading(true);
  const added:DraftFile[]=[];
  for(const {file,name,mime} of accepted){
   try{
    const data_base64=await composerFileBase64(file);
    if(mime)setImage({name,input:{mime_type:mime,data_base64}});
    else added.push({name,data_base64,key:++fileKey.current});
    touched.current=true;
   }catch{errors.push(`无法读取「${name}」，未添加。`);}
  }
  setFiles(current=>[...current,...added]);
  setFileNotes(errors);picking.current=false;setReading(false);
 }
 function paste(event:ClipboardEvent<HTMLTextAreaElement>) {
  const incoming=composerTransferFiles(event.clipboardData);
  if(!incoming.length)return;
  // Let the textarea preserve the text portion of a mixed clipboard naturally.
  if(!event.clipboardData.getData('text/plain'))event.preventDefault();
  void choose(incoming);
 }
 function enter(event:DragEvent<HTMLDialogElement>) {
  if(!composerHasFiles(event.dataTransfer))return;
  event.preventDefault();
  if(++dragDepth.current===1)setDragging(true);
 }
 function leave(event:DragEvent<HTMLDialogElement>) {
  if(!dragDepth.current)return;
  if(--dragDepth.current===0)setDragging(false);
 }
 function over(event:DragEvent<HTMLDialogElement>) {
  if(!composerHasFiles(event.dataTransfer))return;
  event.preventDefault();event.dataTransfer.dropEffect=submitting.current?'none':'copy';
 }
 function drop(event:DragEvent<HTMLDialogElement>) {
  dragDepth.current=0;setDragging(false);
  const incoming=composerTransferFiles(event.dataTransfer);
  if(!incoming.length&&!composerHasFiles(event.dataTransfer))return;
  event.preventDefault();
  void choose(incoming);
 }
 async function submit(event:FormEvent<HTMLFormElement>) {
  event.preventDefault();
  if(submitting.current||picking.current||!canSave)return;
  submitting.current=true;setBusy(true);setError('');
  try{
   const response=await fetch('/api/tasks/compose',{
    method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify({
     goal,project_name:projectName.trim(),...(image?{image:image.input}:{}),
     ...(files.length?{attachments:files.map(({name,data_base64})=>({name,data_base64}))}:{}),
    }),
   });
   const data=await response.json().catch(()=>null);
   if(!response.ok&&response.status>=400&&response.status<500){setError(data?.error||`无法保存 (${response.status})。`);return;}
   if(response.status!==201||!data?.id)throw new Error('未确认回执');
   submitting.current=false;close();
   setGoal('');setProjectName('');setImage(undefined);setFiles([]);setFileNotes([]);touched.current=false;
   if(project.current)project.current.open=false;
   onCreated(data as Task);
  }catch{setUncertain(true);setError('未能确认是否已保存。为避免重复创建，已停止保存此草稿。请关闭弹窗，重新加载页面并核对列表。');}
  finally{setBusy(false);submitting.current=false;}
 }
 return <div className="create-work">
  <button ref={trigger} type="button" className="new-work-button" aria-haspopup="dialog" onClick={open}>＋ 新建工作</button>
  <dialog ref={dialog} className="new-work-dialog" aria-labelledby={headingID} aria-describedby={hintID}
   onCancel={event=>{event.preventDefault();close()}} onDragEnter={enter} onDragLeave={leave} onDragOver={over} onDrop={drop}>
   <header className="new-work-header"><h2 id={headingID}>新建工作</h2><button type="button" onClick={close} disabled={busy} aria-label="关闭新建工作">✕</button></header>
   <p id={hintID} className="new-work-hint">只保存本地记录，不会启动 Codex。</p>
   <form onSubmit={event=>void submit(event)} aria-busy={busy}>
    <fieldset disabled={busy}>
     <div className={'new-work-composer'+(dragging?' drop-target':'')}>
      <label className="visually-hidden" htmlFor={textID}>任务内容</label>
      <textarea ref={text} id={textID} rows={5} aria-describedby={limitsID} aria-invalid={goalTooLong||undefined} value={goal} onPaste={paste}
       onChange={event=>{touched.current=true;setGoal(event.currentTarget.value)}}
       placeholder="告诉我你想做什么。可直接粘贴图片，或把图片和文件拖到这里。"/>
      {(image||files.length>0)&&<ul className="new-work-attachments" aria-label="待保存附件">
       {image&&<li><img src={screenshotPreview(image.input)} alt=""/><div><span title={image.name}>{image.name}</span><small>截图 · 开始后发送给 Codex</small></div>
        <button type="button" disabled={reading} aria-label={`移除 ${image.name}`} onClick={()=>{setImage(undefined);setFileNotes([]);text.current?.focus()}}>✕</button></li>}
       {files.map(file=><li key={file.key}><div><span title={file.name}>{file.name}</span><small>仅本机 · 不发送给 Codex</small></div>
        <button type="button" disabled={reading} aria-label={`移除 ${file.name}`} onClick={()=>{setFiles(current=>current.filter(item=>item.key!==file.key));setFileNotes([]);text.current?.focus()}}>✕</button></li>)}
      </ul>}
      <div className="new-work-toolbar">
       <input ref={picker} type="file" hidden multiple onChange={event=>{
        const incoming=Array.from(event.currentTarget.files??[]);event.currentTarget.value='';void choose(incoming);
       }}/>
       <button type="button" className="attach-button" disabled={reading} aria-label="添加附件" title="添加附件" onClick={()=>picker.current?.click()}>＋</button>
       <button className="primary" type="submit" disabled={reading||!canSave}>{busy?'保存中…':'保存工作'}</button>
      </div>
     </div>
     <small id={limitsID} className="new-work-limits">一张 PNG / JPEG 截图（4 MiB）可供 Codex 读取；另可附 3 个仅保存在本机的文件（每个 2 MiB）。</small>
     {!goal.trim()&&!image&&files.length>0&&<small>只有本地附件时仍可保存，但不能从卡内启动 Codex。</small>}
     {reading&&<small role="status">正在读取附件…</small>}
     {goalTooLong&&<p className="error" role="alert">任务内容最多 2000 字。</p>}
     {fileNotes.length>0&&<p className="error" role="alert">{fileNotes.join(' ')}</p>}
     <details ref={project} className="new-work-project"><summary>项目：{projectName.trim()||'未归类'}</summary>
      <label>项目名（可选）<input value={projectName} maxLength={120} aria-invalid={!validProjectName(projectName)||undefined}
       onChange={event=>{touched.current=true;setProjectName(event.currentTarget.value)}} placeholder="留空为未归类"/></label>
      {!validProjectName(projectName)&&<p className="error" role="alert">项目名最多 60 字。</p>}
     </details>
    </fieldset>
    {error&&<p className="error" role="alert">{error}</p>}
   </form>
  </dialog>
 </div>;
}
