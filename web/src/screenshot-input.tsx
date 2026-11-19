import {useEffect, useRef, useState, type ClipboardEvent} from 'react';
import {screenshotError, screenshotFromDataURL, screenshotPreview, type ScreenshotInput} from './managed-codex';

export function useScreenshotInput(current: ScreenshotInput | undefined, change: (image?: ScreenshotInput) => void) {
 const [loading,setLoading] = useState(false), [error,setError] = useState('');
 const readID = useRef(0);
 useEffect(()=>()=>{++readID.current},[]);
 function choose(file: File) {
  const id = ++readID.current;
  const invalid = screenshotError(file);
  setError(invalid);
  if (invalid) { setLoading(false); return; }
  setLoading(true);
  const reader = new FileReader();
  const finish = (reason?: string) => {
   if (id !== readID.current) return;
   setLoading(false);
   if (reason) { setError(reason); return; }
   try { change(screenshotFromDataURL(file.type, String(reader.result))); }
   catch (e) { setError((e as Error).message); }
  };
  reader.onload = () => finish();
  reader.onerror = reader.onabort = () => finish('截图无法读取。');
  try { reader.readAsDataURL(file); }
  catch { finish('截图无法读取。'); }
 }
 function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
  const file = Array.from(event.clipboardData.files).find(item => item.type.startsWith('image/')) ??
   Array.from(event.clipboardData.items).find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
  if (!file) return;
  // Keep the browser's normal text paste when a clipboard contains both.
  if (!event.clipboardData.getData('text/plain')) event.preventDefault();
  choose(file);
 }
 function clear() {
  ++readID.current;
  change(undefined); setLoading(false); setError('');
 }
 return {current, loading, error, choose, onPaste, clear};
}

export function ScreenshotInput({draft, disabled = false}: {draft: ReturnType<typeof useScreenshotInput>; disabled?: boolean}) {
 return <div className="screenshot-input">
  <label>截图（可选）<input type="file" accept="image/png,image/jpeg" disabled={disabled} onChange={event => {
   const [file] = Array.from(event.currentTarget.files ?? []);
   event.currentTarget.value = '';
   if (file) draft.choose(file);
  }}/></label>
  <small>也可直接粘贴到上面的文字框。最多一张 PNG / JPEG，4 MB。</small>
  {draft.loading && <small role="status">正在读取截图…</small>}
  {draft.error && <small className="error" role="alert">{draft.error}</small>}
  {draft.current && <div className="screenshot-preview">
   <img src={screenshotPreview(draft.current)} alt="待提交的截图"/>
   <button type="button" disabled={disabled} onClick={draft.clear}>移除截图</button>
  </div>}
 </div>;
}
