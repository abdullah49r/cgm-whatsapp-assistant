const { config } = require('./config');
const store = require('./store');

// Insulin on board (IOB) — the linear decay model used by classic insulin
// pumps: a dose loses effectiveness linearly over DIA (default 4 hours for
// rapid-acting insulin; package inserts quote 3-5 hours for rapid analogs)
function iobAt(now = Date.now()) {
  const diaMs = config.diaHours * 3600_000;
  let iob = 0;
  for (const d of store.db.doses) {
    const age = now - d.at;
    if (age >= 0 && age < diaMs) {
      iob += d.units * (1 - age / diaMs);
    }
  }
  return Math.round(iob * 10) / 10;
}

// Most recent dose within the given number of minutes
function lastDoseWithin(minutes, now = Date.now()) {
  const cutoff = now - minutes * 60_000;
  const recent = store.db.doses.filter((d) => d.at >= cutoff);
  if (!recent.length) return null;
  return recent.reduce((a, b) => (a.at > b.at ? a : b));
}

module.exports = { iobAt, lastDoseWithin };
