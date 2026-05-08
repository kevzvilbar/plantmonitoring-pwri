// Calculation utilities for PWRI operations

export const calc = {
  dailyVolume: (current: number, previous: number) =>
    Number.isFinite(current) && Number.isFinite(previous) ? Math.round(current - previous) : null,

  pressureDiff: (inlet: number, outlet: number) =>
    Number.isFinite(inlet) && Number.isFinite(outlet) ? +(inlet - outlet).toFixed(1) : null,

  recovery: (permFlow: number, feedFlow: number) =>
    feedFlow ? +((permFlow / feedFlow) * 100).toFixed(1) : null,

  rejection: (permTDS: number, rejectTDS: number) =>
    rejectTDS ? +((1 - permTDS / rejectTDS) * 100).toFixed(1) : null,

  saltPassage: (permTDS: number, rejectTDS: number) =>
    rejectTDS ? +((permTDS / rejectTDS) * 100).toFixed(1) : null,

  rejectFlow: (feedFlow: number, permFlow: number) =>
    Number.isFinite(feedFlow) && Number.isFinite(permFlow) ? +(feedFlow - permFlow).toFixed(2) : null,

  nrw: (production: number, consumption: number) =>
    production ? +(((production - consumption) / production) * 100).toFixed(1) : null,

  pvRatio: (kwh: number, m3: number) =>
    m3 ? +(kwh / m3).toFixed(2) : null,

  chemCost: (qty: number, unitPrice: number) =>
    +(qty * unitPrice).toFixed(2),
};

export const ALERTS = {
  dp_max: 40,
  permeate_tds_max: 600,
  permeate_ph_min: 6.5,
  permeate_ph_max: 8.5,
  recovery_min: 65,
  recovery_max: 75,
  avg_multiplier_warn: 2.5,
  geofence_radius_m_default: 100,
  nrw_green_max: 13,
  nrw_amber_max: 16,
};

// Haversine distance in meters
export function distanceMeters(
  lat1: number, lng1: number, lat2: number, lng2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isOffLocation(
  readLat: number, readLng: number,
  assetLat: number, assetLng: number,
  radiusM = ALERTS.geofence_radius_m_default,
): boolean {
  if (![readLat, readLng, assetLat, assetLng].every(Number.isFinite)) return false;
  return distanceMeters(readLat, readLng, assetLat, assetLng) > radiusM;
}

export function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not available'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    });
  });
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function nrwColor(pct: number | null): 'accent' | 'warn' | 'danger' {
  if (pct === null) return 'accent';
  if (pct < ALERTS.nrw_green_max) return 'accent';
  if (pct < ALERTS.nrw_amber_max) return 'warn';
  return 'danger';
}
