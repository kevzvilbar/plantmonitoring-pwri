import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'default' | 'accent' | 'warn' | 'danger' | 'info' | 'muted';

const tones: Record<Tone, string> = {
  default: 'bg-secondary text-secondary-foreground',
  accent: 'bg-accent-soft text-accent',
  warn: 'bg-warn-soft text-warn-foreground',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  muted: 'bg-muted text-muted-foreground',
};

export function StatusPill({ tone = 'default', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium leading-none whitespace-nowrap",
      tones[tone], className,
    )}>
      {children}
    </span>
  );
}
