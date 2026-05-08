"""
admin_helpers.py — Admin utilities using asyncpg (replaces Supabase client).
"""
from __future__ import annotations
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

import db
from permissions import decode_token, is_admin, is_manager_or_admin

log = logging.getLogger(__name__)


# ── Caller identity ───────────────────────────────────────────────────────────

def bearer_token(authorization: Optional[str]) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Not authenticated")
    return authorization[7:]


async def caller_identity(access_token: str) -> dict[str, Any]:
    payload = decode_token(access_token)
    user_id = payload["sub"]
    roles_rows = await db.fetch("SELECT role FROM user_roles WHERE user_id = $1", user_id)
    roles = [r["role"] for r in roles_rows]
    prof = await db.fetchrow(
        "SELECT username, first_name, last_name, designation, plant_assignments FROM user_profiles WHERE id = $1",
        user_id,
    )
    return {
        "sub": user_id,
        "email": payload.get("email"),
        "roles": roles,
        "plant_assignments": payload.get("plant_assignments", []),
        "profile": dict(prof) if prof else {},
    }


def require_roles(caller: dict[str, Any], allowed: set[str]) -> None:
    roles = set(caller.get("roles", []))
    if not roles.intersection(allowed):
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail=f"Required role: {allowed}")


# ── DB helpers ────────────────────────────────────────────────────────────────

async def count_refs(table: str, column: str, value: Any) -> int:
    result = await db.fetchval(
        f'SELECT COUNT(*) FROM "{table}" WHERE "{column}" = $1', value
    )
    return int(result or 0)


async def scrub_plant_assignments(plant_id: str) -> None:
    """Remove plant_id from all user plant_assignments arrays."""
    import uuid as uuid_mod
    pid = uuid_mod.UUID(plant_id)
    await db.execute(
        "UPDATE user_profiles SET plant_assignments = array_remove(plant_assignments, $1::uuid)",
        pid,
    )


async def resolve_plant_by_name(name: str) -> Optional[str]:
    row = await db.fetchrow("SELECT id FROM plants WHERE name = $1", name)
    return str(row["id"]) if row else None


async def archive_table_snapshot(
    table: str, plant_id: str, label: str, caller_id: str, reason: str
) -> None:
    import uuid as uuid_mod, json
    rows = await db.fetch(f'SELECT * FROM "{table}" WHERE plant_id = $1', uuid_mod.UUID(plant_id))
    await db.execute(
        """INSERT INTO archived_plant_data(plant_id, table_name, snapshot, label, archived_by)
           VALUES($1, $2, $3, $4, $5)""",
        uuid_mod.UUID(plant_id), table, json.dumps(rows, default=str), label,
        uuid_mod.UUID(caller_id),
    )


# ── Audit log ─────────────────────────────────────────────────────────────────

@dataclass
class AuditEntry:
    entity_type: str
    entity_id:   str
    entity_name: Optional[str] = None
    action:      str = "soft_delete"
    reason:      Optional[str] = None
    actor_id:    Optional[str] = None
    actor_email: Optional[str] = None
    metadata:    dict = field(default_factory=dict)


async def write_audit(entry: AuditEntry) -> None:
    import uuid as uuid_mod, json
    try:
        await db.execute(
            """INSERT INTO deletion_audit_log
               (entity_type, entity_id, entity_name, action, reason, actor_id, actor_email, metadata)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8)""",
            entry.entity_type, entry.entity_id, entry.entity_name,
            entry.action, entry.reason,
            uuid_mod.UUID(entry.actor_id) if entry.actor_id else None,
            entry.actor_email,
            json.dumps(entry.metadata),
        )
    except Exception:
        log.exception("write_audit failed")


# ── Backward-compat aliases ───────────────────────────────────────────────────
_write_audit = write_audit
