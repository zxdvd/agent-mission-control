import {useEffect,useImperativeHandle,useLayoutEffect,useRef,type Ref,type ClipboardEvent,type DragEvent} from 'react';
import {composerHasFiles,composerTransferFiles} from './composer-files';
import {screenshotPreview} from './managed-codex';
import {inlineImageCount,MAX_INLINE_IMAGES,type InlineDraftPart} from './inline-message';

export type InlineEditorHandle={
 focus:()=>void;
 capture:()=>Range|undefined;
 insert:(parts:InlineDraftPart[],at?:Range,quiet?:boolean)=>void;
};
type Props={
 editorRef:Ref<InlineEditorHandle>;
 parts:InlineDraftPart[];
 onChange:(parts:InlineDraftPart[])=>void;
 onFiles:(files:File[],at?:Range,text?:string)=>void;
 disabled?:boolean;
 id?:string;
 label:string;
 placeholder:string;
 describedBy?:string;
 invalid?:boolean;
};

export function InlineEditor({editorRef,parts,onChange,onFiles,disabled,id,label,placeholder,describedBy,invalid}:Props) {
 const root=useRef<HTMLDivElement>(null),saved=useRef<Range>(undefined);
 const refs=useRef(new WeakMap<Node,InlineDraftPart>());
 const last=useRef<InlineDraftPart[]|undefined>(undefined);
 const onChangeRef=useRef(onChange);
 onChangeRef.current=onChange;

 function capture() {
  const selection=window.getSelection();
  if(selection?.rangeCount && root.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) {
   saved.current=selection.getRangeAt(0).cloneRange();
  }
  return saved.current?.cloneRange();
 }
 function publish() {
  if(!root.current)return;
  const next:InlineDraftPart[]=[];
  function text(value:string) {
   if(!value)return;
   const prior=next.at(-1);
   if(prior && 'text' in prior)prior.text+=value;
   else next.push({text:value});
  }
  function visit(node:Node) {
   const image=refs.current.get(node);
   if(image) {next.push(image);return;}
   if(node.nodeType===Node.TEXT_NODE) {text(node.nodeValue||'');return;}
   if(!(node instanceof HTMLElement))return;
   if(node.tagName==='BR') {text('\n');return;}
   if((node.tagName==='DIV'||node.tagName==='P') && node.previousSibling)text('\n');
   for(const child of node.childNodes)visit(child);
  }
  // Browsers can leave a solitary placeholder BR in an empty editor.
  if(!(root.current.childNodes.length===1&&root.current.firstChild instanceof HTMLBRElement))
   for(const child of root.current.childNodes)visit(child);
  last.current=next;
  onChangeRef.current(next);
 }
 function node(part:InlineDraftPart) {
  if('text' in part)return document.createTextNode(part.text);
  const outer=document.createElement('span');
  outer.className='inline-editor-image';
  outer.contentEditable='false';
  const img=document.createElement('img');
  img.src=screenshotPreview(part.image);
  img.alt='截图';
  img.draggable=false;
  const remove=document.createElement('button');
  remove.type='button';
  remove.textContent='✕';
  remove.setAttribute('aria-label','移除截图');
  remove.addEventListener('click',()=>{
   if(root.current?.contentEditable!=='true')return;
   outer.remove();
   saved.current=undefined;
   publish();
   root.current.focus();
  });
  outer.append(img,remove);
  refs.current.set(outer,part);
  return outer;
 }
 function insert(incoming:InlineDraftPart[],at?:Range,quiet=false) {
  const editor=root.current;
  if(!editor || editor.contentEditable!=='true' || !incoming.length)return;
  const range=at && editor.contains(at.commonAncestorContainer)?at:capture();
  const cursor=range && editor.contains(range.commonAncestorContainer)?range:document.createRange();
  if(cursor!==range) {cursor.selectNodeContents(editor);cursor.collapse(false);}
  if(inlineImageCount(last.current||[])+inlineImageCount(incoming)>MAX_INLINE_IMAGES)return;
  const selection=window.getSelection();
  const current=selection?.rangeCount?selection.getRangeAt(0):undefined;
  if(quiet)cursor.collapse(false);
  const restore=!quiet || (document.activeElement===editor&&(!current ||
   (current.collapsed&&current.compareBoundaryPoints(Range.START_TO_START,cursor)===0)));
  if(!quiet)cursor.deleteContents();
  const fragment=document.createDocumentFragment();
  const additions=incoming.map(node);
  fragment.append(...additions);
  cursor.insertNode(fragment);
  cursor.setStartAfter(additions[additions.length-1]);cursor.collapse(true);
  if(restore) {
   editor.focus();
   selection?.removeAllRanges();selection?.addRange(cursor);
   saved.current=cursor.cloneRange();
  }
  publish();
 }
 useImperativeHandle(editorRef,()=>({focus:()=>root.current?.focus(),capture,insert}));
 useLayoutEffect(()=>{
  if(!root.current || last.current===parts)return;
  root.current.replaceChildren(...parts.map(node));
  last.current=parts;
  saved.current=undefined;
 },[parts]);
 useEffect(()=>{
  for (const button of root.current?.querySelectorAll('button')??[]) button.disabled=!!disabled;
 },[disabled,parts]);

 function paste(event:ClipboardEvent<HTMLDivElement>) {
  event.preventDefault();
  if(disabled)return;
  const files=composerTransferFiles(event.clipboardData);
  const text=event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n');
  const at=capture();
  if(files.length)onFiles(files,at,text);
  else if(text)insert([{text}],at);
 }
 function drop(event:DragEvent<HTMLDivElement>) {
  event.preventDefault();
  const files=composerTransferFiles(event.dataTransfer);
  if(!files.length || disabled)return;
  event.stopPropagation();
  const doc = document as Document & {caretRangeFromPoint?:(x:number,y:number)=>Range|null};
  const point = doc.caretPositionFromPoint?.(event.clientX,event.clientY);
  const offset = point && root.current?.contains(point.offsetNode) ? document.createRange() : undefined;
  if(offset&&point){offset.setStart(point.offsetNode,point.offset);offset.collapse(true);}
  const range=offset??doc.caretRangeFromPoint?.(event.clientX,event.clientY);
  onFiles(files,range&&root.current?.contains(range.commonAncestorContainer)?range:capture());
 }

 return <div ref={root} id={id} className="inline-editor" role="textbox" aria-label={label}
  aria-multiline="true" aria-disabled={disabled||undefined} aria-describedby={describedBy} aria-invalid={invalid||undefined}
  data-placeholder={placeholder} contentEditable={!disabled} suppressContentEditableWarning
  onInput={()=>{capture();publish()}} onBlur={capture} onMouseUp={capture} onKeyUp={capture}
  onPaste={paste} onDrop={drop} onDragStart={e=>e.preventDefault()}
  onDragOver={e=>{if(!disabled&&composerHasFiles(e.dataTransfer))e.preventDefault()}}
  onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&!disabled){e.preventDefault();insert([{text:'\n'}],capture());}}}/>;
}
