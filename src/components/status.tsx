import { CircleCheck, CirclePause, CircleAlert, Clock3, LoaderCircle, CircleHelp } from 'lucide-react'
import { Badge } from './ui/badge'
const config = {
  running: { label: 'Running', icon: LoaderCircle, variant: 'info' },
  waiting: { label: 'Needs you', icon: Clock3, variant: 'warning' },
  failed: { label: 'Failed', icon: CircleAlert, variant: 'danger' },
  completed: { label: 'Completed', icon: CircleCheck, variant: 'success' },
  idle: { label: 'Idle', icon: CirclePause, variant: 'muted' },
  unknown: { label: 'Unknown', icon: CircleHelp, variant: 'muted' },
} as const
export function StatusBadge({ status }: { status: string }) { const item = config[status as keyof typeof config] || config.unknown; const Icon = item.icon; return <Badge variant={item.variant}><Icon size={12} />{item.label}</Badge> }
