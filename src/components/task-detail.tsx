import { useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, Archive, ArrowUpRight, Check, ChevronRight, Circle, Clock3, Code2, ExternalLink, FileText, GitBranch, GitCommitHorizontal, GitPullRequest, History, LoaderCircle, Pencil, RefreshCw, Server, TerminalSquare, X } from 'lucide-react'
import { api } from '../lib/api'
import type { AgentEvent, Host, TaskDetail } from '../lib/types'
import { agentName, cn, dateTime, duration, relativeTime, safeLink, shortRepo, stringValue, taskState } from '../lib/utils'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { StatusBadge } from './status'
import { AttentionList } from './attention'
const eventLabels: Record<string, string> = { waiting_for_input: 'Input requested', turn_started: 'Turn started', turn_finished: 'Turn finished', task_started: 'Task started', task_completed: 'Task completed', task_failed: 'Task failed', run_started: 'Run started', run_completed: 'Run completed', run_failed: 'Run failed', session_started: 'Session connected', session_ended: 'Session ended', approval_required: 'Approval requested', approval_requested: 'Approval requested', input_required: 'Input requested', input_requested: 'Input requested', error: 'Agent error', tool_started: 'Tool started', tool_completed: 'Tool completed', heartbeat: 'Heartbeat received', message: 'Agent message', progress: 'Progress update', commit_created: 'Commit created', pull_request_created: 'Pull request opened', summary: 'Summary updated', retry: 'Retry reported' }
function eventTitle(event: AgentEvent) { return eventLabels[event.event_type] || event.event_type.replace(/[._-]/g, ' ').replace(/^./, value => value.toUpperCase()) }
function eventMessage(event: AgentEvent) { const p = event.payload || {}; return stringValue(p.question) || stringValue(p.message) || stringValue(p.summary) || stringValue(p.error) || stringValue(p.description) || stringValue(p.text) }
function EventLinks({ event }: { event: AgentEvent }) {
  const p = event.payload || {}
  const links = [
    { url: safeLink(p.pr_url) || safeLink(p.pull_request_url) || (event.event_type.includes('pull_request') ? safeLink(p.url) : undefined), label: 'Pull request', icon: GitPullRequest },
    { url: safeLink(p.commit_url) || (event.event_type.includes('commit') ? safeLink(p.url) : undefined), label: stringValue(p.commit_sha)?.slice(0, 8) || 'Commit', icon: GitCommitHorizontal },
  ].filter(link => link.url)
  const hash = stringValue(p.commit_sha) || stringValue(p.commit)
  return links.length || hash ? <div className="event-links">{hash && !links.some(link => link.icon === GitCommitHorizontal) && <span className="commit-hash mono" title={hash}><GitCommitHorizontal size={13} />{hash.slice(0, 12)}</span>}{links.map(({ url, label, icon: Icon }) => <a key={url} href={url} target="_blank" rel="noreferrer" className="text-link"><Icon size={13} />{label}<ArrowUpRight size={12} /></a>)}</div> : null
}
export function TaskDetailPanel({ taskId, hosts, onChanged, onSignalState, busySignal, canManage }: { canManage: boolean; taskId: string; hosts: Host[]; onChanged: () => void; onSignalState: (id: string, state: 'open' | 'read' | 'ignored') => Promise<void>; busySignal: string | null }) {
  const [data, setData] = useState<TaskDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [tab, setTab] = useState<'activity' | 'runs' | 'context'>('activity')
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [timelineEvents, setTimelineEvents] = useState<AgentEvent[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [timelineError, setTimelineError] = useState<string | null>(null)
  const loadedOlder = useRef(false)
  useEffect(() => {
    let active = true; let running = false
    const controller = new AbortController()
    setData(null); setLoading(true); setError(null); setEditing(false); setActionError(null); setTimelineEvents([]); setNextCursor(null); setTimelineError(null); loadedOlder.current = false
    const load = async () => {
      if (running) return
      running = true
      try {
        const [result, timeline] = await Promise.all([api<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`, { signal: controller.signal }), api<{ events: AgentEvent[]; next_cursor: string | null }>(`/api/tasks/${encodeURIComponent(taskId)}/events?limit=100`, { signal: controller.signal })])
        if (active) {
          setData(result); setError(null)
          setTimelineEvents(current => loadedOlder.current ? mergeEvents(timeline.events, current) : timeline.events)
          if (!loadedOlder.current) setNextCursor(timeline.next_cursor)
        }
      }
      catch (error) { if (active && !(error instanceof DOMException && error.name === 'AbortError')) setError(error instanceof Error ? error.message : 'Could not load task details') }
      finally { running = false; if (active) setLoading(false) }
    }
    void load(); const interval = window.setInterval(load, 7000)
    return () => { active = false; controller.abort(); clearInterval(interval) }
  }, [taskId, retry])
  async function loadOlderEvents() {
    if (!nextCursor || loadingOlder) return
    setLoadingOlder(true); setTimelineError(null)
    try {
      const result = await api<{ events: AgentEvent[]; next_cursor: string | null }>(`/api/tasks/${encodeURIComponent(taskId)}/events?limit=100&cursor=${encodeURIComponent(nextCursor)}`)
      loadedOlder.current = true; setTimelineEvents(current => mergeEvents(current, result.events)); setNextCursor(result.next_cursor)
    } catch (error) { setTimelineError(error instanceof Error ? error.message : 'Could not load older events') }
    finally { setLoadingOlder(false) }
  }
  async function updateTask(body: { name?: string; archived?: boolean }) {
    setSaving(true); setActionError(null)
    try { await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(body) }); setData(current => current ? { ...current, task: { ...current.task, ...body } } : null); setEditing(false); onChanged() }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not update task') }
    finally { setSaving(false) }
  }
  if (loading) return <div className="detail-loading"><LoaderCircle className="spin" size={26} /><p>Loading task activity…</p></div>
  if (!data) return <div className="detail-loading"><AlertTriangle size={28} /><h3>Task details unavailable</h3><p>{error}</p><Button variant="secondary" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />Try again</Button></div>
  const { task, runs, sessions, attention } = data
  const events = timelineEvents
  const host = hosts.find(host => host.id === task.host_id)
  const sortedEvents = [...events].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  const openSignals = attention.filter(item => item.state === 'open' && !item.resolved_at)
  const errorEvents = sortedEvents.filter(event => /error|failed|failure/.test(event.event_type))
  const retryEvents = sortedEvents.filter(event => /retry|restart/.test(event.event_type) || event.payload?.retry_count !== undefined || event.payload?.attempt !== undefined)
  return <>
    <div className="detail-header"><div className="eyebrow"><TerminalSquare size={13} /> TASK INSPECTOR</div><div className="detail-title-row"><h2>{task.name}</h2>{canManage && <Button variant="ghost" size="icon" title="Rename task" aria-label="Rename task" onClick={() => { setName(task.name); setEditing(true) }}><Pencil size={15} /></Button>}</div>
      {editing && <form className="rename-form" onSubmit={event => { event.preventDefault(); if (name.trim()) void updateTask({ name: name.trim() }) }}><label className="sr-only" htmlFor="task-name">Task name</label><input id="task-name" autoFocus maxLength={160} value={name} onChange={event => setName(event.target.value)} /><Button size="sm" type="submit" disabled={saving || !name.trim()}>{saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Save</Button><Button size="icon" variant="ghost" aria-label="Cancel rename" onClick={() => setEditing(false)}><X size={16} /></Button></form>}
      <div className="detail-subtitle"><StatusBadge status={taskState(task)} /><span>{agentName(task.agent_type)}</span><span>·</span><span>{host?.name || task.host_id}</span>{!!task.archived && <Badge variant="muted">Archived</Badge>}</div>
      {task.summary && <p className="detail-summary">{task.summary}</p>}
      <div className="detail-metrics"><div><span>Elapsed</span><strong>{duration(task.created_at, task.completed_at || (task.status === 'failed' ? task.last_activity_at : null))}</strong></div><div><span>Last activity</span><strong>{relativeTime(task.last_activity_at)}</strong></div><div><span>Runs</span><strong>{runs.length}</strong></div><div><span>Events</span><strong>{events.length}{nextCursor ? "+" : ""}</strong></div></div>
      {actionError && <p role="alert" className="inline-error">{actionError}</p>}
      {error && <p role="status" className="inline-error">Live refresh interrupted: {error}</p>}
    </div>
    <div className="detail-tabs" role="tablist" aria-label="Task details">{([{ id: 'activity', label: 'Activity', icon: Activity }, { id: 'runs', label: 'Runs & sessions', icon: History }, { id: 'context', label: 'Context', icon: Code2 }] as const).map(item => <button key={item.id} id={`tab-${item.id}`} aria-controls={`panel-${item.id}`} role="tab" tabIndex={tab === item.id ? 0 : -1} aria-selected={tab === item.id} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const tabs = ["activity", "runs", "context"] as const; const index = tabs.indexOf(tab); const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[2] : tabs[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3]; setTab(next); document.getElementById(`tab-${next}`)?.focus() } }} onClick={() => setTab(item.id)} className={cn(tab === item.id && 'selected')}><item.icon size={14} />{item.label}</button>)}</div>
    <div className="detail-body" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {tab === 'activity' && <>
        {openSignals.length > 0 && <section className="detail-signals"><h3 className="section-kicker">Needs attention</h3><AttentionList items={openSignals} tasks={[task]} hosts={hosts} busy={busySignal} canManage={canManage} onState={(signal, state) => { void onSignalState(signal.id, state).then(() => setData(current => current ? { ...current, attention: current.attention.map(item => item.id === signal.id ? { ...item, state } : item) } : null)).catch(error => setActionError(error instanceof Error ? error.message : 'Could not update signal')) }} /></section>}
        {errorEvents.length > 0 && <div className="error-summary"><AlertTriangle size={16} /><div><strong>Latest error</strong><p>{eventMessage(errorEvents[0]) || eventTitle(errorEvents[0])}</p><small>{dateTime(errorEvents[0].timestamp)}</small></div></div>}
        <div className="timeline-heading"><h3>Event timeline</h3><span>{events.length}{nextCursor ? "+" : ""} events loaded · newest first</span></div>
        {!events.length ? <div className="small-empty"><Activity size={24} /><h3>No events yet</h3><p>Reported agent events will appear here automatically.</p></div> : <ol className="timeline">{sortedEvents.map((event, index) => {
          const isError = /error|fail/.test(event.event_type); const isWaiting = /approval|input/.test(event.event_type)
          return <li className={cn('timeline-item', isError && 'is-error', isWaiting && 'is-warning')} key={event.id || event.event_id || `${event.timestamp}-${index}`}><span className="timeline-marker">{isError ? <AlertTriangle size={11} /> : /complete/.test(event.event_type) ? <Check size={11} /> : <Circle size={7} fill="currentColor" />}</span><div className="timeline-topline"><h4>{eventTitle(event)}</h4><time title={event.timestamp}>{dateTime(event.timestamp)}</time></div>{eventMessage(event) && <p className="event-message">{eventMessage(event)}</p>}<EventLinks event={event} /><div className="event-meta"><span>{agentName(event.agent_type)}</span>{event.run_id && <span title={event.run_id}>run {event.run_id.slice(0, 8)}</span>}</div><details className="event-payload"><summary><ChevronRight size={12} />Event payload</summary><pre>{JSON.stringify(event.payload || {}, null, 2)}</pre></details></li>
        })}</ol>}
        {timelineError && <p className="inline-error" role="alert">{timelineError}</p>}
        {nextCursor && <div className="load-more-events"><Button variant="secondary" disabled={loadingOlder} onClick={() => void loadOlderEvents()}>{loadingOlder ? <LoaderCircle className="spin" size={14} /> : <History size={14} />}Load older events</Button></div>}
      </>}
      {tab === 'runs' && <><div className="timeline-heading"><h3>Run history</h3><span>{runs.length} recorded</span></div>{runs.length ? <div className="run-list">{[...runs].sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()).map((run, index) => <article className="run-card" key={run.id}><div className="run-topline"><div className="run-icon"><TerminalSquare size={16} /></div><div><h4>Run {runs.length - index}</h4><span className="mono">{run.id}</span></div><Badge variant={run.status === 'failed' ? 'danger' : run.status === 'completed' ? 'success' : 'info'}>{run.status}</Badge></div>{run.summary && <p>{run.summary}</p>}<div className="run-bottom"><span><Clock3 size={12} />{duration(run.started_at, run.ended_at)}</span><span>{dateTime(run.started_at)}</span></div></article>)}</div> : <div className="small-empty"><History size={24} /><p>No runs have been reported for this task.</p></div>}
        <div className="retry-info"><RefreshCw size={16} /><div><strong>Retry information</strong><p>{retryEvents.length ? `${retryEvents.length} retry-related event${retryEvents.length === 1 ? '' : 's'} reported. Inspect their payloads in the activity timeline for attempt and retry details.` : 'No explicit retry event in the loaded timeline.'}{runs.length > 1 ? ` ${runs.length} runs are recorded for this task; repeated runs do not necessarily indicate a retry.` : ''} Retries are initiated on the agent’s host.</p></div></div>
        <h3 className="section-kicker sessions-heading">Sessions</h3>{sessions.length ? <div className="session-list">{sessions.map(session => <div className="session-row" key={session.id}><div><strong>{agentName(session.agent_type)}</strong><span className="mono">{session.id}</span><small>{dateTime(session.started_at)} · last active {relativeTime(session.last_activity_at)}</small></div><Badge variant="muted">{session.status}</Badge></div>)}</div> : <p className="muted">No linked sessions.</p>}
      </>}
      {tab === 'context' && <><h3 className="section-kicker">Task context</h3><dl className="context-list"><div><dt><Code2 size={14} />Project</dt><dd>{task.project || 'Not reported'}</dd></div><div><dt><FileText size={14} />Repository</dt><dd>{safeLink(task.repo) ? <a className="text-link" target="_blank" rel="noreferrer" href={safeLink(task.repo)}>{shortRepo(task.repo)}<ExternalLink size={12} /></a> : task.repo || 'Not reported'}</dd></div><div><dt><GitBranch size={14} />Branch</dt><dd>{task.branch || 'Not reported'}</dd></div><div><dt><Server size={14} />Host</dt><dd>{host?.name || task.host_id}</dd></div><div><dt><TerminalSquare size={14} />Agent</dt><dd>{agentName(task.agent_type)}</dd></div><div><dt><Clock3 size={14} />Created</dt><dd>{dateTime(task.created_at)}</dd></div><div><dt><Check size={14} />Completed</dt><dd>{dateTime(task.completed_at)}</dd></div><div><dt>Task ID</dt><dd className="mono">{task.id}</dd></div><div><dt>Current run ID</dt><dd className="mono">{task.current_run_id || 'Not reported'}</dd></div></dl>{canManage && <div className="archive-block"><div><h4>{task.archived ? 'Restore to task list' : 'Archive this task'}</h4><p>{task.archived ? 'Make this task visible in your default task list again.' : 'Hide the task from the default list. Its history stays available.'}</p></div><Button variant="outline" size="sm" disabled={saving} onClick={() => void updateTask({ archived: !task.archived })}><Archive size={14} />{task.archived ? 'Restore' : 'Archive'}</Button></div>}</>}
    </div><div className="detail-footer"><span className="live-dot" /><span>Live activity refreshes every 7 seconds</span><span>Observability only</span></div>
  </>
}

function mergeEvents(first: AgentEvent[], second: AgentEvent[]) {
  const map = new Map<string, AgentEvent>()
  for (const event of [...second, ...first]) map.set(event.event_id || event.id || `${event.timestamp}-${event.event_type}-${JSON.stringify(event.payload)}`, event)
  return [...map.values()].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}
