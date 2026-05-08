import { cn } from '@/lib/utils';
import { AlertTriangle, Inbox, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';

type Props = {
  loading?: boolean;
  error?: unknown;
  isEmpty?: boolean;
  onRetry?: () => void;
  /** When to show built-in message; pass children as the content otherwise */
  children?: ReactNode;
  /** Empty-state label */
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
};

/**
 * A single component that renders loading / error / empty / content states
 * consistently across the app. Use like:
 *   <DataState loading={isLoading} error={error} isEmpty={!data?.length}>
 *     {children}
 *   </DataState>
 */
export function DataState({
  loading, error, isEmpty, onRetry,
  children, emptyTitle = 'Nothing here yet', emptyDescription,
  className,
}: Props) {
  if (loading) {
    return (
      <div className={cn('flex items-center justify-center py-10 text-muted-foreground', className)}>
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
      </div>
    );
  }
  if (error) {
    const msg = (error instanceof Error ? error.message : String(error)) || 'Failed to load';
    return (
      <div className={cn('rounded-md border border-rose-200 bg-rose-50/50 p-4 text-sm', className)}>
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-rose-600 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-rose-800">Could not load data</div>
            <div className="text-xs text-rose-700/80 mt-0.5 break-words">{msg}</div>
          </div>
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
          )}
        </div>
      </div>
    );
  }
  if (isEmpty) {
    return (
      <div className={cn('rounded-md border border-dashed py-10 text-center text-muted-foreground', className)}>
        <Inbox className="h-6 w-6 mx-auto opacity-60" />
        <div className="mt-2 text-sm font-medium text-foreground">{emptyTitle}</div>
        {emptyDescription && <div className="text-xs mt-1">{emptyDescription}</div>}
      </div>
    );
  }
  return <>{children}</>;
}
