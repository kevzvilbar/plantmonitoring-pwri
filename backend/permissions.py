"""
permissions.py — JWT creation / verification + FastAPI dependency helpers.
Replaces Supabase RLS and auth.uid().
"""
from __future__ import annotations
import os, logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Any
import jwt
from fastapi import HTTPException, Header, Depends

log = logging.getLogger(__name__)

JWT_SECRET    = os.environ.get("JWT_SECRET", "change-me-in-production-use-a-long-random-string")
ALGORITHM     = "HS256"
ACCESS_TTL    = int(os.environ.get("ACCESS_TOKEN_TTL_MINUTES", "60"))
REFRESH_TTL   = int(os.environ.get("REFRESH_TOKEN_TTL_DAYS", "7"))

# Tables that are filtered by plant_id for non-admin callers
PLANT_SCOPED = {
    "locators", "locator_meter_replacements", "locator_readings",
    "wells", "well_pms_records", "well_meter_replacements", "well_readings",
    "ro_trains", "ro_train_readings", "ro_pretreatment_readings",
    "afm_readings", "pump_readings", "cartridge_readings", "cip_logs",
    "chemical_inventory", "chemical_prices", "chemical_dosing_logs",
    "chemical_deliveries", "chemical_residual_samples",
    "power_readings", "power_tariffs", "electric_bills", "plant_power_config",
    "product_meters", "product_meter_readings", "product_meter_audit_log",
    "checklist_templates", "checklist_executions", "checklist_step_executions",
    "incidents", "blending_events", "daily_plant_summary",
    "train_status_log", "production_costs", "production_calc_log",
    "import_analyses",
}

# plants table uses id as the plant identifier (not plant_id column)
ADMIN_ONLY = {
    "deletion_audit_log", "import_audit_log", "login_attempts", "signup_audit",
    "plant_edit_audit_log", "entity_status_audit_log", "plant_assignment_audit",
    "refresh_tokens", "users",
}


# ── Token helpers ────────────────────────────────────────────────────────────

def create_access_token(user_id: str, email: str, roles: list[str], plant_assignments: list[str]) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TTL)
    payload = {
        "sub": user_id,
        "email": email,
        "roles": roles,
        "plant_assignments": plant_assignments,
        "exp": exp,
        "type": "access",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=ALGORITHM)


def create_refresh_token(user_id: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=REFRESH_TTL)
    payload = {"sub": user_id, "exp": exp, "type": "refresh"}
    return jwt.encode(payload, JWT_SECRET, algorithm=ALGORITHM)


def decode_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")


# ── FastAPI dependencies ─────────────────────────────────────────────────────

def _extract_token(authorization: Optional[str]) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return authorization[7:]


def caller_identity(authorization: Optional[str] = Header(None, alias="authorization")) -> dict:
    """Require a valid JWT; return the payload."""
    token = _extract_token(authorization)
    payload = decode_token(token)
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Not an access token")
    return payload


def optional_caller(authorization: Optional[str] = Header(None, alias="authorization")) -> Optional[dict]:
    """Like caller_identity but returns None instead of raising for unauthenticated requests."""
    if not authorization:
        return None
    try:
        return caller_identity(authorization)
    except HTTPException:
        return None


# ── Permission helpers ───────────────────────────────────────────────────────

def require_roles(caller: dict, allowed: set[str]) -> None:
    roles = set(caller.get("roles", []))
    if not roles.intersection(allowed):
        raise HTTPException(status_code=403, detail=f"Required role: {allowed}")


def is_admin(caller: dict) -> bool:
    return "Admin" in caller.get("roles", [])


def is_manager_or_admin(caller: dict) -> bool:
    return bool({"Admin", "Manager"} & set(caller.get("roles", [])))


def plant_filter_clause(caller: dict, alias: str = "") -> tuple[str, list]:
    """
    Returns (WHERE fragment, params_list) to restrict a query to the caller's
    plant_assignments. Admins get no restriction.
    Alias prefix is e.g. 'p.' for 'p.id' or '' for 'plant_id'.
    """
    if is_admin(caller):
        return "TRUE", []
    assignments = caller.get("plant_assignments", [])
    if not assignments:
        return "FALSE", []
    col = f"{alias}id" if alias else "plant_id"
    placeholders = ", ".join(f"${i+1}" for i in range(len(assignments)))
    return f"{col} = ANY(ARRAY[{placeholders}]::uuid[])", assignments
