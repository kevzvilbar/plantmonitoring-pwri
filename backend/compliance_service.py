"""
Compliance service.

Stores thresholds in MongoDB (one document per scope: "global" or per plant_id).
Evaluates current readings against thresholds and returns violations.
Provides an AI narrative summary via ai_service.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field

log = logging.getLogger(__name__)


# --- Pydantic ---------------------------------------------------------------

class Thresholds(BaseModel):
    # Water loss / production
    nrw_pct_max: float = Field(20.0, description="Max allowed Non-Revenue Water %")
    downtime_hrs_per_day_max: float = Field(2.0, description="Max allowed daily downtime hrs")
    # Quality
    permeate_tds_max: float = Field(500.0, description="Max permeate TDS ppm")
    permeate_ph_min: float = Field(6.5)
    permeate_ph_max: float = Field(8.5)
    raw_turbidity_max: float = Field(5.0, description="Max raw turbidity NTU")
    # RO performance
    dp_psi_max: float = Field(40.0)
    recovery_pct_min: float = Field(70.0)
    # Power / cost
    pv_ratio_max: float = Field(1.2, description="Max kWh per m³")
    # Chem stock
    chem_low_stock_days_min: float = Field(7.0, description="Min days-of-supply remaining before alert")


class ThresholdDoc(BaseModel):
    scope: str  # "global" or plant_id (uuid)
    thresholds: Thresholds
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class ViolationsPayload(BaseModel):
    """Payload posted from the frontend with aggregated current metrics."""
    plant_id: Optional[str] = None
    scope_label: Optional[str] = None  # e.g. plant name
    metrics: dict[str, Any]  # nrw_pct, downtime_hrs, permeate_tds, permeate_ph, ...


class Violation(BaseModel):
    code: str
    severity: str        # low|medium|high
    metric: str
    value: Optional[float]
    threshold: float
    comparator: str      # ">", "<", "out_of_range"
    message: str


class EvaluateResult(BaseModel):
    violations: list[Violation]
    evaluated_at: datetime
    scope: str


# --- Defaults persistence ---------------------------------------------------

DEFAULTS = Thresholds()


async def get_thresholds(db, scope: str = "global") -> Thresholds:
    doc = await db.compliance_thresholds.find_one({"scope": scope})
    if not doc:
        # Fallback: if plant-scope has no doc, return global; if global missing, return defaults.
        if scope != "global":
            return await get_thresholds(db, "global")
        return DEFAULTS
    try:
        return Thresholds(**(doc.get("thresholds") or {}))
    except Exception:  # noqa: BLE001
        log.exception("Invalid thresholds in Mongo; returning defaults")
        return DEFAULTS


async def save_thresholds(db, scope: str, t: Thresholds) -> ThresholdDoc:
    doc = ThresholdDoc(scope=scope, thresholds=t)
    await db.compliance_thresholds.update_one(
        {"scope": scope},
        {"$set": doc.dict(), "$setOnInsert": {"_id": str(uuid.uuid4())}},
        upsert=True,
    )
    return doc


# --- Evaluation -------------------------------------------------------------

def _coerce_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _sev_for_ratio(ratio: float) -> str:
    # How far over / under the threshold: 1.0..1.25 low, 1.25..1.5 med, >1.5 high
    if ratio >= 1.5:
        return "high"
    if ratio >= 1.25:
        return "medium"
    return "low"


def evaluate(t: Thresholds, metrics: dict[str, Any]) -> list[Violation]:
    out: list[Violation] = []

    def over(metric: str, value: Optional[float], threshold: float, msg_fn) -> None:
        if value is None:
            return
        if value > threshold:
            ratio = (value / threshold) if threshold else 2.0
            out.append(Violation(
                code=f"{metric}_over",
                severity=_sev_for_ratio(ratio),
                metric=metric,
                value=value,
                threshold=threshold,
                comparator=">",
                message=msg_fn(value, threshold),
            ))

    def under(metric: str, value: Optional[float], threshold: float, msg_fn) -> None:
        if value is None:
            return
        if value < threshold:
            ratio = (threshold / value) if value else 2.0
            out.append(Violation(
                code=f"{metric}_under",
                severity=_sev_for_ratio(ratio),
                metric=metric,
                value=value,
                threshold=threshold,
                comparator="<",
                message=msg_fn(value, threshold),
            ))

    nrw = _coerce_float(metrics.get("nrw_pct"))
    downtime = _coerce_float(metrics.get("downtime_hrs"))
    p_tds = _coerce_float(metrics.get("permeate_tds"))
    p_ph = _coerce_float(metrics.get("permeate_ph"))
    raw_turb = _coerce_float(metrics.get("raw_turbidity"))
    dp = _coerce_float(metrics.get("dp_psi"))
    recovery = _coerce_float(metrics.get("recovery_pct"))
    pv = _coerce_float(metrics.get("pv_ratio"))

    over("nrw_pct", nrw, t.nrw_pct_max,
         lambda v, th: f"NRW {v:.1f}% exceeds limit of {th:.1f}%.")
    over("downtime_hrs", downtime, t.downtime_hrs_per_day_max,
         lambda v, th: f"Downtime {v:.1f}h exceeds allowable {th:.1f}h/day.")
    over("permeate_tds", p_tds, t.permeate_tds_max,
         lambda v, th: f"Permeate TDS {v:.0f} ppm exceeds limit of {th:.0f} ppm.")
    over("raw_turbidity", raw_turb, t.raw_turbidity_max,
         lambda v, th: f"Raw turbidity {v:.2f} NTU exceeds limit of {th:.2f} NTU.")
    over("dp_psi", dp, t.dp_psi_max,
         lambda v, th: f"Differential pressure {v:.1f} psi exceeds {th:.1f} psi.")
    over("pv_ratio", pv, t.pv_ratio_max,
         lambda v, th: f"PV ratio {v:.2f} kWh/m³ exceeds {th:.2f} kWh/m³.")

    under("recovery_pct", recovery, t.recovery_pct_min,
          lambda v, th: f"Recovery {v:.1f}% is below minimum {th:.1f}%.")

    # pH out-of-range
    if p_ph is not None and (p_ph < t.permeate_ph_min or p_ph > t.permeate_ph_max):
        out.append(Violation(
            code="permeate_ph_range",
            severity="medium",
            metric="permeate_ph",
            value=p_ph,
            threshold=t.permeate_ph_min if p_ph < t.permeate_ph_min else t.permeate_ph_max,
            comparator="out_of_range",
            message=f"Permeate pH {p_ph:.2f} outside {t.permeate_ph_min}..{t.permeate_ph_max}.",
        ))

    # Chemical days-of-supply (optional, expects metrics['chem_days_of_supply'] = list of {name, days})
    for chem in metrics.get("chem_days_of_supply", []) or []:
        days = _coerce_float(chem.get("days"))
        if days is None:
            continue
        if days < t.chem_low_stock_days_min:
            out.append(Violation(
                code="chem_low_stock",
                severity="medium" if days >= t.chem_low_stock_days_min / 2 else "high",
                metric=f"chem:{chem.get('name', 'unknown')}",
                value=days,
                threshold=t.chem_low_stock_days_min,
                comparator="<",
                message=f"{chem.get('name')} has {days:.1f} days of supply (< {t.chem_low_stock_days_min:g}d).",
            ))

    return out


# --- AI narrative -----------------------------------------------------------

async def make_summary(violations: list[Violation], metrics: dict[str, Any], scope_label: str) -> str:
    """Call the LLM to produce a short human summary. Safe to fail silently."""
    from ai_service import _make_chat, UserMessage

    if not violations:
        return f"{scope_label or 'Plant'}: all key metrics are within thresholds."

    system = (
        "You are a concise compliance analyst for a water-treatment plant. "
        "Given a JSON list of threshold violations and the current metrics, produce "
        "a SHORT summary (<=60 words) that: (1) names the top 2 risks, (2) gives one "
        "recommended corrective action. No preamble."
    )
    payload = {
        "scope": scope_label,
        "violations": [v.dict() for v in violations],
        "metrics": metrics,
    }
    try:
        chat = _make_chat(
            session_id=f"compl_{uuid.uuid4().hex[:10]}",
            system=system, provider=None, model=None,
        )
        reply = await chat.send_message(
            UserMessage(text=json.dumps(payload, default=str)[:6000]),
        )
        return str(reply).strip()
    except Exception as e:  # noqa: BLE001
        log.warning("AI summary failed: %s", e)
        top = sorted(violations, key=lambda v: {"high": 0, "medium": 1, "low": 2}.get(v.severity, 9))[:2]
        return " · ".join(v.message for v in top)


# --- PM forecast ------------------------------------------------------------

class PmForecastRequest(BaseModel):
    equipment_name: str
    category: str
    frequency: str                # Daily|Weekly|Monthly|Quarterly|Yearly
    last_execution_date: Optional[str] = None
    history: list[dict[str, Any]] = Field(default_factory=list)
    # Optional operational signals
    downtime_hrs_last_30d: Optional[float] = None
    chem_consumption_trend: Optional[str] = None   # "rising"|"stable"|"falling"
    notes: Optional[str] = None


class PmForecastResponse(BaseModel):
    recommended_next_date: Optional[str]  # YYYY-MM-DD
    confidence: str                        # low|medium|high
    rationale: str
    risk_factors: list[str]


async def forecast_pm(req: PmForecastRequest) -> PmForecastResponse:
    """AI-driven PM forecast."""
    from ai_service import _make_chat, UserMessage, _safe_parse_json

    system = (
        "You forecast the next preventive-maintenance date for a single water-plant "
        "asset based on its frequency, last execution, and any operational signals "
        "(downtime, chemical consumption trends). Return STRICT JSON only:\n"
        '{"recommended_next_date":"YYYY-MM-DD","confidence":"low|medium|high",'
        '"rationale":"<=160 chars","risk_factors":["str", ...]}\n'
        "If you cannot forecast, still output JSON with recommended_next_date=null and "
        "an explanation in rationale. No extra keys."
    )
    payload = req.dict()
    session_id = f"pmfc_{uuid.uuid4().hex[:10]}"
    chat = _make_chat(session_id, system, None, None)
    raw = await chat.send_message(UserMessage(text=json.dumps(payload, default=str)))
    if not isinstance(raw, str):
        raw = str(raw)
    try:
        data = _safe_parse_json(raw)
    except json.JSONDecodeError:
        return PmForecastResponse(
            recommended_next_date=None,
            confidence="low",
            rationale="Model returned invalid JSON; cannot forecast.",
            risk_factors=[],
        )
    return PmForecastResponse(
        recommended_next_date=data.get("recommended_next_date"),
        confidence=str(data.get("confidence") or "low"),
        rationale=str(data.get("rationale") or "")[:400],
        risk_factors=[str(x) for x in (data.get("risk_factors") or [])][:10],
    )
