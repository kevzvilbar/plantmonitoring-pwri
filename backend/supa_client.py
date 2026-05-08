"""
supa_client.py — Shim that replaces the old Supabase client with asyncpg helpers.
Imported by cron_service.py and seed_service.py via `from supa_client import _client`.
"""
from __future__ import annotations
import logging
import db

log = logging.getLogger(__name__)


class _PgClient:
    """Minimal async DB client used by cron / seed services."""

    async def table(self, table_name: str) -> "_TableQuery":
        return _TableQuery(table_name)


class _TableQuery:
    def __init__(self, table: str):
        self._table = table
        self._filters: list[tuple[str, str]] = []
        self._cols    = "*"
        self._order_col: str | None = None
        self._order_desc = False
        self._limit_n: int | None = None

    def select(self, cols: str = "*") -> "_TableQuery":
        self._cols = cols; return self

    def eq(self, col: str, val) -> "_TableQuery":
        self._filters.append((col, val)); return self

    def order(self, col: str, desc: bool = False) -> "_TableQuery":
        self._order_col = col; self._order_desc = desc; return self

    def limit(self, n: int) -> "_TableQuery":
        self._limit_n = n; return self

    async def execute(self):
        where_parts = []
        values: list = []
        for i, (col, val) in enumerate(self._filters, start=1):
            where_parts.append(f'"{col}" = ${i}')
            values.append(val)
        where = "WHERE " + " AND ".join(where_parts) if where_parts else ""
        order = ""
        if self._order_col:
            direction = "DESC" if self._order_desc else "ASC"
            order = f'ORDER BY "{self._order_col}" {direction}'
        limit = f"LIMIT {self._limit_n}" if self._limit_n else ""
        query = f'SELECT {self._cols} FROM "{self._table}" {where} {order} {limit}'.strip()
        rows = await db.fetch(query, *values)
        return _Result(rows)

    async def insert(self, data) -> "_Result":
        rows = data if isinstance(data, list) else [data]
        inserted = []
        for row in rows:
            cols = list(row.keys())
            col_str = ", ".join(f'"{c}"' for c in cols)
            placeholders = ", ".join(f"${i+1}" for i in range(len(cols)))
            vals = [row[c] for c in cols]
            r = await db.fetchrow(
                f'INSERT INTO "{self._table}" ({col_str}) VALUES ({placeholders}) RETURNING *',
                *vals,
            )
            if r:
                inserted.append(dict(r))
        return _Result(inserted)

    async def update(self, data: dict) -> "_Result":
        cols = list(data.keys())
        set_parts = [f'"{c}" = ${i+1}' for i, c in enumerate(cols)]
        set_str = ", ".join(set_parts)
        idx = len(cols) + 1
        filter_parts = []
        filter_vals: list = []
        for col, val in self._filters:
            filter_parts.append(f'"{col}" = ${idx}')
            filter_vals.append(val)
            idx += 1
        where = "WHERE " + " AND ".join(filter_parts) if filter_parts else ""
        all_vals = [data[c] for c in cols] + filter_vals
        rows = await db.fetch(
            f'UPDATE "{self._table}" SET {set_str} {where} RETURNING *', *all_vals
        )
        return _Result(rows)


class _Result:
    def __init__(self, data: list):
        self.data = data
        self.error = None


def _client() -> _PgClient:
    """Return the asyncpg-backed pseudo-client. Always returns a valid client."""
    return _PgClient()


# ── AI tools compatibility ─────────────────────────────────────────────────────

READ_WHITELIST: dict[str, list[str]] = {
    "plants":               ["id", "name", "status", "design_capacity_m3", "address"],
    "wells":                ["id", "plant_id", "name", "status"],
    "well_readings":        ["id", "well_id", "plant_id", "reading_datetime", "current_reading", "daily_volume"],
    "locators":             ["id", "plant_id", "name", "status"],
    "locator_readings":     ["id", "locator_id", "plant_id", "reading_datetime", "current_reading", "daily_volume"],
    "ro_trains":            ["id", "plant_id", "name", "status"],
    "ro_train_readings":    ["id", "ro_train_id", "plant_id", "reading_datetime", "permeate_tds", "permeate_ph", "recovery_pct"],
    "incidents":            ["id", "plant_id", "occurred_at", "severity", "category", "description", "status"],
    "chemical_dosing_logs": ["id", "plant_id", "dosing_date", "chemical_name", "amount_used"],
    "power_readings":       ["id", "plant_id", "reading_datetime", "kwh_consumed"],
    "daily_plant_summary":  ["id", "plant_id", "summary_date", "nrw_pct", "downtime_hrs", "permeate_tds", "recovery_pct"],
    "checklist_executions": ["id", "template_id", "plant_id", "execution_date", "completed"],
}


async def safe_select(
    table: str,
    select: str | None = None,
    filters: dict | None = None,
    order_by: str | None = None,
    desc: bool = False,
    limit: int = 100,
) -> list[dict]:
    """Async safe SELECT for AI tools — restricted to READ_WHITELIST tables."""
    if table not in READ_WHITELIST:
        raise ValueError(f"Table '{table}' not in read whitelist")

    allowed_cols = READ_WHITELIST[table]
    cols = select if select and select != "*" else ", ".join(allowed_cols)
    # Validate requested cols are in whitelist
    requested = [c.strip() for c in cols.split(",")]
    safe_cols  = [c for c in requested if c in allowed_cols]
    col_str    = ", ".join(f'"{c}"' for c in safe_cols) if safe_cols else "*"

    where_parts: list[str] = []
    values: list = []
    idx = 1
    for col, val in (filters or {}).items():
        if col in allowed_cols:
            where_parts.append(f'"{col}" = ${idx}')
            values.append(val)
            idx += 1

    where  = "WHERE " + " AND ".join(where_parts) if where_parts else ""
    order  = f'ORDER BY "{order_by}" {"DESC" if desc else "ASC"}' if order_by and order_by in allowed_cols else ""
    query  = f'SELECT {col_str} FROM "{table}" {where} {order} LIMIT {int(limit)}'
    return await db.fetch(query, *values)
