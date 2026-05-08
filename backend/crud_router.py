"""
crud_router.py — Generic PostgREST-style CRUD for all tables.
Replaces every supabase.from('table').select/insert/update/delete() call.

Endpoint pattern:
  GET    /api/db/{table}  — select with filters
  POST   /api/db/{table}  — insert one or many rows
  PATCH  /api/db/{table}  — update rows matching filters
  DELETE /api/db/{table}  — delete rows matching filters
"""
from __future__ import annotations
import logging, re, uuid as uuid_mod
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import JSONResponse

import db
from permissions import (
    caller_identity, is_admin, is_manager_or_admin,
    PLANT_SCOPED, ADMIN_ONLY,
)

router = APIRouter(prefix="/api/db", tags=["crud"])
log = logging.getLogger(__name__)

# ── Table allow-list (every table in schema.sql) ──────────────────────────────
ALLOWED_TABLES = {
    "users", "user_profiles", "user_roles", "refresh_tokens",
    "plants", "locators", "locator_meter_replacements", "locator_readings",
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
    "deletion_audit_log", "import_audit_log", "plant_edit_audit_log",
    "entity_status_audit_log", "plant_assignment_audit",
    "login_attempts", "signup_audit", "archived_plant_data",
    "import_analyses", "notifications",
}

_SAFE_IDENT = re.compile(r'^[a-z][a-z0-9_]*$')


def _check_table(table: str):
    if table not in ALLOWED_TABLES:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table}")


def _safe_col(col: str) -> str:
    """Validate column name to prevent SQL injection."""
    col = col.strip().strip('"')
    if not _SAFE_IDENT.match(col):
        raise HTTPException(status_code=400, detail=f"Invalid column name: {col!r}")
    return f'"{col}"'


def _parse_select(select_str: str) -> str:
    if not select_str or select_str.strip() == "*":
        return "*"
    cols = [_safe_col(c.strip()) for c in select_str.split(",") if c.strip()]
    return ", ".join(cols)


OPS = {
    "eq": "=",  "neq": "!=",
    "gt": ">",  "gte": ">=",
    "lt": "<",  "lte": "<=",
    "like": "LIKE", "ilike": "ILIKE",
}


def _build_where(params: dict, start_idx: int = 1) -> tuple[str, list, int]:
    """
    Parse filter params from query string.
    Supported: eq[col]=val, neq[col]=val, gt, gte, lt, lte, ilike, in[col]=a,b,c, is[col]=null
    Returns (WHERE clause string, param values list, next param index).
    """
    clauses: list[str] = []
    values: list[Any] = []
    idx = start_idx

    for op_name, sql_op in OPS.items():
        for key, val in params.items():
            if key.startswith(f"{op_name}[") and key.endswith("]"):
                col = key[len(op_name)+1:-1]
                clauses.append(f"{_safe_col(col)} {sql_op} ${idx}")
                values.append(val)
                idx += 1

    # in[col]=a,b,c
    for key, val in params.items():
        if key.startswith("in[") and key.endswith("]"):
            col = key[3:-1]
            items = [v.strip() for v in val.split(",") if v.strip()]
            if items:
                placeholders = ", ".join(f"${idx+i}" for i in range(len(items)))
                clauses.append(f"{_safe_col(col)} = ANY(ARRAY[{placeholders}])")
                values.extend(items)
                idx += len(items)

    # is[col]=null|true|false
    for key, val in params.items():
        if key.startswith("is[") and key.endswith("]"):
            col = key[3:-1]
            if val.lower() == "null":
                clauses.append(f"{_safe_col(col)} IS NULL")
            elif val.lower() == "true":
                clauses.append(f"{_safe_col(col)} IS TRUE")
            elif val.lower() == "false":
                clauses.append(f"{_safe_col(col)} IS FALSE")

    where = " AND ".join(clauses) if clauses else "TRUE"
    return where, values, idx


def _plant_scope_clause(table: str, caller: dict, start_idx: int) -> tuple[str, list, int]:
    """Add plant-scope restriction for non-admin callers on plant-scoped tables."""
    if is_admin(caller):
        return "TRUE", [], start_idx

    assignments = caller.get("plant_assignments", [])
    if not assignments:
        return "FALSE", [], start_idx

    if table == "plants":
        col = '"id"'
    elif table in PLANT_SCOPED:
        col = '"plant_id"'
    else:
        return "TRUE", [], start_idx

    placeholders = ", ".join(f"${start_idx+i}" for i in range(len(assignments)))
    clause = f"{col} = ANY(ARRAY[{placeholders}]::uuid[])"
    return clause, assignments, start_idx + len(assignments)


def _user_scope_clause(table: str, caller: dict, start_idx: int) -> tuple[str, list, int]:
    """Restrict user_profiles / user_roles / notifications to own data for non-managers."""
    if is_manager_or_admin(caller):
        return "TRUE", [], start_idx
    if table in ("user_profiles", "notifications"):
        return f'"id" = ${start_idx}' if table == "user_profiles" else f'"user_id" = ${start_idx}', [caller["sub"]], start_idx + 1
    if table == "user_roles":
        return f'"user_id" = ${start_idx}', [caller["sub"]], start_idx + 1
    return "TRUE", [], start_idx


def _parse_order(order_str: str | None) -> str:
    if not order_str:
        return ""
    parts = []
    for item in order_str.split(","):
        item = item.strip()
        if "." in item:
            col, direction = item.rsplit(".", 1)
            direction = "DESC" if direction.lower() == "desc" else "ASC"
        else:
            col, direction = item, "ASC"
        parts.append(f"{_safe_col(col)} {direction}")
    return "ORDER BY " + ", ".join(parts) if parts else ""


# ── GET ───────────────────────────────────────────────────────────────────────

@router.get("/{table}")
async def select_rows(table: str, request: Request, caller: dict = Depends(caller_identity)):
    _check_table(table)
    if table in ADMIN_ONLY and not is_admin(caller):
        raise HTTPException(status_code=403, detail="Admin only")

    params = dict(request.query_params)
    select_cols = _parse_select(params.get("select", "*"))
    single       = params.get("single", "").lower() == "true"
    maybe_single = params.get("maybeSingle", "").lower() == "true"
    count_mode   = params.get("count", "")
    head_only    = params.get("head", "").lower() == "true"
    limit_val    = params.get("limit")
    offset_val   = params.get("offset", "0")
    order_clause = _parse_order(params.get("order"))

    # Build WHERE
    filter_clause, filter_vals, idx = _build_where(params, start_idx=1)

    # Add plant-scope restriction
    plant_clause, plant_vals, idx = _plant_scope_clause(table, caller, idx)
    filter_vals.extend(plant_vals)

    # Add user-scope restriction
    user_clause, user_vals, idx = _user_scope_clause(table, caller, idx)
    filter_vals.extend(user_vals)

    where = f"({filter_clause}) AND ({plant_clause}) AND ({user_clause})"

    if head_only or count_mode == "exact":
        total = await db.fetchval(f'SELECT COUNT(*) FROM "{table}" WHERE {where}', *filter_vals)
        if head_only:
            return JSONResponse({"data": None, "count": total, "error": None})

    query = f'SELECT {select_cols} FROM "{table}" WHERE {where} {order_clause}'
    if limit_val:
        query += f" LIMIT {int(limit_val)}"
    if offset_val:
        query += f" OFFSET {int(offset_val)}"

    rows = await db.fetch(query, *filter_vals)
    total = len(rows) if count_mode == "exact" else None

    if single:
        if not rows:
            raise HTTPException(status_code=406, detail="No rows found")
        return {"data": rows[0], "error": None, "count": total}
    if maybe_single:
        return {"data": rows[0] if rows else None, "error": None, "count": total}

    return {"data": rows, "error": None, "count": total}


# ── POST (insert) ─────────────────────────────────────────────────────────────

@router.post("/{table}")
async def insert_rows(table: str, request: Request, caller: dict = Depends(caller_identity)):
    _check_table(table)
    if table in ADMIN_ONLY and not is_admin(caller):
        raise HTTPException(status_code=403, detail="Admin only")

    body = await request.json()
    rows = body if isinstance(body, list) else [body]
    if not rows:
        raise HTTPException(status_code=400, detail="No data provided")

    columns = list(rows[0].keys())
    if not columns:
        raise HTTPException(status_code=400, detail="Empty row")

    col_str = ", ".join(_safe_col(c) for c in columns)
    inserted = []
    for row in rows:
        vals = [row.get(c) for c in columns]
        placeholders = ", ".join(f"${i+1}" for i in range(len(columns)))
        result = await db.fetchrow(
            f'INSERT INTO "{table}" ({col_str}) VALUES ({placeholders}) RETURNING *',
            *vals,
        )
        if result:
            inserted.append(dict(result))

    return {"data": inserted if len(inserted) > 1 else (inserted[0] if inserted else None), "error": None}


# ── PATCH (update) ────────────────────────────────────────────────────────────

@router.patch("/{table}")
async def update_rows(table: str, request: Request, caller: dict = Depends(caller_identity)):
    _check_table(table)
    if table in ADMIN_ONLY and not is_admin(caller):
        raise HTTPException(status_code=403, detail="Admin only")

    params = dict(request.query_params)
    body = await request.json()
    if not body:
        raise HTTPException(status_code=400, detail="No update data provided")

    set_cols  = list(body.keys())
    set_vals  = [body[c] for c in set_cols]
    set_parts = ", ".join(f"{_safe_col(c)} = ${i+1}" for i, c in enumerate(set_cols))
    idx = len(set_cols) + 1

    filter_clause, filter_vals, idx = _build_where(params, start_idx=idx)
    plant_clause,  plant_vals,  idx = _plant_scope_clause(table, caller, idx)
    filter_vals.extend(plant_vals)
    user_clause,   user_vals,   idx = _user_scope_clause(table, caller, idx)
    filter_vals.extend(user_vals)
    where = f"({filter_clause}) AND ({plant_clause}) AND ({user_clause})"

    all_vals = set_vals + filter_vals
    rows = await db.fetch(
        f'UPDATE "{table}" SET {set_parts} WHERE {where} RETURNING *', *all_vals
    )
    return {"data": rows, "error": None}


# ── DELETE ────────────────────────────────────────────────────────────────────

@router.delete("/{table}")
async def delete_rows(table: str, request: Request, caller: dict = Depends(caller_identity)):
    _check_table(table)
    if table in ADMIN_ONLY and not is_admin(caller):
        raise HTTPException(status_code=403, detail="Admin only")

    params = dict(request.query_params)
    filter_clause, filter_vals, idx = _build_where(params, start_idx=1)
    plant_clause,  plant_vals,  idx = _plant_scope_clause(table, caller, idx)
    filter_vals.extend(plant_vals)
    user_clause,   user_vals,   idx = _user_scope_clause(table, caller, idx)
    filter_vals.extend(user_vals)
    where = f"({filter_clause}) AND ({plant_clause}) AND ({user_clause})"

    rows = await db.fetch(
        f'DELETE FROM "{table}" WHERE {where} RETURNING *', *filter_vals
    )
    return {"data": rows, "error": None}
