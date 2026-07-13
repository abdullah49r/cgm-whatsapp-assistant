require('dotenv').config();

function num(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function str(name, def = '') {
  return (process.env[name] || def).trim();
}

const config = {
  openRouterKey: str('OPENROUTER_API_KEY'),
  openRouterModel: str('OPENROUTER_MODEL', 'google/gemini-2.5-flash'),

  libreEmail: str('LIBREVIEW_EMAIL'),
  librePassword: str('LIBREVIEW_PASSWORD'),
  libreRegion: str('LIBREVIEW_REGION'),

  // CGM provider: libre or dexcom — a switch made from WhatsApp setup or the
  // dashboard is stored in db.settings and takes priority over these defaults
  cgmProvider: str('CGM_PROVIDER', 'libre'),
  dexcomUsername: str('DEXCOM_USERNAME'),
  dexcomPassword: str('DEXCOM_PASSWORD'),
  dexcomRegion: str('DEXCOM_REGION', 'ous'),

  carbRatio: num('CARB_RATIO', 10),
  correctionFactor: num('CORRECTION_FACTOR', 50),
  targetBg: num('TARGET_BG', 110),
  maxBolus: num('MAX_BOLUS', 15),
  // 1 = whole units (standard pens); 0.5 for half-unit pens, 0.1 for pumps
  doseIncrement: num('DOSE_INCREMENT', 1),
  trendAdjustPct: num('TREND_ADJUST_PCT', 10),

  // Duration of insulin action (DIA) in hours — used for insulin-on-board
  diaHours: num('DIA_HOURS', 4),

  // Fatty-meal dose splitting: fat threshold in grams, first-part share, delay
  fatSplitG: num('FAT_SPLIT_G', 25),
  splitRatioPct: num('SPLIT_RATIO_PCT', 50),
  splitDelayMin: num('SPLIT_DELAY_MIN', 45),

  highAlert: num('HIGH_ALERT', 220),
  lowAlert: num('LOW_ALERT', 70),
  predictHighFrom: num('PREDICT_HIGH_FROM', 180),
  predictLowFrom: num('PREDICT_LOW_FROM', 90),
  pollMinutes: num('POLL_MINUTES', 5),
  highCooldownMin: num('HIGH_COOLDOWN_MIN', 45),
  lowCooldownMin: num('LOW_COOLDOWN_MIN', 15),
  // High-glucose follow-up: re-check every N minutes until it settles or drops
  followupMin: num('FOLLOWUP_MIN', 30),

  // Learning engine (adjusts the carb ratio mathematically from meal outcomes)
  tuneEnabled: num('TUNE_ENABLED', 1) === 1,
  tuneMinMeals: num('TUNE_MIN_MEALS', 10),
  tuneCooldownDays: num('TUNE_COOLDOWN_DAYS', 7),
  tuneMinRatio: num('TUNE_MIN_RATIO', 4),
  tuneMaxRatio: num('TUNE_MAX_RATIO', 20),

  adminPhone: str('ADMIN_PHONE').replace(/[^0-9]/g, ''),

  // Bot language (en, ar, zh, hi, es, fr, pt) — normally chosen in WhatsApp setup
  language: str('LANGUAGE', 'en'),

  // Web dashboard — refuses to start without a password
  dashPort: num('DASH_PORT', 8080),
  dashPassword: str('DASH_PASSWORD'),
};

// Settings editable from WhatsApp ("set <name> <value>") and the dashboard
const SETTABLE = {
  ratio: { key: 'carbRatio', min: 3, max: 30, label: 'Carb ratio (1:X g)' },
  isf: { key: 'correctionFactor', min: 10, max: 200, label: 'Correction factor (ISF)' },
  target: { key: 'targetBg', min: 80, max: 180, label: 'Target glucose' },
  high: { key: 'highAlert', min: 140, max: 400, label: 'High alert threshold' },
  low: { key: 'lowAlert', min: 54, max: 90, label: 'Low alert threshold' },
  maxbolus: { key: 'maxBolus', min: 1, max: 30, label: 'Max single dose' },
  fatsplit: { key: 'fatSplitG', min: 10, max: 100, label: 'Fat threshold for splitting (g)' },
  delay: { key: 'splitDelayMin', min: 15, max: 120, label: 'Second-part delay (min)' },
  followup: { key: 'followupMin', min: 15, max: 180, label: 'High follow-up interval (min)' },
  dia: { key: 'diaHours', min: 2, max: 8, label: 'Insulin action duration (hours)' },
};

// String settings that may be stored in db.settings (from WhatsApp setup or
// the dashboard) and should override .env on load
const STRING_KEYS = [
  'adminPhone',
  'language',
  'cgmProvider',
  'openRouterKey',
  'libreEmail',
  'librePassword',
  'libreRegion',
  'dexcomUsername',
  'dexcomPassword',
  'dexcomRegion',
];

// Apply persisted overrides (saved from WhatsApp/dashboard) on top of .env
function applySettings(overrides) {
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!(key in config)) continue;
    if (Number.isFinite(value) && typeof config[key] === 'number') config[key] = value;
    else if (typeof value === 'string' && value && STRING_KEYS.includes(key)) config[key] = value;
  }
}

function validateConfig() {
  const problems = [];
  if (!config.openRouterKey)
    problems.push('OPENROUTER_API_KEY not set — meal photo analysis will be unavailable');
  return problems;
}

module.exports = { config, validateConfig, applySettings, SETTABLE, STRING_KEYS };
