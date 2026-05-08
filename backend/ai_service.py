"""
AI service for the PWRI monitoring app.

Provides:
  - /api/ai/chat      : multi-turn conversational Q&A (message history persisted in Mongo)
  - /api/ai/anomalies : stateless batch anomaly detection on a list of readings

Uses EMERGENT_LLM_KEY via the `emergentintegrations` library.
Default model: gpt-5.1 (openai).
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime
from typing import Any, Optional

try:
    from emergentintegrations.llm.chat import LlmChat, UserMessage
except ImportError:  # pragma: no cover - optional dep, AI endpoints disabled when missing
    LlmChat = None  # type: ignore
    class UserMessage:  # type: ignore
        def __init__(self, text: str) -> None:
            self.text = text
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

DEFAULT_PROVIDER = "openai"
DEFAULT_MODEL = "gpt-5.1"

# --- System prompts -------------------------------------------------------

CHAT_SYSTEM = """You are the on-duty AI analyst for a water-treatment operations system (PWRI).

You help operators understand well/plant readings, meter statuses, NRW, downtime and
chemical consumption. You speak concisely, use plain language, and always ground answers
in the data snippets you are given.

When you receive a message that includes a JSON block prefixed with "DATA:", treat it as
ground truth for that turn and cite specific numbers. If a question cannot be answered from
the data provided, say so briefly and suggest what data would be needed.

Formatting rules:
 - Keep answers under ~150 words unless explicitly asked for more.
 - Use short bullet points for multi-fact answers.
 - When listing dates, always YYYY-MM-DD.
 - Never invent plant or well names that aren't in the data.
"""

ANOMALY_SYSTEM = """You are an anomaly-detection reviewer for water-plant meter readings.

You will be given a JSON list of daily readings for one or more wells. For each clearly
abnormal point (spike, drop, frozen value, repeated 'defective meter', 'shutoff'
cluster, Final<Initial, etc.), output a single entry.

Return STRICT JSON only, matching this schema:

{
  "anomalies": [
    {
      "well": "string",
      "date": "YYYY-MM-DD",
      "type": "spike|drop|frozen|defective_cluster|downtime_cluster|inconsistent|baseline_shift|other",
      "severity": "low|medium|high",
      "value": number | null,
      "baseline": number | null,
      "message": "one-sentence human description",
      "suggested_action": "one-sentence actionable recommendation"
    }
  ],
  "summary": "one-sentence overall assessment"
}

If nothing looks anomalous, return {"anomalies": [], "summary": "No anomalies detected."}.
Do not include any prose outside the JSON.
"""


# --- Pydantic request/response models --------------------------------------

class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    session_id: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    context: Optional[dict[str, Any]] = None


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    created_at: datetime


class AnomalyRequest(BaseModel):
    readings: list[dict[str, Any]] = Field(..., min_items=0, max_items=2000)
    provider: Optional[str] = None
    model: Optional[str] = None


class AnomalyResponse(BaseModel):
    anomalies: list[dict[str, Any]]
    summary: str


# --- Helpers ---------------------------------------------------------------

def _get_key() -> str:
    key = os.environ.get("EMERGENT_LLM_KEY", "")
    if not key:
        raise RuntimeError(
            "EMERGENT_LLM_KEY is not set. Add it to your backend environment variables."
        )
    return key


def _make_chat(
    session_id: str,
    system: str,
    provider: Optional[str] = None,
    model: Optional[str] = None,
) -> LlmChat:
    """Factory for an LlmChat bound to the Emergent universal key."""
    chat = LlmChat(
        api_key=_get_key(),
        session_id=session_id,
        system_message=system,
    )
    chat.with_model(provider or DEFAULT_PROVIDER, model or DEFAULT_MODEL)
    return chat


def _strip_code_fences(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s)
        s = re.sub(r"\n?```$", "", s)
    return s.strip()


def _safe_parse_json(s: str) -> dict[str, Any]:
    s = _strip_code_fences(s)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", s)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
        raise


async def _chat_complete(
    messages: list[dict[str, str]],
    model: Optional[str] = None,
    provider: Optional[str] = None,
) -> str:
    """Single completion given a list of {role, content} messages.

    Strategy: the first system message becomes the LlmChat system prompt.
    Any prior user/assistant messages are folded into a single preamble on
    the current user turn so the model has the full context in one call.
    """
    system_msg = ""
    conv: list[dict[str, str]] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content") or ""
        if role == "system" and not system_msg:
            system_msg = content
        elif role in ("user", "assistant"):
            conv.append({"role": role, "content": content})

    if not conv:
        return ""

    current = conv[-1]["content"]
    history = conv[:-1]
    if history:
        rendered = "\n\n".join(
            f"[{m['role'].upper()}]: {m['content']}" for m in history
        )
        current = f"Conversation so far:\n{rendered}\n\n[CURRENT]: {current}"

    chat = _make_chat(
        session_id=f"oneoff_{uuid.uuid4().hex[:10]}",
        system=system_msg or "You are a helpful assistant.",
        provider=provider,
        model=model,
    )
    reply = await chat.send_message(UserMessage(text=current))
    return str(reply) if reply is not None else ""


# --- Public service methods ------------------------------------------------

async def chat_turn(
    db,
    user_id: Optional[str],
    req: ChatRequest,
) -> ChatResponse:
    """
    Persists the turn in `ai_conversations` (Mongo) and runs the model.
    Loads full message history from Mongo to maintain multi-turn context.
    """
    session_id = req.session_id or f"sess_{uuid.uuid4().hex[:12]}"
    now = datetime.utcnow()

    user_text = req.message
    if req.context:
        try:
            ctx_json = json.dumps(req.context, default=str)[:8000]
            user_text = f"{req.message}\n\nDATA: {ctx_json}"
        except Exception:
            pass

    messages: list[dict[str, str]] = [{"role": "system", "content": CHAT_SYSTEM}]
    try:
        doc = await db.ai_conversations.find_one({"session_id": session_id})
        if doc:
            for m in (doc.get("messages") or []):
                role = m.get("role")
                content = m.get("content")
                if role in ("user", "assistant") and content:
                    messages.append({"role": role, "content": content})
    except Exception:
        log.exception("Failed to load conversation history (non-fatal)")

    messages.append({"role": "user", "content": user_text})

    try:
        reply = await _chat_complete(messages, model=req.model, provider=req.provider)
    except Exception as e:
        log.exception("chat_turn failed")
        raise RuntimeError(f"AI call failed: {e}") from e

    try:
        await db.ai_conversations.update_one(
            {"session_id": session_id},
            {
                "$setOnInsert": {
                    "_id": str(uuid.uuid4()),
                    "user_id": user_id,
                    "session_id": session_id,
                    "created_at": now,
                },
                "$set": {"updated_at": datetime.utcnow()},
                "$push": {
                    "messages": {
                        "$each": [
                            {"role": "user", "content": req.message, "created_at": now},
                            {"role": "assistant", "content": reply,
                             "created_at": datetime.utcnow()},
                        ]
                    }
                },
            },
            upsert=True,
        )
    except Exception:
        log.exception("Mongo persist failed (non-fatal)")

    return ChatResponse(session_id=session_id, reply=reply, created_at=datetime.utcnow())


async def list_sessions(db, user_id: Optional[str], limit: int = 20) -> list[dict[str, Any]]:
    q: dict[str, Any] = {}
    if user_id:
        q["user_id"] = user_id
    cursor = db.ai_conversations.find(
        q,
        {"session_id": 1, "updated_at": 1, "created_at": 1,
         "messages": {"$slice": -1}, "_id": 0},
    ).sort("updated_at", -1).limit(limit)
    out: list[dict[str, Any]] = []
    async for d in cursor:
        last_msg = (d.get("messages") or [{}])[-1].get("content", "")
        out.append({
            "session_id": d["session_id"],
            "updated_at": d.get("updated_at"),
            "preview": (last_msg or "")[:120],
        })
    return out


async def get_session(db, session_id: str) -> dict[str, Any]:
    doc = await db.ai_conversations.find_one({"session_id": session_id}, {"_id": 0})
    if not doc:
        return {"session_id": session_id, "messages": []}
    return {
        "session_id": session_id,
        "messages": [
            {"role": m.get("role"), "content": m.get("content"),
             "created_at": m.get("created_at")}
            for m in (doc.get("messages") or [])
        ],
    }


async def detect_anomalies(req: AnomalyRequest) -> AnomalyResponse:
    payload = req.readings[:1500]
    if not payload:
        return AnomalyResponse(anomalies=[], summary="No readings supplied.")

    slim = []
    for r in payload:
        slim.append({k: r.get(k) for k in
                     ("well", "well_name", "date", "reading_datetime",
                      "initial", "final", "previous_reading", "current_reading",
                      "volume", "daily_volume", "status", "status_raw",
                      "flags", "off_location_flag") if k in r})

    messages = [
        {"role": "system", "content": ANOMALY_SYSTEM},
        {
            "role": "user",
            "content": (
                "Analyze the following readings and return STRICT JSON as specified.\n\n"
                "READINGS:\n" + json.dumps(slim, default=str)
            ),
        },
    ]

    raw = await _chat_complete(messages, model=req.model, provider=req.provider)

    try:
        parsed = _safe_parse_json(raw)
    except json.JSONDecodeError:
        log.warning("Anomaly model returned unparseable JSON: %s", raw[:400])
        return AnomalyResponse(
            anomalies=[],
            summary="Model returned invalid JSON; no anomalies extracted.",
        )

    anomalies = parsed.get("anomalies", [])
    summary = parsed.get("summary", "") or "Analysis complete."
    if not isinstance(anomalies, list):
        anomalies = []
    return AnomalyResponse(anomalies=anomalies[:100], summary=str(summary)[:500])


__all__ = [
    "ChatRequest",
    "ChatResponse",
    "AnomalyRequest",
    "AnomalyResponse",
    "chat_turn",
    "list_sessions",
    "get_session",
    "detect_anomalies",
    "_make_chat",
    "_chat_complete",
    "_safe_parse_json",
    "UserMessage",
]
