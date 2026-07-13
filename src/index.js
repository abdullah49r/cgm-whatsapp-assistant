const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require('baileys');
const NodeCache = require('node-cache');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');

const { config, validateConfig, applySettings } = require('./config');
const store = require('./store');
const runtime = require('./runtime');
const cgm = require('./cgm');
const setup = require('./setup');
const { handleCommand } = require('./commands');
const { processMeal } = require('./mealflow');
const { startMonitor } = require('./monitor');
const { startScheduler } = require('./scheduler');
const { startWeb } = require('./web');
const { t } = require('./i18n');

const log = pino({
  level: 'info',
  transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
});

// Load the database and apply persisted overrides on top of .env
store.load();
applySettings(store.db.settings);

// Provider manager — LibreView or Dexcom behind one getLatestReading()
const activeProvider = cgm.init();
const libre = cgm;

const adminJid = () => `${config.adminPhone}@s.whatsapp.net`;

// Ids of messages this bot sent — so it never replies to itself when it
// runs on your personal number
const sentIds = new Set();
function rememberSent(id) {
  sentIds.add(id);
  if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value);
}

// Sent-message store — required for resends when the phone fails to decrypt
// (without it, "Waiting for this message" never resolves)
const msgStore = new Map();
function storeMessage(key, message) {
  if (!key?.id || !message) return;
  msgStore.set(key.id, message);
  if (msgStore.size > 300) msgStore.delete(msgStore.keys().next().value);
}

// A meal photo that arrived without a caption — wait for the mandatory description (10 min)
let pendingImage = null;
function clearPendingImage() {
  pendingImage = null;
}

// One pairing hint per stranger JID, so the bot never spams
const pairingHinted = new Set();

function jidDigits(jid = '') {
  return jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function senderDigits(msg) {
  const candidates = [
    msg.key.remoteJid,
    msg.key.remoteJidAlt, // the real number when the chat uses a LID
    msg.key.participant,
    msg.key.participantAlt,
    msg.key.senderPn,
  ].filter(Boolean);
  for (const j of candidates) {
    const d = jidDigits(j);
    if (d.length >= 8) return d;
  }
  return jidDigits(candidates[0] || '');
}

function isFromAdmin(msg) {
  const candidates = [
    msg.key.remoteJid,
    msg.key.remoteJidAlt,
    msg.key.participant,
    msg.key.participantAlt,
    msg.key.senderPn,
  ].filter(Boolean);
  return candidates.some((j) => jidDigits(j) === config.adminPhone);
}

function getText(msg) {
  const m = msg.message;
  return (m.conversation || m.extendedTextMessage?.text || '').trim();
}

let monitorStarted = false;
let setupOffered = false;

// The current socket, module-level — monitor and scheduler keep using reply
// even after a reconnect (the dead socket is replaced here)
let currentSock = null;

async function reply(jid, text) {
  if (!currentSock) throw new Error('WhatsApp is not connected right now');
  const sent = await currentSock.sendMessage(jid, { text });
  if (sent?.key?.id) {
    rememberSent(sent.key.id);
    storeMessage(sent.key, sent.message);
  }
}

async function sendToAdmin(text) {
  if (!setup.isPaired()) return; // nobody to talk to yet
  try {
    await reply(adminJid(), text);
  } catch (err) {
    log.error({ err: err.message }, 'Failed to message the admin');
  }
}

function printPairingInstructions() {
  console.log('\n==============================================');
  console.log('  📱 PAIRING — one more step');
  console.log('  From the WhatsApp account that should receive');
  console.log('  glucose alerts, send this code to the number');
  console.log('  you just linked:');
  console.log(`\n      ${setup.getPairingCode()}\n`);
  console.log('  (If the bot runs on your own number, just');
  console.log('   send the code to yourself.)');
  console.log('==============================================\n');
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, '..', 'auth'));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['CGMAssistant', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
    // When the other side fails to decrypt, WhatsApp asks for a resend —
    // this returns the original message so it can be re-encrypted
    msgRetryCounterCache: new NodeCache({ stdTTL: 3600 }),
    getMessage: async (key) => msgStore.get(key?.id),
  });
  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan this QR code in WhatsApp: Settings → Linked Devices → Link a Device\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      runtime.waConnected = true;
      log.info('✅ Connected to WhatsApp');

      if (!setup.isPaired()) {
        printPairingInstructions();
      } else if (setup.needsSetup() && !setupOffered) {
        setupOffered = true;
        setup.begin({ reply: (text) => reply(adminJid(), text) }).catch(() => {});
      }

      if (!monitorStarted) {
        monitorStarted = true;
        const ctx = { libre, sendToAdmin, log };
        startMonitor(ctx);
        startScheduler(ctx);
        if (setup.isPaired() && !setup.needsSetup()) {
          sendToAdmin(t('assistant_up'));
        }
      }
    }

    if (connection === 'close') {
      runtime.waConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        log.error('❌ Logged out of WhatsApp — delete the auth/ folder contents (except *-session.json) and restart.');
        process.exit(1);
      } else {
        log.warn('Connection dropped — reconnecting...');
        setTimeout(startBot, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) continue;
        if (msg.key.id && sentIds.has(msg.key.id)) continue; // a message this bot sent

        const replyHere = (text) => reply(jid, text);

        // ===== Pairing phase: no admin claimed yet =====
        if (!setup.isPaired()) {
          const text = getText(msg);
          if (setup.tryPair(text, senderDigits(msg))) {
            log.info(`Paired with admin ${config.adminPhone}`);
            await replyHere(t('paired_ok'));
            if (setup.needsSetup()) {
              setupOffered = true;
              await setup.begin({ reply: replyHere });
            } else {
              await replyHere(t('all_configured'));
            }
          } else if (text && !pairingHinted.has(jid)) {
            pairingHinted.add(jid);
            await replyHere('🔒 This assistant is not paired yet. Send the 6-digit pairing code shown in the server console.');
          }
          continue;
        }

        if (!isFromAdmin(msg)) continue; // personal assistant — admin only

        // ===== Guided setup in progress =====
        const maybeText = getText(msg);
        if (setup.isActive() && maybeText) {
          const consumed = await setup.onMessage(maybeText, { reply: replyHere });
          if (consumed) continue;
        }

        // ===== Meal photo =====
        const img = msg.message.imageMessage;
        if (img) {
          const caption = (img.caption || '').trim();
          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
          );

          if (!caption) {
            // Description is mandatory — hold the photo and wait for it
            pendingImage = { buffer, mimeType: img.mimetype || 'image/jpeg', at: Date.now() };
            await replyHere(t('photo_needs_desc'));
            continue;
          }

          await replyHere(t('analyzing'));
          await processMeal({
            desc: caption,
            imageBuffer: buffer,
            mimeType: img.mimetype || 'image/jpeg',
            libre,
            reply: replyHere,
            log,
          });
          continue;
        }

        // ===== Text =====
        const text = maybeText;
        if (!text) continue;

        // First: is it a known command?
        const handled = await handleCommand(text, {
          reply: replyHere,
          libre,
          log,
          clearPendingImage,
        });
        if (handled) continue;

        // Second: are we waiting for a pending photo's description?
        if (pendingImage && Date.now() - pendingImage.at < 10 * 60_000) {
          const { buffer, mimeType } = pendingImage;
          pendingImage = null;
          await replyHere(t('analyzing'));
          await processMeal({ desc: text, imageBuffer: buffer, mimeType, libre, reply: replyHere, log });
          continue;
        }
        pendingImage = null;

        await replyHere(t('default_hint'));
      } catch (err) {
        log.error({ err: err.message, stack: err.stack }, 'Failed to handle a message');
        try {
          await reply(msg.key.remoteJid, t('error_generic', { error: err.message }));
        } catch {}
      }
    }
  });
}

// ===== Boot =====
console.log('🩸 CGM WhatsApp Assistant — Libre / Dexcom + WhatsApp\n');

const problems = validateConfig();
if (problems.length) {
  console.log('ℹ️ Notes:');
  for (const p of problems) console.log('   - ' + p);
  console.log('');
}

log.info(`Glucose source: ${activeProvider === 'dexcom' ? 'Dexcom Share' : 'LibreLinkUp'}${cgm.isConfigured() ? '' : ' (not configured yet — WhatsApp setup will ask)'}`);

// The dashboard runs from boot, even before WhatsApp connects
startWeb({
  log,
  sendToAdmin,
  sendToAdminOrThrow: (text) => {
    if (!setup.isPaired()) throw new Error('not paired with an admin yet');
    return reply(adminJid(), text);
  },
});

startBot().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
