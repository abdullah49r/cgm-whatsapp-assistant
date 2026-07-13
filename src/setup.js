const crypto = require('crypto');
const { config } = require('./config');
const store = require('./store');
const cgm = require('./cgm');
const i18n = require('./i18n');

// Conversational onboarding over WhatsApp itself:
//
// 1. PAIRING — on first run (no ADMIN_PHONE anywhere) the console prints a
//    one-time 6-digit code. Whoever sends that code to the bot's WhatsApp
//    number becomes the admin: the person who receives alerts and controls
//    the bot. This works both when the bot runs on the user's own number
//    (message yourself) and on a dedicated second number.
//
// 2. SETUP — language first, then a mandatory medical notice, then a short
//    question-and-answer flow that collects the dosing parameters and CGM
//    credentials, tests the connection live, and saves everything to
//    db.settings. Every value can also be pre-filled in .env, in which case
//    the corresponding question still shows the default and can be skipped.

const { t } = i18n;

let pairingCode = null;
let state = null; // { step, data: {}, onlyLanguage? }

// ===== Pairing =====

function getPairingCode() {
  if (!pairingCode) pairingCode = String(crypto.randomInt(100000, 1000000));
  return pairingCode;
}

function isPaired() {
  return !!config.adminPhone && config.adminPhone.length >= 8;
}

// Returns true when this message claims admin successfully
function tryPair(text, senderDigits) {
  if (isPaired()) return false;
  if ((text || '').replace(/[^0-9]/g, '') !== getPairingCode()) return false;
  config.adminPhone = senderDigits;
  store.db.settings.adminPhone = senderDigits;
  store.save();
  pairingCode = null;
  return true;
}

// ===== Setup flow =====

function isActive() {
  return !!state;
}

// Setup is proposed automatically when nothing essential is configured yet
function needsSetup() {
  return !store.db.settings.setupComplete && !cgm.isConfigured();
}

function saveNumber(key, value) {
  config[key] = value;
  store.db.settings[key] = value;
  store.save();
}

const NUM_STEPS = {
  ratio: { key: 'carbRatio', min: 3, max: 30, def: null, q: 'q_ratio' },
  isf: { key: 'correctionFactor', min: 10, max: 200, def: null, q: 'q_isf' },
  target: { key: 'targetBg', min: 80, max: 180, def: 110, q: 'q_target' },
  high: { key: 'highAlert', min: 140, max: 400, def: 220, q: 'q_high' },
  low: { key: 'lowAlert', min: 54, max: 90, def: 70, q: 'q_low' },
  maxbolus: { key: 'maxBolus', min: 1, max: 30, def: 15, q: 'q_maxbolus' },
};
const NUM_ORDER = ['ratio', 'isf', 'target', 'high', 'low', 'maxbolus'];

// Full onboarding: language → medical notice → questions
async function begin(ctx) {
  state = { step: 'language', data: {} };
  await ctx.reply(i18n.languageMenu());
}

// Just the language picker (the "language" command)
async function askLanguage(ctx) {
  state = { step: 'language', data: {}, onlyLanguage: true };
  await ctx.reply(i18n.languageMenu());
}

async function afterLanguage(ctx) {
  if (state.onlyLanguage) {
    const code = i18n.lang();
    state = null;
    await ctx.reply(t('lang_set', { name: i18n.LANGS[code].name }));
    return;
  }
  state.step = 'ratio';
  await ctx.reply(t('medical_warning'));
  await ctx.reply(`${t('setup_intro')}\n\n${t(NUM_STEPS.ratio.q)}`);
}

async function finish(ctx) {
  const d = state.data;
  await ctx.reply(t('testing_conn'));
  try {
    const creds =
      d.provider === 'dexcom'
        ? { username: d.username, password: d.password, region: d.region || 'ous' }
        : { email: d.email, password: d.password, region: '' };
    const reading = await cgm.switchProvider(d.provider, creds);

    store.db.settings.setupComplete = true;
    store.save();
    state = null;

    await ctx.reply(
      t('connected_line', {
        value: reading.value,
        arrow: reading.trend.arrow,
        label: t('trend_' + reading.trend.key),
      }) + '\n\n' + t('setup_done_tips')
    );
  } catch (err) {
    await ctx.reply(t('connect_failed', { error: err.message }));
    state.step = 'connect_failed';
  }
}

async function askProviderCreds(ctx) {
  if (state.data.provider === 'dexcom') {
    state.step = 'dex_user';
    await ctx.reply(t('dex_user_q'));
  } else {
    state.step = 'libre_email';
    await ctx.reply(t('libre_email_q'));
  }
}

// Handles a message while setup is active. Returns true when consumed.
async function onMessage(text, ctx) {
  if (!state) return false;
  const raw = (text || '').trim();
  const tl = raw.toLowerCase();

  if (/^(cancel|stop|quit)$/i.test(tl)) {
    state = null;
    await ctx.reply(t('setup_cancelled'));
    return true;
  }

  // Language selection (step 0)
  if (state.step === 'language') {
    const code = i18n.parseLanguageChoice(raw);
    if (!code) {
      await ctx.reply(i18n.languageMenu());
      return true;
    }
    i18n.setLang(code);
    await afterLanguage(ctx);
    return true;
  }

  // Numeric steps
  if (NUM_STEPS[state.step]) {
    const s = NUM_STEPS[state.step];
    let value;
    if (/^(skip|default)$/i.test(tl) && s.def != null) {
      value = s.def;
    } else {
      value = parseFloat(raw.replace(/[^\d.]/g, ''));
      if (!Number.isFinite(value) || value < s.min || value > s.max) {
        await ctx.reply(t(s.def != null ? 'invalid_number_skip' : 'invalid_number', { min: s.min, max: s.max }));
        return true;
      }
    }
    saveNumber(s.key, value);

    const idx = NUM_ORDER.indexOf(state.step);
    const next = NUM_ORDER[idx + 1];
    if (next) {
      state.step = next;
      await ctx.reply(`${t('saved')}\n\n${t(NUM_STEPS[next].q)}`);
    } else {
      state.step = 'provider';
      await ctx.reply(`${t('saved')}\n\n${t('q_provider')}`);
    }
    return true;
  }

  switch (state.step) {
    case 'provider': {
      if (/^(1|libre|freestyle)/i.test(tl)) state.data.provider = 'libre';
      else if (/^(2|dexcom|dex)/i.test(tl)) state.data.provider = 'dexcom';
      else {
        await ctx.reply(t('provider_pick'));
        return true;
      }
      await askProviderCreds(ctx);
      return true;
    }

    case 'libre_email': {
      if (!raw.includes('@')) {
        await ctx.reply(t('email_invalid'));
        return true;
      }
      state.data.email = raw;
      state.step = 'password';
      await ctx.reply(t('password_q'));
      return true;
    }

    case 'dex_user': {
      if (raw.length < 3) {
        await ctx.reply(t('input_too_short'));
        return true;
      }
      state.data.username = raw;
      state.step = 'password';
      await ctx.reply(t('password_q'));
      return true;
    }

    case 'password': {
      if (raw.length < 4) {
        await ctx.reply(t('input_too_short'));
        return true;
      }
      state.data.password = raw;
      if (state.data.provider === 'dexcom') {
        state.step = 'dex_region';
        await ctx.reply(t('dex_region_q'));
      } else {
        await finish(ctx);
      }
      return true;
    }

    case 'dex_region': {
      if (/^(2|us|usa)$/i.test(tl)) state.data.region = 'us';
      else if (/^(3|jp|japan)$/i.test(tl)) state.data.region = 'jp';
      else state.data.region = 'ous'; // 1 / skip / anything else
      await finish(ctx);
      return true;
    }

    case 'connect_failed': {
      if (/^retry$/i.test(tl)) {
        await askProviderCreds(ctx);
      } else {
        await ctx.reply(t('retry_hint'));
      }
      return true;
    }
  }

  return false;
}

module.exports = { getPairingCode, isPaired, tryPair, isActive, needsSetup, begin, askLanguage, onMessage };
