import { ArrowUpRight, CheckCheck, CircleAlert, Clock3, EyeOff, Hand, MessageSquare, Radio, Unplug } from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { relativeTime } from '../lib/utils'
import type { Attention, Host, Task } from '../lib/types'
export const signalConfig = {
  approval: { label: 'Approval requested', icon: Hand, color: 'warning' },
  input: { label: 'Input requested', icon: MessageSquare, color: 'warning' },
  error: { label: 'Agent error', icon: CircleAlert, color: 'danger' },
  stale: { label: 'Activity is stale', icon: Clock3, color: 'muted' },
  offline: { label: 'Host is offline', icon: Unplug, color: 'muted' },
} as const
export function AttentionList({ items, tasks, hosts, busy, onInspect, onState, canManage = true, emptyTitle, emptyDescription }: { items: Attention[]; tasks: Task[]; hosts: Host[]; busy: string | null; emptyTitle?: string; emptyDescription?: string; canManage?: boolean; onInspect?: (item: Attention) => void; onState: (item: Attention, state: Attention['state']) => void }) {
  if (!items.length) return <div className="inbox-empty"><div className="empty-icon success"><CheckCheck size={22} /></div><div><h3>{emptyTitle || "Nothing needs your attention"}</h3><p>{emptyDescription || "Approval requests, missing input, and errors will appear here."}</p></div>{!emptyTitle && <Badge variant="success">All clear</Badge>}</div>
  return <div className="attention-list">{items.map(item => {
    const config = signalConfig[item.kind] || signalConfig.error
    const Icon = config.icon
    const task = tasks.find(task => task.id === item.task_id)
    const host = hosts.find(host => host.id === item.host_id)
    const inferred = item.inferred || item.kind === 'stale' || item.kind === 'offline'
    return <article className={`attention-card ${config.color} ${item.state !== 'open' ? 'signal-handled' : ''}`} key={item.id}>
      <div className="signal-icon"><Icon size={18} /></div>
      <div className="signal-body"><div className="signal-topline"><span className="signal-kind">{config.label}</span><Badge variant={inferred ? 'muted' : config.color}>{inferred ? <><Radio size={10} /> Inferred</> : 'Agent reported'}</Badge>{item.state !== 'open' && <Badge variant="muted">{item.state}</Badge>}<time title={item.created_at}>{relativeTime(item.created_at)}</time></div>{onInspect ? <button className="signal-title" onClick={() => onInspect(item)}>{item.message || config.label}</button> : <p className="signal-title">{item.message || config.label}</p>}<div className="signal-context"><span>{task?.name || item.task_id || 'Host signal'}</span><span className="separator">·</span><span>{host?.name || item.host_id}</span></div>{inferred && <p className="inferred-note">Inferred from missing telemetry. This is not an agent-reported request.</p>}</div>
      <div className="signal-actions">{onInspect && <Button variant="secondary" size="sm" onClick={() => onInspect(item)}>Inspect <ArrowUpRight size={13} /></Button>}{canManage && (item.state === 'open' ? <><Button variant="ghost" size="icon" disabled={busy === item.id} onClick={() => onState(item, 'read')} title="Mark as read" aria-label={`Mark ${config.label.toLowerCase()} as read`}><CheckCheck size={16} /></Button><Button variant="ghost" size="icon" disabled={busy === item.id} onClick={() => onState(item, 'ignored')} title="Ignore signal" aria-label={`Ignore ${config.label.toLowerCase()}`}><EyeOff size={15} /></Button></> : <Button variant="ghost" size="sm" disabled={busy === item.id} onClick={() => onState(item, 'open')}>Reopen</Button>)}</div>
    </article>
  })}</div>
}
