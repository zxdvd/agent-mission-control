import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowDown, ArrowRight, ArrowUpRight, Box, CheckCheck, ChevronDown, ChevronRight, CircleAlert, Clock3, Command, GitBranch, Github, Inbox, Layers3, LayoutDashboard, LoaderCircle, LogOut, Menu, Moon, Radio, RefreshCw, Search, Server, ShieldCheck, Sun, TerminalSquare, Wifi, WifiOff, X, Zap } from 'lucide-react'
import { api, ApiError, requireLogin } from './lib/api'
import type { Attention, Host, Identity, Overview, Task } from './lib/types'
import { agentName, cn, dateTime, duration, relativeTime, taskState, shortRepo } from './lib/utils'
import { Button } from './components/ui/button'
import { Badge } from './components/ui/badge'
import { Sheet } from './components/ui/sheet'
import { StatusBadge } from './components/status'
import { AttentionList, signalConfig } from './components/attention'
import { TaskDetailPanel } from './components/task-detail'

type Page = 'overview' | 'tasks' | 'attention' | 'hosts'
const nav = [{ id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'tasks', label: 'All tasks', icon: Layers3 }, { id: 'attention', label: 'Attention inbox', icon: Inbox }, { id: 'hosts', label: 'Hosts', icon: Server }] as const
const statuses = ['all', 'running', 'waiting', 'failed', 'completed', 'idle', 'unknown']
function initials(value: string) { return value.slice(0, 2).toUpperCase() }
function Empty({ icon: Icon = Layers3, title, description, action }: { icon?: typeof Layers3; title: string; description: string; action?: React.ReactNode }) { return <div className="empty-state"><div className="empty-illustration"><div className="empty-orbit" /><Icon size={28} /></div><h3>{title}</h3><p>{description}</p>{action}</div> }
function SelectFilter({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) { return <div className={cn('select-filter', value !== 'all' && 'filter-active')}><label className="sr-only" htmlFor={`filter-${label}`}>{label}</label><select id={`filter-${label}`} value={value} onChange={event => onChange(event.target.value)}>{children}</select><ChevronDown size={12} aria-hidden /></div> }

export default function App() {
  const [page, setPage] = useState<Page>('overview')
  const [data, setData] = useState<Overview | null>(null)
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => { try { return localStorage.getItem('mission-control-theme') === 'light' ? 'light' : 'dark' } catch { return 'dark' } })
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const [selectedSignal, setSelectedSignal] = useState<Attention | null>(null)
  const [busySignal, setBusySignal] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [hostFilter, setHostFilter] = useState('all')
  const [agentFilter, setAgentFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [archivedTasks, setArchivedTasks] = useState<Task[] | null>(null)
  const [archiveLoadError, setArchiveLoadError] = useState<string | null>(null)
  const [attentionState, setAttentionState] = useState<Attention['state']>('open')
  const loadingRef = useRef(false)
  const logoutRef = useRef(false)
  const authBlockedRef = useRef(false)
  const aliveRef = useRef(true)
  const searchRef = useRef<HTMLInputElement>(null)

  const clearWorkspace = useCallback(() => {
    setData(null); setIdentity(null); setSelectedTask(null); setSelectedSignal(null); setArchivedTasks(null); setIncludeArchived(false)
  }, [])

  const refresh = useCallback(async () => {
    if (loadingRef.current || logoutRef.current || authBlockedRef.current) return
    loadingRef.current = true; setRefreshing(true)
    try {
      const session = await api<Identity>('/api/me')
      if (!aliveRef.current || logoutRef.current) return
      setIdentity(session)
      const result = await api<Overview>('/api/overview')
      if (aliveRef.current && !logoutRef.current) { setData(result); setError(null); setLastSync(new Date()) }
    } catch (error) {
      if (aliveRef.current && !logoutRef.current) {
        if (error instanceof ApiError && error.status === 401) { authBlockedRef.current = true; clearWorkspace() }
        setError(error instanceof Error ? error.message : 'Could not connect to the API')
      }
    }
    finally { loadingRef.current = false; if (aliveRef.current) setRefreshing(false) }
  }, [clearWorkspace])
  useEffect(() => {
    aliveRef.current = true; void refresh()
    const interval = window.setInterval(refresh, 7000)
    return () => { aliveRef.current = false; clearInterval(interval) }
  }, [refresh])
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; try { localStorage.setItem('mission-control-theme', theme) } catch { /* Storage may be blocked. */ } }, [theme])
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPage('tasks'); requestAnimationFrame(() => searchRef.current?.focus()) } if (event.key === 'Escape') setMobileNav(false) }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler) }, [])
  useEffect(() => {
    if (!includeArchived) { setArchivedTasks(null); setArchiveLoadError(null); return }
    let active = true
    void api<{ tasks: Task[] }>('/api/tasks?archived=all').then(result => { if (active) { setArchivedTasks(result.tasks); setArchiveLoadError(null) } }).catch(error => { if (active) setArchiveLoadError(error instanceof Error ? error.message : 'Could not load archived tasks') })
    return () => { active = false }
  }, [includeArchived, lastSync])
  const tasks = includeArchived && archivedTasks ? archivedTasks : data?.tasks || []
  const canManage = identity?.role === 'admin' && !loggingOut
  const hosts = data?.hosts || []
  const signals = (data?.attention || []).filter(item => !item.resolved_at)
  const openSignals = signals.filter(item => item.state === 'open')
  const activeTasks = tasks.filter(task => !task.archived && task.status === 'active')
  const agents = [...new Set(tasks.map(task => task.agent_type))].sort()
  const projects = [...new Set(tasks.map(task => task.project).filter((project): project is string => Boolean(project)))].sort()
  const filteredTasks = useMemo(() => {
    const search = query.toLowerCase().trim()
    return tasks.filter(task => (includeArchived || !task.archived) && (status === 'all' || taskState(task) === status) && (hostFilter === 'all' || task.host_id === hostFilter) && (agentFilter === 'all' || task.agent_type === agentFilter) && (projectFilter === 'all' || task.project === projectFilter) && (!search || [task.name, task.summary, task.project, task.repo, task.branch, task.agent_type, hosts.find(host => host.id === task.host_id)?.name].some(value => value?.toLowerCase().includes(search)))).sort((a, b) => new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime())
  }, [tasks, hosts, query, status, hostFilter, agentFilter, projectFilter, includeArchived])
  const anyFilter = Boolean(query || status !== 'all' || hostFilter !== 'all' || agentFilter !== 'all' || projectFilter !== 'all' || includeArchived)
  const clearFilters = () => { setQuery(''); setStatus('all'); setHostFilter('all'); setAgentFilter('all'); setProjectFilter('all'); setIncludeArchived(false) }
  const navigate = (next: Page) => { setPage(next); setMobileNav(false) }
  const showStatus = (next: string) => { clearFilters(); setStatus(next); navigate('tasks') }
  async function changeSignal(id: string, state: Attention['state']) {
    setBusySignal(id); setMutationError(null)
    try { await api(`/api/attention/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ state }) }); setData(current => current ? { ...current, attention: current.attention.map(item => item.id === id ? { ...item, state } : item) } : null); setSelectedSignal(current => current?.id === id ? { ...current, state } : current); void refresh() }
    catch (error) { setMutationError(error instanceof Error ? error.message : 'Could not update the attention item'); throw error }
    finally { setBusySignal(null) }
  }
  async function signOut() {
    if (logoutRef.current) return
    logoutRef.current = true; setLoggingOut(true); setMutationError(null)
    try {
      await api('/api/auth/logout', { method: 'POST' })
      authBlockedRef.current = true; clearWorkspace()
      requireLogin()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        authBlockedRef.current = true; clearWorkspace()
        setError(error.message)
      } else {
        logoutRef.current = false
        setMutationError(error instanceof Error ? error.message : 'Could not sign out. Try again.')
      }
    } finally { if (aliveRef.current) setLoggingOut(false) }
  }
  const handleSignal = (item: Attention, state: Attention['state']) => { void changeSignal(item.id, state).catch(() => {}) }
  const inspectSignal = (item: Attention) => { if (item.task_id) setSelectedTask(item.task_id); else setSelectedSignal(item) }
  const connectionOk = Boolean(data && !error)
  const title = nav.find(item => item.id === page)?.label || 'Overview'
  const stats = data?.stats

  return <div className="app-shell">
    <a href="#main-content" className="skip-link">Skip to content</a>
    {mobileNav && <button className="mobile-nav-overlay" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside className={cn('sidebar', mobileNav && 'is-open')}>
      <a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('overview') }} aria-label="Mission Control home"><div className="brand-mark"><Command size={22} strokeWidth={2.4} /></div><span>mission<span className="brand-light">control</span><small>AGENT OPERATIONS</small></span></a>
      <div className="workspace-chip"><div className="workspace-icon"><Box size={17} /></div><div><strong>Control room</strong><span>All environments</span></div><ShieldCheck size={14} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{nav.map(item => <button className={cn('nav-item', page === item.id && 'active')} aria-current={page === item.id ? 'page' : undefined} key={item.id} onClick={() => navigate(item.id)}><item.icon size={17} /><span>{item.label}</span>{item.id === 'attention' && openSignals.length > 0 && <span className="nav-count warning-count">{openSignals.length}</span>}{item.id === 'tasks' && tasks.length > 0 && <span className="nav-count">{tasks.filter(task => !task.archived).length}</span>}</button>)}</nav>
      <div className="sidebar-divider" />
      <div className="nav-label agent-label">CONNECTED AGENTS <span>{agents.length}</span></div>
      <div className="sidebar-agents">{agents.length ? agents.map(agent => <button key={agent} onClick={() => { clearFilters(); setAgentFilter(agent); navigate('tasks') }} className="sidebar-agent"><span className={cn('agent-logo', agent.toLowerCase().includes('claude') && 'claude', agent.toLowerCase().includes('openclaw') && 'claw')}>{agent.toLowerCase().includes('claude') ? '✳' : agent.toLowerCase().includes('openclaw') ? <Zap size={14} /> : <TerminalSquare size={14} />}</span><span>{agentName(agent)}</span><span className="agent-task-count">{tasks.filter(task => task.agent_type === agent && task.status === 'active' && !task.archived).length}</span></button>) : <p className="sidebar-hint">Agents appear when their first event arrives.</p>}</div>
      <div className="sidebar-bottom"><div className="monitoring-note"><Radio size={17} /><strong>One place. Every agent.</strong><p>A shared view of work across your machines.</p><span><span className={cn('live-dot', !connectionOk && 'offline')} />{connectionOk ? 'Telemetry connected' : refreshing ? 'Connecting…' : 'Telemetry unavailable'}</span></div><div className="identity"><div className="avatar">{initials(identity?.email || (identity?.local ? 'LO' : 'MC'))}</div><div><strong>{identity?.local ? 'Local operator' : identity?.email || 'Workspace operator'}</strong><span>{identity ? identity.local ? 'Local development' : 'Password session' : 'Checking session…'}</span></div>{identity && !identity.local ? <Button variant="ghost" size="icon" className="sign-out-button" title="Sign out" aria-label={loggingOut ? 'Signing out' : 'Sign out'} disabled={loggingOut} onClick={() => void signOut()}>{loggingOut ? <LoaderCircle size={15} className="spin" /> : <LogOut size={15} />}</Button> : <ShieldCheck size={15} />}</div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><Button variant="ghost" size="icon" className="mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={20} /></Button><span className="breadcrumb-root">Workspace</span><ChevronRight size={13} /><strong>{title}</strong></div><div className="topbar-actions"><span className={cn('sync-status', !connectionOk && 'sync-offline')} title={lastSync ? `Last synced ${lastSync.toLocaleTimeString()}` : 'Waiting for API response'}><span className={cn('live-dot', !connectionOk && 'offline')} />{connectionOk ? 'Live' : refreshing ? 'Connecting' : 'Disconnected'}<span className="sync-cadence">· 7s</span></span><div className="topbar-divider" /><Button variant="ghost" size="icon" title="Refresh now" aria-label="Refresh data now" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={16} className={refreshing ? 'spin' : ''} /></Button><Button variant="ghost" size="icon" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</Button></div></header>
      <main className="main-content" id="main-content">
        <div className="page-header"><div><div className="eyebrow"><span className="eyebrow-line" />{page === 'overview' ? 'THE BIG PICTURE' : page === 'hosts' ? 'YOUR INFRASTRUCTURE' : page === 'attention' ? 'HUMAN IN THE LOOP' : 'WORK IN MOTION'}</div><h1>{page === 'overview' ? 'Mission Control' : title}<span className="title-dot">.</span></h1><p>{page === 'overview' ? 'Every agent, every task. A clear view of what happens next.' : page === 'hosts' ? 'Heartbeat, availability, and activity across your machines.' : page === 'attention' ? 'The decisions and signals that deserve a closer look.' : 'Follow the work from first event to final commit.'}</p></div><div className="page-header-aside"><span className="header-date">{new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span><span className="header-activity"><Activity size={13} />{activeTasks.length} active task{activeTasks.length === 1 ? '' : 's'}</span></div></div>
        {error && <div className="error-banner" role="alert"><CircleAlert size={18} /><div><strong>{data ? 'Live updates are interrupted' : 'Couldn’t reach your control room'}</strong><p>{error}{data && ' Displaying the last successfully synced data.'}</p></div>{authBlockedRef.current ? <a className="button button-outline button-sm" href="/login">Sign in</a> : <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={13} />Retry</Button>}</div>}
        {mutationError && <div className="error-banner" role="alert"><CircleAlert size={17} /><p>{mutationError}</p><Button variant="ghost" size="icon" onClick={() => setMutationError(null)} aria-label="Dismiss error"><X size={15} /></Button></div>}
        {!data && !error ? <DashboardSkeleton /> : !data ? <Empty icon={WifiOff} title="Waiting for a connection" description="Your dashboard will appear when the API is reachable. Check the service and your authenticated session, then retry." action={!authBlockedRef.current && <Button variant="secondary" onClick={() => void refresh()} disabled={refreshing}>{refreshing && <LoaderCircle size={14} className="spin" />}Reconnect</Button>} /> : <>
          {(page === 'overview' || page === 'tasks') && <div className="stats-grid"><Stat label="Running" value={stats?.running || 0} detail="Agents on the job" icon={Activity} tone="teal" onClick={() => showStatus('running')} /><Stat label="Needs you" value={stats?.waiting || 0} detail="Waiting for a human" icon={Clock3} tone="orange" onClick={() => showStatus('waiting')} /><Stat label="Failed" value={stats?.failed || 0} detail="Tasks to investigate" icon={CircleAlert} tone="red" onClick={() => showStatus('failed')} /><Stat label="Completed today" value={stats?.completed_today || 0} detail="Finished since 00:00 UTC" icon={CheckCheck} tone="blue" onClick={() => showStatus('completed')} /><Stat label="Hosts online" value={`${stats?.online_hosts || 0}/${hosts.length}`} detail={`${stats?.offline_hosts || 0} offline · heartbeat status`} icon={Server} tone="neutral" onClick={() => navigate('hosts')} /></div>}
          {(page === 'overview' || page === 'attention') && <section className="inbox-section"><div className="section-heading"><div className="section-title"><Inbox size={18} /><h2>Attention inbox</h2><span className={cn('count-pill', openSignals.length > 0 && 'count-orange')}>{openSignals.length}</span></div>{page === 'overview' ? <button className="subtle-link" onClick={() => navigate('attention')}>View inbox<ArrowRight size={13} /></button> : <div className="segmented-control" aria-label="Attention status">{(['open', 'read', 'ignored'] as const).map(state => <button aria-pressed={attentionState === state} className={cn(attentionState === state && 'selected')} key={state} onClick={() => setAttentionState(state)}>{state.charAt(0).toUpperCase() + state.slice(1)}<span>{signals.filter(item => item.state === state).length}</span></button>)}</div>}</div><AttentionList items={page === 'overview' ? openSignals.slice(0, 4) : signals.filter(item => item.state === attentionState)} tasks={tasks} hosts={hosts} busy={busySignal} canManage={canManage} emptyTitle={page === "attention" && attentionState !== "open" ? `No ${attentionState} signals` : undefined} emptyDescription={page === "attention" && attentionState !== "open" ? `Signals you mark as ${attentionState} will appear here.` : undefined} onInspect={inspectSignal} onState={handleSignal} />{page === 'overview' && openSignals.length > 4 && <button className="more-signals" onClick={() => navigate('attention')}>View {openSignals.length - 4} more signal{openSignals.length - 4 === 1 ? '' : 's'}<ArrowRight size={13} /></button>}{page === 'attention' && <p className="section-footnote"><ShieldCheck size={13} />Marking a signal as read or ignored only updates this inbox. Approval and input requests must be handled in the agent’s own session.</p>}</section>}
          {(page === 'overview' || page === 'tasks') && <section className="tasks-section"><div className="section-heading"><div className="section-title"><Layers3 size={18} /><h2>{page === 'overview' ? 'Task activity' : 'All tasks'}</h2><span className="count-pill">{filteredTasks.length}</span></div><span className="small-label"><ArrowDown size={12} />Latest activity first</span></div><div className="tasks-panel"><div className="task-toolbar"><div className="search-box"><Search size={16} /><label htmlFor="task-search" className="sr-only">Search tasks</label><input id="task-search" ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search tasks, repos, branches…" /><kbd>⌘ K</kbd>{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={13} /></button>}</div><div className="filters"><SelectFilter label="Status" value={status} onChange={setStatus}>{statuses.map(value => <option key={value} value={value}>{value === 'all' ? 'All statuses' : value === 'waiting' ? 'Needs you' : value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</SelectFilter><SelectFilter label="Host" value={hostFilter} onChange={setHostFilter}><option value="all">All hosts</option>{hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}</SelectFilter><SelectFilter label="Agent" value={agentFilter} onChange={setAgentFilter}><option value="all">All agents</option>{agents.map(agent => <option key={agent} value={agent}>{agentName(agent)}</option>)}</SelectFilter><SelectFilter label="Project" value={projectFilter} onChange={setProjectFilter}><option value="all">All projects</option>{projects.map(project => <option key={project} value={project}>{project}</option>)}</SelectFilter></div></div><div className="task-filter-meta"><label className="checkbox-label"><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />Include archived</label>{anyFilter && <button className="clear-filters" onClick={clearFilters}><X size={12} />Clear filters</button>}</div>
            {includeArchived && archiveLoadError && <p className="archive-load-error" role="alert">Archived tasks unavailable: {archiveLoadError}</p>}
            {includeArchived && !archivedTasks && !archiveLoadError && <p className="archive-load-error" role="status">Loading archived tasks…</p>}
            {filteredTasks.length ? <div className="task-table-wrap"><table className="task-table"><thead><tr><th scope="col">Task / project</th><th scope="col">Agent / host</th><th scope="col">Status</th><th scope="col">Elapsed</th><th scope="col">Last activity</th><th scope="col"><span className="sr-only">Open details</span></th></tr></thead><tbody>{filteredTasks.map(task => { const host = hosts.find(host => host.id === task.host_id); return <tr key={task.id} className={cn(taskState(task) === 'waiting' && 'waiting-row')}><td className="task-main-cell"><div className="task-name-line"><span className={cn('task-indicator', taskState(task))} /><button className="task-name" onClick={() => setSelectedTask(task.id)}>{task.name}</button>{!!task.archived && <Badge variant="muted">Archived</Badge>}</div>{task.summary && <p className="task-summary" title={task.summary}>{task.summary}</p>}<div className="repo-context">{task.project && <span className="project-label">{task.project}</span>}{task.repo && <span title={task.repo}><Github size={11} />{shortRepo(task.repo)}</span>}{task.branch && <span title={task.branch}><GitBranch size={11} />{task.branch}</span>}</div></td><td><div className="table-agent"><TerminalSquare size={12} />{agentName(task.agent_type)}</div><div className="table-host"><span className={cn('tiny-dot', host?.online && 'online')} />{host?.name || task.host_id}</div></td><td><StatusBadge status={taskState(task)} />{(task.attention === 'approval' || task.attention === 'input') && task.status === 'active' && <span className="status-note">{task.attention === 'approval' ? 'Approval requested' : 'Input requested'}</span>}</td><td className="duration-cell">{duration(task.created_at, task.completed_at || (task.status === 'failed' ? task.last_activity_at : null))}</td><td className="activity-cell"><time title={dateTime(task.last_activity_at)}>{relativeTime(task.last_activity_at)}</time>{task.status === 'active' && task.activity === 'running' && <span className="activity-bars" aria-hidden><i /><i /><i /><i /></span>}</td><td className="task-arrow-cell"><Button variant="ghost" size="icon" aria-label={`Inspect ${task.name}`} onClick={() => setSelectedTask(task.id)}><ChevronRight size={16} /></Button></td></tr> })}</tbody></table></div> : <Empty icon={anyFilter ? Search : TerminalSquare} title={anyFilter ? 'No matching tasks' : 'Ready for your first task'} description={anyFilter ? 'Try another search or clear your filters to see more work.' : 'Connect a host adapter and start an agent session. Real task activity will appear here automatically.'} action={anyFilter ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined} />}
            <div className="table-footer"><span>{filteredTasks.length} task{filteredTasks.length === 1 ? '' : 's'}{anyFilter ? ' matching filters' : ' in your workspace'}</span><span><span className="tiny-dot online" />Auto-refreshes every 7s</span></div></div></section>}
          {page === 'hosts' && <HostsView hosts={hosts} tasks={tasks} onShowTasks={host => { clearFilters(); setHostFilter(host.id); navigate('tasks') }} />}
          <footer className="page-footer"><span><ShieldCheck size={12} />A monitoring console. Your agents stay in control.</span><span>{lastSync ? `Last synced ${lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Not yet synced'}<span className="footer-dot">·</span>UTC reporting day</span></footer>
        </>}
      </main>
    </div>
    <Sheet open={Boolean(selectedTask)} onOpenChange={open => { if (!open) setSelectedTask(null) }} title="Task details" description="Inspect task status, events, run history, and context.">{selectedTask && <TaskDetailPanel canManage={canManage} taskId={selectedTask} hosts={hosts} onChanged={() => void refresh()} onSignalState={changeSignal} busySignal={busySignal} />}</Sheet>
    <Sheet open={Boolean(selectedSignal)} onOpenChange={open => { if (!open) setSelectedSignal(null) }} title="Signal details" description="Inspect host signal details.">{selectedSignal && <div className="standalone-signal"><div className="eyebrow"><Radio size={14} />SIGNAL DETAILS</div><h2>{signalConfig[selectedSignal.kind]?.label || 'Signal'}</h2><Badge variant={selectedSignal.inferred ? 'muted' : 'warning'}>{selectedSignal.inferred ? 'Inferred from telemetry' : 'Agent reported'}</Badge><p className="signal-detail-message">{selectedSignal.message}</p><dl className="context-list"><div><dt>Host</dt><dd>{hosts.find(host => host.id === selectedSignal.host_id)?.name || selectedSignal.host_id}</dd></div><div><dt>Created</dt><dd>{dateTime(selectedSignal.created_at)}</dd></div><div><dt>State</dt><dd>{selectedSignal.state}</dd></div><div><dt>Session</dt><dd className="mono">{selectedSignal.session_id || 'Not linked'}</dd></div><div><dt>Signal ID</dt><dd className="mono">{selectedSignal.id}</dd></div></dl>{selectedSignal.inferred && <div className="retry-info"><Radio size={17} /><p>This signal is inferred from missing telemetry. Inspect the host’s connection and agent session to verify its condition.</p></div>}{mutationError && <p className="inline-error" role="alert">{mutationError}</p>}<div className="signal-detail-actions">{canManage && (selectedSignal.state === 'open' ? <><Button variant="secondary" disabled={busySignal === selectedSignal.id} onClick={() => handleSignal(selectedSignal, 'read')}><CheckCheck size={15} />Mark as read</Button><Button variant="outline" disabled={busySignal === selectedSignal.id} onClick={() => handleSignal(selectedSignal, 'ignored')}>Ignore</Button></> : <Button variant="secondary" disabled={busySignal === selectedSignal.id} onClick={() => handleSignal(selectedSignal, 'open')}>Reopen signal</Button>)}</div></div>}</Sheet>
  </div>
}
function Stat({ label, value, detail, icon: Icon, tone, onClick }: { label: string; value: string | number; detail: string; icon: typeof Activity; tone: string; onClick: () => void }) { return <button className={`stat-card ${tone}`} onClick={onClick}><div className="stat-top"><span>{label}</span><Icon size={16} /></div><div className="stat-value">{value}<ArrowUpRight size={18} /></div><span className="stat-detail">{detail}</span><div className="stat-accent" /></button> }
function HostsView({ hosts, tasks, onShowTasks }: { hosts: Host[]; tasks: Task[]; onShowTasks: (host: Host) => void }) {
  return <section><div className="host-summary"><div><span className="live-dot" /><strong>{hosts.filter(host => host.online).length}</strong> online</div><div><span className="live-dot offline" /><strong>{hosts.filter(host => !host.online).length}</strong> offline</div><span>Availability is inferred from host heartbeat telemetry</span></div>{!hosts.length ? <div className="tasks-panel"><Empty icon={Server} title="Your fleet starts here" description="Configure a fixed host token in Worker Secrets and its matching adapter. The first valid heartbeat creates the host record here." /></div> : <div className="hosts-grid">{hosts.map(host => { const hostTasks = tasks.filter(task => task.host_id === host.id && !task.archived); const agentTypes = [...new Set(hostTasks.map(task => task.agent_type))]; return <article className={cn('host-card', !host.online && 'host-offline')} key={host.id}><div className="host-card-header"><div className="host-icon"><Server size={22} /></div><Badge variant={host.online ? 'success' : 'muted'}>{host.online ? <Wifi size={11} /> : <WifiOff size={11} />}{host.online ? 'Online' : 'Offline'}</Badge></div><h3>{host.name}</h3><p className="host-id mono">{host.id}</p><div className="host-heartbeat"><Activity size={13} /><span>Last heartbeat</span><strong title={dateTime(host.last_heartbeat_at)}>{relativeTime(host.last_heartbeat_at)}</strong></div><div className="host-counts"><div><strong>{host.task_count}</strong><span>Tasks</span></div><div><strong>{host.session_count}</strong><span>Sessions</span></div><div><strong>{hostTasks.filter(task => taskState(task) === 'running').length}</strong><span>Running</span></div></div><div className="host-agents">{agentTypes.length ? agentTypes.map(agent => <Badge key={agent} variant="muted"><TerminalSquare size={11} />{agentName(agent)}</Badge>) : <span>No agent tasks reported</span>}</div><button className="host-task-link" onClick={() => onShowTasks(host)}>View host tasks<ArrowRight size={14} /></button></article> })}</div>}</section>
}
function DashboardSkeleton() { return <div className="dashboard-skeleton" aria-busy="true" aria-label="Loading dashboard"><div className="stats-grid">{Array.from({ length: 5 }, (_, i) => <div className="skeleton-stat" key={i}><span /><strong /><small /></div>)}</div><div className="skeleton-heading" /><div className="skeleton-signal" /><div className="skeleton-signal" /><div className="skeleton-heading" /><div className="skeleton-table">{Array.from({ length: 5 }, (_, i) => <div key={i}><span /><span /><span /></div>)}</div></div> }
