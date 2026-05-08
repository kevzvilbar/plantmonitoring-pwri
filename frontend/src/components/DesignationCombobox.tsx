import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
  CommandSeparator,
} from '@/components/ui/command';

export const DEFAULT_DESIGNATIONS = [
  'Admin',
  'Manager',
  'Supervisor',
  'Operator',
  'Maintenance',
  'Quality Assurance',
  'Data Analyst',
] as const;

export type DefaultDesignation = typeof DEFAULT_DESIGNATIONS[number];

/** The only designation that uses shared-email / multi-username sign-up. */
export const OPERATOR_DESIGNATION = 'Operator' as const;

/** Designations that get unique email + multi-plant support. */
export const NON_OPERATOR_DESIGNATIONS: DefaultDesignation[] = [
  'Admin', 'Manager', 'Supervisor', 'Maintenance', 'Quality Assurance', 'Data Analyst',
];

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  'data-testid'?: string;
  /** Extra suggestions merged with defaults (e.g. already-used custom values). */
  extraOptions?: string[];
}

/**
 * Editable combobox: default designations + free-text "Other…" entry.
 *
 * UI:
 *  - Closed: button showing current value.
 *  - Open: searchable list with 4 defaults + any `extraOptions` +
 *    a sticky "Use custom value" row if the search term doesn't match.
 */
export function DesignationCombobox({
  value, onChange, placeholder = 'Select designation…', disabled, extraOptions,
  ...rest
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState('');

  const options = useMemo(() => {
    const set = new Set<string>([...DEFAULT_DESIGNATIONS, ...(extraOptions ?? [])]);
    if (value) set.add(value);
    return Array.from(set).filter(Boolean);
  }, [extraOptions, value]);

  const commitCustom = () => {
    const v = customValue.trim();
    if (!v) return;
    onChange(v);
    setCustomMode(false);
    setCustomValue('');
    setOpen(false);
  };

  if (customMode) {
    return (
      <div className="flex gap-1.5">
        <Input
          autoFocus
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitCustom(); }
            if (e.key === 'Escape') { setCustomMode(false); setCustomValue(''); }
          }}
          placeholder="Enter custom designation…"
          data-testid="designation-custom-input"
        />
        <Button size="sm" onClick={commitCustom} data-testid="designation-custom-save">Set</Button>
        <Button
          size="sm" variant="ghost"
          onClick={() => { setCustomMode(false); setCustomValue(''); }}
        >
          Cancel
        </Button>
      </div>
    );
  }

  const showCustomHint = query.trim() && !options.some((o) => o.toLowerCase() === query.trim().toLowerCase());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
          data-testid={rest['data-testid'] ?? 'designation-trigger'}
        >
          <span className={cn(!value && 'text-muted-foreground')}>
            {value || placeholder}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Search designations…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup heading="Suggested">
              {options.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={() => { onChange(opt); setOpen(false); setQuery(''); }}
                  data-testid={`designation-option-${opt.toLowerCase()}`}
                >
                  <Check className={cn('h-4 w-4 mr-2', value === opt ? 'opacity-100' : 'opacity-0')} />
                  {opt}
                </CommandItem>
              ))}
            </CommandGroup>
            {showCustomHint && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => { onChange(query.trim()); setOpen(false); setQuery(''); }}
                    className="text-accent"
                  >
                    <Check className="h-4 w-4 mr-2 opacity-0" />
                    Use "{query.trim()}"
                  </CommandItem>
                </CommandGroup>
              </>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => { setOpen(false); setCustomMode(true); setCustomValue(query.trim()); setQuery(''); }}
                data-testid="designation-custom-mode"
              >
                <Plus className="h-4 w-4 mr-2" />
                Enter custom…
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Derive a coarse-grained access level badge from the user's roles.
 * Admin → Full access, Manager → Elevated, Supervisor/Maintenance/QA/Data Analyst → Limited,
 * Operator/other → Restricted.
 */
export function accessLevelFromRoles(roles: string[] | undefined | null): {
  label: string;
  tone: 'accent' | 'warn' | 'muted';
} {
  const r = new Set((roles ?? []).map((x) => x.toLowerCase()));
  if (r.has('admin')) return { label: 'Full access', tone: 'accent' };
  if (r.has('manager')) return { label: 'Elevated', tone: 'accent' };
  if (r.has('supervisor')) return { label: 'Limited', tone: 'warn' };
  return { label: 'Restricted', tone: 'muted' };
}
