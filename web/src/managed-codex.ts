export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const FOLLOW_UP_LIMIT = 2000;
export type ScreenshotMime = 'image/png' | 'image/jpeg';
export type ScreenshotInput = {mime_type: ScreenshotMime; data_base64: string};
export type ManagedMode = 'read_only' | 'no_sandbox';
export type ManagedAction = 'start' | 'follow_up';
export type ManagedState = 'pending' | 'running' | 'completed' | 'blocked' | 'uncertain';
export type ManagedTurn = {id: string; kind: ManagedAction; state: ManagedState; message?: string; image_url?: string; reply?: string};
export type ManagedSnapshot = {mode?: ManagedMode; run_id: string; enabled: boolean; managed: boolean; can_start: boolean; can_follow_up: boolean; initial_image_url?: string; turns: ManagedTurn[]};
export type ManagedReceipt = {action: ManagedAction; request_id: string; mode?: 'no_sandbox'};
export type ManagedRequest = ManagedReceipt & {run_id: string; message?: string; image?: ScreenshotInput};

export function screenshotError(file: {type: string; size: number}): string {
 if (file.type !== 'image/png' && file.type !== 'image/jpeg') return '只支持 PNG 或 JPEG 截图。';
 if (!file.size || file.size > MAX_SCREENSHOT_BYTES) return '截图不能超过 4 MB，也不能为空。';
 return '';
}

export function screenshotFromDataURL(mime: string, url: string): ScreenshotInput {
 if (mime !== 'image/png' && mime !== 'image/jpeg') throw new Error('只支持 PNG 或 JPEG 截图。');
 const head = `data:${mime};base64,`;
 if (!url.startsWith(head) || url.length === head.length) throw new Error('截图无法读取。');
 return {mime_type: mime, data_base64: url.slice(head.length)};
}

export function screenshotPreview(image: ScreenshotInput): string {
 return `data:${image.mime_type};base64,${image.data_base64}`;
}

export function managedPath(id: string): string {
 return `/api/tasks/${encodeURIComponent(id)}/managed`;
}

// Accept only a server-supplied, task-scoped local image URL. Never fetch a
// user-supplied external URL or expose local filesystem names from the browser.
export function managedImageURL(taskID: string, value?: string): string | undefined {
 const path = managedPath(taskID) + '/images/';
 if (typeof value !== 'string' || !value.startsWith(path)) return;
 const key = value.slice(path.length);
 return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key) ? value : undefined;
}

export function parseManagedReceipt(raw: string | null): ManagedReceipt | undefined {
 if (!raw) return;
 try {
  const value = JSON.parse(raw);
  if ((value?.action === 'start' || value?.action === 'follow_up') && typeof value.request_id === 'string' &&
   /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.request_id)) return {action: value.action, request_id: value.request_id, ...(value.mode === 'no_sandbox' ? {mode: 'no_sandbox'} : {})};
 } catch {/* Old or invalid session data is not a receipt. */}
}

export function managedRequest(receipt: ManagedReceipt, runID: string, message: string, image?: ScreenshotInput): ManagedRequest {
 const target = {action: receipt.action, request_id: receipt.request_id, run_id: runID,
  ...(receipt.mode ? {mode: receipt.mode} : {})};
 if (receipt.action === 'start') return target;
 const text = message.trim();
 return {...target, ...(text ? {message: text} : {}), ...(image ? {image} : {})};
}

export function managedRequestModeMatches(snapshot: ManagedSnapshot, receipt: ManagedReceipt): boolean {
 return snapshot.enabled && (snapshot.mode ?? 'read_only') === (receipt.mode ?? 'read_only');
}

export function receiptConfirmed(snapshot: ManagedSnapshot, receipt: ManagedReceipt): boolean {
 return snapshot.turns.some(turn => turn.id === receipt.request_id && turn.kind === receipt.action);
}

export const managedStateLabel: Record<ManagedState, string> = {
 pending: '已排队', running: '执行中', completed: '已回报 · 未验收', blocked: '受阻', uncertain: '结果待核实',
};
