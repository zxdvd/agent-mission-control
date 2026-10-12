import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'
const variants = cva('badge', { variants: { variant: { default: 'badge-neutral', success: 'badge-success', warning: 'badge-warning', danger: 'badge-danger', info: 'badge-info', muted: 'badge-muted' } }, defaultVariants: { variant: 'default' } })
export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof variants>) { return <span className={cn(variants({ variant }), className)} {...props} /> }
