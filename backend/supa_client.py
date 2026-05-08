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
