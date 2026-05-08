"""
Serverless-friendly cron jobs.

Vercel Cron (https://vercel.com/docs/cron-jobs) hits HTTP endpoints on a
schedule — there is no long-running process. We expose plain async
functions here, which server.py wraps into `POST /api/cron/*` endpoints
(with Mongo `db` injected and secret verification).
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException

from compliance_service import (
    get_thresholds, evaluate, forecast_pm, PmForecastRequest,
)
from supa_client import _client as supa_client

log = logging.getLogger(__name__)


def verify_secret(secret: Optional[str]) -> None:
    want = os.environ.get("CRON_SECRET")
    if not want:
        return  # open in dev
    if secret != want:
        raise HTTPException(status_code=401, detail="Invalid cron secret")


async def run_compliance_evaluate(db) -> dict[str, Any]:
    """Evaluate latest metrics for every plant; snapshot into
    `compliance_snapshots`."""
    sb = supa_client()
    if sb is None:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    plants = sb.table("plants").select("id,name").execute().data or []
    results: list[dict[str, Any]] = []
    for p in plants:
        pid = p["id"]
        rows = (sb.table("daily_plant_summary")
                .select("*").eq("plant_id", pid)
                .order("summary_date", desc=True).limit(1).execute().data or [])
        if not rows:
            continue
        latest = rows[0]
        t = await get_thresholds(db, pid)
        metrics = {
            "nrw_pct": latest.get("nrw_pct"),
            "downtime_hrs": latest.get("downtime_hrs"),
            "permeate_tds": latest.get("permeate_tds"),
            "permeate_ph": latest.get("permeate_ph"),
            "raw_turbidity": latest.get("raw_turbidity"),
            "dp_psi": latest.get("dp_psi"),
            "recovery_pct": latest.get("recovery_pct"),
            "pv_ratio": latest.get("pv_ratio"),
        }
        violations = evaluate(t, metrics)
        snap = {
            "plant_id": pid,
            "plant_name": p["name"],
            "evaluated_at": datetime.now(timezone.utc),
            "summary_date": latest.get("summary_date"),
            "metrics": metrics,
            "thresholds": t.dict(),
            "violations": [v.dict() for v in violations],
            "violation_count": len(violations),
        }
        await db.compliance_snapshots.insert_one(snap)
        results.append({k: v for k, v in snap.items() if k != "_id"})

    return {
        "ok": True,
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "plant_count": len(results),
        "results": results,
    }


async def run_pm_forecast_sweep(db, limit: int = 50) -> dict[str, Any]:
    sb = supa_client()
    if sb is None:
        raise HTTPException(status_code=500, detail="Supabase not configured")

    templates = (sb.table("checklist_templates")
                 .select("id,equipment_name,category,frequency,schedule_start_date,plant_id")
                 .execute().data or [])
    forecasts: list[dict[str, Any]] = []
    for tpl in templates[:limit]:
        req = PmForecastRequest(
            equipment_name=tpl.get("equipment_name") or "Unknown",
            category=tpl.get("category") or "General",
            frequency=tpl.get("frequency") or "Monthly",
            last_execution_date=tpl.get("schedule_start_date"),
        )
        try:
            resp = await forecast_pm(req)
            doc = {
                "template_id": tpl["id"],
                "plant_id": tpl.get("plant_id"),
                "equipment_name": req.equipment_name,
                "category": req.category,
                "frequency": req.frequency,
                "recommended_next_date": resp.recommended_next_date,
                "confidence": resp.confidence,
                "rationale": resp.rationale,
                "risk_factors": resp.risk_factors,
                "generated_at": datetime.now(timezone.utc),
            }
            await db.pm_forecasts.update_one(
                {"template_id": tpl["id"]},
                {"$set": doc}, upsert=True,
            )
            forecasts.append({k: v for k, v in doc.items() if k != "_id"})
        except Exception as e:  # noqa: BLE001
            log.exception("pm forecast failed for %s", tpl.get("id"))
            forecasts.append({"template_id": tpl["id"], "error": str(e)})

    return {
        "ok": True,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "count": len(forecasts),
        "forecasts": forecasts,
    }
