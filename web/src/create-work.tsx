import {useId,useRef,useState,type DragEvent,type FormEvent} from 'react';
import {type Task,validProjectName} from './model';
import {InlineEditor,type InlineEditorHandle} from './inline-editor';
import {inlineText,inlineImageCount,MAX_INLINE_IMAGES,type InlineDraftPart} from './inline-message';
import {composerFileBase64,composerHasFiles,composerTransferFiles,planComposerFiles,type LocalFileInput} from './composer-files';

type DraftFile=LocalFileInput&{key:number};

export function CreateWork({onCreated,defaultProjectName=''}:{onCreated:(task:Task)=>void;defaultProjectName?:string}) {
 const [parts,setParts]=useState<InlineDraftPart[]>([]),[projectName,setProjectName]=useState('');
 const [files,setFiles]=useState<DraftFile[]>([]);
 const goal=inlineText(parts), imageCount=inlineImageCount(parts);
 const [busy,setBusy]=useState(false),[reading,setReading]=useState(false),[dragging,setDragging]=useState(false);
 const [fileNotes,setFileNotes]=useState<string[]>([]),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const text=useRef<InlineEditorHandle>(null),picker=useRef<HTMLInputElement>(null),project=useRef<HTMLDetailsElement>(null);
 const submitting=useRef(false),picking=useRef(false),touched=useRef(false),dragDepth=useRef(0),fileKey=useRef(0),pickerAt=useRef<Range>(undefined);
 const headingID=useId(),hintID=useId(),limitsID=useId(),textID=useId();
 const goalTooLong=Array.from(goal).length>2000;
 const canSave=!uncertain&&!goalTooLong&&validProjectName(projectName)&&!!(goal.trim()||imageCount||files.length);

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
 async function choose(incoming:File[],at=text.current?.capture(),clipboardText="") {
  dragDepth.current=0;setDragging(false);
  if(!incoming.length||submitting.current)return;
  if(picking.current){setFileNotes(['正在读取上一批附件，请稍后再添加。']);return;}
  if(clipboardText){text.current?.insert([{text:clipboardText}],at);at=text.current?.capture();}
  at?.collapse(false);
  const {accepted,errors}=planComposerFiles(incoming,imageCount,files.length,MAX_INLINE_IMAGES);
  setFileNotes(errors);
  if(!accepted.length)return;
  picking.current=true;setReading(true);
  const added:DraftFile[]=[], inline:InlineDraftPart[]=[];
  for(const {file,name,mime} of accepted){
   try{
    const data_base64=await composerFileBase64(file);
    if(mime)inline.push({image:{mime_type:mime,data_base64}});
    else added.push({name,data_base64,key:++fileKey.current});
    touched.current=true;
   }catch{errors.push(`无法读取「${name}」，未添加。`);}
  }
  if(inline.length)text.current?.insert(inline,at,true);
  setFiles(current=>[...current,...added]);
  setFileNotes(errors);picking.current=false;setReading(false);
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
     project_name:projectName.trim(),...(imageCount?{parts}:{goal}),
     ...(files.length?{attachments:files.map(({name,data_base64})=>({name,data_base64}))}:{}),
    }),
   });
   const data=await response.json().catch(()=>null);
   if(!response.ok&&response.status>=400&&response.status<500){setError(data?.error||`无法保存 (${response.status})。`);return;}
   if(response.status!==201||!data?.id)throw new Error('未确认回执');
   submitting.current=false;close();
   setParts([]);setProjectName('');setFiles([]);setFileNotes([]);touched.current=false;
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
      <InlineEditor editorRef={text} id={textID} label="任务内容" describedBy={limitsID} invalid={goalTooLong}
       parts={parts} onChange={next=>{touched.current=true;setParts(next)}} onFiles={(incoming,at,plain)=>void choose(incoming,at,plain)}
       disabled={busy} placeholder="告诉我你想做什么。可在文字中粘贴图片，或拖入附件。"/>
      {files.length>0&&<ul className="new-work-attachments" aria-label="待保存附件">
       {files.map(file=><li key={file.key}><div><span title={file.name}>{file.name}</span><small>仅本机 · 不发送给 Codex</small></div>
        <button type="button" disabled={reading} aria-label={`移除 ${file.name}`} onClick={()=>{setFiles(current=>current.filter(item=>item.key!==file.key));setFileNotes([]);text.current?.focus()}}>✕</button></li>)}
      </ul>}
      <div className="new-work-toolbar">
       <input ref={picker} type="file" hidden multiple onChange={event=>{
        const incoming=Array.from(event.currentTarget.files??[]);event.currentTarget.value='';void choose(incoming,pickerAt.current);
       }}/>
       <button type="button" className="attach-button" disabled={reading} aria-label="添加附件" title="添加附件" onClick={()=>{pickerAt.current=text.current?.capture();picker.current?.click()}}>＋</button>
       <button className="primary" type="submit" disabled={reading||!canSave}>{busy?'保存中…':'保存工作'}</button>
      </div>
     </div>
     <small id={limitsID} className="new-work-limits">最多 3 张 PNG / JPEG 截图（每张 4 MiB），会保留在插入位置；另可附 3 个仅保存在本机的文件（每个 2 MiB）。</small>
     {!goal.trim()&&!imageCount&&files.length>0&&<small>只有本地附件时仍可保存，但不能从卡内启动 Codex。</small>}
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
