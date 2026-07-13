const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { config, SETTABLE } = require('./config');
const store = require('./store');
const runtime = require('./runtime');
const cgm = require('./cgm');
const { iobAt } = require('./iob');
const learn = require('./learn');

// Web dashboard — a built-in http server with zero extra dependencies.
// Protection: one password (DASH_PASSWORD) → HMAC-signed cookie valid 30
// days, plus per-IP login rate limiting.

const HTML_FILE = path.join(__dirname, 'dashboard.html');
const COOKIE_DAYS = 30;
const LOGIN_MAX_TRIES = 8;
const LOGIN_WINDOW_MS = 15 * 60_000;

const loginAttempts = new Map(); // ip → { count, resetAt }

// The signing secret is generated once and kept in the database
// (sessions survive restarts)
function dashSecret() {
  if (!store.db.settings.dashSecret) {
    store.db.settings.dashSecret = crypto.randomBytes(32).toString('hex');
    store.save();
  }
  return store.db.settings.dashSecret;
}

function sign(exp) {
  return crypto.createHmac('sha256', dashSecret()).update(String(exp)).digest('hex');
}

function makeCookie() {
  const exp = Date.now() + COOKIE_DAYS * 24 * 3600_000;
  return `dash=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}`;
}

function isAuthed(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)dash=(\d+)\.([0-9a-f]+)/);
  if (!m) return false;
  const [, exp, sig] = m;
  if (parseInt(exp, 10) < Date.now()) return false;
  const expected = sign(exp);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function passwordOk(input) {
  // Constant-time comparison via hashing both sides
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(config.dashPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  return req.socket.remoteAddress || '?';
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) return false;
  return rec.count >= LOGIN_MAX_TRIES;
}

function recordAttempt(ip, success) {
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (success) {
    loginAttempts.delete(ip);
    return;
  }
  rec.count += 1;
  loginAttempts.set(ip, rec);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
  });
  res.end(html);
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in — CGM Assistant</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0d0d0d;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  form{background:#1a1a19;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:32px;width:300px}
  h1{font-size:18px;margin:0 0 6px}p{color:#898781;font-size:13px;margin:0 0 18px}
  input{width:100%;box-sizing:border-box;background:#0d0d0d;border:1px solid #383835;color:#fff;
    border-radius:8px;padding:10px 12px;font-size:15px;margin-bottom:12px}
  input:focus{outline:none;border-color:#3987e5}
  button{width:100%;background:#3987e5;color:#fff;border:0;border-radius:8px;padding:10px;font-size:15px;cursor:pointer}
  .err{color:#e66767;font-size:13px;min-height:18px;margin:0 0 8px}
</style></head><body>
<form id="f"><h1>🩸 CGM Assistant</h1><p>Dashboard — enter your password</p>
<div class="err" id="err"></div>
<input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password">
<button>Sign in</button></form>
<script>
document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();
  const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({password:document.getElementById('pw').value})});
  if(r.ok)location.reload();
  else document.getElementById('err').textContent=(await r.json()).error||'Error';
};
</script></body></html>`;

// Live reading for the dashboard with a 60s cache — so browser refreshes
// never hammer the provider servers
let readingCache = { at: 0, reading: null, error: null };
async function overviewReading() {
  if (!cgm.isConfigured()) return { reading: null, error: 'CGM not configured yet' };
  const pollFresh = config.pollMinutes * 60_000 * 2;
  if (runtime.lastReading && Date.now() - runtime.lastPollAt < pollFresh) {
    return { reading: runtime.lastReading, error: null };
  }
  if (Date.now() - readingCache.at < 60_000) {
    return { reading: readingCache.reading, error: readingCache.error };
  }
  try {
    const reading = await cgm.getLatestReading();
    readingCache = { at: Date.now(), reading, error: null };
  } catch (err) {
    readingCache = { at: Date.now(), reading: null, error: err.message };
  }
  return { reading: readingCache.reading, error: readingCache.error };
}

function maskUser(u) {
  if (!u) return null;
  const s = String(u);
  return s.length <= 3 ? s[0] + '***' : s.slice(0, 3) + '***' + (s.includes('@') ? s.slice(s.indexOf('@')) : '');
}

function settingsPayload() {
  const out = [];
  for (const s of Object.values(SETTABLE)) {
    out.push({ key: s.key, label: s.label, min: s.min, max: s.max, value: config[s.key] });
  }
  return out;
}

function applySetting(key, value) {
  const setting = Object.values(SETTABLE).find((s) => s.key === key);
  if (!setting) throw new Error('Unknown setting');
  const v = parseFloat(value);
  if (!Number.isFinite(v) || v < setting.min || v > setting.max) {
    throw new Error(`${setting.label}: value must be between ${setting.min} and ${setting.max}`);
  }
  const old = config[key];
  config[key] = v;
  store.db.settings[key] = v;
  if (key === 'carbRatio' && old !== v) {
    store.db.tuning.lastChangeAt = Date.now();
    store.db.tuning.history.push({ at: Date.now(), from: old, to: v, manual: true });
  }
  store.save();
  return { label: setting.label, old, value: v };
}

const REMINDER_NAMES = { split2: 'second-part reminder', outcome: 'meal outcome check', followup_high: 'high follow-up' };

async function handleApi(req, res, url, ctx) {
  const route = `${req.method} ${url.pathname}`;

  // ===== Login (no auth required) =====
  if (route === 'POST /api/login') {
    const ip = clientIp(req);
    if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many attempts — wait 15 minutes' });
    const body = await readBody(req);
    if (!passwordOk(body.password)) {
      recordAttempt(ip, false);
      return sendJson(res, 401, { error: 'Wrong password' });
    }
    recordAttempt(ip, true);
    return sendJson(res, 200, { ok: true }, { 'set-cookie': makeCookie() });
  }

  if (!isAuthed(req)) return sendJson(res, 401, { error: 'Unauthorized — sign in' });

  // ===== Overview =====
  if (route === 'GET /api/overview') {
    const { reading, error } = await overviewReading();
    const dex = cgm.savedDexcomCreds();
    const lib = cgm.savedLibreCreds();
    return sendJson(res, 200, {
      provider: cgm.providerName(),
      providerLabel: cgm.providerLabel(),
      reading,
      readingError: error,
      iob: iobAt(),
      diaHours: config.diaHours,
      whatsapp: runtime.waConnected,
      startedAt: runtime.startedAt,
      lastPollAt: runtime.lastPollAt,
      lastError: runtime.lastError,
      muteUntil: store.db.alertState.muteUntil || 0,
      suggestion: store.getLastSuggestion(90),
      learn: learn.statusSummary(),
      tuningHistory: store.db.tuning.history.slice(-5),
      reminders: store.pendingReminders().map((r) => ({
        type: r.type,
        name: REMINDER_NAMES[r.type] || r.type,
        dueAt: r.dueAt,
        units: r.payload?.units ?? null,
      })),
      settings: settingsPayload(),
      thresholds: { high: config.highAlert, low: config.lowAlert, target: config.targetBg },
      libre: { configured: !!(lib.email && lib.password), email: maskUser(lib.email) },
      dexcom: { configured: !!(dex.username && dex.password), username: maskUser(dex.username), region: dex.region },
    });
  }

  // ===== Reading log =====
  if (route === 'GET /api/readings') {
    const hours = Math.min(24 * 15, Math.max(1, parseFloat(url.searchParams.get('hours')) || 24));
    return sendJson(res, 200, { readings: store.readingsSince(Date.now() - hours * 3600_000) });
  }

  // ===== Doses and meals =====
  if (route === 'GET /api/history') {
    const days = Math.min(60, Math.max(1, parseFloat(url.searchParams.get('days')) || 14));
    const from = Date.now() - days * 24 * 3600_000;
    return sendJson(res, 200, {
      doses: store.db.doses.filter((d) => d.at >= from).slice(-100).reverse(),
      meals: store.db.meals.filter((m) => m.at >= from).slice(-50).reverse(),
    });
  }

  // ===== Change a setting =====
  if (route === 'POST /api/settings') {
    const body = await readBody(req);
    try {
      const r = applySetting(body.key, body.value);
      ctx.log.info(`Dashboard: ${r.label} ${r.old} → ${r.value}`);
      return sendJson(res, 200, { ok: true, ...r });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // ===== Mute / unmute / cancel =====
  if (route === 'POST /api/mute') {
    const body = await readBody(req);
    const hours = parseFloat(body.hours);
    if (!Number.isFinite(hours) || hours < 0.5 || hours > 12)
      return sendJson(res, 400, { error: 'Mute between 0.5 and 12 hours' });
    store.db.alertState.muteUntil = Date.now() + hours * 3600_000;
    store.save();
    return sendJson(res, 200, { ok: true, muteUntil: store.db.alertState.muteUntil });
  }
  if (route === 'POST /api/unmute') {
    store.db.alertState.muteUntil = 0;
    store.save();
    return sendJson(res, 200, { ok: true });
  }
  if (route === 'POST /api/cancel') {
    const n = store.cancelReminders(['split2', 'followup_high']);
    store.setLastSuggestion(null);
    return sendJson(res, 200, { ok: true, cancelled: n });
  }

  // ===== Log a manual dose =====
  if (route === 'POST /api/dose') {
    const body = await readBody(req);
    const units = parseFloat(body.units);
    if (!Number.isFinite(units) || units <= 0 || units > 40)
      return sendJson(res, 400, { error: 'That amount does not look right (0.5 - 40)' });
    store.addDose({ units, kind: 'manual' });
    ctx.sendToAdmin(`💉 Logged a ${units.toFixed(1)}U dose from the dashboard (on board now: ~${iobAt().toFixed(1)}U)`);
    return sendJson(res, 200, { ok: true, iob: iobAt() });
  }

  // ===== Provider: test and switch =====
  if (route === 'POST /api/cgm/test' || route === 'POST /api/cgm/switch') {
    const body = await readBody(req);
    const name = body.provider;
    let creds = null;
    if (name === 'dexcom') {
      const saved = cgm.savedDexcomCreds();
      creds = {
        username: (body.username || '').trim() || saved.username,
        password: body.password || saved.password,
        region: (body.region || saved.region || 'ous').toLowerCase(),
      };
      if (!creds.username || !creds.password)
        return sendJson(res, 400, { error: 'Enter a Dexcom username and password' });
    } else if (name === 'libre') {
      const saved = cgm.savedLibreCreds();
      creds = {
        email: (body.email || '').trim() || saved.email,
        password: body.password || saved.password,
        region: saved.region || '',
      };
      if (!creds.email || !creds.password)
        return sendJson(res, 400, { error: 'Enter a LibreLinkUp email and password' });
    }
    try {
      if (route === 'POST /api/cgm/test') {
        const reading = await cgm.testProvider(name, creds);
        return sendJson(res, 200, { ok: true, reading });
      }
      const reading = await cgm.switchProvider(name, creds);
      ctx.log.info(`Switched CGM provider to ${name} from the dashboard`);
      ctx.sendToAdmin(`🔄 Glucose source switched to *${cgm.providerLabel()}* — current reading: ${reading.value} ${reading.trend.arrow}`);
      return sendJson(res, 200, { ok: true, provider: cgm.providerName(), providerLabel: cgm.providerLabel(), reading });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  // ===== WhatsApp test message =====
  if (route === 'POST /api/wa/test') {
    try {
      await ctx.sendToAdminOrThrow('🔧 Test message from the dashboard — connection is fine');
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 502, { error: `WhatsApp unavailable: ${err.message}` });
    }
  }

  return sendJson(res, 404, { error: 'Unknown route' });
}

function startWeb(ctx) {
  if (!config.dashPassword || config.dashPassword.length < 8) {
    ctx.log.warn('Dashboard disabled — set DASH_PASSWORD (8+ characters) in .env to enable it');
    return null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url, ctx);
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (!isAuthed(req)) return sendHtml(res, LOGIN_PAGE);
        return sendHtml(res, fs.readFileSync(HTML_FILE, 'utf8'));
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
    } catch (err) {
      ctx.log.error({ err: err.message }, 'Dashboard error');
      try {
        sendJson(res, 500, { error: 'Internal error' });
      } catch {}
    }
  });

  server.listen(config.dashPort, '0.0.0.0', () => {
    ctx.log.info(`Dashboard listening on port ${config.dashPort}`);
  });
  return server;
}

module.exports = { startWeb };
