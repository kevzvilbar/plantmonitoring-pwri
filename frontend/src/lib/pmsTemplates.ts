// PMS checklist templates extracted from the manufacturer's checklist workbook.
// Each entry produces one row in `checklist_templates` per plant, grouped by
// equipment + frequency. The `steps` array becomes `checklist_steps`.

export type PmsTemplate = {
  category: string;
  equipment_name: string;
  frequency: 'Daily' | 'Weekly' | 'Monthly' | 'Quarterly' | 'Yearly';
  steps: string[];
};

export const PMS_TEMPLATES: PmsTemplate[] = [
  // ============== GENSET ==============
  {
    category: 'Genset', equipment_name: 'Genset', frequency: 'Daily',
    steps: [
      'Fuel Level — Full / 75% / 50% / Low',
      'Oil Level — Normal / Low / Overfilled',
      'Coolant Level — Normal / Low',
      'Battery Condition — Clean / Corroded / Loose',
      'Air Intake — Clear / Restricted',
      'Control Panel — No Alarms / Active Alarm',
      'Louver / Enclosure Opening — Clear / Obstructed',
      'Technician Signature',
    ],
  },
  {
    category: 'Genset', equipment_name: 'Genset', frequency: 'Weekly',
    steps: [
      'Battery Charger — Charging / Floating / Off',
      'Drive Belts — Tight / Loose / Cracked',
      'Radiator Hoses — Flexible / Hard / Leaking',
      'Water Separator — Drained / Clean / Contaminated',
      'Block Heater — Warm / Cold / Not Installed',
      'Exhaust System — Sealed / Soot Visible / Damaged',
    ],
  },
  {
    category: 'Genset', equipment_name: 'Genset', frequency: 'Monthly',
    steps: [
      'No-Load Run — Pass (15–30 min) / Failed / Did Not Start',
      'Battery Fluid — Level OK / Topped Up / Low',
      'Main Breaker — Functional / Stiff / Stuck',
      'Control Wiring — Secure / Frayed / Loose',
      'Flexible Lines — Good / Seeping',
      'Engine Hours (manual reading)',
    ],
  },
  {
    category: 'Genset', equipment_name: 'Genset', frequency: 'Quarterly',
    steps: [
      'Air Filter Element — Clean / Dirty / Replaced',
      'Radiator Cleaning — Clean / Dust Clogged / Flushed',
      'Alternator Screen — No Obstruction / Cleaned',
      'Linkage Lubrication — Lubricated / Stiff / Dry',
    ],
  },
  {
    category: 'Genset', equipment_name: 'Genset', frequency: 'Yearly',
    steps: [
      'Oil Filter Change — Completed / Not Due',
      'Engine Oil Change — Completed / Not Due',
      'Fuel Filter Change — Completed / Not Due',
      'Coolant DCA Test — Pass / Fail (Add SCA) / Replace',
      'Breather Cleaning — Cleaned / Replaced',
      'ATS Inspection — Contacts Clean / Pitting Seen',
      'Load Bank Test — Pass / Fail / Not Required',
    ],
  },

  // ============== RO MEMBRANES / VESSELS ==============
  {
    category: 'RO Membranes', equipment_name: 'RO Train', frequency: 'Weekly',
    steps: [
      'Conductivity Probe — Calibrated / Cleaned / Needs Replacement',
      'Low-Pressure Cutoff — Tested OK / Failed',
      'High-Pressure Trip — Tested OK / Failed',
      'Permeate Check Valve — Sealing / Backflowing',
    ],
  },
  {
    category: 'RO Membranes', equipment_name: 'RO Train', frequency: 'Monthly',
    steps: [
      'Normalized Flow — Stable / Dropped >10% / Dropped >15%',
      'Vessel Racks — Secure / Rusting / Loose Bolts',
      'Victaulic Couplings — Tight / Salt Creep Visible',
      'Membrane Visual Check — Not Required / Done',
    ],
  },
  {
    category: 'RO Membranes', equipment_name: 'RO Train', frequency: 'Quarterly',
    steps: [
      'CIP Procedure — Performed (Acid/Alkaline) / Skipped',
      'Vessel O-Rings — Replaced / Lubricated / Good',
      'Interconnectors — Inspected / Replaced O-Rings',
      'Membrane Rotation — Completed / Not Required',
      'Pressure Gauges — Re-Calibrated / Replaced',
    ],
  },

  // ============== DOSING PUMP ==============
  {
    category: 'Dosing Pump', equipment_name: 'Dosing Pump', frequency: 'Daily',
    steps: [
      'Priming Status — Primed / Air-Locked / Loss of Prime',
      'Diaphragm Click — Regular / Irregular / Silent',
      'Chemical Level (manual reading)',
      'Injection Point — Clear / Calcified / Blocked',
      'Leak Check — Dry / Seeping / Active Leak',
    ],
  },
  {
    category: 'Dosing Pump', equipment_name: 'Dosing Pump', frequency: 'Weekly',
    steps: [
      'Drawdown Test — Accurate / Over-Dosing / Under-Dosing',
      'Suction Strainer — Clean / Clogged / Sludge',
      'Tubing Condition — Flexible / Brittle / Discolored',
      'Vent Valve — Functional / Clogged',
    ],
  },
  {
    category: 'Dosing Pump', equipment_name: 'Dosing Pump', frequency: 'Monthly',
    steps: [
      'Stroke Adjustment — Free / Stuck / Hard to Turn',
      'Electrical Plug — Secure / Corrosion on Pins',
      'Controller Sync — Running / External Stop Active',
      'Mounting Bolts — Tight / Loose / Vibrating',
    ],
  },
  {
    category: 'Dosing Pump', equipment_name: 'Dosing Pump', frequency: 'Yearly',
    steps: [
      'Diaphragm Swap — Replaced / Inspected OK',
      'Check Valves — Replaced / Cleaned',
      'O-Rings — Replaced / Lubricated',
      'Backpressure Valve — Tested OK / Failed / Replaced',
    ],
  },

  // ============== CONTROLLERS ==============
  {
    category: 'Controllers', equipment_name: 'VFD / Soft Starter', frequency: 'Weekly',
    steps: [
      'Running Frequency (Hz)',
      'Operating Amps',
      'Heatsink Temperature (°C)',
      'Cooling Fans — Spinning / Noisy / Stopped',
      'Fault Codes — None / Active / Warning',
      'Panel Humidity — Dry / Condensation Visible',
    ],
  },
  {
    category: 'Controllers', equipment_name: 'VFD / Soft Starter', frequency: 'Monthly',
    steps: [
      'Panel Filters — Clean / Dust Clogged / Replaced',
      'Louver Vents — Clear / Obstructed',
      'External Vibration — Stable / Excessive',
      'Display Visibility — Clear / Faded / Flickering',
    ],
  },
  {
    category: 'Controllers', equipment_name: 'VFD / Soft Starter', frequency: 'Quarterly',
    steps: [
      'Internal Dust — None / Light / Heavy (Vacuumed)',
      'Terminal Discoloration — Normal / Overheating Signs',
      'Cable Integrity — Secure / Loose / Rodent Damage',
      'Ground Connection — Tight / Corroded',
    ],
  },
  {
    category: 'Controllers', equipment_name: 'VFD / Soft Starter', frequency: 'Yearly',
    steps: [
      'Terminal Torque — Checked / Loose',
      'Capacitor Check — No Bulging / Leaking / Good',
      'Fan Replacement — Operational / Replaced',
      'Backup Parameters — Uploaded / Not Done',
      'Heatsink Cleaning — Deep Cleaned / No Blockage',
    ],
  },

  // ============== CARTRIDGE FILTER ==============
  {
    category: 'Filter Media', equipment_name: 'Cartridge Filter', frequency: 'Daily',
    steps: [
      'Housing Leaks — None / Cover Leak / Drain Leak',
      'Visual Clarity — Clear / Cloudy / Sediment',
    ],
  },
  {
    category: 'Filter Media', equipment_name: 'Cartridge Filter', frequency: 'Weekly',
    steps: [
      'Pressure Gauges — Working / Stuck / Fogged or Broken',
      'Housing Vents — Air Bled / Functional',
      'Drain Valve — Closed/Dry / Seeping',
      'Mounting Support — Stable / Vibrating / Loose',
    ],
  },
  {
    category: 'Filter Media', equipment_name: 'Cartridge Filter', frequency: 'Monthly',
    steps: [
      'Filter Condition — New / Slightly Discolored / Dark',
      'Internal O-Ring — Elastic / Flattened / Nicked',
      'Spring Plate — Secure / Rusting / Missing',
      'Element Replaced? — No / Yes',
    ],
  },
  {
    category: 'Filter Media', equipment_name: 'Cartridge Filter', frequency: 'Quarterly',
    steps: [
      'Housing Sanitize — Completed / Not Required',
      'Gauge Calibration — Calibrated / Replaced',
      'Support Pipe Inspect — Good / Corrosion / Leaking',
      'Spare Stock Check — >5 Spares / <2 (Order)',
    ],
  },

  // ============== PUMP AND MOTOR ==============
  {
    category: 'Pumps & Motors', equipment_name: 'Pump & Motor', frequency: 'Daily',
    steps: [
      'Vibration Level — Smooth / Slight / Excessive',
      'Operating Temperature — Normal / Hot to Touch',
      'Seal Leakage — None / Drip / Active',
      'Abnormal Noise — None / Grinding / Squealing',
      'Discharge Pressure (psi)',
    ],
  },
  {
    category: 'Pumps & Motors', equipment_name: 'Pump & Motor', frequency: 'Weekly',
    steps: [
      'Amperage Draw',
      'Mounting Bolts — Tight / Loose / Vibrating',
      'Coupling Guard — Secure / Missing / Rubbing',
      'Oil Level Sight — Full / Low / Discolored',
    ],
  },
  {
    category: 'Pumps & Motors', equipment_name: 'Pump & Motor', frequency: 'Monthly',
    steps: [
      'Grease Applied — Yes (1–2 Pumps) / Not Required',
      'Terminal Box — Clean & Dry / Moisture or Dust',
      'Cooling Fins — Clean / Clogged with Dust',
      'Suction Strainer — Clear / Partially Blocked',
    ],
  },
  {
    category: 'Pumps & Motors', equipment_name: 'Pump & Motor', frequency: 'Quarterly',
    steps: [
      'Shaft Alignment — Aligned / Misaligned',
      'Insulation Test (MΩ — Megger)',
      'Flow Rate vs Pump Curve',
      'Bearing Temperature (IR thermometer, °C)',
    ],
  },
  {
    category: 'Pumps & Motors', equipment_name: 'Pump & Motor', frequency: 'Yearly',
    steps: [
      'Mechanical Seal — Replaced / Inspected OK',
      'Bearing Swap — Replaced / Inspected OK',
      'Coupling Insert — Replaced / Good',
      'Paint Touch-Up — Completed / No Corrosion',
    ],
  },

  // ============== QUALITY TESTERS ==============
  {
    category: 'pH Meter', equipment_name: 'pH Meter', frequency: 'Daily',
    steps: ['Storage Check — Wet (KCl) / Dry (Action) / Refilled'],
  },
  {
    category: 'pH Meter', equipment_name: 'pH Meter', frequency: 'Weekly',
    steps: [
      'pH 7 Buffer Calibration — Passed / Adjusted / Failed',
      'pH 4 or 10 Slope Calibration — Passed / Adjusted / Failed',
    ],
  },
  {
    category: 'pH Meter', equipment_name: 'pH Meter', frequency: 'Monthly',
    steps: [
      'Electrode Cleaning (Acid Soak) — Cleaned / Good',
      'Response Time — Fast (<30s) / Slow / Critical (>60s)',
    ],
  },
  {
    category: 'pH Meter', equipment_name: 'pH Meter', frequency: 'Quarterly',
    steps: ['Junction Inspection — Clear / Clogged / Discolored'],
  },
  {
    category: 'pH Meter', equipment_name: 'pH Meter', frequency: 'Yearly',
    steps: ['Probe Replacement — Replaced / Still Functional'],
  },

  {
    category: 'Nephelometer', equipment_name: 'NTU Meter', frequency: 'Weekly',
    steps: [
      'Vial Clarity — Clean / Smudged / Scratched',
      'Zero Standard Verify — Passed (<0.1 NTU) / Re-Zeroed',
    ],
  },
  {
    category: 'Nephelometer', equipment_name: 'NTU Meter', frequency: 'Monthly',
    steps: [
      'Secondary Standard Check (10 / 100 NTU) — Matched / Drifted',
      'Optical Chamber Cleaning — No Dust / Cleaned',
    ],
  },
  {
    category: 'Nephelometer', equipment_name: 'NTU Meter', frequency: 'Quarterly',
    steps: ['Vial Replacement — Good / Replaced'],
  },
  {
    category: 'Nephelometer', equipment_name: 'NTU Meter', frequency: 'Yearly',
    steps: [
      'Light Source Audit — Stable / Flickering',
      'Formazin Calibration (Upload Certificate)',
    ],
  },

  {
    category: 'Colorimeter', equipment_name: 'Colorimeter', frequency: 'Weekly',
    steps: [
      'Blanking Verification — Zeroed (0.00) / Re-Zeroed',
      'Reagent Check (DPD) — In-Stock / Expired / Low',
    ],
  },
  {
    category: 'Colorimeter', equipment_name: 'Colorimeter', frequency: 'Monthly',
    steps: [
      'Optical Cell Clean — Clean / Cleaned',
      'Vial Match Check — Matched / Discarded',
    ],
  },
  {
    category: 'Colorimeter', equipment_name: 'Colorimeter', frequency: 'Quarterly',
    steps: ['Secondary Standard (Spec-Check 0.2 / 1.0 / 2.0) — Passed / Calibrated'],
  },
  {
    category: 'Colorimeter', equipment_name: 'Colorimeter', frequency: 'Yearly',
    steps: [
      'Comparison Audit (vs DPD Titration / Lab) — Matched / Discrepancy',
      'Battery Compartment — Clean & Dry / Corrosion',
    ],
  },
];
