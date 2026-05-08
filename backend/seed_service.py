"""
Seeding service: ingest one or more XLSX files straight into Supabase
(well_readings, plants/wells auto-create) and into Mongo (downtime_events).

Called from the `/api/import/seed-from-url` endpoint.

Idempotency / override semantics:
  - For each (plant_id, well_id, reading_date) that already exists in
    Supabase `well_readings`, the existing row is UPDATED with the parsed
    values (previous_reading, current_reading, daily_volume,
    off_location_flag). Rows that do not yet exist are inserted.
  - Rows with status=='defective' are skipped unless include_defective=True.
  - Downtime rows are inserted with volume forced to 0 and
    off_location_flag=True.
  - Mongo `downtime_events` collection is cleared per (plant_id, source_file)
    then re-populated to keep the dataset in sync with the spreadsheet.

This module does NOT hit any background thread / scheduler — it is a plain
async function called from a FastAPI HTTP handler, so it stays Vercel-friendly.
"""
from __future__ import annotations

import asyncio
import io
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from import_parser import parse_xlsx
from downtime_parser import parse_downtime_xlsx
from supa_client import _client as supa_client

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _download(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as ac:
        r = await ac.get(url)
        r.raise_for_status()
        return r.content


def _norm(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip()).lower()


def _ensure_plant(sb, plant_name: str) -> str:
    """Return plant_id. Create plant if it doesn't exist (matched by name
    case-insensitively)."""
    rows = sb.table("plants").select("id,name").execute().data or []
    for p in rows:
        if _norm(p["name"]) == _norm(plant_name):
            return p["id"]
    # Create minimal plant (status Active)
    res = sb.table("plants").insert({
        "name": plant_name.strip(),
        "status": "Active",
    }).execute()
    if res.data:
        return res.data[0]["id"]
    raise RuntimeError(f"Failed to create plant '{plant_name}'")


def _ensure_well(sb, plant_id: str, well_name: str,
                 existing: dict[str, str]) -> str:
    """Return well_id for plant_id + well_name. Create if missing."""
    key = _norm(well_name)
    if key in existing:
        return existing[key]
    res = sb.table("wells").insert({
        "plant_id": plant_id,
        "name": well_name.strip(),
        "status": "Active",
        "has_power_meter": False,
    }).execute()
    if not res.data:
        raise RuntimeError(f"Failed to create well '{well_name}'")
    wid = res.data[0]["id"]
    existing[key] = wid
    return wid


def _load_existing_wells(sb, plant_id: str) -> dict[str, str]:
    rows = sb.table("wells").select("id,name").eq("plant_id", plant_id).execute().data or []
    return {_norm(w["name"]): w["id"] for w in rows}


def _existing_readings(sb, plant_id: str, well_id: str, dates: list[str]) -> dict[str, str]:
    """Return {reading_date_str: reading_id} for already-saved rows
    (Supabase `well_readings`)."""
    out: dict[str, str] = {}
    if not dates:
        return out
    # Batch in chunks — Supabase `in_` parameter has URL length limits
    for i in range(0, len(dates), 100):
        chunk = dates[i:i + 100]
        iso_ranges_from = [f"{d}T00:00:00" for d in chunk]
        # Simpler: fetch all rows in date_range, then filter
        q = sb.table("well_readings").select("id,reading_datetime")
        q = q.eq("well_id", well_id).eq("plant_id", plant_id)
        q = q.gte("reading_datetime", min(iso_ranges_from))
        # end exclusive day after the max
        max_d = max(chunk)
        q = q.lte("reading_datetime", f"{max_d}T23:59:59.999")
        rows = q.execute().data or []
        for r in rows:
            d = str(r.get("reading_datetime", ""))[:10]
            out[d] = r["id"]
    return out


# ---------------------------------------------------------------------------
# Main seeding entry
# ---------------------------------------------------------------------------

async def seed_from_urls(
    db,
    targets: list[dict[str, str]],
    include_defective: bool = False,
    downtime_as_zero: bool = True,
    access_token: Optional[str] = None,
) -> dict[str, Any]:
    """
    targets: [{plant_name, url, source: 'meter'|'downtime'|'auto'}]
    access_token: optional Supabase user JWT — enables RLS-protected writes.

    Without a JWT, only Mongo-side ingest (downtime_events) runs; the
    meter upsert into Supabase is skipped with a warning in the report.
    """
    sb = supa_client(access_token) if access_token else None
    can_write_supabase = sb is not None and bool(access_token)

    file_reports: list[dict[str, Any]] = []

    for t in targets:
        plant_name = t["plant_name"]
        url = t["url"]
        source = t.get("source", "auto")
        try:
            content = await _download(url)
        except Exception as e:  # noqa: BLE001
            file_reports.append({"plant": plant_name, "url": url, "error": f"download: {e}"})
            continue

        report: dict[str, Any] = {"plant": plant_name, "url": url,
                                   "inserted": 0, "updated": 0,
                                   "skipped": 0, "wells_created": 0,
                                   "downtime_events": 0, "errors": []}
        if can_write_supabase:
            try:
                plant_id = _ensure_plant(sb, plant_name)
            except Exception as e:  # noqa: BLE001
                log.warning("plant ensure failed: %s", e)
                plant_id = f"pseudo:{_norm(plant_name)}"
                report["errors"].append(f"plant: {e}")
        else:
            plant_id = f"pseudo:{_norm(plant_name)}"
            report["errors"].append("no-auth: meter ingest skipped (Supabase requires JWT)")

        # ---------- Downtime sheet ingestion (best-effort, only if present) ----------
        try:
            ev_rows = parse_downtime_xlsx(content)
            if ev_rows:
                # Wipe previous events for this plant + source_file
                src_key = url.rsplit("/", 1)[-1][:80]
                await db.downtime_events.delete_many({"plant_id": plant_id, "source_file": src_key})
                now = datetime.now(timezone.utc)
                docs = []
                for ev in ev_rows:
                    docs.append({
                        "plant_id": plant_id,
                        "plant_name": plant_name,
                        "source_file": src_key,
                        "event_date": ev["event_date"],
                        "subsystem": ev["subsystem"],
                        "duration_hrs": float(ev["duration_hrs"]),
                        "cause": ev["cause"],
                        "raw_text": ev["raw_text"],
                        "op_hrs": ev.get("op_hrs"),
                        "shutdown_hrs": ev.get("shutdown_hrs"),
                        "created_at": now,
                    })
                if docs:
                    await db.downtime_events.insert_many(docs)
                report["downtime_events"] = len(docs)
        except Exception as e:  # noqa: BLE001
            log.exception("downtime ingest failed")
            report["errors"].append(f"downtime: {e}")

        # ---------- Well-meter sheets ingestion ----------
        if source in ("auto", "meter") and can_write_supabase:
            try:
                parsed = parse_xlsx(content)
                existing_wells = _load_existing_wells(sb, plant_id)
                wells_created_before = len(existing_wells)
                for sheet in parsed["sheets"]:
                    sname = sheet["sheet_name"]
                    wname = sheet["suggested_well_name"].strip() or sname
                    # Skip non-well sheets heuristically — a well sheet has
                    # >=20 rows of parsed data with dates
                    dated = [r for r in sheet["rows"] if r.get("date")]
                    if len(dated) < 20:
                        continue
                    # Skip aggregator sheets like "MAMBALING RO DATA",
                    # "Downtime", "Product TDS", "Chemical Consumption", etc.
                    if re.search(r"\b(data|downtime|tds|consumption|turbidity|chemical|power\s+meter|permeate)\b",
                                 sname, re.I):
                        # Keep Power-meter-of-wells style sheets as wells if they have meter data
                        if not re.search(r"power\s+meter\s+reading", sname, re.I):
                            continue
                    well_id = _ensure_well(sb, plant_id, wname, existing_wells)
                    # Build rows
                    all_dates = [r["date"] for r in dated]
                    existing_map = _existing_readings(sb, plant_id, well_id, all_dates)

                    to_update: list[dict[str, Any]] = []
                    to_insert: list[dict[str, Any]] = []

                    for r in dated:
                        if r["status"] == "defective" and not include_defective:
                            report["skipped"] += 1
                            continue
                        vol = r.get("volume")
                        if r.get("is_downtime") and downtime_as_zero:
                            vol = 0
                        payload = {
                            "plant_id": plant_id,
                            "well_id": well_id,
                            "reading_datetime": f"{r['date']}T00:00:00+00:00",
                            "previous_reading": r.get("initial"),
                            "current_reading": r.get("final"),
                            "daily_volume": vol,
                            "off_location_flag": bool(r.get("is_downtime")
                                                     or r["status"] == "defective"
                                                     or r.get("flags")),
                        }
                        rid = existing_map.get(r["date"])
                        if rid:
                            payload["id"] = rid
                            to_update.append(payload)
                        else:
                            to_insert.append(payload)

                    # Update in batches
                    for row in to_update:
                        rid = row.pop("id")
                        try:
                            sb.table("well_readings").update(row).eq("id", rid).execute()
                            report["updated"] += 1
                        except Exception as e:  # noqa: BLE001
                            report["errors"].append(f"update {wname} {row.get('reading_datetime')}: {e}")
                    # Insert in chunks of 500
                    for i in range(0, len(to_insert), 500):
                        chunk = to_insert[i:i + 500]
                        try:
                            sb.table("well_readings").insert(chunk).execute()
                            report["inserted"] += len(chunk)
                        except Exception as e:  # noqa: BLE001
                            report["errors"].append(f"insert {wname} batch {i // 500}: {e}")

                report["wells_created"] = max(0, len(existing_wells) - wells_created_before)
            except Exception as e:  # noqa: BLE001
                log.exception("seed meter ingest failed")
                report["errors"].append(f"meters: {e}")

        file_reports.append(report)

    return {
        "ok": all(not r.get("errors") for r in file_reports),
        "files": file_reports,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }
