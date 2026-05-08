"""
db.py — asyncpg connection pool for Render PostgreSQL.
Replaces all supabase client usage in the backend.
"""
from __future__ import annotations
import os
import logging
import asyncpg

log = logging.getLogger(__name__)
_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError("DATABASE_URL env var is not set")
        _pool = await asyncpg.create_pool(url, min_size=2, max_size=10)
        log.info("asyncpg pool created")
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
        log.info("asyncpg pool closed")


# ── Convenience helpers ──────────────────────────────────────────────────────

async def fetch(query: str, *args) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *args)
        return [dict(r) for r in rows]


async def fetchrow(query: str, *args) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, *args)
        return dict(row) if row else None


async def fetchval(query: str, *args):
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchval(query, *args)


async def execute(query: str, *args) -> str:
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.execute(query, *args)


async def executemany(query: str, args_list: list) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.executemany(query, args_list)
