import { useRef, useState } from 'react';
import { type Task, validProjectName, projectNameForNewDraft } from './model';
import {type ScreenshotInput as Screenshot} from './managed-codex';
import {ScreenshotInput, useScreenshotInput} from './screenshot-input';

export function CreateWork({onCreated,defaultProjectName=''}:{onCreated:(task:Task)=>void;defaultProjectName?:string}) {
 const [expanded,setExpanded]=useState(false),[title,setTitle]=useState(''),[goal,setGoal]=useState(''),[origin,setOrigin]=useState('本人创建 · 本地工作'),[projectName,setProjectName]=useState(''),[draftTouched,setDraftTouched]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [image,setImage]=useState<Screenshot>();
 const screenshot=useScreenshotInput(image,next=>{setImage(next);setDraftTouched(true)});
 const submitting=useRef(false);
 async function submit(event:React.FormEvent) {
  event.preventDefault();if(submitting.current||screenshot.loading||!validProjectName(projectName))return;submitting.current=true;setBusy(true);setError('');
  try {
   const res=await fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,goal,origin,project_name:projectName.trim(),...(image?{image}:{})})});
   const data=await res.json();if(!res.ok)throw new Error(data.error||`请求失败 (${res.status})`);
   onCreated(data as Task);screenshot.clear();setTitle('');setGoal('');setProjectName('');setDraftTouched(false);setExpanded(false);
  } catch(e) { setError(`未能确认创建：${(e as Error).message}。请先刷新列表核实，避免重复创建。`); }
  finally {setBusy(false);submitting.current=false}
 }
 return <section className="create-work" aria-label="新建本地工作"><div className="create-heading"><button className="new-work-button" disabled={busy} aria-expanded={expanded} onClick={()=>{if(!expanded)setProjectName(projectNameForNewDraft({title,goal,projectName,touched:draftTouched},defaultProjectName));setExpanded(!expanded);setError('')}}>{expanded?'收起新建工作':'＋ 新建工作'}</button></div>
 {expanded&&<form onSubmit={e=>void submit(e)}><p className="muted">仅创建本地记录，不启动 Agent。</p><fieldset disabled={busy}><label>工作标题<input required maxLength={160} value={title} onChange={e=>{setTitle(e.target.value);setDraftTouched(true)}} placeholder="如：修复搜索忽略首尾空白"/></label><label>目标与边界<textarea required maxLength={2000} rows={3} onPaste={screenshot.onPaste} value={goal} onChange={e=>{setGoal(e.target.value);setDraftTouched(true)}} placeholder="要修复什么，怎样验收，哪些不做。不要填写凭据或公司敏感资料。"/></label><ScreenshotInput draft={screenshot} disabled={busy}/><label>项目名（可选）<input maxLength={120} value={projectName} onChange={e=>{setProjectName(e.target.value);setDraftTouched(true)}} placeholder="如：AMC、relay、Workbench"/><small>最多 60 字；留空为「未归类」，不会从来源自动分类。</small>{!validProjectName(projectName)&&<small role="alert">项目名请控制在 60 字以内。</small>}</label><label>来源说明<input required maxLength={300} value={origin} onChange={e=>{setOrigin(e.target.value);setDraftTouched(true)}}/></label><button className="primary" type="submit" disabled={screenshot.loading||!title.trim()||!goal.trim()||!origin.trim()||!validProjectName(projectName)}>{busy?'记录中…':'仅创建本地记录'}</button></fieldset>{error&&<p role="alert" className="error">{error}</p>}</form>}
 </section>
}
