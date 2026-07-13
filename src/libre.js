const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Unofficial LibreLinkUp client — the same interface the LibreLinkUp app uses.
// The server enforces a minimum app version (status 920) — we adapt automatically.
const DEFAULT_VERSION = '4.16.0';
const SESSION_FILE = path.join(__dirname, '..', 'auth', 'libre-session.json');

// `key` feeds the i18n trend labels (trend_*); `label` stays English for the dashboard
const TREND = {
  1: { arrow: '↓↓', key: 'falling_fast', label: 'falling fast', dir: -2 },
  2: { arrow: '↓', key: 'falling', label: 'falling', dir: -1 },
  3: { arrow: '→', key: 'stable', label: 'stable', dir: 0 },
  4: { arrow: '↑', key: 'rising', label: 'rising', dir: 1 },
  5: { arrow: '↑↑', key: 'rising_fast', label: 'rising fast', dir: 2 },
};

class LibreClient {
  constructor({ email, password, region }) {
    this.email = email;
    this.password = password;
    this.region = region || '';
    this.version = DEFAULT_VERSION;
    this.token = null;
    this.accountId = null;
    this.patientId = null;
    this.tokenExpires = 0;
    this.blockedUntil = 0;
    this.loadSession();
  }

  get baseUrl() {
    return this.region
      ? `https://api-${this.region}.libreview.io`
      : 'https://api.libreview.io';
  }

  // The session is persisted — tokens are long-lived, and repeated logins
  // trigger a temporary block (HTTP 430)
  loadSession() {
    try {
      const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (s.email === this.email && s.token && s.tokenExpires > Date.now() + 60_000) {
        this.token = s.token;
        this.tokenExpires = s.tokenExpires;
        this.accountId = s.accountId;
        this.region = s.region || this.region;
        this.patientId = s.patientId || null;
        this.version = s.version || this.version;
      }
    } catch {}
  }

  saveSession() {
    try {
      fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
      fs.writeFileSync(
        SESSION_FILE,
        JSON.stringify({
          email: this.email,
          token: this.token,
          tokenExpires: this.tokenExpires,
          accountId: this.accountId,
          region: this.region,
          patientId: this.patientId,
          version: this.version,
        })
      );
    } catch {}
  }

  headers() {
    const h = {
      'accept-encoding': 'gzip',
      'cache-control': 'no-cache',
      connection: 'Keep-Alive',
      'content-type': 'application/json',
      product: 'llu.android',
      version: this.version,
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.accountId) h['account-id'] = this.accountId;
    return h;
  }

  async request(apiPath, options = {}) {
    if (Date.now() < this.blockedUntil) {
      const mins = Math.ceil((this.blockedUntil - Date.now()) / 60000);
      throw new Error(`LibreView is rate-limiting us — next attempt in ~${mins} min`);
    }
    const res = await fetch(`${this.baseUrl}${apiPath}`, {
      ...options,
      headers: this.headers(),
    });
    if (res.status === 430 || res.status === 429) {
      // Temporary block for too many requests — back off for 10 minutes
      this.blockedUntil = Date.now() + 10 * 60_000;
      throw new Error(
        'LibreView temporarily blocked our requests (too many attempts). The assistant will retry automatically in ~10 min.'
      );
    }
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { res, json };
  }

  async login(attempt = 0) {
    if (attempt > 3) throw new Error('LibreLinkUp login failed after several attempts');
    this.token = null;
    this.accountId = null;

    const { res, json } = await this.request('/llu/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: this.email, password: this.password }),
    });

    // Server demands a newer app version → adopt it and retry
    if (json?.status === 920 && json?.data?.minimumVersion) {
      this.version = json.data.minimumVersion;
      return this.login(attempt + 1);
    }
    // Account lives on another regional server → follow the redirect
    if (json?.data?.redirect && json?.data?.region) {
      this.region = json.data.region;
      return this.login(attempt + 1);
    }

    const ticket = json?.data?.authTicket;
    const userId = json?.data?.user?.id;
    if (!res.ok || !ticket?.token || !userId) {
      throw new Error(
        `LibreLinkUp login failed (HTTP ${res.status}, status=${json?.status}). ` +
          'Check the email and password, and make sure it is a LibreLinkUp *follower* account.'
      );
    }
    this.token = ticket.token;
    this.tokenExpires = (ticket.expires || 0) * 1000 || Date.now() + 30 * 24 * 3600_000;
    this.accountId = crypto.createHash('sha256').update(userId).digest('hex');
    this.saveSession();
  }

  async ensureAuth() {
    if (!this.token || this.tokenExpires < Date.now() + 60_000) {
      await this.login();
    }
  }

  async apiGet(apiPath, retried = false) {
    await this.ensureAuth();
    const { res, json } = await this.request(apiPath);

    if (!retried) {
      // Stale version → bump it and repeat the same request without re-login
      if (json?.status === 920 && json?.data?.minimumVersion) {
        this.version = json.data.minimumVersion;
        this.saveSession();
        return this.apiGet(apiPath, true);
      }
      // Expired token → one login, then retry
      if (res.status === 401) {
        this.token = null;
        return this.apiGet(apiPath, true);
      }
    }
    if (!res.ok) {
      throw new Error(`LibreLinkUp GET ${apiPath} HTTP ${res.status} (status=${json?.status ?? '?'})`);
    }
    return json;
  }

  async getPatientId() {
    if (this.patientId) return this.patientId;
    const json = await this.apiGet('/llu/connections');
    const conn = json?.data?.[0];
    if (!conn?.patientId) {
      throw new Error(
        'No connections in this LibreLinkUp account — enable sharing in the LibreLink app (Connected Apps → LibreLinkUp) and accept the invite in the LibreLinkUp app.'
      );
    }
    this.patientId = conn.patientId;
    this.saveSession();
    return this.patientId;
  }

  // Returns the latest reading:
  // { value (mg/dL), trendArrow, trend:{arrow,label,dir}, timestamp:Date, ageMinutes, isHigh, isLow }
  async getLatestReading() {
    const patientId = await this.getPatientId();
    const json = await this.apiGet(`/llu/connections/${patientId}/graph`);
    const gm = json?.data?.connection?.glucoseMeasurement;
    if (!gm) throw new Error('No reading from the sensor (glucoseMeasurement is empty)');

    const value = gm.ValueInMgPerDl ?? gm.Value;
    const trendArrow = gm.TrendArrow ?? 3;

    // FactoryTimestamp is UTC in US format like "7/8/2026 1:23:45 PM"
    let timestamp = null;
    if (gm.FactoryTimestamp) {
      const d = new Date(`${gm.FactoryTimestamp} UTC`);
      if (!isNaN(d)) timestamp = d;
    }
    if (!timestamp && gm.Timestamp) {
      const d = new Date(gm.Timestamp);
      if (!isNaN(d)) timestamp = d;
    }
    const ageMinutes = timestamp
      ? Math.max(0, Math.round((Date.now() - timestamp.getTime()) / 60000))
      : null;

    return {
      value,
      trendArrow,
      trend: TREND[trendArrow] || TREND[3],
      timestamp,
      ageMinutes,
      isHigh: !!gm.isHigh,
      isLow: !!gm.isLow,
    };
  }
}

module.exports = { LibreClient, TREND };
