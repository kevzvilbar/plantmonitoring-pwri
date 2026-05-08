import React from 'react';
import { AlertTriangle, RefreshCcw } from 'lucide-react';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-[50vh] flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <div className="mx-auto h-12 w-12 rounded-full bg-rose-100 flex items-center justify-center">
            <AlertTriangle className="h-6 w-6 text-rose-600" />
          </div>
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="text-sm text-muted-foreground break-words">
            {this.state.error.message || 'An unexpected error occurred.'}
          </p>
          <div className="flex gap-2 justify-center">
            <button
              className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              onClick={this.reset}
            >
              <RefreshCcw className="h-4 w-4" /> Retry
            </button>
            <button
              className="inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm hover:bg-primary/90"
              onClick={() => (window.location.href = '/')}
            >
              Go to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
