"""
Helpers for `ai_import_service.py`.

Groups together:
    * Long keyword-only signatures, replaced with frozen dataclasses
      (`AnalysisPersistPayload`, `ReadingsInsertContext`, `AuditDecision`)
      so call-sites are easier to read.
    * Per-target row builders for `_insert_readings`. Each builder turns a
      single source row into a Supabase insert payload, or returns None
      to skip.
    * Pure JSON / date / float coercions used by the readings pipeline.

These helpers are stateless: they take a Supabase Client and the relevant
data and return either dicts (rows to insert) or HTTPException-friendly
errors. Side effects (insert / update) live in `ai_import_service.py`.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Optional

from fastapi import HTTPException
from supabase import Client

log = logging.getLogger(__name__)

# Map of canonical field aliases -> logical field name. Used to recognise
# admin-edited column_mapping even when sources name things differently.
DATE_KEYS = {"date", "reading_date", "day", "datetime", "reading_datetime"}
VOLUME_KEYS = {
    "volume", "value", "kwh", "production", "permeate", "delivered", "current_reading",
}
INITIAL_KEYS = {"initial", "previous", "previous_reading", "start"}
FINAL_KEYS = {"final", "current", "end"}
NAME_KEYS = {"name", "well", "well_name", "locator", "locator_name", "train", "train_name"}


# ---- Dataclasses for long signatures --------------------------------------

@dataclass(frozen=True)
class AnalysisPersistPayload:
    """Bundle the 11 named args that `_persist_analysis` used to take.

    Keeps `ai_import_service._persist_analysis` readable and forces
    callers to commit to one consistent set of values.
    """
    caller: dict[str, Any]
    filename: str
    file_kind: str
    file_size: int
    plant_id: Optional[str]
    extracted: list[Any]              # list[ExtractedTable] (avoids cycle)
    analyses: list[Any]               # list[TableAnalysis]
    wellmeter_detected: bool
    ai_provider: str
    ai_model: Optional[str]


@dataclass(frozen=True)
class ReadingsInsertContext:
    """Bundle the 8 args `_insert_readings` used to take."""
    target: str
    plant_id: str
    entity_id: str
    recorded_by: Optional[str]
    headers: list[str]
    rows: list[list[Any]]
    mapping: dict[str, str]


@dataclass(frozen=True)
class AuditDecision:
    """Identifies one approve/reject decision for the import audit log."""
    analysis_id: str
    source: str
    target: str
    label: str
    reason: str


# ---- Coercions -------------------------------------------------------------

def coerce_date(v: Any) -> Optional[str]:
    """Best-effort `YYYY-MM-DD` coercion. Returns None if unparseable."""
    if v in (None, ""):
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    s = str(v).strip()
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%Y/%m/%d", "%m-%d-%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return None


def coerce_float(v: Any) -> Optional[float]:
    if v in (None, ""):
        return None
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def to_jsonable(v: Any) -> Any:
    """Coerce numpy / datetime / unknown types to JSON-friendly primitives."""
    if v is None:
        return None
    if isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


# ---- Column resolution ----------------------------------------------------

def resolve_col(
    headers: list[str],
    mapping: dict[str, str],
    aliases: set[str],
) -> Optional[int]:
    """Return the column index in `headers` for the first mapping key that
    matches one of `aliases` (case-insensitive). Falls back to direct
    header-name match."""
    lowered_headers = [h.lower().strip() for h in headers]

    # 1. user-provided mapping {our_field: source_header}
    for our, source in mapping.items():
        if our.lower().strip() in aliases:
            try:
                return lowered_headers.index(str(source).lower().strip())
            except ValueError:
                continue

    # 2. direct header alias match
    for alias in aliases:
        for i, h in enumerate(lowered_headers):
            if alias in h:
                return i
    return None


# ---- Per-target row builders ----------------------------------------------
#
# Each builder receives the resolved column-index map and one source row,
# and returns the dict ready for Supabase insert. Builders are pure.
# `None` means "skip this row".

RowBuilder = Callable[[list[Any], dict[str, Optional[int]], ReadingsInsertContext, str], Optional[dict[str, Any]]]


def _val_at(row: list[Any], idx: Optional[int]) -> Any:
    if idx is None or idx >= len(row):
        return None
    return row[idx]


def _build_well_reading(
    row: list[Any], idxs: dict[str, Optional[int]],
    ctx: ReadingsInsertContext, date_iso: str,
) -> Optional[dict[str, Any]]:
    return {
        "plant_id": ctx.plant_id,
        "well_id": ctx.entity_id,
        "reading_datetime": f"{date_iso}T00:00:00Z",
        "previous_reading": coerce_float(_val_at(row, idxs.get("initial"))),
        "current_reading": coerce_float(_val_at(row, idxs.get("final"))),
        "daily_volume": coerce_float(_val_at(row, idxs.get("volume"))),
        "off_location_flag": False,
        "recorded_by": ctx.recorded_by,
    }


def _build_locator_reading(
    row: list[Any], idxs: dict[str, Optional[int]],
    ctx: ReadingsInsertContext, date_iso: str,
) -> Optional[dict[str, Any]]:
    return {
        "plant_id": ctx.plant_id,
        "locator_id": ctx.entity_id,
        "reading_datetime": f"{date_iso}T00:00:00Z",
        "daily_volume": coerce_float(_val_at(row, idxs.get("volume"))),
        "recorded_by": ctx.recorded_by,
    }


def _build_ro_train_reading(
    row: list[Any], idxs: dict[str, Optional[int]],
    ctx: ReadingsInsertContext, date_iso: str,
) -> Optional[dict[str, Any]]:
    return {
        "plant_id": ctx.plant_id,
        "ro_train_id": ctx.entity_id,
        "reading_datetime": f"{date_iso}T00:00:00Z",
        "permeate_volume_m3": coerce_float(_val_at(row, idxs.get("volume"))),
        "recorded_by": ctx.recorded_by,
    }


def _build_power_reading(
    row: list[Any], idxs: dict[str, Optional[int]],
    ctx: ReadingsInsertContext, date_iso: str,
) -> Optional[dict[str, Any]]:
    return {
        "plant_id": ctx.plant_id,
        "reading_datetime": f"{date_iso}T00:00:00Z",
        "kwh": coerce_float(_val_at(row, idxs.get("volume"))),
        "recorded_by": ctx.recorded_by,
    }


# Per-target build config:
#   builder      -> the row->dict function
#   needs        -> column aliases that must resolve (e.g. {"volume"})
#   missing_msg  -> warning to surface if a `needs` column is missing
@dataclass(frozen=True)
class _TargetSpec:
    builder: RowBuilder
    needs: tuple[str, ...]                # alias-group names that must resolve
    missing_msg: Optional[str] = None     # surfaced if a `needs` column missing


_ALIAS_GROUPS: dict[str, set[str]] = {
    "date": DATE_KEYS,
    "volume": VOLUME_KEYS,
    "initial": INITIAL_KEYS,
    "final": FINAL_KEYS,
}

TARGET_SPECS: dict[str, _TargetSpec] = {
    "well_readings": _TargetSpec(
        builder=_build_well_reading,
        needs=(),  # no hard requirement beyond date; builder fills None
    ),
    "locator_readings": _TargetSpec(
        builder=_build_locator_reading,
        needs=("volume",),
        missing_msg="No volume column resolved for locator_readings.",
    ),
    "ro_train_readings": _TargetSpec(
        builder=_build_ro_train_reading,
        needs=(),
    ),
    "power_readings": _TargetSpec(
        builder=_build_power_reading,
        needs=("volume",),
        missing_msg="No kWh column resolved for power_readings.",
    ),
}


def build_reading_rows(
    ctx: ReadingsInsertContext,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Translate `ctx.rows` into Supabase-ready insert payloads for `ctx.target`.

    Returns (payload, warnings). Empty payload + a warning is normal for
    inputs with no recognisable date column.
    """
    spec = TARGET_SPECS.get(ctx.target)
    if spec is None:
        return [], [f"Unsupported reading target: {ctx.target}"]

    date_idx = resolve_col(ctx.headers, ctx.mapping, DATE_KEYS)
    if date_idx is None:
        return [], ["No date column resolved — provide a 'date' column mapping."]

    # Resolve `needs` columns up-front; bail with the configured message
    # if a required one is missing.
    idxs: dict[str, Optional[int]] = {"date": date_idx}
    for group in ("volume", "initial", "final"):
        idxs[group] = resolve_col(ctx.headers, ctx.mapping, _ALIAS_GROUPS[group])
    for required in spec.needs:
        if idxs.get(required) is None:
            return [], [spec.missing_msg or f"No {required} column resolved for {ctx.target}."]

    payload: list[dict[str, Any]] = []
    seen_dates: set[str] = set()
    for r in ctx.rows:
        d = coerce_date(_val_at(r, date_idx))
        if not d or d in seen_dates:
            continue
        seen_dates.add(d)
        row = spec.builder(r, idxs, ctx, d)
        if row is not None:
            payload.append(row)

    warnings: list[str] = []
    if not payload:
        warnings.append("No date-coercible rows found.")
    return payload, warnings


# ---- Entity get-or-create -------------------------------------------------

def ensure_entity(
    client: Client, target: str, plant_id: str, name: str,
) -> tuple[Optional[str], bool]:
    """Get-or-create an entity row of `target` type under `plant_id` by name.

    Returns (entity_id, created_now). `created_now` is True only when this
    call inserted a new row — so callers count creations accurately.

    Race protection: if a concurrent caller wins the insert race,
    `unique (plant_id, name)` (recommended DB constraint) raises and we
    re-select. Without the constraint, this still narrows the window but
    cannot eliminate it; document the recommendation in the migration.
    """
    table = target  # 'wells' | 'locators' | 'ro_trains'
    name = name.strip()
    if not name or not plant_id:
        return None, False
    try:
        existing = (
            client.table(table).select("id,name")
            .eq("plant_id", plant_id).ilike("name", name).limit(1).execute()
        )
        if existing.data:
            return existing.data[0]["id"], False
        base: dict[str, Any] = {"plant_id": plant_id, "name": name, "status": "Active"}
        if target == "wells":
            base["has_power_meter"] = False
        try:
            ins = client.table(table).insert(base).select("id").single().execute()
            return (ins.data or {}).get("id"), True
        except Exception as ins_err:  # noqa: BLE001
            # Likely a race winning a unique constraint — re-select.
            log.info(
                "Insert race on %s '%s' (%s) — re-selecting.",
                target, name, ins_err,
            )
            re = (
                client.table(table).select("id,name")
                .eq("plant_id", plant_id).ilike("name", name).limit(1).execute()
            )
            if re.data:
                return re.data[0]["id"], False
            raise
    except Exception as e:  # noqa: BLE001
        log.warning("Failed to upsert %s '%s': %s", target, name, e)
        return None, False
