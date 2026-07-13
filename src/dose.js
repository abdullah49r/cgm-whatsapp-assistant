const { config } = require('./config');
const { t } = require('./i18n');

function roundTo(value, inc) {
  return Math.round(value / inc) * inc;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Dose calculation — fixed formulas following standard clinical practice:
// meal dose = carbs / insulin-to-carb ratio (ICR)
// correction = (glucose − target) / correction factor (ISF)
// insulin on board (IOB) is deducted from the correction part only — as in
// pump bolus calculators
// trend adjustment: ±10% per arrow step (published CGM percentage method)
// Returns: { noDose, rounded, summary (one line), warnings[] (short) }
function calculateDose(carbs, reading, { iob = 0 } = {}) {
  const warnings = [];
  const segs = [];

  const mealDose = carbs / config.carbRatio;
  segs.push(t('seg_meal', { v: mealDose.toFixed(1) }));

  let correction = 0;
  let trendPct = 0;
  let bg = null;

  if (reading) {
    bg = reading.value;
    if (reading.ageMinutes == null || reading.ageMinutes > 15) {
      warnings.push(t('warn_stale'));
      bg = null;
    }
  } else {
    warnings.push(t('warn_no_reading'));
  }

  if (bg != null) {
    if (bg <= config.lowAlert) {
      return {
        noDose: true,
        text: t('nodose_low', { bg }),
      };
    }

    correction = (bg - config.targetBg) / config.correctionFactor;
    if (correction >= 0) {
      segs.push(t('seg_corr', { v: correction.toFixed(1) }));
      if (iob > 0) {
        const deducted = Math.min(correction, iob);
        segs.push(t('seg_iob', { v: deducted.toFixed(1) }));
        correction -= deducted;
      }
    } else {
      segs.push(t('seg_below', { v: Math.abs(correction).toFixed(1) }));
      if (iob > 0) warnings.push(t('warn_below_target_iob', { iob: iob.toFixed(1) }));
    }

    const dir = reading.trend?.dir ?? 0;
    trendPct = dir * config.trendAdjustPct;
    if (trendPct !== 0) segs.push(t('seg_trend', { sign: trendPct > 0 ? '+' : '−', pct: Math.abs(trendPct) }));

    if (bg < config.lowAlert + 15 && dir < 0) warnings.push(t('warn_near_low'));
    else if (dir === -2) warnings.push(t('warn_fast_drop'));
  }

  let total = (mealDose + correction) * (1 + trendPct / 100);
  if (total < 0) total = 0;
  let rounded = roundTo(total, config.doseIncrement);

  if (rounded > config.maxBolus) {
    warnings.push(t('warn_max', { max: config.maxBolus }));
    rounded = config.maxBolus;
  }

  return {
    noDose: false,
    mealDose,
    correction,
    trendPct,
    total,
    rounded,
    summary: segs.join(' '),
    warnings,
  };
}

// Split-dose plan for fatty meals — dual-wave style:
// fat delays glucose absorption and raises glucose late (Wolpert 2013, Bell 2015)
// Splitting is offered to the user — the decision is theirs
function makeSplitPlan(roundedTotal, fatG) {
  if (fatG == null || fatG < config.fatSplitG) return null;
  if (roundedTotal < 3) return null; // small doses are not worth splitting

  const part1 = roundTo((roundedTotal * config.splitRatioPct) / 100, config.doseIncrement);
  const part2 = roundTo(roundedTotal - part1, config.doseIncrement);
  if (part2 < 1) return null;

  return { part1, part2, delayMin: config.splitDelayMin, fatG };
}

// Correction-only dose (no meal) — deducts IOB to prevent insulin stacking
function correctionOnly(reading, iob = 0) {
  const bg = reading.value;
  let correction = (bg - config.targetBg) / config.correctionFactor;
  correction -= iob;
  const dir = reading.trend?.dir ?? 0;
  correction *= 1 + (dir * config.trendAdjustPct) / 100;
  if (correction < 0) correction = 0;
  let rounded = roundTo(correction, config.doseIncrement);
  if (rounded > config.maxBolus) rounded = config.maxBolus;
  return rounded;
}

module.exports = { calculateDose, makeSplitPlan, correctionOnly, fmt, roundTo };
