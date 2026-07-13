const fs = require('fs');
const path = require('path');

// Unofficial Dexcom Share client — the same interface the Follow app uses
// (the community-proven path used by pydexcom, Nightscout and Home Assistant).
// Requires the Share feature enabled in the Dexcom app with at least one follower.
const SESSION_FILE = path.join(__dirname, '..', 'auth', 'dexcom-session.json');

// Well-known Share application id — the same one used across community libraries
const APP_ID = 'd89443d2-327c-4a6f-89e5-496bbb0317db';

const BASE_URLS = {
  us: 'https://share2.dexcom.com/ShareWebServices/Services',
  ous: 'https://shareous1.dexcom.com/ShareWebServices/Services',
  jp: 'https://share.dexcom.jp/ShareWebServices/Services',
};

// Dexcom's seven arrows → the internal TREND shape (dir -2..2 as the rest of
// the codebase expects)
// `key` feeds the i18n trend labels (trend_*); `label` stays English for the dashboard
const TREND_MAP = {
  DoubleUp: { arrow: '↑↑', key: 'rising_fast', label: 'rising fast', dir: 2 },
  SingleUp: { arrow: '↑', key: 'rising', label: 'rising', dir: 1 },
  FortyFiveUp: { arrow: '↗', key: 'rising_slow', label: 'rising slowly', dir: 1 },
  Flat: { arrow: '→', key: 'stable', label: 'stable', dir: 0 },
  FortyFiveDown: { arrow: '↘', key: 'falling_slow', label: 'falling slowly', dir: -1 },
  SingleDown: { arrow: '↓', key: 'falling', label: 'falling', dir: -1 },
  DoubleDown: { arrow: '↓↓', key: 'falling_fast', label: 'falling fast', dir: -2 },
  None: { arrow: '→', key: 'unknown', label: 'unknown', dir: 0 },
  NotComputable: { arrow: '→', key: 'unknown', label: 'unknown', dir: 0 },
  RateOutOfRange: { arrow: '→', key: 'oor', label: 'out of range', dir: 0 },
};
// Legacy numeric trends (0-9) in Dexcom's official order
const TREND_NUMERIC = [
  'None', 'DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat',
  'FortyFiveDown', 'SingleDown', 'DoubleDown', 'NotComputable', 'RateOutOfRange',
];

// Known server error codes → human-readable messages
function mapError(code, fallback) {
  if (/AccountPasswordInvalid|AuthenticateAccountNotFound|SSO_InternalError/i.test(code || ''))
    return 'Dexcom credentials are invalid — check the username, password and region';
  if (/MaxAttemptsExceeded/i.test(code || ''))
    return 'Dexcom temporarily blocked login attempts (too many) — wait 10-30 minutes';
  if (/SessionIdNotFound|SessionNotValid/i.test(code || '')) return 'Dexcom session expired';
  return fallback;
}

class DexcomClient {
  constructor({ username, password, region }) {
    this.username = (username || '').trim();
    this.password = password || '';
    this.region = (region || 'ous').toLowerCase();
    this.accountId = null;
    this.sessionId = null;
    this.blockedUntil = 0;
    this.loadSession();
  }

  get baseUrl() {
    return BASE_URLS[this.region] || BASE_URLS.ous;
  }

  loadSession() {
    try {
      const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (s.username === this.username && s.region === this.region) {
        this.accountId = s.accountId || null;
        this.sessionId = s.sessionId || null;
      }
    } catch {}
  }

  saveSession() {
    try {
      fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
      fs.writeFileSync(
        SESSION_FILE,
        JSON.stringify({
          username: this.username,
          region: this.region,
          accountId: this.accountId,
          sessionId: this.sessionId,
        })
      );
    } catch {}
  }

  async post(apiPath, body) {
    if (Date.now() < this.blockedUntil) {
      const mins = Math.ceil((this.blockedUntil - Date.now()) / 60000);
      throw new Error(`Dexcom is rate-limiting us — next attempt in ~${mins} min`);
    }
    const res = await fetch(`${this.baseUrl}${apiPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    if (res.status === 429) {
      this.blockedUntil = Date.now() + 10 * 60_000;
      throw new Error('Dexcom rate-limited our requests — the assistant will retry in ~10 min');
    }
    return { res, json };
  }

  // Two-step login: account name → accountId, then accountId → sessionId
  async login() {
    this.sessionId = null;
    if (!this.username || !this.password) {
      throw new Error('Dexcom credentials not configured — provide a username and password');
    }

    if (!this.accountId) {
      const { res, json } = await this.post('/General/AuthenticatePublisherAccount', {
        accountName: this.username,
        password: this.password,
        applicationId: APP_ID,
      });
      if (!res.ok || typeof json !== 'string') {
        throw new Error(mapError(json?.Code, `Dexcom account verification failed (HTTP ${res.status})`));
      }
      this.accountId = json;
    }

    const { res, json } = await this.post('/General/LoginPublisherAccountById', {
      accountId: this.accountId,
      password: this.password,
      applicationId: APP_ID,
    });
    if (!res.ok || typeof json !== 'string' || json === '00000000-0000-0000-0000-000000000000') {
      this.accountId = null; // the account may live in another region — re-verify from scratch
      throw new Error(mapError(json?.Code, `Dexcom login failed (HTTP ${res.status})`));
    }
    this.sessionId = json;
    this.saveSession();
  }

  // Returns the latest reading with the same contract as libre.js:
  // { value (mg/dL), trendArrow, trend:{arrow,label,dir}, timestamp:Date, ageMinutes, isHigh, isLow }
  async getLatestReading(retried = false) {
    if (!this.sessionId) await this.login();

    const { res, json } = await this.post(
      `/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${encodeURIComponent(this.sessionId)}&minutes=1440&maxCount=1`
    );

    // Expired session → one re-login, then retry
    if (!res.ok) {
      if (!retried && /SessionIdNotFound|SessionNotValid/i.test(json?.Code || '')) {
        this.sessionId = null;
        return this.getLatestReading(true);
      }
      throw new Error(mapError(json?.Code, `Dexcom Share HTTP ${res.status}`));
    }

    const gv = Array.isArray(json) ? json[0] : null;
    if (!gv) {
      throw new Error(
        'No readings in this Dexcom account in the last 24 hours — make sure Share is enabled in the Dexcom app with at least one follower'
      );
    }

    // WT looks like "Date(1699999999000)" — extract the epoch
    let timestamp = null;
    const wt = String(gv.WT || gv.ST || '');
    const ms = wt.match(/(\d{10,})/);
    if (ms) timestamp = new Date(parseInt(ms[1], 10));

    const trendName =
      typeof gv.Trend === 'number' ? TREND_NUMERIC[gv.Trend] || 'None' : String(gv.Trend || 'None');
    const trend = TREND_MAP[trendName] || TREND_MAP.None;

    const ageMinutes = timestamp
      ? Math.max(0, Math.round((Date.now() - timestamp.getTime()) / 60000))
      : null;

    return {
      value: gv.Value,
      trendArrow: trendName,
      trend,
      timestamp,
      ageMinutes,
      isHigh: false,
      isLow: false,
    };
  }
}

module.exports = { DexcomClient };
