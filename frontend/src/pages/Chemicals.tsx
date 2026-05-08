/**
 * Chemical Dosing has moved into the RO Trains page
 * under the "Chemical Dosing" tab.
 *
 * This file is kept as a redirect shim so any existing route
 * (/chemicals) still renders something graceful instead of crashing.
 */
export default function Chemicals() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 text-center p-6">
      <p className="text-lg font-semibold">Chemical Dosing has moved</p>
      <p className="text-sm text-muted-foreground max-w-xs">
        You can now find Chemical Dosing inside{' '}
        <strong>RO Trains &amp; Pre-Treatment</strong> → <strong>Chemical Dosing</strong> tab.
      </p>
      <a
        href="/ro-trains"
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Go to RO Trains →
      </a>
    </div>
  );
}
