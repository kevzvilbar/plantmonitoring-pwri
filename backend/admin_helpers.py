"""
Shared helpers for admin / import services.

This module groups the small, side-effect-free pieces that used to live
inline in `admin_service.py` so they can be reused by `ai_import_service.py`
and `migrations_status.py` without re-implementing auth, audit-logging, or
Supabase-row scrubbing logic.

Public API (preferred):
    - `user_scoped_client(token)`
    - `bearer_token(authorization_header)`
    - `caller_identity(token)`
    - `require_roles(caller, allowed)`
    - `is_missing_table_error(msg)`
    - `count_refs(client, table, column, value)`
    - `scrub_plant_assignments(client, plant_id)`
    - `resolve_plant_by_name(client, name)`
    - `archive_table_snapshot(client, table, plant_id, label, caller, reason)`
    - `AuditEntry` dataclass + `write_audit(client, entry)`

Backward-compat underscore aliases (`_user_scoped_client`, `_write_audit`, …)
are re-exposed from `admin_service` so existing imports keep working.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Optional

from fastapi import HTTPException
from supabase import Client, create_client

log = logging.getLogger(__name__)


# ---- Error classification --------------------------------------------------

def is_missing_table_error(msg: str) -> bool:
    """True if a Supabase / PostgREST error string looks like a "table not
    found" condition (covers raw SQL "does not exist", PostgREST PGRST205
    schema-cache misses, and generic "relation" errors).

    Used to skip optional/older tables instead of turning their absence
    into a 500.
    """
    if not msg:
        return False
    lower = msg.lower()
    return (
        "does not exist" in lower
        or "schema cache" in lower
        or "could not find the table" in lower
        or "pgrst205" in lower
        or "relation" in lower
    )


# ---- Supabase client + auth ------------------------------------------------

def user_scoped_client(access_token: Optional[str] = None) -> Client:
    """Build a Supabase client bound to the caller's JWT (so RLS applies)."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_ANON_KEY")
    if not url or not key:
        raise HTTPException(status_code=500, detail="Supabase is not configured.")
    client = create_client(url, key)
    if access_token:
        try:
            client.postgrest.auth(access_token)
        except Exception:  # noqa: BLE001
            log.exception("Failed to attach JWT to Supabase client")
    return client


def service_role_client() -> Client:
    """Build a Supabase client using the service-role key.

    This bypasses RLS entirely — use ONLY for admin-privileged destructive
    operations (hard deletes, cascades) where the caller's JWT cannot satisfy
    RLS policies on rows owned by another user.

    Falls back to the anon-key client with a warning if the service-role key
    is not configured, so the endpoint degrades gracefully on deployments
    that haven't set the variable yet.
    """
    url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if url and service_key:
        return create_client(url, service_key)
    # Fallback: log warning but don't crash — the delete may still work if
    # RLS policies permit the admin's own JWT to modify other users' rows.
    log.warning(
        "SUPABASE_SERVICE_ROLE_KEY is not set. Hard deletes may fail due to RLS. "
        "Add the key to your environment to enable full admin delete capability."
    )
    return user_scoped_client()


def bearer_token(authorization: Optional[str]) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Empty bearer token")
    return token


def caller_identity(access_token: str) -> dict[str, Any]:
    """Resolve the caller's user_id, display name, and roles from Supabase."""
    client = user_scoped_client(access_token)
    try:
        user_resp = client.auth.get_user(access_token)
    except Exception as e:  # noqa: BLE001
        log.exception("auth.get_user failed")
        raise HTTPException(status_code=401, detail=f"Invalid session: {e}")
    user = getattr(user_resp, "user", None) or (
        user_resp.get("user") if isinstance(user_resp, dict) else None
    )
    user_id = getattr(user, "id", None) if user else None
    if not user_id:
        raise HTTPException(status_code=401, detail="Unable to identify caller")

    roles: list[str] = []
    try:
        rows = client.table("user_roles").select("role").eq("user_id", user_id).execute()
        roles = [r.get("role") for r in (rows.data or []) if r.get("role")]
    except Exception:
        log.exception("Failed to load caller roles")

    label: Optional[str] = None
    try:
        prof = client.table("user_profiles").select(
            "first_name,last_name,username",
        ).eq("id", user_id).maybeSingle().execute()
        data = prof.data or {}
        label = (
            " ".join(filter(None, [data.get("first_name"), data.get("last_name")])).strip()
            or data.get("username")
        )
    except Exception:
        log.debug("caller profile lookup failed", exc_info=True)

    return {"user_id": user_id, "roles": roles, "label": label}


def require_roles(caller: dict[str, Any], allowed: set[str]) -> None:
    if not (set(caller.get("roles") or []) & allowed):
        raise HTTPException(
            status_code=403,
            detail=f"Forbidden. Required role(s): {sorted(allowed)}.",
        )


# ---- Generic Supabase helpers ----------------------------------------------

def count_refs(client: Client, table: str, column: str, value: Any) -> int:
    """Cheap count() using head=True + exact count; returns 0 on failure."""
    try:
        res = (
            client.table(table)
            .select("id", count="exact", head=True)
            .eq(column, value)
            .execute()
        )
        return int(getattr(res, "count", 0) or 0)
    except Exception as e:  # noqa: BLE001
        log.debug("count failed for %s.%s=%s: %s", table, column, value, e)
        return 0


# ---- Audit log -------------------------------------------------------------

@dataclass(frozen=True)
class AuditEntry:
    """Audit-log row for deletion / import decisions.

    Replaces an 8-arg keyword-only signature on the old `_write_audit()`
    with an immutable value object that's easier to pass around, log,
    or post-process.
    """
    kind: str                          # "user" | "plant" | "well"
    entity_id: str
    entity_label: Optional[str]
    action: str                        # "soft" | "hard"
    caller: dict[str, Any]
    reason: Optional[str] = None
    dependencies: Optional[dict[str, Any]] = None


def write_audit(client: Client, entry: AuditEntry) -> None:
    """Persist one audit row. Failure is logged but never blocks the action."""
    try:
        client.table("deletion_audit_log").insert(
            {
                "kind": entry.kind,
                "entity_id": entry.entity_id,
                "entity_label": (entry.entity_label or "")[:200] or None,
                "action": entry.action,
                "actor_user_id": entry.caller.get("user_id"),
                "actor_label": entry.caller.get("label"),
                "reason": (entry.reason or "").strip()[:500] or None,
                "dependencies": entry.dependencies,
            }
        ).execute()
    except Exception as e:  # noqa: BLE001
        log.warning(
            "deletion_audit_log insert skipped (%s). "
            "Did you run supabase/migrations/20260424_deletion_audit_log.sql?",
            e,
        )


# ---- Plant cleanup helpers (shared by hard_delete_plant + cleanup_plants) -

def scrub_plant_assignments(client: Client, plant_id: str) -> None:
    """Detach `plant_id` from every user_profiles.plant_assignments array.

    Best-effort: failures are logged but never raised, since this is part
    of a cascade-cleanup path and the parent delete should still succeed.
    """
    try:
        assigned = (
            client.table("user_profiles")
            .select("id,plant_assignments")
            .contains("plant_assignments", [plant_id])
            .execute()
        )
        for prof in assigned.data or []:
            new_arr = [
                p for p in (prof.get("plant_assignments") or []) if p != plant_id
            ]
            client.table("user_profiles").update(
                {"plant_assignments": new_arr}
            ).eq("id", prof["id"]).execute()
    except Exception:  # noqa: BLE001
        log.debug("plant_assignments scrub failed", exc_info=True)


def resolve_plant_by_name(client: Client, name: str) -> Optional[dict[str, Any]]:
    """Look up a plant row by exact name; returns None if not found.

    Raises HTTPException(500) on Supabase error so the caller can surface
    a deterministic failure to the admin UI.
    """
    try:
        res = (
            client.table("plants")
            .select("id,name")
            .eq("name", name)
            .maybeSingle()
            .execute()
        )
        return res.data or None
    except Exception as e:  # noqa: BLE001
        log.exception("plant lookup failed for %s", name)
        raise HTTPException(status_code=500, detail=f"Lookup failed for '{name}': {e}")


def archive_table_snapshot(
    client: Client,
    *,
    table: str,
    plant_id: str,
    plant_label: Optional[str],
    caller: dict[str, Any],
    reason: Optional[str],
) -> int:
    """Snapshot every row in `table` where plant_id matches into
    `archived_plant_data` as JSONB. Returns the number of rows archived.

    Tolerates the archive table being missing (pre-migration deployments)
    by warning and returning 0. Other failures raise HTTPException(500)
    so the caller can abort the destructive delete that would follow.
    """
    try:
        snap = (
            client.table(table)
            .select("*")
            .eq("plant_id", plant_id)
            .execute()
        )
        rows = snap.data or []
    except Exception:  # noqa: BLE001
        log.exception("archive snapshot read failed for %s", table)
        return 0

    if not rows:
        return 0

    payload = [
        {
            "plant_id": plant_id,
            "plant_name": plant_label,
            "source_table": table,
            "source_row_id": (
                r.get("id") if isinstance(r.get("id"), str) else None
            ),
            "payload": r,
            "archived_by": caller.get("user_id"),
            "reason": (reason or "").strip()[:500] or None,
        }
        for r in rows
    ]
    try:
        client.table("archived_plant_data").insert(payload).execute()
        return len(payload)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "archived_plant_data" in msg and is_missing_table_error(msg):
            log.warning(
                "archived_plant_data table missing — run "
                "supabase/migrations/20260425_archived_plant_data.sql"
            )
            return 0
        log.exception("archive insert failed for %s", table)
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed archiving {table} for plant "
                f"'{plant_label or plant_id}': {e}"
            ),
        )
