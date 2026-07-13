const store = require('./store');
const { config } = require('./config');
const { analyzeMeal, analyzeMealText } = require('./vision');
const { calculateDose, makeSplitPlan } = require('./dose');
const { iobAt } = require('./iob');
const { formatMealResponse } = require('./messages');
const { t } = require('./i18n');

// The single path for any meal (photo + description, or description only):
// AI analysis → fixed math → suggestion + wait for "took"
async function processMeal({ desc, imageBuffer = null, mimeType = 'image/jpeg', libre, reply, log }) {
  // No AI key yet → walk the user through getting one, right in the chat
  if (!config.openRouterKey) {
    await reply(t('or_guide'));
    return;
  }

  let meal, reading;
  try {
    [meal, reading] = await Promise.all([
      imageBuffer ? analyzeMeal(imageBuffer, mimeType, desc) : analyzeMealText(desc),
      libre.getLatestReading().catch((err) => {
        log?.warn({ err: err.message }, 'Failed to fetch reading');
        return null;
      }),
    ]);
  } catch (err) {
    // Out of OpenRouter credits → targeted guidance instead of a raw error
    if (/402|credit|insufficient/i.test(err.message)) {
      await reply(t('or_credits'));
      return;
    }
    throw err;
  }

  if (meal.is_food === false || meal.total_carbs_g == null) {
    await reply(t('not_a_meal') + (meal.notes ? `\n(${meal.notes})` : ''));
    return;
  }

  const iob = iobAt();
  const dose = calculateDose(meal.total_carbs_g, reading, { iob });
  const split = dose.noDose ? null : makeSplitPlan(dose.rounded, meal.fat_g);

  if (dose.noDose) {
    store.setLastSuggestion(null);
  } else {
    // units = the full dose; splitting is opt-in via the "split" reply
    store.setLastSuggestion({
      kind: 'meal',
      desc,
      carbs: meal.total_carbs_g,
      fatG: meal.fat_g,
      preBg: reading?.value ?? null,
      units: dose.rounded,
      totalUnits: dose.rounded,
      splitPlan: split,
    });
  }

  await reply(formatMealResponse(meal, reading, dose, split));
}

module.exports = { processMeal };
