const fs = require('fs');
const path = require('path');

// Persistent single-file JSON store — doses, meals, reminders, settings, readings
const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULTS = {
  // Settings changed from WhatsApp/dashboard — take priority over .env
  settings: {},
  // Confirmed doses: { id, at, units, kind: 'meal'|'correction'|'split2'|'manual', carbs, preBg, mealId }
  doses: [],
  // Logged meals: { id, at, desc, carbs, fatG, units, preBg, outcome2h, outcome3h, qualified }
  meals: [],
  // Scheduled tasks: { id, type: 'split2'|'followup_high'|'outcome', dueAt, payload }
  reminders: [],
  // Learning engine: history of adjustments
  tuning: { lastChangeAt: 0, history: [] },
  // Alert state: temporary mute + last dose suggestion (so "took" works)
  alertState: { muteUntil: 0, lastSuggestion: null },
  // Reading log for the dashboard: { at, v (mg/dL), d (trend -2..2) } — ~15 days at 5-min cadence
  readings: [],
};

let db = null;
let idCounter = 0;

function load() {
  if (db) return db;
  db = structuredClone(DEFAULTS);
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] !== undefined) db[key] = raw[key];
    }
    // New nested keys introduced by updates
    db.tuning = { ...DEFAULTS.tuning, ...db.tuning };
    db.alertState = { ...DEFAULTS.alertState, ...db.alertState };
  } catch {}
  return db;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('Failed to save database:', err.message);
  }
}

function nextId() {
  return `${Date.now()}-${++idCounter}`;
}

// ===== Doses =====
function addDose({ units, kind, carbs = null, preBg = null, mealId = null, at = Date.now() }) {
  const dose = { id: nextId(), at, units, kind, carbs, preBg, mealId };
  db.doses.push(dose);
  if (db.doses.length > 2000) db.doses.splice(0, db.doses.length - 2000);
  save();
  return dose;
}

function dosesBetween(from, to) {
  return db.doses.filter((d) => d.at >= from && d.at <= to);
}

// ===== Reading log (for the dashboard) =====
function addReading({ at, value, dir = 0 }) {
  if (!at || !Number.isFinite(value)) return;
  const last = db.readings[db.readings.length - 1];
  if (last && last.at === at) return; // same sensor reading (5-min cadence)
  db.readings.push({ at, v: value, d: dir });
  if (db.readings.length > 4500) db.readings.splice(0, db.readings.length - 4500);
  save();
}

function readingsSince(from) {
  return db.readings.filter((r) => r.at >= from);
}

// ===== Meals =====
function addMeal({ desc, carbs, fatG, units, preBg, splitPlanned = false, at = Date.now() }) {
  const meal = {
    id: nextId(),
    at,
    desc,
    carbs,
    fatG: fatG ?? null,
    units,
    preBg: preBg ?? null,
    splitPlanned,
    outcome2h: null,
    outcome3h: null,
    qualified: null,
  };
  db.meals.push(meal);
  if (db.meals.length > 1000) db.meals.splice(0, db.meals.length - 1000);
  save();
  return meal;
}

function getMeal(id) {
  return db.meals.find((m) => m.id === id) || null;
}

// ===== Scheduled tasks =====
function addReminder(type, dueAt, payload = {}) {
  const r = { id: nextId(), type, dueAt, payload };
  db.reminders.push(r);
  save();
  return r;
}

function dueReminders(now = Date.now()) {
  return db.reminders.filter((r) => r.dueAt <= now);
}

function removeReminder(id) {
  db.reminders = db.reminders.filter((r) => r.id !== id);
  save();
}

function cancelReminders(types) {
  const before = db.reminders.length;
  db.reminders = db.reminders.filter((r) => !types.includes(r.type));
  if (db.reminders.length !== before) save();
  return before - db.reminders.length;
}

function pendingReminders(types = null) {
  return types ? db.reminders.filter((r) => types.includes(r.type)) : [...db.reminders];
}

// ===== Last dose suggestion (for the "took" command) =====
function setLastSuggestion(s) {
  db.alertState.lastSuggestion = s ? { ...s, at: s.at ?? Date.now() } : null;
  save();
}

function getLastSuggestion(maxAgeMin = 90) {
  const s = db.alertState.lastSuggestion;
  if (!s) return null;
  if (Date.now() - s.at > maxAgeMin * 60_000) return null;
  return s;
}

module.exports = {
  load,
  save,
  get db() {
    return load();
  },
  nextId,
  addDose,
  dosesBetween,
  addReading,
  readingsSince,
  addMeal,
  getMeal,
  addReminder,
  dueReminders,
  removeReminder,
  cancelReminders,
  pendingReminders,
  setLastSuggestion,
  getLastSuggestion,
};
