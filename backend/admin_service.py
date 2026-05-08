"""
Admin service — user & plant deletion with RBAC, dependency checks, and
Supabase-backed audit logging.

Rules (per product spec):
    Users (Only Admin):
        - Soft delete -> user_profiles.status = 'Suspended'.
        - Hard delete -> only if no dependencies.
        - Audit row in `deletion_audit_log` on every action.
    Plants (Only Admin):
        - Soft delete -> plants.status = 'Inactive'.
        - Hard delete -> only if no dependencies.
        - Audit row in `deletion_audit_log` on every action.

Cascade handling is advisory (the dependency snapshot is returned to the caller
so linked records can be archived/reassigned before hard-delete).

Endpoints authenticate via the caller's Supabase JWT
(Authorization: Bearer <jwt>).

NOTE on the underscore-aliases at the bottom of this module:
    `migrations_status.py` and `ai_import_service.py` historically imported
    `_bearer_token`, `_caller_identity`, `_user_scoped_client`,
    `_require_roles`, `_write_audit`, and `_is_missing_table_error` from
    here. Those helpers now live in `admin_helpers.py` under public names
    (no underscore). The aliases at the bottom of this file preserve the
    legacy import path so a follow-up refactor can migrate callers
    incrementally.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import HTTPException
from supabase import Client

from admin_helpers import (
    AuditEntry,
    archive_table_snapshot,
    bearer_token,
    caller_identity,
    count_refs,
    is_missing_table_error,
    require_roles,
    resolve_plant_by_name,
    scrub_plant_assignments,
    service_role_client,
    user_scoped_client,
    write_audit,
)

log = logging.getLogger(__name__)

# Tables that may reference a user id (column name -> list of tables) ---------
USER_REF_TABLES: list[tuple[str, str]] = [
    ("well_readings", "recorded_by"),
    ("locator_readings", "recorded_by"),
    ("ro_train_readings", "recorded_by"),
    ("afm_readings", "recorded_by"),
    ("cartridge_readings", "recorded_by"),
    ("pump_readings", "recorded_by"),
    ("ro_pretreatment_readings", "recorded_by"),
    ("power_readings", "recorded_by"),
    ("chemical_dosing_logs", "recorded_by"),
    ("chemical_residual_samples", "recorded_by"),
    ("downtime_events", "recorded_by"),
    ("incidents", "recorded_by"),
    ("well_pms_records", "performed_by"),
    ("well_meter_replacements", "replaced_by"),
    ("locator_meter_replacements", "replaced_by"),
    ("checklist_templates", "created_by"),
    ("checklist_executions", "performed_by"),
]

# Tables that directly reference a plant_id ----------------------------------
PLANT_REF_TABLES: list[str] = [
    "wells", "locators", "ro_trains",
    "well_readings", "locator_readings", "ro_train_readings",
    "afm_readings", "cartridge_readings", "pump_readings",
    "ro_pretreatment_readings",
    "power_readings", "electric_bills", "power_tariffs",
    "chemical_inventory", "chemical_deliveries", "chemical_dosing_logs",
    "chemical_residual_samples", "chemical_prices",
    "cip_logs",
    "daily_plant_summary", "downtime_events", "incidents",
    "checklist_templates", "train_status_log", "production_costs",
    "notifications",
]

# Tables whose plant_id FK has NO ON DELETE CASCADE — we must delete these
# rows ourselves before the parent plant can be removed.
_PLANT_NO_CASCADE_CHILDREN: list[str] = [
    "well_meter_replacements",
    "well_pms_records",
    "well_readings",
    "locator_meter_replacements",
    "locator_readings",
    "ro_train_readings",
    "ro_train_replacements",
    "incidents",
    "checklist_executions",
]


# --- Dependency counters ----------------------------------------------------

def user_dependencies(client: Client, user_id: str) -> dict[str, Any]:
    roles_count = count_refs(client, "user_roles", "user_id", user_id)
    refs: list[dict[str, Any]] = []
    total = 0
    for table, col in USER_REF_TABLES:
        n = count_refs(client, table, col, user_id)
        if n:
            refs.append({"table": table, "column": col, "count": n})
            total += n

    assigned: list[str] = []
    try:
        res = (
            client.table("user_profiles")
            .select("plant_assignments")
            .eq("id", user_id)
            .single()
            .execute()
        )
        assigned = list((res.data or {}).get("plant_assignments") or [])
    except Exception:
        pass

    # plant_assignments is JSONB array data in the profile row — it is deleted
    # along with the profile row itself and is NOT a FK that blocks deletion.
    # Only operational records (readings, incidents, etc.) are true blockers.
    return {
        "user_id": user_id,
        "role_rows": roles_count,
        "references": refs,
        "total_references": total,
        "assigned_plants": assigned,
        "blocking": total > 0,
    }


def plant_dependencies(client: Client, plant_id: str) -> dict[str, Any]:
    refs: list[dict[str, Any]] = []
    total = 0
    for table in PLANT_REF_TABLES:
        n = count_refs(client, table, "plant_id", plant_id)
        if n:
            refs.append({"table": table, "count": n})
            total += n

    assigned_users = 0
    try:
        res = (
            client.table("user_profiles")
            .select("id", count="exact", head=True)
            .contains("plant_assignments", [plant_id])
            .execute()
        )
        assigned_users = int(getattr(res, "count", 0) or 0)
    except Exception:
        log.debug("assigned_users count failed", exc_info=True)

    return {
        "plant_id": plant_id,
        "references": refs,
        "total_references": total,
        "assigned_users": assigned_users,
        "blocking": total > 0 or assigned_users > 0,
    }


# --- Entity label lookup ----------------------------------------------------

def _entity_label(client: Client, kind: str, entity_id: str) -> Optional[str]:
    try:
        if kind == "user":
            row = (
                client.table("user_profiles")
                .select("first_name,last_name,username")
                .eq("id", entity_id)
                .maybeSingle()
                .execute()
            )
            d = row.data or {}
            return (
                " ".join(filter(None, [d.get("first_name"), d.get("last_name")])).strip()
                or d.get("username")
            )
        if kind == "plant":
            row = (
                client.table("plants")
                .select("name")
                .eq("id", entity_id)
                .maybeSingle()
                .execute()
            )
            return (row.data or {}).get("name")
    except Exception:
        log.debug("entity label lookup failed", exc_info=True)
    return None


# --- Plant force-delete helpers --------------------------------------------

def _clear_no_cascade_children(
    client: Client,
    *,
    plant_id: str,
    plant_label: Optional[str],
    caller: dict[str, Any],
    reason: Optional[str],
    archive: bool,
) -> tuple[dict[str, int], dict[str, int]]:
    """Delete every no-cascade child row for `plant_id`, optionally
    snapshotting each table into `archived_plant_data` first.

    Returns (deleted_counts, archived_counts).

    Raises HTTPException on hard failure; tolerates missing tables.
    """
    deleted_counts: dict[str, int] = {}
    archived_counts: dict[str, int] = {}

    for table in _PLANT_NO_CASCADE_CHILDREN:
        try:
            if archive:
                count = archive_table_snapshot(
                    client,
                    table=table,
                    plant_id=plant_id,
                    plant_label=plant_label,
                    caller=caller,
                    reason=reason,
                )
                if count:
                    archived_counts[table] = count

            res = (
                client.table(table)
                .delete(count="exact")
                .eq("plant_id", plant_id)
                .execute()
            )
            deleted_counts[table] = int(getattr(res, "count", 0) or 0)
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if is_missing_table_error(msg):
                log.debug("skipping missing table %s", table)
                continue
            log.exception("force-delete child clear failed: %s", table)
            raise HTTPException(
                status_code=500,
                detail=f"Failed clearing {table} for plant '{plant_label or plant_id}': {e}",
            )

    return deleted_counts, archived_counts


# --- Deletion actions -------------------------------------------------------

def soft_delete_user(
    authorization: Optional[str], user_id: str, reason: Optional[str] = None,
) -> dict[str, Any]:
    token = bearer_token(authorization)
    caller = caller_identity(token)
    require_roles(caller, {"Admin", "Manager"})
    if caller["user_id"] == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")

    client = user_scoped_client(token)
    label = _entity_label(client, "user", user_id)
    try:
        svc = service_role_client()
        res = (
            svc.table("user_profiles")
            .update({"status": "Suspended"})
            .eq("id", user_id)
            .execute()
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Supabase update failed: {e}")
    if not (res.data or []):
        raise HTTPException(status_code=404, detail="User not found")

    write_audit(client, AuditEntry(
        kind="user", entity_id=user_id, entity_label=label,
        action="soft", caller=caller, reason=reason,
    ))
    return {"ok": True, "mode": "soft", "user_id": user_id, "status": "Suspended"}


def hard_delete_user(
    authorization: Optional[str], user_id: str,
    reason: Optional[str] = None, force: bool = False,
) -> dict[str, Any]:
    """Admin-only. If `force=True`, dependencies are orphaned but deletion proceeds."""
    token = bearer_token(authorization)
    caller = caller_identity(token)
    require_roles(caller, {"Admin"})  # only Admin can hard-delete users
    if caller["user_id"] == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")

    client = user_scoped_client(token)
    deps = user_dependencies(client, user_id)
    if deps["blocking"] and not force:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "User has active dependencies; cannot hard-delete.",
                "dependencies": deps,
                "force_allowed": True,  # Admin may retry with force=true
            },
        )
    label = _entity_label(client, "user", user_id)
    try:
        # Use service-role client for the destructive deletes so RLS on
        # user_profiles / user_roles doesn't block an admin removing another user.
        svc = service_role_client()
        svc.table("user_roles").delete().eq("user_id", user_id).execute()
        svc.table("user_profiles").delete().eq("id", user_id).execute()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Hard delete failed: {e}")

    write_audit(client, AuditEntry(
        kind="user", entity_id=user_id, entity_label=label,
        action="hard", caller=caller,
        reason=(f"[FORCE] {reason or ''}".strip() if force else reason),
        dependencies=deps,
    ))
    return {
        "ok": True,
        "mode": "hard",
        "forced": bool(force and deps["blocking"]),
        "user_id": user_id,
        "note": (
            "Profile and role rows removed. Auth record (auth.users) must be "
            "removed separately via the Supabase dashboard if desired."
            + (" Linked records were ORPHANED (their recorded_by/performed_by/"
               "replaced_by pointers now dangle)." if force and deps["blocking"] else "")
        ),
    }


def soft_delete_plant(
    authorization: Optional[str], plant_id: str, reason: Optional[str] = None,
) -> dict[str, Any]:
    token = bearer_token(authorization)
    caller = caller_identity(token)
    require_roles(caller, {"Admin", "Manager"})
    client = user_scoped_client(token)
    label = _entity_label(client, "plant", plant_id)
    try:
        res = (
            client.table("plants")
            .update({"status": "Inactive"})
            .eq("id", plant_id)
            .execute()
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Supabase update failed: {e}")
    if not (res.data or []):
        raise HTTPException(status_code=404, detail="Plant not found")

    write_audit(client, AuditEntry(
        kind="plant", entity_id=plant_id, entity_label=label,
        action="soft", caller=caller, reason=reason,
    ))
    return {"ok": True, "mode": "soft", "plant_id": plant_id, "status": "Inactive"}


def hard_delete_plant(
    authorization: Optional[str], plant_id: str,
    reason: Optional[str] = None, force: bool = False,
    archive: bool = False,
) -> dict[str, Any]:
    """Admin + Manager. Only Admin may `force=True` over a dependency block.

    When `archive=True` (Admin + force only), every row in the no-cascade
    child tables is snapshotted into `archived_plant_data` as JSONB before
    being deleted, so historical readings/incidents/PMs survive the hard
    delete for compliance review.
    """
    token = bearer_token(authorization)
    caller = caller_identity(token)
    require_roles(caller, {"Admin", "Manager"})
    roles = set(caller.get("roles") or [])
    is_admin = "Admin" in roles

    client = user_scoped_client(token)
    deps = plant_dependencies(client, plant_id)
    if deps["blocking"]:
        if not (force and is_admin):
            raise HTTPException(
                status_code=409,
                detail={
                    "message": (
                        "Plant has active dependencies; archive or reassign them first."
                        if not force
                        else "Only Admin may force-delete a plant with dependencies."
                    ),
                    "dependencies": deps,
                    "force_allowed": is_admin,
                },
            )
    label = _entity_label(client, "plant", plant_id)

    # Several child tables reference plants(id) WITHOUT ON DELETE CASCADE
    # (well_readings, locator_readings, incidents, etc). We must clear them
    # ourselves before the parent DELETE — otherwise Postgres raises 23503.
    deleted_counts: dict[str, int] = {}
    archived_counts: dict[str, int] = {}
    will_archive = archive and is_admin and force and deps["blocking"]
    if force and deps["blocking"]:
        scrub_plant_assignments(client, plant_id)
        deleted_counts, archived_counts = _clear_no_cascade_children(
            client,
            plant_id=plant_id,
            plant_label=label,
            caller=caller,
            reason=reason,
            archive=will_archive,
        )

    try:
        client.table("plants").delete().eq("id", plant_id).execute()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Hard delete failed: {e}")

    write_audit(client, AuditEntry(
        kind="plant", entity_id=plant_id, entity_label=label,
        action="hard", caller=caller,
        reason=(f"[FORCE] {reason or ''}".strip() if force and deps["blocking"] else reason),
        dependencies=deps,
    ))
    return {
        "ok": True,
        "mode": "hard",
        "forced": bool(force and deps["blocking"]),
        "archived": bool(will_archive),
        "plant_id": plant_id,
        "deleted_counts": deleted_counts,
        "archived_counts": archived_counts if will_archive else {},
    }


def get_user_dependencies(authorization: Optional[str], user_id: str) -> dict[str, Any]:
    token = bearer_token(authorization)
    caller = caller_identity(token)
    require_roles(caller, {"Admin", "Manager"})
    client = user_scoped_client(token)
    return user_dependencies(client, user_id)


def get_plant_dependencies(authorization: Optional[str], plant_id: str) -> dict[str, Any]:
    token = bearer_token(authorization)
    caller = caller_identity(token)
    require_roles(caller, {"Admin", "Manager"})
    client = user_scoped_client(token)
    return plant_dependencies(client, plant_id)


def list_audit_log(
    authorization: Optional[str],
    kind: Optional[str] = None,
    limit: int = 100,
) -> dict[str, Any]:
    token = bearer_token(authorization)
    caller = caller_identity(token)
    require_roles(caller, {"Admin", "Manager"})
    client = user_scoped_client(token)
    limit = max(1, min(int(limit), 500))
    try:
        q = client.table("deletion_audit_log").select("*").order(
            "created_at", desc=True,
        ).limit(limit)
        if kind in ("user", "plant", "well"):
            q = q.eq("kind", kind)
        res = q.execute()
        return {"count": len(res.data or []), "entries": res.data or []}
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        # Only swallow the "table/relation does not exist" error (pre-migration state).
        # Any other Supabase error (RLS denial, network, etc) must surface as 500.
        if "deletion_audit_log" in msg and is_missing_table_error(msg):
            log.warning(
                "deletion_audit_log table missing — run supabase/migrations/"
                "20260424_deletion_audit_log.sql in Supabase SQL editor."
            )
            return {
                "count": 0,
                "entries": [],
                "table_missing": True,
                "warning": msg,
            }
        log.exception("audit log read failed")
        raise HTTPException(status_code=500, detail=f"Audit log read failed: {msg}")


# --- Plant cleanup (Admin one-click bulk hard-delete) ----------------------

def _validate_cleanup_args(names: list[str], reason: str) -> list[str]:
    """Validate inputs for `cleanup_plants` and return the canonicalised
    list of names. Raises HTTPException(400) on invalid inputs."""
    if not isinstance(names, list) or not names:
        raise HTTPException(status_code=400, detail="`names` must be a non-empty list.")
    cleaned_names = [n.strip() for n in names if isinstance(n, str) and n.strip()]
    if not cleaned_names:
        raise HTTPException(status_code=400, detail="`names` must contain non-empty strings.")
    if not reason or len(reason.strip()) < 5:
        raise HTTPException(
            status_code=400,
            detail="`reason` is required and must be at least 5 characters.",
        )
    return cleaned_names


def _cleanup_one_plant(
    client: Client,
    *,
    name: str,
    row: dict[str, Any],
    caller: dict[str, Any],
    reason: str,
) -> dict[str, Any]:
    """Hard-delete one plant (already resolved) and its no-cascade children.
    Writes the audit row first so an interrupted cleanup leaves a paper trail.
    """
    plant_id = row["id"]

    # Snapshot dependency counts before mutation (for audit + response).
    deps = plant_dependencies(client, plant_id)

    # Audit FIRST — even if a downstream delete fails, the caller has a trail.
    write_audit(client, AuditEntry(
        kind="plant", entity_id=plant_id, entity_label=row.get("name"),
        action="hard", caller=caller,
        reason=f"[CLEANUP] {reason.strip()}",
        dependencies=deps,
    ))

    deleted_counts: dict[str, int] = {}
    try:
        cleared, _ = _clear_no_cascade_children(
            client,
            plant_id=plant_id,
            plant_label=row.get("name"),
            caller=caller,
            reason=reason,
            archive=False,
        )
        deleted_counts.update(cleared)
        scrub_plant_assignments(client, plant_id)
        # Finally drop the plant; CASCADE removes wells/locators/ro_trains/etc.
        client.table("plants").delete().eq("id", plant_id).execute()
        deleted_counts["plants"] = 1
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("plant cleanup failed for %s", name)
        raise HTTPException(
            status_code=500,
            detail=f"Cleanup failed mid-flight for '{name}': {e}",
        )

    return {
        "name": name,
        "plant_id": plant_id,
        "deleted_counts": deleted_counts,
    }


def cleanup_plants(
    authorization: Optional[str],
    names: list[str],
    reason: str,
) -> dict[str, Any]:
    """Admin-only. Bulk hard-delete a list of plants by name, clearing all
    no-cascade dependents and writing one audit-log row per plant.
    """
    token = bearer_token(authorization)
    caller = caller_identity(token)
    require_roles(caller, {"Admin"})

    cleaned_names = _validate_cleanup_args(names, reason)
    client = user_scoped_client(token)

    processed: list[dict[str, Any]] = []
    not_found: list[str] = []

    for name in cleaned_names:
        row = resolve_plant_by_name(client, name)
        if not row:
            not_found.append(name)
            continue
        processed.append(_cleanup_one_plant(
            client, name=name, row=row, caller=caller, reason=reason,
        ))

    return {
        "ok": True,
        "processed": processed,
        "not_found": not_found,
        "actor_label": caller.get("label"),
    }


# ---------------------------------------------------------------------------
# Backward-compat underscore aliases.
# `migrations_status.py` and `ai_import_service.py` import these names.
# ---------------------------------------------------------------------------

_user_scoped_client = user_scoped_client
_bearer_token = bearer_token
_caller_identity = caller_identity
_require_roles = require_roles
_is_missing_table_error = is_missing_table_error
_count_refs = count_refs


def _write_audit(
    client: Client,
    *,
    kind: str,
    entity_id: str,
    entity_label: Optional[str],
    action: str,
    caller: dict[str, Any],
    reason: Optional[str],
    dependencies: Optional[dict[str, Any]] = None,
) -> None:
    """Backward-compat shim: builds an `AuditEntry` and delegates to
    `write_audit`. Prefer the dataclass call-site in new code."""
    write_audit(
        client,
        AuditEntry(
            kind=kind,
            entity_id=entity_id,
            entity_label=entity_label,
            action=action,
            caller=caller,
            reason=reason,
            dependencies=dependencies,
        ),
    )
