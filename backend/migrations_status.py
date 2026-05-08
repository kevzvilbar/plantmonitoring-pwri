"""
Supabase migrations status — Admin-only endpoint that scans the
`supabase/migrations/*.sql` files, parses out the tables and columns each
migration is expected to create, and probes the live Supabase project to
report which ones are already applied vs missing.

The frontend Admin → Migrations tab uses this to show the user the exact
SQL to paste into the Supabase Dashboard SQL Editor for each pending file.

We deliberately do NOT execute any DDL ourselves — the anon-role JWT does
not have CREATE permission, and the user prefers the explicit "copy → paste
in Supabase" flow so they retain a clear audit trail of schema changes.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from admin_service import (
    _bearer_token,
    _caller_identity,
    _is_missing_table_error,
    _require_roles,
    _user_scoped_client,
)

log = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "supabase" / "migrations"

# Local override store. We can't add a row to `deletion_audit_log` for these
# (its check constraint only permits kind in {user, plant}), and we don't want
# to require a fresh schema migration just to track migration overrides — that
# would be circular. A small JSON file beside the backend keeps state simple,
# survives uvicorn reloads, and is trivial to inspect or reset by hand.
_OVERRIDES_DIR = Path(
    os.environ.get(
        "MIGRATIONS_STATE_DIR",
        str(Path(__file__).resolve().parent / "state"),
    )
)
_OVERRIDES_PATH = _OVERRIDES_DIR / "migration_overrides.json"

# Apply history is a permanent audit trail (overrides get auto-purged once
# the probe confirms applied; we copy their metadata here just before the
# purge so the UI keeps a "first applied locally on …" timestamp even after
# the override entry itself is gone). One record per filename — we only keep
# the first known apply event, since that's the historically-meaningful one.
# Files applied directly via psql / Supabase Dashboard without ever going
# through Mark-applied won't have a history entry, which is honest: we
# genuinely don't know when they were run.
_HISTORY_PATH = _OVERRIDES_DIR / "migration_apply_history.json"


def _load_overrides() -> dict[str, dict[str, Any]]:
    try:
        return json.loads(_OVERRIDES_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Failed to read migration overrides at %s: %s", _OVERRIDES_PATH, exc)
        return {}


def _save_overrides(data: dict[str, dict[str, Any]]) -> None:
    _OVERRIDES_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _OVERRIDES_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(_OVERRIDES_PATH)


def _load_history() -> dict[str, dict[str, Any]]:
    try:
        return json.loads(_HISTORY_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Failed to read migration apply history at %s: %s", _HISTORY_PATH, exc)
        return {}


def _save_history(data: dict[str, dict[str, Any]]) -> None:
    _OVERRIDES_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _HISTORY_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(_HISTORY_PATH)

# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

_RE_CREATE_TABLE = re.compile(
    r"create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)",
    re.IGNORECASE,
)

# Captures the table name in a multi-column ALTER TABLE … ADD COLUMN block.
_RE_ALTER_TABLE = re.compile(
    r"alter\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)",
    re.IGNORECASE,
)

_RE_ADD_COLUMN = re.compile(
    r"add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)",
    re.IGNORECASE,
)

# Captures `select id into <var> from <table>` and similar references that we
# never want to treat as "must exist" probes (DO blocks, RPCs, etc).
_RE_NOISE = re.compile(r"^\s*(--|/\*|\*)", re.MULTILINE)


# Tokens that start a table-level constraint (NOT a column definition) inside
# a CREATE TABLE block. We skip any segment whose first token matches one of
# these so e.g. `primary key (id, plant_id)` doesn't get probed as a column.
_CONSTRAINT_HEADS = {
    "primary", "foreign", "unique", "check", "constraint",
    "exclude", "like",
}


def _split_top_level_commas(body: str) -> list[str]:
    """Split a CREATE TABLE body at commas that are NOT inside parens.

    Needed because `numeric(10,2)` and `check (a in (1, 2))` contain commas
    that must not split column definitions.
    """
    out: list[str] = []
    depth = 0
    buf: list[str] = []
    for ch in body:
        if ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


def _extract_table_columns(create_block: str) -> list[str]:
    """Given the parenthesised body of a CREATE TABLE, return column names."""
    cols: list[str] = []
    seen: set[str] = set()
    for segment in _split_top_level_commas(create_block):
        if not segment:
            continue
        # First identifier token of the segment.
        m = re.match(r'\s*"?([a-z_][a-z0-9_]*)"?\b', segment, re.IGNORECASE)
        if not m:
            continue
        first = m.group(1).lower()
        if first in _CONSTRAINT_HEADS:
            continue
        if first in seen:
            continue
        seen.add(first)
        cols.append(first)
    return cols


def _find_create_table_blocks(cleaned_sql: str) -> list[tuple[str, str]]:
    """Return [(table_name, paren_body), ...] for each CREATE TABLE in the SQL.

    Uses paren-matching so we capture the full block even when it spans many
    lines and contains nested parens (e.g. CHECK constraints, numeric(10,2)).
    """
    out: list[tuple[str, str]] = []
    for m in _RE_CREATE_TABLE.finditer(cleaned_sql):
        name = m.group(1).lower()
        # Find the opening paren after the table name.
        open_idx = cleaned_sql.find("(", m.end())
        if open_idx < 0:
            continue
        depth = 1
        i = open_idx + 1
        while i < len(cleaned_sql) and depth > 0:
            ch = cleaned_sql[i]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            i += 1
        if depth != 0:
            continue
        body = cleaned_sql[open_idx + 1 : i - 1]
        out.append((name, body))
    return out


def _parse_migration(sql: str) -> dict[str, Any]:
    """Parse the SQL file into the structures we'll probe.

    Returns:
        tables_with_cols: [(table, [col, col, ...]), ...]
            Tables created by this file plus the columns each one declares.
        added_columns: [(table, column), ...]
            Columns added by ALTER TABLE … ADD COLUMN statements.
    """
    # Strip line comments so commented-out statements don't get probed.
    cleaned_lines = []
    for line in sql.splitlines():
        if line.strip().startswith("--"):
            continue
        cleaned_lines.append(line)
    cleaned = "\n".join(cleaned_lines)

    tables_with_cols: list[tuple[str, list[str]]] = []
    seen_tables: set[str] = set()
    for table_name, body in _find_create_table_blocks(cleaned):
        if table_name in seen_tables:
            continue
        seen_tables.add(table_name)
        tables_with_cols.append((table_name, _extract_table_columns(body)))

    # Walk each ALTER TABLE … ADD COLUMN … chunk independently so we attribute
    # the column to the right table when a file has multiple ALTERs.
    added_columns: list[tuple[str, str]] = []
    column_seen: set[tuple[str, str]] = set()
    for alter in re.finditer(
        r"alter\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)(.*?)(?=alter\s+table|$)",
        cleaned,
        re.IGNORECASE | re.DOTALL,
    ):
        table = alter.group(1).lower()
        body = alter.group(2)
        for col in _RE_ADD_COLUMN.finditer(body):
            colname = col.group(1).lower()
            key = (table, colname)
            if key in column_seen:
                continue
            column_seen.add(key)
            added_columns.append(key)

    return {"tables_with_cols": tables_with_cols, "added_columns": added_columns}


# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------

def _probe_table(client, table: str) -> dict[str, Any]:
    """Returns {exists: bool, error: str|None}.

    'exists' is True even when the table is RLS-restricted from the caller —
    we only flip it False on a genuine missing-table error.
    """
    try:
        client.table(table).select("*", head=True, count="exact").limit(1).execute()
        return {"exists": True, "error": None}
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if _is_missing_table_error(msg):
            return {"exists": False, "error": msg}
        # RLS denial / permission errors: treat as "exists, just not visible"
        return {"exists": True, "error": None}


def _probe_column(client, table: str, column: str) -> dict[str, Any]:
    """Probe a single column. Returns {exists: bool, error: str|None}."""
    try:
        client.table(table).select(column).limit(0).execute()
        return {"exists": True, "error": None}
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        lower = msg.lower()
        # PostgREST returns PGRST204 / "column ... does not exist" for missing cols.
        if "column" in lower and (
            "does not exist" in lower
            or "could not find" in lower
            or "pgrst204" in lower
        ):
            return {"exists": False, "error": msg}
        if _is_missing_table_error(lower):
            # Table itself missing — the table-level probe will surface that;
            # we mark the column missing too so the migration shows pending.
            return {"exists": False, "error": msg}
        return {"exists": True, "error": None}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def list_migration_status(authorization: Optional[str]) -> dict[str, Any]:
    """Admin-only. Scan migrations dir, probe live schema, return per-file status."""
    token = _bearer_token(authorization)
    caller = _caller_identity(token)
    _require_roles(caller, {"Admin"})

    if not MIGRATIONS_DIR.is_dir():
        raise HTTPException(
            status_code=500,
            detail=f"Migrations directory not found at {MIGRATIONS_DIR}",
        )

    client = _user_scoped_client(token)

    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    out: list[dict[str, Any]] = []
    summary = {"total": 0, "applied": 0, "pending": 0, "partial": 0, "indeterminate": 0}
    # Filenames whose override entry we auto-purged this call because the
    # live probe now confirms the migration is applied for real. Returned
    # to the client so the UI can surface a one-time confirmation toast.
    purged_overrides: list[str] = []
    overrides = _load_overrides()
    history = _load_history()
    history_dirty = False

    for path in files:
        sql = path.read_text(encoding="utf-8", errors="replace")
        parsed = _parse_migration(sql)

        # ---- CREATE TABLE diffs (table + per-column existence) -----------
        table_probes: list[dict[str, Any]] = []
        all_signals: list[bool] = []  # everything we use to compute status
        for table_name, expected_cols in parsed["tables_with_cols"]:
            t_res = _probe_table(client, table_name)
            table_exists = t_res["exists"]
            all_signals.append(table_exists)

            col_diffs: list[dict[str, Any]] = []
            missing_cols: list[str] = []
            present_cols: list[str] = []
            if table_exists:
                # Only worth probing columns when the table is there — otherwise
                # PostgREST will just say "missing table" for every column and
                # we waste round-trips.
                for col in expected_cols:
                    c_res = _probe_column(client, table_name, col)
                    col_diffs.append({"column": col, "exists": c_res["exists"]})
                    if c_res["exists"]:
                        present_cols.append(col)
                    else:
                        missing_cols.append(col)
                    all_signals.append(c_res["exists"])
            else:
                # Table missing → every declared column is implicitly missing.
                # We don't add these to all_signals (the table=False already
                # contributes), but we still report them so the UI can show
                # "this file would create N columns".
                col_diffs = [
                    {"column": col, "exists": False} for col in expected_cols
                ]
                missing_cols = list(expected_cols)

            table_probes.append({
                "name": table_name,
                "exists": table_exists,
                "expected_columns": col_diffs,
                "missing_columns": missing_cols,
                "present_columns": present_cols,
                "expected_count": len(expected_cols),
            })

        # ---- ALTER TABLE … ADD COLUMN diffs ------------------------------
        added_column_probes: list[dict[str, Any]] = []
        for table, col in parsed["added_columns"]:
            res = _probe_column(client, table, col)
            added_column_probes.append({
                "table": table, "column": col, "exists": res["exists"],
            })
            all_signals.append(res["exists"])

        if not all_signals:
            probed_status = "indeterminate"
        elif all(all_signals):
            probed_status = "applied"
        elif not any(all_signals):
            probed_status = "pending"
        else:
            probed_status = "partial"

        # Apply manual override (only meaningful for non-applied files —
        # there's nothing to mark on a file the parser already verified).
        # If the live probe now says applied AND we still have an override
        # entry, the override has done its job and is just clutter — drop it
        # so the override store doesn't accumulate stale assertions for
        # migrations that were eventually run for real. Before purging, we
        # snapshot the override metadata into the apply-history store so
        # the "applied locally on …" timestamp survives the cleanup.
        override = overrides.get(path.name)
        if override and probed_status == "applied":
            if path.name not in history:
                # First-known apply event for this file — record it.
                # Subsequent purges (e.g. after a teammate re-marks it
                # applied for some reason) won't overwrite this, so the
                # timestamp stays the historically-meaningful one.
                history[path.name] = {
                    "applied_at": override.get("marked_at"),
                    "by_label": override.get("by_label"),
                    "note": override.get("note"),
                    "source": "override-purge",
                }
                history_dirty = True
            overrides.pop(path.name, None)
            purged_overrides.append(path.name)
            override = None
            override_applied = False
            status = "applied"
        elif override and probed_status != "applied":
            status = "applied"
            override_applied = True
        else:
            status = probed_status
            override_applied = False

        summary["total"] += 1
        summary[status] += 1

        # Backwards-compatible flat `column_probes` (added-columns only) is
        # kept so older clients don't break; tables[].expected_columns carries
        # the new per-table column diff.
        out.append({
            "filename": path.name,
            "size": path.stat().st_size,
            # SHA-256 of the raw file bytes — the frontend uses this to flag
            # files that changed on disk since the user's last acknowledged
            # snapshot, so they don't accidentally re-run a stale download.
            "sha256": hashlib.sha256(sql.encode("utf-8")).hexdigest(),
            "status": status,
            "probed_status": probed_status,
            "manual_override": override,
            "override_applied": override_applied,
            # Permanent record of when this file was first marked applied
            # locally (preserved across override purges). None for files
            # never run through the override flow — we don't fabricate a
            # timestamp we don't actually know.
            "apply_history": history.get(path.name),
            "table_probes": table_probes,
            "column_probes": added_column_probes,
            "added_column_probes": added_column_probes,
            "sql": sql,
        })

    # Persist override store only if we actually removed anything — keeps the
    # mtime stable on the file (and sidesteps a redundant fsync) when no
    # cleanup happened, which is the overwhelmingly common case.
    if purged_overrides:
        _save_overrides(overrides)
    if history_dirty:
        _save_history(history)

    return {
        "migrations_dir": str(MIGRATIONS_DIR),
        "summary": summary,
        "files": out,
        "purged_overrides": purged_overrides,
    }


# ---------------------------------------------------------------------------
# Manual overrides — for files the schema probe can't verify (RPCs, pure DML
# like cleanup_bad_imports, one-shot UPDATEs like promote_admin_kevin, etc.).
# ---------------------------------------------------------------------------

def _validate_filename(filename: str) -> Path:
    """Reject path traversal / unknown files so the override store can't grow
    arbitrary keys. Returns the resolved path on success."""
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid migration filename")
    if not filename.endswith(".sql"):
        raise HTTPException(status_code=400, detail="Migration filenames must end with .sql")
    p = MIGRATIONS_DIR / filename
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"Migration not found: {filename}")
    return p


def mark_migration_applied(
    authorization: Optional[str], filename: str, note: Optional[str] = None,
) -> dict[str, Any]:
    """Admin-only. Record that the named migration has been run in Supabase."""
    token = _bearer_token(authorization)
    caller = _caller_identity(token)
    _require_roles(caller, {"Admin"})
    _validate_filename(filename)

    overrides = _load_overrides()
    overrides[filename] = {
        "marked_at": datetime.now(timezone.utc).isoformat(),
        "by_user_id": caller.get("user_id"),
        "by_label": caller.get("label") or caller.get("user_id"),
        "note": (note or "").strip()[:500] or None,
    }
    _save_overrides(overrides)
    return {"ok": True, "filename": filename, "manual_override": overrides[filename]}


def unmark_migration_applied(
    authorization: Optional[str], filename: str,
) -> dict[str, Any]:
    """Admin-only. Remove a previous mark — restores the probed status."""
    token = _bearer_token(authorization)
    caller = _caller_identity(token)
    _require_roles(caller, {"Admin"})
    _validate_filename(filename)

    overrides = _load_overrides()
    removed = overrides.pop(filename, None)
    if removed is not None:
        _save_overrides(overrides)
    return {"ok": True, "filename": filename, "removed": removed is not None}


def import_apply_history(
    authorization: Optional[str],
    payload: dict[str, Any],
    mode: str = "fill_gaps",
) -> dict[str, Any]:
    """Admin-only. Merge an exported apply-history JSON into the local store.

    Modes:
      - "fill_gaps" (default, non-destructive): only add filenames that don't
        already have a local history entry. The local truth always wins on
        conflict — useful when seeding a fresh environment from a staging
        export without risking overwriting events already recorded here.
      - "overwrite": replace local entries on conflict. Use only when you
        know the imported file is more authoritative (e.g. restoring from
        a backup of this same environment).

    Filenames are validated against the on-disk migrations directory: any
    entry whose filename doesn't correspond to a real migration file is
    skipped and reported, so a typo or a stale export can't grow the
    history store with fictitious filenames.
    """
    token = _bearer_token(authorization)
    caller = _caller_identity(token)
    _require_roles(caller, {"Admin"})

    if mode not in ("fill_gaps", "overwrite"):
        raise HTTPException(status_code=400, detail=f"Unknown import mode: {mode}")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload must be a JSON object")
    incoming = payload.get("history")
    if not isinstance(incoming, dict):
        raise HTTPException(
            status_code=400,
            detail="Payload must contain a 'history' object keyed by filename",
        )

    # Build the set of legitimate filenames once — cheaper than stat-ing
    # each file individually inside the loop.
    known = {p.name for p in MIGRATIONS_DIR.glob("*.sql")}

    history = _load_history()
    added: list[str] = []
    overwritten: list[str] = []
    skipped_existing: list[str] = []
    skipped_unknown: list[str] = []
    skipped_invalid: list[str] = []

    for filename, entry in incoming.items():
        # Reject path traversal / unknown shapes early.
        if (not isinstance(filename, str)
                or "/" in filename or "\\" in filename or ".." in filename
                or not filename.endswith(".sql")):
            skipped_invalid.append(str(filename))
            continue
        if not isinstance(entry, dict):
            skipped_invalid.append(filename)
            continue
        if filename not in known:
            skipped_unknown.append(filename)
            continue

        # Normalise the entry to our canonical shape — drop unknown keys so
        # an attacker-crafted import can't inject extra fields the UI then
        # blindly renders.
        normalised = {
            "applied_at": entry.get("applied_at"),
            "by_label": entry.get("by_label"),
            "note": entry.get("note"),
            "source": entry.get("source") or "import",
        }
        if not normalised["applied_at"]:
            skipped_invalid.append(filename)
            continue

        if filename in history:
            if mode == "overwrite":
                history[filename] = normalised
                overwritten.append(filename)
            else:
                skipped_existing.append(filename)
        else:
            history[filename] = normalised
            added.append(filename)

    if added or overwritten:
        _save_history(history)

    return {
        "ok": True,
        "mode": mode,
        "added": sorted(added),
        "overwritten": sorted(overwritten),
        "skipped_existing": sorted(skipped_existing),
        "skipped_unknown": sorted(skipped_unknown),
        "skipped_invalid": sorted(skipped_invalid),
        "imported_by": caller.get("label") or caller.get("user_id"),
    }
