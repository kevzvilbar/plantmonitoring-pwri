import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Read-only input for auto-calculated values.
 * Uses a distinct background + dashed border so users can tell at a glance
 * which fields they need to type into vs. which are derived.
 */
export const ComputedInput = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, value, ...props }, ref) => (
    <input
      ref={ref}
      readOnly
      tabIndex={-1}
      value={value ?? ''}
      className={cn(
        'flex h-10 w-full rounded-md border border-dashed border-accent/40 bg-accent-soft/30 px-3 py-2 text-sm font-mono-num text-foreground/80 cursor-default focus:outline-none transition-colors',
        className,
      )}
      {...props}
    />
  ),
);
ComputedInput.displayName = 'ComputedInput';
