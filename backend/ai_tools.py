"""
AI query-planner (poor man's tool calling).

Flow:
  user_message  ─▶  LLM #1 plans  ─▶  {table, select, filters, ...}
                                      │
                                      ▼
                               safe_select() runs it against Supabase
                                      │
                                      ▼
  results  ─▶  LLM #2 answers (with the data) ─▶ natural-language reply

We skip the plan entirely when the model replies with {"plan": null}, letting
the model answer from its own knowledge.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any, Optional

from pydantic import BaseModel, Field

from supa_client import READ_WHITELIST, safe_select
from ai_service import _chat_complete, _safe_parse_json

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Planner prompt
# ---------------------------------------------------------------------------

def _schema_hint() -> str:
    lines = ["Tables and columns you may query (ALL other tables are forbidden):"]
    for t, cols in READ_WHITELIST.items():
        lines.append(f"  - {t}({', '.join(sorted(cols))})")
    return "\n".join(lines)


PLANNER_SYSTEM = """You are the "data router" for a water-plant monitoring app.

Given a user question about the plants' operations, decide whether answering it
requires fetching data. If YES, output a STRICT JSON plan describing ONE Supabase
query. If NO (small-talk / definitions / previous-context questions), output
{"plan": null, "reason": "…"}.

Plan schema (when plan is needed):
{
  "plan": {
    "table": "<one of the whitelisted tables>",
    "select": ["col1", "col2", ...] | null,
    "filters": [{"column":"...", "op":"eq|neq|gt|gte|lt|lte|like|ilike|in", "value": ...}, ...],
    "order_by": "column" | null,
    "desc": true|false,
    "limit": <1..500>,
    "post_process": "auto_summary | anomaly_flag | none"
  }
}

Rules:
 • Only emit columns that exist in the schema below.
 • Prefer daily_plant_summary for aggregated metrics.
 • For time-filtering on a datetime column, always use ISO strings like
   "2026-03-01T00:00:00Z".
 • For resolving plant / well / train names, USE ilike matches on the `name`
   column if the user provides a human name (e.g. "Umapad", "Well 2"). The
   calling system will follow up with additional sub-queries if needed.
 • limit should be the SMALLEST needed: 30 for single-well monthly scans,
   100 for multi-item lists. Never > 500.
 • Return JSON ONLY. No prose, no markdown fences.

SCHEMA
""" + _schema_hint()


ANSWER_SYSTEM = """You are the on-duty AI analyst for a water-treatment plant.

Given the original user question and a JSON `DATA` block (fetched rows), write a
short natural-language answer. Cite specific numbers. Use short bullets when
multiple facts are involved. Under ~180 words. If the DATA is empty or doesn't
answer the question, say so briefly and suggest what to try next."""


# ---------------------------------------------------------------------------
# Pydantic
# ---------------------------------------------------------------------------

class ChatWithToolsRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    session_id: Optional[str] = None
    plant_hint_id: Optional[str] = None
    time_hint_days: Optional[int] = None
    debug: bool = False


class ChatWithToolsResponse(BaseModel):
    session_id: str
    reply: str
    plan: Optional[dict[str, Any]] = None
    rows_fetched: int = 0
    took_ms: int = 0
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Planning + execution
# ---------------------------------------------------------------------------

def _inject_hints(
    plan: dict[str, Any],
    plant_hint_id: Optional[str],
    time_hint_days: Optional[int],
) -> dict[str, Any]:
    filters = list(plan.get("filters") or [])

    if plant_hint_id:
        already = any((f.get("column") == "plant_id") for f in filters)
        if not already:
            filters.append({"column": "plant_id", "op": "eq", "value": plant_hint_id})

    if time_hint_days and time_hint_days > 0:
        tcol_map = {
            "well_readings": "reading_datetime",
            "locator_readings": "reading_datetime",
            "ro_train_readings": "reading_datetime",
            "daily_plant_summary": "summary_date",
            "incidents": "occurred_at",
            "checklist_executions": "execution_date",
        }
        table = plan.get("table")
        tcol = tcol_map.get(table)
        if tcol:
            has_time = any(f.get("column") == tcol for f in filters)
            if not has_time:
                since = (datetime.utcnow() - timedelta(days=time_hint_days)).isoformat() + "Z"
                filters.append({"column": tcol, "op": "gte", "value": since})

    plan["filters"] = filters
    return plan


async def chat_with_tools(
    db,
    user_id: Optional[str],
    req: ChatWithToolsRequest,
) -> ChatWithToolsResponse:
    t0 = datetime.utcnow()
    session_id = req.session_id or f"sess_{uuid.uuid4().hex[:12]}"

    # --- Step 1: plan -------------------------------------------------------
    plan_messages = [
        {"role": "system", "content": PLANNER_SYSTEM},
        {"role": "user", "content": req.message},
    ]

    plan_raw = await _chat_complete(plan_messages)

    try:
        plan_obj = _safe_parse_json(plan_raw)
    except json.JSONDecodeError:
        plan_obj = {"plan": None, "reason": "planner returned invalid JSON"}

    plan = plan_obj.get("plan") if isinstance(plan_obj, dict) else None
    fetched: list[dict[str, Any]] = []
    error: Optional[str] = None

    # --- Step 2: execute ----------------------------------------------------
    if plan and isinstance(plan, dict):
        try:
            plan = _inject_hints(plan, req.plant_hint_id, req.time_hint_days)
            table = plan.get("table")
            if not table or table not in READ_WHITELIST:
                raise ValueError(f"Table '{table}' not allowed")
            fetched = safe_select(
                table=table,
                select=plan.get("select"),
                filters=plan.get("filters"),
                order_by=plan.get("order_by"),
                desc=bool(plan.get("desc")),
                limit=int(plan.get("limit") or 100),
            )
        except Exception as e:
            error = f"Data fetch failed: {e}"
            log.warning("safe_select failed: %s", e)

    # --- Step 3: answer -----------------------------------------------------
    answer_payload: dict[str, Any] = {
        "question": req.message,
        "data_available": bool(fetched) and not error,
        "row_count": len(fetched),
        "sample_rows": fetched[:100],
    }
    if error:
        answer_payload["error"] = error

    answer_messages = [
        {"role": "system", "content": ANSWER_SYSTEM},
        {
            "role": "user",
            "content": (
                "QUESTION: " + req.message +
                "\n\nDATA: " + json.dumps(answer_payload, default=str)[:12000]
            ),
        },
    ]

    try:
        reply_text = await _chat_complete(answer_messages)
    except Exception as e:
        log.exception("answerer failed")
        reply_text = f"⚠ Could not produce an answer: {e}"

    # Persist to Mongo
    now = datetime.utcnow()
    try:
        await db.ai_conversations.update_one(
            {"session_id": session_id},
            {
                "$setOnInsert": {
                    "_id": str(uuid.uuid4()),
                    "user_id": user_id,
                    "session_id": session_id,
                    "created_at": now,
                    "mode": "tools",
                },
                "$set": {"updated_at": datetime.utcnow()},
                "$push": {
                    "messages": {
                        "$each": [
                            {"role": "user", "content": req.message, "created_at": now},
                            {"role": "assistant", "content": reply_text,
                             "created_at": datetime.utcnow(),
                             "meta": {"plan": plan, "rows": len(fetched), "error": error}},
                        ]
                    }
                },
            },
            upsert=True,
        )
    except Exception:
        log.exception("Mongo persist failed (non-fatal)")

    took_ms = int((datetime.utcnow() - t0).total_seconds() * 1000)

    return ChatWithToolsResponse(
        session_id=session_id,
        reply=reply_text,
        plan=plan,
        rows_fetched=len(fetched),
        took_ms=took_ms,
        error=error,
    )
