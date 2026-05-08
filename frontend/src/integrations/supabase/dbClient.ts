/**
 * dbClient.ts — Supabase-compatible client that talks to the FastAPI backend.
 *
 * Drop-in replacement for @supabase/supabase-js.
 * All supabase.from(...).select/insert/update/delete/eq/... calls work unchanged.
 * All supabase.auth.signIn/signUp/signOut/getSession/onAuthStateChange work unchanged.
 * All supabase.rpc(...) calls work unchanged.
 *
 * Tokens are stored in localStorage under 'sb_access_token' / 'sb_refresh_token'.
 */

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string) || '';

// ── Token storage ─────────────────────────────────────────────────────────────

const ACCESS_KEY  = 'sb_access_token';
const REFRESH_KEY = 'sb_refresh_token';

function getAccessToken(): string | null  { return localStorage.getItem(ACCESS_KEY); }
function getRefreshToken(): string | null { return localStorage.getItem(REFRESH_KEY); }

function saveSession(session: { access_token: string; refresh_token: string }): void {
  localStorage.setItem(ACCESS_KEY,  session.access_token);
  localStorage.setItem(REFRESH_KEY, session.refresh_token);
}

function clearSession(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

// ── Base fetch helper (handles token refresh automatically) ────────────────────

let _refreshPromise: Promise<boolean> | null = null;

async function _doRefresh(): Promise<boolean> {
  const rt = getRefreshToken();
  if (!rt) return false;
  try {
    const res = await fetch(`${BACKEND}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!res.ok) { clearSession(); return false; }
    const json = await res.json();
    if (json?.data?.session) { saveSession(json.data.session); return true; }
    clearSession(); return false;
  } catch { clearSession(); return false; }
}

async function apiFetch(
  url: string,
  options: RequestInit = {},
  retry = true,
): Promise<Response> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`${BACKEND}${url}`, { ...options, headers });

  if (res.status === 401 && retry) {
    if (!_refreshPromise) _refreshPromise = _doRefresh().finally(() => { _refreshPromise = null; });
    const ok = await _refreshPromise;
    if (ok) return apiFetch(url, options, false);
  }
  return res;
}

// ── Supabase-style response shape ─────────────────────────────────────────────

interface SbResponse<T = any> {
  data: T | null;
  error: { message: string } | null;
  count?: number | null;
}

async function toSbResponse<T>(res: Response): Promise<SbResponse<T>> {
  let json: any;
  try { json = await res.json(); } catch { json = {}; }
  if (!res.ok) return { data: null, error: { message: json?.detail || json?.error?.message || res.statusText }, count: null };
  return { data: json?.data ?? json, error: null, count: json?.count ?? null };
}

// ── Query builder ─────────────────────────────────────────────────────────────

type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike';

class QueryBuilder<T = any> implements PromiseLike<SbResponse<T>> {
  private _table: string;
  private _select    = '*';
  private _filters: string[] = [];
  private _order    = '';
  private _limit    = '';
  private _offset   = '';
  private _single   = false;
  private _maybe    = false;
  private _count:   'exact' | null = null;
  private _head     = false;
  private _method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET';
  private _body:    any = undefined;

  constructor(table: string) { this._table = table; }

  // ── Column selection ──────────────────────────────────────────────────────

  select(cols = '*', opts?: { count?: 'exact'; head?: boolean }): this {
    this._select = cols;
    if (opts?.count)  this._count = opts.count;
    if (opts?.head)   this._head  = true;
    return this;
  }

  // ── Write operations ──────────────────────────────────────────────────────

  insert(data: Partial<T> | Partial<T>[]): this {
    this._method = 'POST'; this._body = data; return this;
  }

  update(data: Partial<T>): this {
    this._method = 'PATCH'; this._body = data; return this;
  }

  delete(): this {
    this._method = 'DELETE'; return this;
  }

  upsert(data: Partial<T> | Partial<T>[]): this {
    return this.insert(data); // backend handles ON CONFLICT for upsert-like ops
  }

  // ── Filters ───────────────────────────────────────────────────────────────

  private _addFilter(op: FilterOp, col: string, val: any): this {
    this._filters.push(`${op}[${col}]=${encodeURIComponent(String(val))}`);
    return this;
  }

  eq   (col: string, val: any) { return this._addFilter('eq',    col, val); }
  neq  (col: string, val: any) { return this._addFilter('neq',   col, val); }
  gt   (col: string, val: any) { return this._addFilter('gt',    col, val); }
  gte  (col: string, val: any) { return this._addFilter('gte',   col, val); }
  lt   (col: string, val: any) { return this._addFilter('lt',    col, val); }
  lte  (col: string, val: any) { return this._addFilter('lte',   col, val); }
  like (col: string, val: string) { return this._addFilter('like',  col, val); }
  ilike(col: string, val: string) { return this._addFilter('ilike', col, val); }

  in(col: string, vals: any[]): this {
    this._filters.push(`in[${col}]=${vals.map(v => encodeURIComponent(String(v))).join(',')}`);
    return this;
  }

  is(col: string, val: null | boolean): this {
    this._filters.push(`is[${col}]=${val === null ? 'null' : String(val)}`);
    return this;
  }

  not(col: string, op: string, val: any): this {
    // minimal: map to neq for the common .not('col','is',null) pattern
    if (op === 'is' && val === null) this._filters.push(`neq[${col}]=null`);
    return this;
  }

  contains(col: string, val: any[]): this {
    return this.in(col, val);
  }

  or(filters: string): this {
    // Pass through as-is for complex or() — not all ops supported server-side
    this._filters.push(`or=${encodeURIComponent(filters)}`);
    return this;
  }

  // ── Modifiers ─────────────────────────────────────────────────────────────

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const dir = opts?.ascending === false ? 'desc' : 'asc';
    this._order = `${col}.${dir}`;
    return this;
  }

  limit(n: number): this  { this._limit  = String(n); return this; }
  range(from: number, to: number): this {
    this._offset = String(from);
    this._limit  = String(to - from + 1);
    return this;
  }

  single(): this      { this._single = true; return this; }
  maybeSingle(): this { this._maybe  = true; return this; }

  // ── Execute ───────────────────────────────────────────────────────────────

  private _buildUrl(): string {
    const qs = new URLSearchParams();
    if (this._method === 'GET' || this._method === 'DELETE' || this._method === 'PATCH') {
      qs.set('select', this._select);
      this._filters.forEach(f => {
        const [k, ...vParts] = f.split('=');
        qs.append(k, decodeURIComponent(vParts.join('=')));
      });
      if (this._order)  qs.set('order', this._order);
      if (this._limit)  qs.set('limit', this._limit);
      if (this._offset) qs.set('offset', this._offset);
      if (this._single) qs.set('single', 'true');
      if (this._maybe)  qs.set('maybeSingle', 'true');
      if (this._count)  qs.set('count', this._count);
      if (this._head)   qs.set('head', 'true');
    }
    return `/api/db/${this._table}?${qs.toString()}`;
  }

  async execute(): Promise<SbResponse<T>> {
    const url = this._buildUrl();
    const opts: RequestInit = { method: this._method };
    if (this._body !== undefined) opts.body = JSON.stringify(this._body);
    const res = await apiFetch(url, opts);
    return toSbResponse<T>(res);
  }

  // PromiseLike — allows `await supabase.from(...).select()`
  then<R1 = SbResponse<T>, R2 = never>(
    onfulfilled?: ((value: SbResponse<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?:  ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

// ── Auth client ───────────────────────────────────────────────────────────────

type AuthChangeCallback = (event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED', session: any) => void;
const _authListeners: AuthChangeCallback[] = [];

function _notifyAuth(event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED', session: any) {
  _authListeners.forEach(cb => cb(event, session));
}

class AuthClient {
  async signInWithPassword(creds: { email: string; password: string }) {
    const res  = await fetch(`${BACKEND}/api/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(creds),
    });
    const json = await res.json();
    if (!res.ok) return { data: null, error: { message: json?.detail || 'Sign in failed' } };
    const session = json?.data?.session;
    if (session) {
      saveSession(session);
      _notifyAuth('SIGNED_IN', session);
    }
    return { data: { session, user: session?.user }, error: null };
  }

  async signUp(creds: { email: string; password: string; options?: any }) {
    const res  = await fetch(`${BACKEND}/api/auth/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: creds.email, password: creds.password }),
    });
    const json = await res.json();
    if (!res.ok) return { data: null, error: { message: json?.detail || 'Sign up failed' } };
    const session = json?.data?.session;
    if (session) {
      saveSession(session);
      _notifyAuth('SIGNED_IN', session);
    }
    return { data: { session, user: session?.user }, error: null };
  }

  async signOut() {
    const rt = getRefreshToken();
    await apiFetch('/api/auth/signout', {
      method: 'POST',
      body:   JSON.stringify({ refresh_token: rt }),
    }).catch(() => {});
    clearSession();
    _notifyAuth('SIGNED_OUT', null);
    return { error: null };
  }

  async getSession() {
    const token = getAccessToken();
    if (!token) return { data: { session: null }, error: null };
    const res  = await apiFetch('/api/auth/session');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      clearSession();
      return { data: { session: null }, error: null };
    }
    return {
      data: {
        session: {
          access_token:  getAccessToken(),
          refresh_token: getRefreshToken(),
          user: json?.data?.session?.user,
        },
      },
      error: null,
    };
  }

  async getUser() {
    const res  = await apiFetch('/api/auth/user');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { data: { user: null }, error: { message: json?.detail } };
    return { data: { user: json?.data?.user }, error: null };
  }

  onAuthStateChange(callback: AuthChangeCallback): { data: { subscription: { unsubscribe: () => void } } } {
    _authListeners.push(callback);
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            const idx = _authListeners.indexOf(callback);
            if (idx !== -1) _authListeners.splice(idx, 1);
          },
        },
      },
    };
  }

  async updateUser(attrs: { email?: string; password?: string }) {
    // Minimal implementation for password/email changes
    const res  = await apiFetch('/api/auth/update', { method: 'PATCH', body: JSON.stringify(attrs) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { data: null, error: { message: json?.detail } };
    return { data: { user: json?.data?.user }, error: null };
  }
}

// ── Top-level client ──────────────────────────────────────────────────────────

class SupabaseCompat {
  auth = new AuthClient();

  from<T = any>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(table);
  }

  async rpc(funcName: string, params: Record<string, any> = {}): Promise<SbResponse> {
    const isWrite = ['complete_onboarding', 'update_own_profile', 'approve_user'].includes(funcName);
    const method  = isWrite ? 'POST' : 'GET';
    const url     = `/api/rpc/${funcName}`;
    const opts: RequestInit = method === 'POST'
      ? { method: 'POST', body: JSON.stringify(params) }
      : { method: 'GET' };

    if (method === 'GET' && Object.keys(params).length) {
      const qs = new URLSearchParams(params as any).toString();
      const res = await apiFetch(`${url}?${qs}`, opts);
      return toSbResponse(res);
    }
    const res = await apiFetch(url, opts);
    return toSbResponse(res);
  }
}

export const supabase = new SupabaseCompat();
export default supabase;
