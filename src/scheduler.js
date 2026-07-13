const { config } = require('./config');
const store = require('./store');
const { iobAt } = require('./iob');
const { correctionOnly, fmt } = require('./dose');
const learn = require('./learn');
const { t } = require('./i18n');

// The scheduler executes tasks persisted in the database (they survive restarts)
// - split2: reminder for the second part of a split dose
// - outcome: check the meal outcome after 2h and 3h (feeds the learning engine)
// - followup_high: keep following a high until glucose comes down

const OVERDUE_DROP_MIN = 90; // a task overdue by more than this is dropped (bot was off)

function isMuted() {
  return Date.now() < (store.db.alertState.muteUntil || 0);
}

function classifyBg(bg) {
  if (bg < 70) return t('cls_low');
  if (bg <= 180) return t('cls_ok');
  if (bg <= 250) return t('cls_above');
  return t('cls_vhigh');
}

// ===== Scheduling (called from other modules) =====

function scheduleOutcomeChecks(mealId, baseAt = Date.now()) {
  store.addReminder('outcome', baseAt + 2 * 3600_000, { mealId, stage: '2h' });
  store.addReminder('outcome', baseAt + 3 * 3600_000, { mealId, stage: '3h' });
}

function scheduleSplit2(units, mealId, delayMin) {
  store.addReminder('split2', Date.now() + delayMin * 60_000, { units, mealId });
}

function ensureHighFollowup(baselineBg, count = 1) {
  if (store.pendingReminders(['followup_high']).length > 0) return;
  store.addReminder('followup_high', Date.now() + config.followupMin * 60_000, {
    baselineBg,
    count,
  });
}

function cancelFollowups() {
  return store.cancelReminders(['followup_high']);
}

// ===== Task execution =====

async function handleSplit2(r, { libre, sendToAdmin }) {
  const units = r.payload.units;
  let reading = null;
  try {
    reading = await libre.getLatestReading();
  } catch {}

  if (reading && reading.value <= config.lowAlert) {
    store.setLastSuggestion(null);
    await sendToAdmin(t('split2_low', { bg: reading.value }));
    return;
  }
  if (reading && reading.value < 120 && (reading.trend?.dir ?? 0) < 0) {
    const half = Math.max(config.doseIncrement, Math.round(units / 2 / config.doseIncrement) * config.doseIncrement);
    store.setLastSuggestion({ kind: 'split2', units: half, totalUnits: half, mealId: r.payload.mealId });
    await sendToAdmin(t('split2_reduced', { bg: reading.value, units: fmt(half) }));
    return;
  }
  store.setLastSuggestion({ kind: 'split2', units, totalUnits: units, mealId: r.payload.mealId });
  await sendToAdmin(t('split2_due', { units: fmt(units) }));
}

async function handleOutcome(r, { libre, sendToAdmin }) {
  const meal = store.getMeal(r.payload.mealId);
  if (!meal) return;

  let reading;
  try {
    reading = await libre.getLatestReading();
  } catch {
    // Retry in 10 minutes (3 attempts max)
    const retries = (r.payload.retries || 0) + 1;
    if (retries <= 3) {
      store.addReminder('outcome', Date.now() + 10 * 60_000, { ...r.payload, retries });
    }
    return;
  }

  const bg = reading.value;
  if (r.payload.stage === '2h') {
    // Silent logging — actual lows/highs are covered by the periodic monitor
    meal.outcome2h = bg;
    store.save();
  } else {
    meal.outcome3h = bg;
    meal.qualified = learn.qualifyMeal(meal);
    store.save();
    const delta = meal.preBg != null ? ` (${bg - meal.preBg >= 0 ? '+' : ''}${bg - meal.preBg})` : '';
    await sendToAdmin(t('outcome_3h', { bg, cls: classifyBg(bg), delta }));
    // After every complete outcome, evaluate whether the ratio needs tuning (pure math)
    const tuneMsg = learn.evaluate();
    if (tuneMsg) await sendToAdmin(tuneMsg);
  }
}

async function handleHighFollowup(r, { libre, sendToAdmin, log }) {
  // While muted, postpone the follow-up to just after the mute ends
  if (isMuted()) {
    store.addReminder('followup_high', store.db.alertState.muteUntil + 60_000, r.payload);
    return;
  }

  let reading;
  try {
    reading = await libre.getLatestReading();
  } catch {
    const retries = (r.payload.retries || 0) + 1;
    if (retries <= 3) {
      store.addReminder('followup_high', Date.now() + 10 * 60_000, { ...r.payload, retries });
    }
    return;
  }

  const bg = reading.value;
  const dir = reading.trend?.dir ?? 0;
  const { baselineBg, count } = r.payload;
  const iob = iobAt();

  // Conditions to end the chain (one short message, then silence):
  // dropped below the alert line, trending down, or stable with insulin working
  if (bg < config.highAlert || dir <= -1 || (dir === 0 && iob >= 1)) {
    await sendToAdmin(t('under_control', { bg, arrow: reading.trend.arrow }));
    return;
  }

  // Still high (stable with no active insulin, or rising) → short alert every interval
  const lines = [t('still_high', { bg, arrow: reading.trend.arrow, bg0: baselineBg })];

  if (iob >= 1) {
    lines.push(t('dont_stack', { iob: iob.toFixed(1) }));
  } else {
    const corr = correctionOnly(reading, iob);
    if (corr > 0) {
      lines.push(t('corr_suggest', { units: fmt(corr) }));
      // Don't overwrite a fresh unconfirmed meal suggestion
      const fresh = store.getLastSuggestion(20);
      if (!fresh || fresh.kind !== 'meal') {
        store.setLastSuggestion({ kind: 'correction', units: corr, totalUnits: corr, preBg: bg });
      }
    }
  }

  if (bg >= 300) lines.push(t('ketones_pen'));
  if (count >= 3) lines.push(t('no_improvement'));

  await sendToAdmin(lines.join('\n'));
  store.addReminder('followup_high', Date.now() + config.followupMin * 60_000, {
    baselineBg: bg,
    count: count + 1,
  });
}

// ===== Main loop =====

// Execute everything due now (called periodically, and at boot to catch up)
async function processDue(ctx) {
  const due = store.dueReminders();
  for (const r of due) {
    store.removeReminder(r.id);

    // Very old task (the bot was off) — drop it, with a note if it was a dose
    if (Date.now() - r.dueAt > OVERDUE_DROP_MIN * 60_000) {
      if (r.type === 'split2') {
        await ctx.sendToAdmin(t('overdue_split', { units: r.payload.units }));
      }
      continue;
    }

    try {
      if (r.type === 'split2') await handleSplit2(r, ctx);
      else if (r.type === 'outcome') await handleOutcome(r, ctx);
      else if (r.type === 'followup_high') await handleHighFollowup(r, ctx);
    } catch (err) {
      ctx.log.error({ err: err.message, type: r.type }, 'Scheduled task failed');
    }
  }
}

function startScheduler(ctx) {
  const interval = setInterval(() => processDue(ctx), 60_000);
  ctx.log.info('Scheduler running: checking tasks every minute');
  return () => clearInterval(interval);
}

module.exports = {
  startScheduler,
  processDue,
  scheduleOutcomeChecks,
  scheduleSplit2,
  ensureHighFollowup,
  cancelFollowups,
  isMuted,
  classifyBg,
};
