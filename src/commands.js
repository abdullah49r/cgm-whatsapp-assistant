const { config, SETTABLE } = require('./config');
const store = require('./store');
const { iobAt } = require('./iob');
const { calculateDose, roundTo, fmt } = require('./dose');
const { formatReadingResponse, settingsText, helpText } = require('./messages');
const { scheduleOutcomeChecks, scheduleSplit2 } = require('./scheduler');
const { processMeal } = require('./mealflow');
const learn = require('./learn');
const setup = require('./setup');
const i18n = require('./i18n');

const { t } = i18n;

// Invisible characters some keyboards insert: ZWSP..RLM (200B-200F),
// directional marks (202A-202E), WJ (2060), BOM (FEFF)
const INVISIBLE = new RegExp(
  '[' +
    String.fromCharCode(0x200b) + '-' + String.fromCharCode(0x200f) +
    String.fromCharCode(0x202a) + '-' + String.fromCharCode(0x202e) +
    String.fromCharCode(0x2060) + String.fromCharCode(0xfeff) +
    ']',
  'g'
);

// Normalize before matching commands: strip the optional "/", invisible
// characters, convert Arabic/Persian digits and the Arabic decimal separator
function normalize(text) {
  return text
    .replace(INVISIBLE, '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\/\s*/, '');
}

// An OpenRouter API key pasted into the chat → verify it live, then save
async function connectApiKey(key, ctx) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    await ctx.reply(t('or_key_invalid', { error: err.message }));
    return;
  }
  config.openRouterKey = key;
  store.db.settings.openRouterKey = key;
  store.save();
  await ctx.reply(t('or_key_saved'));
}

// Record a taken dose — units: what was actually injected.
// For a meal with a split plan: taking at least 1U less than the full dose
// → remind about the remainder only. Taking it all (or more) → no reminder.
async function recordTakenDose(units, ctx) {
  const { reply } = ctx;

  if (units <= 0 || units > 40) {
    await reply(t('bad_amount'));
    return;
  }

  const suggestion = store.getLastSuggestion(90);
  const kind = suggestion?.kind ?? 'manual';
  const lines = [];

  if (kind === 'meal') {
    const total = suggestion.totalUnits ?? suggestion.units;
    const remainder = roundTo(Math.max(0, total - units), config.doseIncrement);
    const remind = !!suggestion.splitPlan && remainder >= 1;

    const meal = store.addMeal({
      desc: suggestion.desc || '-',
      carbs: suggestion.carbs,
      fatG: suggestion.fatG,
      units,
      preBg: suggestion.preBg,
      splitPlanned: remind,
    });
    store.addDose({ units, kind: 'meal', carbs: suggestion.carbs, preBg: suggestion.preBg, mealId: meal.id });
    scheduleOutcomeChecks(meal.id);

    lines.push(t('logged_units', { units: fmt(units) }));
    if (remind) {
      scheduleSplit2(remainder, meal.id, suggestion.splitPlan.delayMin);
      lines.push(t('remind_remainder', { units: fmt(remainder), min: suggestion.splitPlan.delayMin }));
    } else if (units - total >= 1) {
      lines.push(t('more_than_suggested', { units: fmt(total) }));
    }
  } else if (kind === 'split2') {
    const meal = suggestion.mealId ? store.getMeal(suggestion.mealId) : null;
    store.addDose({ units, kind: 'split2', mealId: suggestion.mealId ?? null });
    if (meal) {
      meal.units += units;
      store.save();
    }
    lines.push(t('logged_remainder', { units: fmt(units) }));
  } else if (kind === 'correction') {
    store.addDose({ units, kind: 'correction', preBg: suggestion.preBg ?? null });
    lines.push(t('logged_correction', { units: fmt(units) }));
  } else {
    store.addDose({ units, kind: 'manual' });
    lines.push(t('logged_manual', { units: fmt(units), iob: iobAt().toFixed(1) }));
  }

  store.db.alertState.awaitingUnitsUntil = 0;
  store.setLastSuggestion(null);
  await reply(lines.join('\n'));
}

// Handle a text command — returns true when the text was handled
// ctx: { reply, libre, log, clearPendingImage? }
async function handleCommand(text, ctx) {
  const { reply, libre, log } = ctx;

  // A pasted OpenRouter key (raw text — keys are case-sensitive)
  const keyMatch = text.trim().match(/^(sk-or-[A-Za-z0-9_\-]{10,})$/);
  if (keyMatch) {
    await connectApiKey(keyMatch[1], ctx);
    return true;
  }

  const tx = normalize(text);

  // ===== Current reading =====
  if (/^(bg|sugar|reading|glucose)$/i.test(tx)) {
    try {
      const reading = await libre.getLatestReading();
      await reply(formatReadingResponse(reading, iobAt()));
    } catch (err) {
      await reply(t('fetch_failed', { error: err.message }));
    }
    return true;
  }

  // ===== Help =====
  if (/^(help|commands|\?)$/i.test(tx)) {
    await reply(helpText());
    return true;
  }

  // ===== Language picker =====
  if (/^(language|lang|idioma|langue|لغة|اللغة|语言|भाषा)$/i.test(tx)) {
    await setup.askLanguage(ctx);
    return true;
  }

  // ===== Re-run guided setup =====
  if (/^setup$/i.test(tx)) {
    await setup.begin(ctx);
    return true;
  }

  // ===== Show settings =====
  if (/^settings$/i.test(tx)) {
    await reply(settingsText());
    return true;
  }

  // ===== Change a setting: "set ratio 10" =====
  const setMatch = tx.match(/^set\s+([a-z]+)\s*(\d+(?:\.\d+)?)$/i);
  if (setMatch) {
    const name = setMatch[1].toLowerCase();
    const value = parseFloat(setMatch[2]);
    const setting = SETTABLE[name];
    if (!setting) {
      await reply(t('available_settings', { list: Object.keys(SETTABLE).join(', ') }));
      return true;
    }
    if (value < setting.min || value > setting.max) {
      await reply(t('setting_range', { label: setting.label, min: setting.min, max: setting.max }));
      return true;
    }
    const old = config[setting.key];
    config[setting.key] = value;
    store.db.settings[setting.key] = value;
    // A manual carb-ratio change restarts the learning window
    if (setting.key === 'carbRatio') {
      store.db.tuning.lastChangeAt = Date.now();
      store.db.tuning.history.push({ at: Date.now(), from: old, to: value, manual: true });
    }
    store.save();
    await reply(t('setting_changed', { label: setting.label, old, value }));
    return true;
  }

  // ===== "took it" — the full suggested dose =====
  if (/^(took it|taken|i took it|done)$/i.test(tx)) {
    const suggestion = store.getLastSuggestion(90);
    if (!suggestion) {
      await reply(t('no_suggestion'));
      return true;
    }
    await recordTakenDose(suggestion.totalUnits ?? suggestion.units, ctx);
    return true;
  }

  // ===== "split" — take the first part of the split plan =====
  if (/^(split|split it|splitting)$/i.test(tx)) {
    const suggestion = store.getLastSuggestion(90);
    if (!suggestion?.splitPlan) {
      await reply(t('no_split_plan'));
      return true;
    }
    await recordTakenDose(suggestion.splitPlan.part1, ctx);
    return true;
  }

  // ===== "took 7" — a specific amount =====
  const tookMatch = tx.match(/^(?:i )?took\s*(\d+(?:\.\d+)?)?\s*(?:units?|u)?$/i);
  if (tookMatch) {
    if (!tookMatch[1]) {
      const suggestion = store.getLastSuggestion(90);
      if (suggestion) {
        await recordTakenDose(suggestion.totalUnits ?? suggestion.units, ctx);
        return true;
      }
      // Accept a bare-number reply for 10 minutes after this question
      store.db.alertState.awaitingUnitsUntil = Date.now() + 10 * 60_000;
      store.save();
      await reply(t('how_many_units'));
      return true;
    }
    await recordTakenDose(parseFloat(tookMatch[1]), ctx);
    return true;
  }

  // Bare-number reply right after "how many units?"
  const bareNum = tx.match(/^(\d+(?:\.\d+)?)$/);
  if (bareNum && (store.db.alertState.awaitingUnitsUntil || 0) > Date.now()) {
    await recordTakenDose(parseFloat(bareNum[1]), ctx);
    return true;
  }

  // Numbered reply to an active suggestion menu:
  // 1 = took the suggested dose, 2 = split (or "different amount" when no
  // split plan was offered — matches what the menu displayed), 3 = different amount
  if (/^[123]$/.test(tx)) {
    const suggestion = store.getLastSuggestion(90);
    if (suggestion) {
      if (tx === '1') {
        await recordTakenDose(suggestion.totalUnits ?? suggestion.units, ctx);
        return true;
      }
      if (tx === '2' && suggestion.splitPlan) {
        await recordTakenDose(suggestion.splitPlan.part1, ctx);
        return true;
      }
      // "3", or "2" when the menu had no split option
      store.db.alertState.awaitingUnitsUntil = Date.now() + 10 * 60_000;
      store.save();
      await reply(t('how_many_units'));
      return true;
    }
  }

  // ===== Mute alerts =====
  const muteMatch = tx.match(/^mute\s*(\d+(?:\.\d+)?)?\s*(?:h|hr|hours?)?$/i);
  if (muteMatch) {
    const hours = muteMatch[1] ? parseFloat(muteMatch[1]) : 1;
    if (hours < 0.5 || hours > 12) {
      await reply(t('mute_range'));
      return true;
    }
    store.db.alertState.muteUntil = Date.now() + hours * 3600_000;
    store.save();
    await reply(t('muted_for', { hours }));
    return true;
  }

  if (/^(unmute|alerts on)$/i.test(tx)) {
    store.db.alertState.muteUntil = 0;
    store.save();
    await reply(t('alerts_on'));
    return true;
  }

  // ===== Cancel reminders and follow-ups =====
  if (/^cancel$/i.test(tx)) {
    const n = store.cancelReminders(['split2', 'followup_high']);
    store.setLastSuggestion(null);
    ctx.clearPendingImage?.();
    await reply(n > 0 ? t('cancelled_n', { n }) : t('nothing_pending'));
    return true;
  }

  // ===== Status =====
  if (/^status$/i.test(tx)) {
    const muteUntil = store.db.alertState.muteUntil;
    const pending = store.pendingReminders();
    const ls = learn.statusSummary();
    const typeNames = { split2: t('rem_split2'), outcome: t('rem_outcome'), followup_high: t('rem_followup') };
    const lines = [
      t('status_iob', { iob: iobAt().toFixed(1) }),
      t('status_learning', { q: ls.qualified, n: ls.needed }),
    ];
    if (muteUntil > Date.now()) {
      const time = new Date(muteUntil).toLocaleTimeString(i18n.locale(), { hour: '2-digit', minute: '2-digit' });
      lines.push(t('status_muted_until', { time }));
    }
    for (const r of pending.slice(0, 4)) {
      const mins = Math.max(0, Math.round((r.dueAt - Date.now()) / 60000));
      lines.push(t('status_reminder', { name: typeNames[r.type] || r.type, min: mins }));
    }
    await reply(lines.join('\n'));
    return true;
  }

  // ===== "dose 45" — known carbs =====
  const doseMatch = tx.match(/^dose\s*(\d+(?:\.\d+)?)\s*(?:g|grams?)?$/i);
  if (doseMatch) {
    const carbs = parseFloat(doseMatch[1]);
    const reading = await libre.getLatestReading().catch(() => null);
    const dose = calculateDose(carbs, reading, { iob: iobAt() });
    if (dose.noDose) {
      store.setLastSuggestion(null);
      await reply(dose.text);
    } else {
      store.setLastSuggestion({
        kind: 'meal',
        desc: `${carbs}g`,
        carbs,
        fatG: null,
        preBg: reading?.value ?? null,
        units: dose.rounded,
        totalUnits: dose.rounded,
        splitPlan: null,
      });
      await reply(
        [
          t('dose_for', { carbs, units: fmt(dose.rounded), summary: dose.summary }),
          ...dose.warnings,
          '',
          t('reply_took_options'),
          t('disclaimer'),
        ].join('\n')
      );
    }
    return true;
  }

  // ===== "meal big mac" — text description =====
  const mealMatch = tx.match(/^meal\s+(.{2,})$/i);
  if (mealMatch) {
    await reply(t('analyzing'));
    await processMeal({ desc: mealMatch[1].trim(), libre, reply, log });
    return true;
  }

  return false;
}

module.exports = { handleCommand };
