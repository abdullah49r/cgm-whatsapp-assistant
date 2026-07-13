const { config } = require('./config');
const { aiLanguageName } = require('./i18n');

// AI is used HERE only: identifying the food and estimating carbs and fat.
// Every dose calculation and decision after that is fixed math in dose.js

const SYSTEM_PROMPT = `You are a nutrition expert specialized in carbohydrate counting for people with diabetes.
You receive a written meal description from the user, and usually a photo of it as well.

Estimation rules:
1. The written description is the primary source for identifying the meal. Use the photo to estimate portion sizes and to spot additional items not mentioned.
2. If the description points to a known commercial product (restaurant chains or packaged products), use that product's officially published nutrition values instead of guessing visually.
3. Also estimate total fat in grams (fat_g) — fatty meals need insulin dose splitting.
4. Be realistic about portion sizes. If the content is not food or is too ambiguous, set is_food=false and explain why in notes.

Reply with JSON only, no other text and no code fences:
{
  "is_food": true,
  "items": [
    { "name": "item name", "portion": "estimated portion description", "carbs_g": 0 }
  ],
  "total_carbs_g": 0,
  "fat_g": 0,
  "confidence": "high | medium | low",
  "notes": "important notes if any (source of values, size assumptions...)"
}`;

function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callOpenRouter(userContent) {
  if (!config.openRouterKey) {
    throw new Error('Meal analysis is disabled — add OPENROUTER_API_KEY (or send it during setup)');
  }
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openRouterKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'CGM WhatsApp Assistant',
    },
    body: JSON.stringify({
      model: config.openRouterModel,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  const parsed = extractJson(content);
  if (!parsed) throw new Error(`Could not parse the model reply: ${String(content).slice(0, 200)}`);

  parsed.items = Array.isArray(parsed.items) ? parsed.items : [];
  if (!Number.isFinite(parsed.total_carbs_g)) {
    parsed.total_carbs_g = parsed.items.reduce(
      (sum, it) => sum + (Number.isFinite(it.carbs_g) ? it.carbs_g : 0),
      0
    );
  }
  if (!Number.isFinite(parsed.fat_g)) parsed.fat_g = null;
  return parsed;
}

// Analyze photo + description (the description is mandatory — enforced by the caller)
async function analyzeMeal(imageBuffer, mimeType = 'image/jpeg', description) {
  return callOpenRouter([
    { type: 'text', text: `User's meal description: "${description}"\nAnalyze the meal and estimate carbohydrates and fat. Write item names and notes in ${aiLanguageName()}.` },
    {
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}` },
    },
  ]);
}

// Text-only analysis (the "meal ..." command) — no photo
async function analyzeMealText(description) {
  return callOpenRouter([
    {
      type: 'text',
      text: `User's meal description (no photo): "${description}"\nEstimate carbohydrates and fat from the description, using official nutrition values if it is a known product. If no size is given, assume the standard size and state your assumption in notes. Write item names and notes in ${aiLanguageName()}.`,
    },
  ]);
}

module.exports = { analyzeMeal, analyzeMealText };
