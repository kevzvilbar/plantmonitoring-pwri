from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter, UploadFile, File, HTTPException, Header
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging

try:
    from mongomock_motor import AsyncMongoMockClient  # type: ignore
except ImportError:  # pragma: no cover
    AsyncMongoMockClient = None  # type: ignore
from pathlib import Path
from pydantic import BaseModel, Field
from typing import Any, List, Optional
import uuid
from datetime import datetime

from import_parser import parse_xlsx
from ai_service import (
    ChatRequest, AnomalyRequest,
    chat_turn, list_sessions, get_session, detect_anomalies,
)
from ai_tools import ChatWithToolsRequest, chat_with_tools
from compliance_service import (
    Thresholds, ViolationsPayload, EvaluateResult,
    PmForecastRequest,
    get_thresholds, save_thresholds, evaluate, make_summary, forecast_pm,
)
from seed_service import seed_from_urls
from cron_service import (
    verify_secret, run_compliance_evaluate, run_pm_forecast_sweep,
)
from admin_service import (
    soft_delete_user, hard_delete_user,
    soft_delete_plant, hard_delete_plant,
    get_user_dependencies, get_plant_dependencies,
    list_audit_log, cleanup_plants,
)
from ai_import_service import (
    analyze_upload as ai_analyze_upload,
    sync_analysis as ai_sync_analysis,
    list_analyses as ai_list_analyses,
    MAX_FILE_BYTES as AI_MAX_FILE_BYTES,
)


class DeletionRequest(BaseModel):
    reason: Optional[str] = None


class HardDeleteRequest(BaseModel):
    reason: Optional[str] = None
    force: bool = False
    archive: bool = False


class CleanupPlantsRequest(BaseModel):
    names: List[str] = Field(..., min_length=1, max_length=50)
    reason: str = Field(..., min_length=5, max_length=500)


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection — falls back to an in-memory mongomock client when no
# MONGO_URL is configured (e.g. local Replit dev). This keeps the FastAPI
# backend startable so that Supabase-only endpoints (admin, compliance
# evaluate, etc.) work, while Mongo-backed features (compliance thresholds
# storage, AI session history, downtime events) operate against the in-memory
# store and reset on restart.
mongo_url = os.environ.get('MONGO_URL')
if mongo_url:
    client = AsyncIOMotorClient(mongo_url)
    db = client[os.environ.get('DB_NAME', 'pwri')]
elif AsyncMongoMockClient is not None:
    logging.getLogger(__name__).warning(
        "MONGO_URL not set — using in-memory mongomock store. "
        "Mongo-backed data will not persist across restarts."
    )
    client = AsyncMongoMockClient()
    db = client[os.environ.get('DB_NAME', 'pwri')]
else:
    raise RuntimeError(
        "MONGO_URL is not set and mongomock_motor is not installed. "
        "Install mongomock_motor or configure MONGO_URL."
    )

# Lifespan: open asyncpg pool on startup, close both pools on shutdown
@asynccontextmanager
async def lifespan(app: FastAPI):
    import db as pg_db
    await pg_db.get_pool()          # warm up the Render PG connection pool
    yield
    client.close()                  # MongoDB
    await pg_db.close_pool()        # Render PostgreSQL

# Create the main app without a prefix
app = FastAPI(lifespan=lifespan)

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# Define Models
class StatusCheck(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class StatusCheckCreate(BaseModel):
    client_name: str


# --- Routes ----------------------------------------------------------------

@api_router.get("/")
async def root():
    return {"message": "Hello World"}


@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.dict()
    status_obj = StatusCheck(**status_dict)
    _ = await db.status_checks.insert_one(status_obj.dict())
    return status_obj


@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    status_checks = await db.status_checks.find().to_list(1000)
    return [StatusCheck(**status_check) for status_check in status_checks]


# ---- XLSX import ---------------------------------------------------------

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB


@api_router.post("/import/parse-wellmeter")
async def parse_wellmeter(file: UploadFile = File(...)):
    """
    Accept an uploaded XLSX file with well/meter readings.
    Returns a structured preview with detected statuses and flags.
    Does NOT persist anything — the frontend commits rows into Supabase.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing file")
    fname = file.filename.lower()
    if not (fname.endswith(".xlsx") or fname.endswith(".xlsm")):
        raise HTTPException(status_code=400, detail="Only .xlsx / .xlsm supported")

    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="File too large (>10MB)")

    try:
        result = parse_xlsx(data)
    except Exception as e:  # noqa: BLE001
        logging.exception("parse_xlsx failed")
        raise HTTPException(status_code=400, detail=f"Failed to parse: {e}")

    return JSONResponse(result)


# ---- AI assistant --------------------------------------------------------

@api_router.post("/ai/chat")
async def ai_chat(req: ChatRequest, x_user_id: Optional[str] = Header(None)):
    try:
        resp = await chat_turn(db, x_user_id, req)
        return resp
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # noqa: BLE001
        logging.exception("ai_chat failed")
        raise HTTPException(status_code=500, detail=f"Unexpected: {e}")


@api_router.get("/ai/sessions")
async def ai_list_sessions(
    x_user_id: Optional[str] = Header(None),
    limit: int = 20,
):
    return await list_sessions(db, x_user_id, limit=max(1, min(limit, 100)))


@api_router.get("/ai/sessions/{session_id}")
async def ai_get_session(session_id: str):
    return await get_session(db, session_id)


@api_router.delete("/ai/sessions/{session_id}")
async def ai_delete_session(session_id: str):
    await db.ai_conversations.delete_one({"session_id": session_id})
    return {"ok": True, "session_id": session_id}


@api_router.post("/ai/anomalies")
async def ai_anomalies(req: AnomalyRequest):
    try:
        return await detect_anomalies(req)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # noqa: BLE001
        logging.exception("ai_anomalies failed")
        raise HTTPException(status_code=500, detail=f"Unexpected: {e}")


@api_router.post("/ai/chat-tools")
async def ai_chat_tools(req: ChatWithToolsRequest, x_user_id: Optional[str] = Header(None)):
    """AI chat that can query Supabase via a constrained planner."""
    try:
        return await chat_with_tools(db, x_user_id, req)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # noqa: BLE001
        logging.exception("ai_chat_tools failed")
        raise HTTPException(status_code=500, detail=f"Unexpected: {e}")


@api_router.get("/ai/health")
async def ai_health():
    """Quick probe to verify EMERGENT_LLM_KEY is configured."""
    key_set = bool(os.environ.get("EMERGENT_LLM_KEY"))
    return {"ok": key_set, "model": "gpt-5.1", "provider": "openai"}


# ---- Compliance ----------------------------------------------------------

@api_router.get("/compliance/thresholds")
async def get_compliance_thresholds(scope: str = "global"):
    t = await get_thresholds(db, scope)
    return {"scope": scope, "thresholds": t.dict()}


@api_router.put("/compliance/thresholds")
async def put_compliance_thresholds(body: dict):
    scope = str(body.get("scope") or "global")
    raw = body.get("thresholds") or {}
    try:
        t = Thresholds(**raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid thresholds: {e}")
    doc = await save_thresholds(db, scope, t)
    return {"scope": doc.scope, "thresholds": doc.thresholds.dict(),
            "updated_at": doc.updated_at.isoformat()}


@api_router.post("/compliance/evaluate")
async def compliance_evaluate(body: ViolationsPayload, summarize: bool = False):
    scope = body.plant_id or "global"
    t = await get_thresholds(db, scope)
    violations = evaluate(t, body.metrics)
    result: dict[str, Any] = {
        "scope": scope,
        "scope_label": body.scope_label,
        "evaluated_at": datetime.utcnow().isoformat(),
        "violations": [v.dict() for v in violations],
        "thresholds": t.dict(),
    }
    if summarize:
        try:
            result["summary"] = await make_summary(
                violations, body.metrics, body.scope_label or scope,
            )
        except Exception as e:  # noqa: BLE001
            logging.exception("compliance summary failed")
            result["summary_error"] = str(e)
    return result


# ---- Predictive PM -------------------------------------------------------

@api_router.post("/ai/pm-forecast")
async def ai_pm_forecast(req: PmForecastRequest):
    try:
        resp = await forecast_pm(req)
        return resp
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # noqa: BLE001
        logging.exception("pm_forecast failed")
        raise HTTPException(status_code=500, detail=f"Unexpected: {e}")


# ---- XLSX seeding (bulk ingest from URLs) --------------------------------

class SeedTarget(BaseModel):
    plant_name: str
    url: str
    source: str = "auto"  # 'auto' | 'meter' | 'downtime'


class SeedRequest(BaseModel):
    targets: List[SeedTarget]
    include_defective: bool = False
    downtime_as_zero: bool = True


@api_router.post("/import/seed-from-url")
async def import_seed_from_url(
    body: SeedRequest,
    authorization: Optional[str] = Header(None),
):
    """Download one or more XLSX files from public URLs and upsert them
    into Supabase + Mongo. Pass the user's Supabase JWT via the
    `Authorization: Bearer <jwt>` header so RLS policies apply under
    their identity.
    """
    if not body.targets:
        raise HTTPException(status_code=400, detail="No targets supplied")
    token: Optional[str] = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip() or None
    try:
        report = await seed_from_urls(
            db,
            [t.dict() for t in body.targets],
            include_defective=body.include_defective,
            downtime_as_zero=body.downtime_as_zero,
            access_token=token,
        )
        return report
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:  # noqa: BLE001
        logging.exception("seed_from_urls failed")
        raise HTTPException(status_code=500, detail=f"Seed failed: {e}")


# ---- Downtime events (dashboard list) ------------------------------------

@api_router.get("/downtime/events")
async def downtime_events(
    plant_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = 500,
):
    q: dict[str, Any] = {}
    if plant_id:
        q["plant_id"] = plant_id
    if date_from or date_to:
        r: dict[str, Any] = {}
        if date_from:
            r["$gte"] = date_from
        if date_to:
            r["$lte"] = date_to
        q["event_date"] = r
    cursor = (db.downtime_events.find(q, {"_id": 0})
              .sort("event_date", -1)
              .limit(max(1, min(limit, 2000))))
    docs: list[dict[str, Any]] = [d async for d in cursor]
    # summary
    total_hours = sum(float(d.get("duration_hrs") or 0) for d in docs)
    by_sub: dict[str, float] = {}
    for d in docs:
        sub = d.get("subsystem") or "Plant"
        by_sub[sub] = by_sub.get(sub, 0.0) + float(d.get("duration_hrs") or 0)
    return {
        "count": len(docs),
        "total_duration_hrs": round(total_hours, 2),
        "by_subsystem": [{"subsystem": k, "hours": round(v, 2)} for k, v in
                          sorted(by_sub.items(), key=lambda x: -x[1])],
        "events": docs,
    }


# ---- Blending wells (Mongo-backed: no Supabase schema change needed) -----

class BlendingToggleRequest(BaseModel):
    well_id: str
    plant_id: str
    is_blending: bool
    well_name: Optional[str] = None
    plant_name: Optional[str] = None
    note: Optional[str] = None


@api_router.get("/blending/wells")
async def blending_wells_list(plant_id: Optional[str] = None):
    q: dict[str, Any] = {}
    if plant_id:
        q["plant_id"] = plant_id
    cursor = db.blending_wells.find(q, {"_id": 0}).sort("tagged_at", -1)
    return {"wells": [d async for d in cursor]}


@api_router.post("/blending/toggle")
async def blending_toggle(body: BlendingToggleRequest,
                          x_user_id: Optional[str] = Header(None)):
    now = datetime.utcnow()
    if body.is_blending:
        doc = {
            "well_id": body.well_id,
            "plant_id": body.plant_id,
            "well_name": body.well_name or "",
            "plant_name": body.plant_name or "",
            "tagged_by": x_user_id,
            "tagged_at": now,
            "note": body.note or "",
        }
        await db.blending_wells.update_one(
            {"well_id": body.well_id},
            {"$set": doc}, upsert=True,
        )
        return {"ok": True, "is_blending": True, "well_id": body.well_id}
    await db.blending_wells.delete_one({"well_id": body.well_id})
    return {"ok": True, "is_blending": False, "well_id": body.well_id}


class BlendingAuditRequest(BaseModel):
    plant_id: str
    well_id: str
    well_name: Optional[str] = None
    plant_name: Optional[str] = None
    event_date: str
    volume_m3: float


@api_router.post("/blending/audit")
async def blending_log_event(body: BlendingAuditRequest):
    """Record a blending event (used when a blending well's volume > 0)."""
    doc = {
        "plant_id": body.plant_id,
        "well_id": body.well_id,
        "well_name": body.well_name or "",
        "plant_name": body.plant_name or "",
        "event_date": body.event_date,
        "volume_m3": body.volume_m3,
        "noted_at": datetime.utcnow(),
    }
    await db.blending_events.insert_one(doc)
    return {"ok": True}


@api_router.get("/blending/volume")
async def blending_volume(plant_ids: Optional[str] = None,
                          days: int = 14):
    """Daily blending-injection volume (m³) totals for the given plants.

    Used by the Plant Dashboard "Blending volume" card to show how much
    product-line water originates from blending wells (vs. RO product).
    `plant_ids` is a comma-separated list; omitted = all plants.
    """
    from datetime import timedelta
    span = max(1, min(int(days or 14), 180))
    since_date = (datetime.utcnow() - timedelta(days=span - 1)).date().isoformat()
    today = datetime.utcnow().date().isoformat()
    q: dict[str, Any] = {"event_date": {"$gte": since_date, "$lte": today}}
    if plant_ids:
        ids = [p for p in (s.strip() for s in plant_ids.split(",")) if p]
        if ids:
            q["plant_id"] = {"$in": ids}

    by_day: dict[str, float] = {}
    by_well: dict[str, dict[str, Any]] = {}
    total = 0.0
    today_total = 0.0

    async for ev in db.blending_events.find(q, {"_id": 0}):
        day = str(ev.get("event_date", ""))[:10]
        vol = float(ev.get("volume_m3") or 0)
        by_day[day] = by_day.get(day, 0.0) + vol
        wid = ev.get("well_id") or ""
        if wid:
            cur = by_well.setdefault(wid, {
                "well_id": wid,
                "well_name": ev.get("well_name") or "",
                "plant_id": ev.get("plant_id"),
                "plant_name": ev.get("plant_name") or "",
                "volume_m3": 0.0,
                "today_volume_m3": 0.0,
                "previous_volume_m3": None,
                "previous_event_date": None,
            })
            cur["volume_m3"] += vol
            if day == today:
                cur["today_volume_m3"] += vol
            # Track the most recent prior (non-today) entry for this well.
            elif day and day < today:
                prev_d = cur.get("previous_event_date")
                if prev_d is None or day > prev_d:
                    cur["previous_event_date"] = day
                    cur["previous_volume_m3"] = vol
        total += vol
        if day == today:
            today_total += vol

    # Build a continuous daily series so the chart never has gaps.
    series: list[dict[str, Any]] = []
    base = datetime.utcnow().date()
    for i in range(span - 1, -1, -1):
        d = (base - timedelta(days=i)).isoformat()
        series.append({"date": d, "volume_m3": round(by_day.get(d, 0.0), 2)})

    by_well_list = sorted(
        by_well.values(),
        key=lambda x: x["volume_m3"],
        reverse=True,
    )
    for w in by_well_list:
        w["volume_m3"] = round(float(w["volume_m3"]), 2)
        w["today_volume_m3"] = round(float(w.get("today_volume_m3") or 0.0), 2)
        if w.get("previous_volume_m3") is not None:
            w["previous_volume_m3"] = round(float(w["previous_volume_m3"]), 2)

    return {
        "days": span,
        "total_m3": round(total, 2),
        "today_m3": round(today_total, 2),
        "series": series,
        "by_well": by_well_list,
    }


# ---- Unified alerts feed -------------------------------------------------

@api_router.get("/alerts/feed")
async def alerts_feed(plant_id: Optional[str] = None,
                       days: int = 7):
    """Combined alerts from downtime, blending, and compliance snapshots."""
    from datetime import timedelta
    since = (datetime.utcnow() - timedelta(days=max(1, days))).date().isoformat()
    today = datetime.utcnow().date().isoformat()
    q_plant = {"plant_id": plant_id} if plant_id else {}

    alerts: list[dict[str, Any]] = []

    # Downtime alerts — prolonged (≥12h) or frequent (>3 events/day)
    dt_q = {**q_plant, "event_date": {"$gte": since, "$lte": today}}
    dt_cursor = db.downtime_events.find(dt_q, {"_id": 0})
    events_by_day: dict[str, list[dict[str, Any]]] = {}
    async for d in dt_cursor:
        key = str(d.get("event_date", ""))[:10]
        events_by_day.setdefault(key, []).append(d)
    for day, evs in events_by_day.items():
        total = sum(float(e.get("duration_hrs") or 0) for e in evs)
        long_ones = [e for e in evs if float(e.get("duration_hrs") or 0) >= 12]
        if long_ones:
            alerts.append({
                "kind": "downtime",
                "severity": "high",
                "date": day,
                "plant_id": long_ones[0].get("plant_id"),
                "plant_name": long_ones[0].get("plant_name"),
                "title": f"Prolonged shutdown · {long_ones[0].get('subsystem')}",
                "detail": f"{long_ones[0].get('duration_hrs')}h — {long_ones[0].get('cause') or long_ones[0].get('raw_text','')[:80]}",
                "count": len(long_ones),
            })
        elif len(evs) >= 3 and total >= 6:
            alerts.append({
                "kind": "downtime",
                "severity": "medium",
                "date": day,
                "plant_id": evs[0].get("plant_id"),
                "plant_name": evs[0].get("plant_name"),
                "title": f"Abnormal downtime pattern · {len(evs)} events / {total:.1f}h",
                "detail": "Multiple short shutdowns in one day.",
                "count": len(evs),
            })

    # Blending events (volume injected from tagged wells)
    be_q = {**q_plant, "event_date": {"$gte": since}}
    be_cursor = db.blending_events.find(be_q, {"_id": 0}).sort("event_date", -1).limit(50)
    async for d in be_cursor:
        alerts.append({
            "kind": "blending",
            "severity": "info",
            "date": str(d.get("event_date", ""))[:10],
            "plant_id": d.get("plant_id"),
            "plant_name": d.get("plant_name"),
            "title": f"Blending · {d.get('well_name')}",
            "detail": f"Injected {d.get('volume_m3')} m³ Directly Into Product Water (Audit).",
        })

    # Recovery deviations from latest compliance snapshots
    snap_q = {**q_plant}
    snap_cursor = (db.compliance_snapshots.find(snap_q, {"_id": 0})
                   .sort("evaluated_at", -1).limit(20))
    seen_plants: set[str] = set()
    async for s in snap_cursor:
        pid = s.get("plant_id")
        if pid in seen_plants:
            continue
        seen_plants.add(pid)
        for v in s.get("violations", []):
            if v.get("code") == "recovery_pct_under":
                alerts.append({
                    "kind": "recovery",
                    "severity": v.get("severity", "medium"),
                    "date": str(s.get("summary_date", ""))[:10],
                    "plant_id": pid,
                    "plant_name": s.get("plant_name"),
                    "title": "Recovery below threshold",
                    "detail": f"Recovery {v.get('value')}% vs. min {v.get('limit')}%",
                })
                break

    # Sort: high > medium > low/info, then recent first
    sev_rank = {"high": 0, "medium": 1, "low": 2, "info": 3}
    alerts.sort(key=lambda a: (sev_rank.get(a.get("severity", "info"), 9),
                                -int(str(a.get("date", "")).replace("-", "") or 0)))
    capped = alerts[:80]
    return {"count": len(capped), "alerts": capped}


# ---- Admin: user & plant deletion (RBAC + dependency checks) ------------

@api_router.get("/admin/users/{user_id}/dependencies")
async def admin_user_dependencies(user_id: str,
                                   authorization: Optional[str] = Header(None)):
    return get_user_dependencies(authorization, user_id)


@api_router.post("/admin/users/{user_id}/soft-delete")
async def admin_user_soft_delete(user_id: str,
                                  body: Optional[DeletionRequest] = None,
                                  authorization: Optional[str] = Header(None)):
    return soft_delete_user(authorization, user_id,
                             reason=(body.reason if body else None))


@api_router.post("/admin/users/{user_id}/hard-delete")
async def admin_user_hard_delete(user_id: str,
                                  body: Optional[HardDeleteRequest] = None,
                                  authorization: Optional[str] = Header(None)):
    reason = body.reason if body else None
    force = body.force if body else False
    return hard_delete_user(authorization, user_id, reason=reason, force=force)


@api_router.get("/admin/plants/{plant_id}/dependencies")
async def admin_plant_dependencies(plant_id: str,
                                    authorization: Optional[str] = Header(None)):
    return get_plant_dependencies(authorization, plant_id)


@api_router.post("/admin/plants/{plant_id}/soft-delete")
async def admin_plant_soft_delete(plant_id: str,
                                   body: Optional[DeletionRequest] = None,
                                   authorization: Optional[str] = Header(None)):
    return soft_delete_plant(authorization, plant_id,
                              reason=(body.reason if body else None))


@api_router.post("/admin/plants/{plant_id}/hard-delete")
async def admin_plant_hard_delete(plant_id: str,
                                   body: Optional[HardDeleteRequest] = None,
                                   authorization: Optional[str] = Header(None)):
    reason = body.reason if body else None
    force = body.force if body else False
    archive = body.archive if body else False
    return hard_delete_plant(
        authorization, plant_id, reason=reason, force=force, archive=archive,
    )


@api_router.post("/import/ai-analyze")
async def import_ai_analyze(file: UploadFile = File(...),
                             plant_id: Optional[str] = None,
                             authorization: Optional[str] = Header(None)):
    """AI Universal Import — analyse a file and propose per-table mappings.
    Persists the analysis row but does NOT mutate any business tables yet.
    The Admin must POST /api/import/ai-sync/{analysis_id} to commit.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing file")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > AI_MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (limit 25 MiB)")
    return ai_analyze_upload(authorization, file, data, plant_id)


@api_router.post("/import/ai-sync/{analysis_id}")
async def import_ai_sync(analysis_id: str,
                          body: dict,
                          authorization: Optional[str] = Header(None)):
    """Commit admin-approved decisions from a prior /import/ai-analyze run.
    Body: { reason, plant_id, decisions: [{source, action, target, entity_name, column_mapping}] }.
    Writes one [IMPORT] / [IMPORT-REJECT] audit row per decision.
    """
    return ai_sync_analysis(authorization, analysis_id, body)


@api_router.get("/import/ai-analyses")
async def import_ai_list(limit: int = 25,
                          authorization: Optional[str] = Header(None)):
    return ai_list_analyses(authorization, limit=limit)


@api_router.post("/admin/plants/cleanup")
async def admin_plants_cleanup(body: CleanupPlantsRequest,
                                authorization: Optional[str] = Header(None)):
    """Admin-only one-click bulk hard-delete of imported-by-mistake plants.

    Accepts a list of plant names + a reason (min 5 chars). For each
    matched plant: writes a `[CLEANUP]`-prefixed audit row, clears all
    no-cascade dependent rows (well_*/locator_*/incidents/etc.), strips
    plant id from user_profiles.plant_assignments arrays, and finally
    drops the plant row.
    """
    return cleanup_plants(authorization, names=body.names, reason=body.reason)


@api_router.get("/admin/audit-log")
async def admin_audit_log(kind: Optional[str] = None,
                           limit: int = 100,
                           authorization: Optional[str] = Header(None)):
    return list_audit_log(authorization, kind=kind, limit=limit)


@api_router.get("/admin/migrations/status")
async def admin_migrations_status(authorization: Optional[str] = Header(None)):
    """Admin-only. Scan supabase/migrations/*.sql, probe the live Supabase
    schema for each declared table/column, and return per-file status
    (applied / pending / partial). The response includes the SQL body so the
    frontend can offer a one-click copy → paste-into-Supabase flow.
    """
    from migrations_status import list_migration_status
    return list_migration_status(authorization)


class MigrationMarkRequest(BaseModel):
    note: Optional[str] = None


@api_router.post("/admin/migrations/{filename}/mark-applied")
async def admin_migrations_mark_applied(
    filename: str,
    body: Optional[MigrationMarkRequest] = None,
    authorization: Optional[str] = Header(None),
):
    """Admin-only. Mark a migration as applied even when the schema probe
    can't confirm it (RPC-only files, one-shot UPDATEs, pure DML cleanups).
    The override is recorded with the actor + timestamp + optional note in a
    local JSON store so non-applied status can be cleared without altering
    the audit_log schema.
    """
    from migrations_status import mark_migration_applied
    return mark_migration_applied(authorization, filename,
                                   note=(body.note if body else None))


@api_router.delete("/admin/migrations/{filename}/mark-applied")
async def admin_migrations_unmark_applied(
    filename: str,
    authorization: Optional[str] = Header(None),
):
    """Admin-only. Clear a previous mark for the given migration filename."""
    from migrations_status import unmark_migration_applied
    return unmark_migration_applied(authorization, filename)


class MigrationHistoryImportRequest(BaseModel):
    history: dict[str, dict[str, Any]]
    mode: Optional[str] = "fill_gaps"


@api_router.post("/admin/migrations/apply-history/import")
async def admin_migrations_import_history(
    body: MigrationHistoryImportRequest,
    authorization: Optional[str] = Header(None),
):
    """Admin-only. Merge an exported apply-history JSON into the local store.
    Default mode is non-destructive (fill_gaps): local entries always win on
    conflict. Pass mode='overwrite' only when the import is more authoritative.
    """
    from migrations_status import import_apply_history
    return import_apply_history(
        authorization,
        body.model_dump(exclude_none=True),
        mode=body.mode or "fill_gaps",
    )


# ---- Serverless-friendly cron endpoints ----------------------------------
@api_router.post("/cron/compliance-evaluate")
async def cron_compliance_evaluate(x_cron_secret: Optional[str] = Header(None)):
    verify_secret(x_cron_secret)
    try:
        return await run_compliance_evaluate(db)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logging.exception("cron compliance failed")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/cron/pm-forecast-sweep")
async def cron_pm_forecast_sweep(x_cron_secret: Optional[str] = Header(None)):
    verify_secret(x_cron_secret)
    try:
        return await run_pm_forecast_sweep(db)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logging.exception("cron pm sweep failed")
        raise HTTPException(status_code=500, detail=str(e))

# ── Operator Switch Audit Log ──────────────────────────────────────────────
# Append this block anywhere below the existing api_router definitions in
# server.py (e.g. just before the final `app.include_router(api_router)` call).


class OperatorSwitchLogRequest(BaseModel):
    plant_id: str
    from_username: str
    to_username: str
    device_id: str


@api_router.post("/operator/switch-log")
async def operator_switch_log(
    body: OperatorSwitchLogRequest,
    authorization: Optional[str] = Header(None),
):
    """
    Record every Operator Switch event for accountability.

    Stored fields
    -------------
    plant_id       – Plant where the switch occurred.
    from_username  – Username of the session that initiated the switch.
    to_username    – Username that will record subsequent events.
    timestamp      – Server-side UTC timestamp (authoritative, not client-supplied).
    device_id      – Stable device fingerprint generated in the browser.

    Access
    ------
    Caller must supply a valid Supabase JWT in the Authorization header.
    The endpoint does NOT enforce Designation server-side because the frontend
    RBAC gate already prevents non-Operators from reaching this call; the stored
    record is append-only and never modified or deleted.
    """
    # Validate the caller's JWT so anonymous callers cannot flood the log.
    if not authorization or not authorization.startswith("Bearer "):
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization.removeprefix("Bearer ").strip()
    # Verify with Supabase (raises on invalid/expired token)
    user_resp = supa.auth.get_user(token)
    caller_id = user_resp.user.id if user_resp and user_resp.user else None
    if not caller_id:
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Token validation failed")

    doc = {
        "plant_id":      body.plant_id,
        "from_username": body.from_username,
        "to_username":   body.to_username,
        "timestamp":     datetime.utcnow(),
        "device_id":     body.device_id,
        # Extra: store the auth-user id of whoever was logged in (immutable audit trail)
        "session_user_id": caller_id,
    }
    await db.operator_switch_log.insert_one(doc)
    return {"ok": True}


# ── Admin User Creation ────────────────────────────────────────────────────────
# Append this block anywhere above `app.include_router(api_router)` in server.py.
#
# FIX: The previous patch called `svc.auth.admin.create_user()` but in
# gotrue>=2.4 (used by supabase==2.15.0), the sync Client's `.auth` property
# is a SyncGoTrueClient which has NO `.admin` attribute. That caused an
# AttributeError which surfaced as a blank error on the frontend.
#
# The correct approach is to instantiate SyncGoTrueAdminAPI directly using
# the service-role key. It accepts the project URL + service-role JWT in its
# headers — exactly how the Supabase Admin REST API is authenticated.


class AdminCreateUserRequest(BaseModel):
    email: str
    password: str
    username: str
    first_name: str
    last_name: str
    middle_name: Optional[str] = None
    suffix: Optional[str] = None
    designation: Optional[str] = None


def _make_admin_api():
    """
    Build a SyncGoTrueAdminAPI instance authenticated with the service-role key.

    SyncGoTrueAdminAPI is a SEPARATE class from the regular supabase Client —
    it is NOT accessible via `client.auth.admin` in gotrue>=2.4.
    It must be instantiated directly with the project URL and service-role JWT
    passed as an Authorization header.
    """
    url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not service_key:
        raise HTTPException(
            status_code=500,
            detail="SUPABASE_SERVICE_ROLE_KEY is not configured on the server.",
        )
    from gotrue import SyncGoTrueAdminAPI
    admin_url = f"{url.rstrip('/')}/auth/v1"
    return SyncGoTrueAdminAPI(
        url=admin_url,
        headers={"Authorization": f"Bearer {service_key}"},
    )


@api_router.post("/admin/users/create")
async def admin_create_user(
    body: AdminCreateUserRequest,
    authorization: Optional[str] = Header(None),
):
    """
    Admin-only. Create a new auth user + profile via the Supabase Admin API.

    Why not supabase.auth.signUp() on the frontend?
    ------------------------------------------------
    signUp() is the public self-registration endpoint. When the email already
    exists it either silently returns the existing user (confirmation OFF) or
    sends a confirmation email and returns an obfuscated fake response
    (confirmation ON). Either way the new account never appears in the pending
    queue and no real error is shown to the Admin.

    This endpoint uses SyncGoTrueAdminAPI (service-role) which:
      - Does NOT send a confirmation email (email_confirm=True skips it).
      - Returns a real error when the email already exists.
      - Creates the profile immediately with profile_complete=True.
      - Places the account in status='Pending' for Admin approval.
    """
    token = bearer_token(authorization)
    caller = caller_identity(token)
    require_roles(caller, {"Admin"})

    # ── 1. Create the auth.users row via Admin API ───────────────────────────
    try:
        from gotrue.types import AdminUserAttributes
        admin_api = _make_admin_api()
        auth_resp = admin_api.create_user(
            AdminUserAttributes(
                email=body.email,
                password=body.password,
                email_confirm=True,  # skip confirmation email; Admin vouches for account
            )
        )
    except HTTPException:
        raise
    except Exception as e:
        # Surface the real Supabase error message (e.g. "Email already registered")
        msg = getattr(e, "message", None) or str(e)
        raise HTTPException(status_code=422, detail=msg)

    uid = getattr(auth_resp.user, "id", None) if auth_resp and auth_resp.user else None
    if not uid:
        raise HTTPException(
            status_code=500,
            detail="Admin API returned no user ID. Check your SUPABASE_SERVICE_ROLE_KEY.",
        )

    # ── 2. Fill in the user_profiles row ─────────────────────────────────────
    # A DB trigger on auth.users INSERT creates the profile row automatically.
    # We update it with the form fields.
    svc = service_role_client()
    profile_data = {
        "username":         body.username,
        "first_name":       body.first_name,
        "middle_name":      body.middle_name or None,
        "last_name":        body.last_name,
        "suffix":           body.suffix or None,
        "designation":      body.designation or None,
        "profile_complete": True,
        # status stays 'Pending' — Admin must click Approve to activate.
    }

    try:
        res = svc.table("user_profiles").update(profile_data).eq("id", uid).execute()
    except Exception as e:
        log.exception("admin_create_user: profile update failed for uid=%s", uid)
        raise HTTPException(
            status_code=500,
            detail=f"Auth user created (uid={uid}) but profile update failed: {e}",
        )

    # If the trigger hasn't fired yet (some Supabase plans), fall back to upsert
    if not (res.data or []):
        try:
            svc.table("user_profiles").upsert({
                "id":               uid,
                "status":           "Pending",
                "plant_assignments": [],
                **profile_data,
            }).execute()
        except Exception as e:
            log.exception("admin_create_user: profile upsert fallback failed for uid=%s", uid)
            raise HTTPException(
                status_code=500,
                detail=f"Profile upsert fallback failed: {e}",
            )

    # ── 3. Assign default Operator role ──────────────────────────────────────
    try:
        svc.table("user_roles").upsert({"user_id": uid, "role": "Operator"}).execute()
    except Exception as e:
        log.warning("admin_create_user: role assignment failed for uid=%s: %s", uid, e)
        # Non-fatal — Admin can assign role manually in UsersPanel.

    log.info(
        "admin_create_user: uid=%s username=%s created by %s",
        uid, body.username, caller.get("label"),
    )
    return {
        "ok":       True,
        "user_id":  uid,
        "email":    body.email,
        "username": body.username,
    }


# Include the router in the main app
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', 'http://localhost:5000,http://127.0.0.1:5000').split(','),
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["*"],
)

app.include_router(api_router)

# Render PostgreSQL — auth, RPC, and generic CRUD routers
from auth_router import router as auth_router_pg, rpc_router
from crud_router import router as crud_router
app.include_router(auth_router_pg)
app.include_router(rpc_router)
app.include_router(crud_router)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


