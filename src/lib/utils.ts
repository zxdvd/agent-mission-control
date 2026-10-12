import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Task } from './types'
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }
export function relativeTime(value?: string | null) {
  if (!value) return 'Not yet seen'
  const ms = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(ms)) return 'Unknown time'
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
export function dateTime(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
export function duration(start?: string | null, end?: string | null) {
  if (!start) return '—'
  const raw = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()
  if (!Number.isFinite(raw)) return '—'
  const mins = Math.max(0, Math.floor(raw / 60000))
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`
  return `${Math.floor(mins / 1440)}d ${Math.floor(mins % 1440 / 60)}h`
}
export function taskState(task: Task): string {
  if (task.status === 'failed') return 'failed'
  if (task.status === 'completed') return 'completed'
  if (task.attention === 'approval' || task.attention === 'input') return 'waiting'
  return task.activity === 'running' ? 'running' : task.activity === 'idle' ? 'idle' : 'unknown'
}
export function agentName(name?: string) { return name ? ({ claude: 'Claude Code', claude_code: 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw' }[name.toLowerCase()] || name) : 'Agent' }
export function safeLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined } catch { return undefined }
}
export function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined }
export function shortRepo(value?: string | null) { return value ? value.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '') : 'No repository' }
