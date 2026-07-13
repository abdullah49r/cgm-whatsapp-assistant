const { config } = require('./config');
const store = require('./store');
const { t } = require('./i18n');

// ===== Learning engine — pure math, no AI =====
//
// Methodology (drawn from standard clinical titration practice):
// - Carb-ratio validity test: with a correct ratio, glucose returns to near
//   its pre-meal value 3-4 hours after eating (within ~30-50 mg/dL) — a
//   well-known rule in intensive insulin therapy education
//   (Walsh "Using Insulin", Scheiner "Think Like a Pancreas").
// - Gradual adjustment: a single step only (±1 in the ratio ≈ 10-12% dose
//   strength change), matching titration guidance (adjust 10-20% after a
//   repeated pattern, never after a single event).
// - Strict preconditions: enough qualified meals (default 10), a cooldown
//   between changes (default 7 days), and hard min/max ratio bounds.
// - Safety first: repeated post-meal lows weaken doses immediately (raise
//   the ratio) even if the median looks fine — lows are more dangerous
//   than highs.

const WINDOW_DAYS = 30; // ignore meals older than a month
const UNDER_DOSED_DELTA = 50; // median delta above this ⇒ doses too weak
const OVER_DOSED_DELTA = -30; // median delta below this ⇒ doses too strong
const MIN_LOWS_TO_WEAKEN = 2; // two post-meal lows are enough to weaken doses

// Is this meal usable for learning? (no other doses/meals polluting the outcome)
function qualifyMeal(meal) {
  if (meal.preBg == null || meal.outcome3h == null || !meal.units) return false;
  if (meal.preBg < 70 || meal.preBg > 250) return false;

  // A split meal whose second part was never taken → polluted outcome
  if (meal.splitPlanned) {
    const split2Taken = store.db.doses.some((d) => d.mealId === meal.id && d.kind === 'split2');
    if (!split2Taken) return false;
  }

  const windowEnd = meal.at + 3.25 * 3600_000;
  const interferingDose = store.db.doses.some(
    (d) => d.at > meal.at + 60_000 && d.at < windowEnd && d.mealId !== meal.id
  );
  const interferingMeal = store.db.meals.some(
    (m) => m.id !== meal.id && m.at > meal.at && m.at < windowEnd
  );
  return !interferingDose && !interferingMeal;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Called after every 3-hour outcome — returns a change message or null
function evaluate() {
  if (!config.tuneEnabled) return null;

  const now = Date.now();
  const t = store.db.tuning;
  if (now - t.lastChangeAt < config.tuneCooldownDays * 24 * 3600_000) return null;

  const since = Math.max(t.lastChangeAt, now - WINDOW_DAYS * 24 * 3600_000);
  const qualified = store.db.meals.filter((m) => m.at > since && m.qualified === true);
  if (qualified.length < config.tuneMinMeals) return null;

  const deltas = qualified.map((m) => m.outcome3h - m.preBg);
  const med = Math.round(median(deltas));
  const lows = qualified.filter(
    (m) => (m.outcome2h != null && m.outcome2h < 70) || m.outcome3h < 70
  ).length;

  const current = config.carbRatio;
  let next = current;
  let reason = '';

  if (lows >= MIN_LOWS_TO_WEAKEN || med < OVER_DOSED_DELTA) {
    next = current + 1; // bigger ratio = weaker doses
    reason =
      lows >= MIN_LOWS_TO_WEAKEN
        ? t('tune_lows', { lows })
        : t('tune_drop', { med });
  } else if (med > UNDER_DOSED_DELTA) {
    next = current - 1; // smaller ratio = stronger doses
    reason = t('tune_high', { med, max: UNDER_DOSED_DELTA });
  }

  next = Math.min(config.tuneMaxRatio, Math.max(config.tuneMinRatio, next));
  if (next === current) return null;

  // Apply and persist the change
  config.carbRatio = next;
  store.db.settings.carbRatio = next;
  t.lastChangeAt = now;
  t.history.push({ at: now, from: current, to: next, medianDelta: med, meals: qualified.length, lows });
  store.save();

  return [
    t('tune_changed', { from: current, to: next }),
    t('tune_reason', { n: qualified.length, reason }),
    t('tune_undo', { from: current }),
  ].join('\n');
}

// Current learning progress (for the "status" command)
function statusSummary() {
  const t = store.db.tuning;
  const since = Math.max(t.lastChangeAt, Date.now() - WINDOW_DAYS * 24 * 3600_000);
  const qualified = store.db.meals.filter((m) => m.at > since && m.qualified === true).length;
  return { qualified, needed: config.tuneMinMeals, changes: t.history.length };
}

module.exports = { evaluate, qualifyMeal, statusSummary };
