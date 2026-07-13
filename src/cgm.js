const { config } = require('./config');
const store = require('./store');
const { LibreClient } = require('./libre');
const { DexcomClient } = require('./dexcom');

// CGM provider manager — one layer above LibreView and Dexcom Share:
// the rest of the codebase only calls getLatestReading() and never knows
// which provider is active. The choice and credentials are stored in
// db.settings (priority over .env) so switching works at runtime without
// a restart — from WhatsApp setup or the dashboard.

const PROVIDERS = {
  libre: { label: 'FreeStyle Libre (LibreLinkUp)' },
  dexcom: { label: 'Dexcom (Share)' },
};

let active = null; // { name, client }

function savedLibreCreds() {
  const s = store.db.settings;
  return {
    email: s.libreEmail || config.libreEmail,
    password: s.librePassword || config.librePassword,
    region: s.libreRegion || config.libreRegion,
  };
}

function savedDexcomCreds() {
  const s = store.db.settings;
  return {
    username: s.dexcomUsername || config.dexcomUsername,
    password: s.dexcomPassword || config.dexcomPassword,
    region: s.dexcomRegion || config.dexcomRegion || 'ous',
  };
}

function buildClient(name, creds = null) {
  if (name === 'dexcom') return new DexcomClient(creds || savedDexcomCreds());
  return new LibreClient(creds || savedLibreCreds());
}

function init() {
  const name = store.db.settings.cgmProvider || config.cgmProvider || 'libre';
  active = { name: PROVIDERS[name] ? name : 'libre', client: buildClient(name) };
  return active.name;
}

function providerName() {
  return active?.name || 'libre';
}

function providerLabel() {
  return PROVIDERS[providerName()].label;
}

function isConfigured() {
  const name = active?.name || store.db.settings.cgmProvider || config.cgmProvider || 'libre';
  const c = name === 'dexcom' ? savedDexcomCreds() : savedLibreCreds();
  return name === 'dexcom' ? !!(c.username && c.password) : !!(c.email && c.password);
}

async function getLatestReading() {
  if (!active) init();
  return active.client.getLatestReading();
}

// Try a provider with given credentials without activating it — returns the reading
async function testProvider(name, creds = null) {
  if (!PROVIDERS[name]) throw new Error(`Unknown provider: ${name}`);
  const client = buildClient(name, creds);
  return client.getLatestReading();
}

// The actual switch: test first, then persist and activate immediately
async function switchProvider(name, creds = null) {
  if (!PROVIDERS[name]) throw new Error(`Unknown provider: ${name}`);
  const client = buildClient(name, creds);
  const reading = await client.getLatestReading(); // failure here = no switch

  store.db.settings.cgmProvider = name;
  if (creds) {
    if (name === 'dexcom') {
      store.db.settings.dexcomUsername = creds.username;
      store.db.settings.dexcomPassword = creds.password;
      store.db.settings.dexcomRegion = creds.region || 'ous';
    } else {
      store.db.settings.libreEmail = creds.email;
      store.db.settings.librePassword = creds.password;
      if (creds.region) store.db.settings.libreRegion = creds.region;
    }
  }
  store.save();
  active = { name, client };
  return reading;
}

module.exports = {
  PROVIDERS,
  init,
  providerName,
  providerLabel,
  isConfigured,
  getLatestReading,
  testProvider,
  switchProvider,
  savedLibreCreds,
  savedDexcomCreds,
};
