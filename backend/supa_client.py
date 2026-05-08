"""
Supabase REST helper used from the server side.

Uses the same project URL + anon key the browser uses (read-only-friendly).
Provides a thin wrapper with table whitelisting for AI-initiated queries.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

from supabase import Client, create_client

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Whitelist of tables the AI query-planner may access.
# Columns listed are those the UI already considers safe / read-only.
# ---------------------------------------------------------------------------

READ_WHITELIST: dict[str, set[str]] = {
    "plants": {"id", "name", "location", "status", "capacity_m3", "code"},
    "wells": {"id", "plant_id", "name", "status", "has_power_meter",
              "capacity_m3", "depth_m"},
    "well_readings": {
        "id", "plant_id", "well_id", "reading_datetime",
        "previous_reading", "current_reading", "daily_volume",
        "off_location_flag", "power_meter_reading",
    },
    "locators": {"id", "plant_id", "name", "status"},
    "locator_readings": {
        "id", "plant_id", "locator_id", "reading_datetime",
        "previous_reading", "current_reading", "daily_volume",
        "off_location_flag",
    },
    "ro_trains": {"id", "plant_id", "name", "status"},
    "ro_train_readings": {
        "id", "plant_id", "ro_train_id", "reading_datetime",
        "permeate_tds", "permeate_ph", "raw_turbidity",
        "dp_psi", "recovery_pct",
    },
    "chemical_inventory": {"id", "plant_id", "chemical_name",
                            "quantity", "unit", "updated_at"},
    "daily_plant_summary": {
        "id", "plant_id", "summary_date",
        "total_production_m3", "total_consumption_m3", "nrw_pct",
        "downtime_hrs", "permeate_tds", "permeate_ph",
        "raw_turbidity", "dp_psi", "recovery_pct", "pv_ratio",
    },
    "incidents": {"id", "plant_id", "occurred_at", "severity",
                   "category", "description", "status"},
    "checklist_templates": {"id", "plant_id", "equipment_name",
                             "category", "frequency",
                             "schedule_start_date"},
    "checklist_executions": {"id", "template_id", "execution_date",
                              "completed", "findings"},
}

ALLOWED_OPS = {"eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in"}


def _client(access_token: Optional[str] = None) -> Optional[Client]:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_ANON_KEY")
    if not url or not key:
        log.warning("SUPABASE_URL / SUPABASE_ANON_KEY not set")
        return None
    client = create_client(url, key)
    if access_token:
        # Attach user's JWT so RLS policies apply under their identity
        try:
            client.postgrest.auth(access_token)
        except Exception:  # noqa: BLE001
            log.exception("Failed to attach user JWT to Supabase client")
    return client


def is_available() -> bool:
    return bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_ANON_KEY"))


def _project_columns(table: str, select: Optional[list[str]]) -> str:
    cols = READ_WHITELIST.get(table, set())
    if not cols:
        raise ValueError(f"Table '{table}' is not allowed.")
    if not select:
        return "*"
    picked = [c for c in select if c in cols or c.startswith("!") or c == "*"]
    if not picked:
        return "*"
    return ",".join(picked)


def safe_select(
    table: str,
    select: Optional[list[str]] = None,
    filters: Optional[list[dict[str, Any]]] = None,
    order_by: Optional[str] = None,
    desc: bool = False,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """
    Execute a whitelisted SELECT against Supabase.

    filters: list of {"column": str, "op": str, "value": Any} where op is in ALLOWED_OPS.
    Returns at most `limit` rows, hard-capped to 500.
    """
    if table not in READ_WHITELIST:
        raise ValueError(f"Table '{table}' is not allowed.")

    client = _client()
    if client is None:
        raise RuntimeError(
            "Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.",
        )

    columns = _project_columns(table, select)
    limit = max(1, min(int(limit), 500))

    cols_allowed = READ_WHITELIST[table]
    q = client.table(table).select(columns)
    for f in filters or []:
        col = f.get("column")
        op = (f.get("op") or "eq").lower()
        val = f.get("value")
        if col not in cols_allowed:
            raise ValueError(f"Column '{col}' is not allowed on '{table}'.")
        if op not in ALLOWED_OPS:
            raise ValueError(f"Operator '{op}' is not allowed.")
        if op == "eq":
            q = q.eq(col, val)
        elif op == "neq":
            q = q.neq(col, val)
        elif op == "gt":
            q = q.gt(col, val)
        elif op == "gte":
            q = q.gte(col, val)
        elif op == "lt":
            q = q.lt(col, val)
        elif op == "lte":
            q = q.lte(col, val)
        elif op == "like":
            q = q.like(col, str(val))
        elif op == "ilike":
            q = q.ilike(col, str(val))
        elif op == "in":
            if not isinstance(val, (list, tuple)):
                raise ValueError("`in` requires a list value")
            q = q.in_(col, list(val))

    if order_by:
        if order_by not in cols_allowed:
            raise ValueError(f"Order-by column '{order_by}' not allowed.")
        q = q.order(order_by, desc=desc)

    q = q.limit(limit)
    res = q.execute()
    return res.data or []
