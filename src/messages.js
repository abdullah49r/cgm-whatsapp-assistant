const { config, SETTABLE } = require('./config');
const { fmt } = require('./dose');
const { t } = require('./i18n');

// Every bot message is a short fixed template (localized in i18n.js) —
// no AI-generated text

function readingLine(reading) {
  if (!reading) return t('reading_unavailable');
  const age =
    reading.ageMinutes == null || reading.ageMinutes === 0
      ? ''
      : t('reading_age', { m: reading.ageMinutes });
  return `🩸 *${reading.value}* ${reading.trend.arrow} ${t('trend_' + reading.trend.key)}${age}`;
}

// Meal message — compact: contents, reading, dose, reply options
function formatMealResponse(meal, reading, dose, split) {
  const parts = [];

  const names = meal.items.map((it) => it.name).filter(Boolean).join(', ') || t('meal_word');
  const fat = meal.fat_g != null ? t('fat_part', { fat: fmt(meal.fat_g) }) : '';
  parts.push(`🍽️ ${names}`);
  parts.push(t('carbs_line', { carbs: fmt(meal.total_carbs_g), fat }));
  if (meal.confidence === 'low') parts.push(t('low_confidence'));

  parts.push(readingLine(reading));

  if (dose.noDose) {
    parts.push('', dose.text);
    return parts.join('\n');
  }

  parts.push('', t('dose_line', { units: fmt(dose.rounded), summary: dose.summary }));
  if (dose.warnings.length) parts.push(...dose.warnings);

  if (split) {
    parts.push(
      t('split_line', { p1: fmt(split.part1), p2: fmt(split.part2), delay: split.delayMin })
    );
    parts.push('', t('reply_split_options'));
  } else {
    parts.push('', t('reply_options'));
  }

  parts.push(t('disclaimer'));
  return parts.join('\n');
}

function formatReadingResponse(reading, iob) {
  const parts = [readingLine(reading)];
  if (reading.value >= config.highAlert) parts.push(t('above_high', { high: config.highAlert }));
  else if (reading.value <= config.lowAlert) parts.push(t('below_low', { low: config.lowAlert }));
  if (iob > 0) parts.push(t('status_iob', { iob: iob.toFixed(1) }));
  return parts.join('\n');
}

function settingsText() {
  const rows = Object.entries(SETTABLE).map(
    ([name, s]) => `${s.label}: *${config[s.key]}*  (set ${name} ...)`
  );
  return [
    t('settings_header'),
    ...rows,
    t('settings_learning', {
      state: t(config.tuneEnabled ? 'on' : 'off'),
      meals: config.tuneMinMeals,
      days: config.tuneCooldownDays,
    }),
  ].join('\n');
}

function helpText() {
  return t('help');
}

module.exports = { formatMealResponse, formatReadingResponse, settingsText, helpText, readingLine };
