const { config } = require('./config');
const store = require('./store');
const runtime = require('./runtime');
const { correctionOnly, fmt } = require('./dose');
const { iobAt } = require('./iob');
const { ensureHighFollowup, isMuted } = require('./scheduler');
const { t } = require('./i18n');

// Periodic monitor — alert rhythm:
// low: every LOW_COOLDOWN_MIN (15m) while low and not rising, one recovery message
// high: first alert, then a follow-up chain every FOLLOWUP_MIN (30m) until it
//       settles or drops (handled in scheduler)
// A real low alert always bypasses mute
function startMonitor({ libre, sendToAdmin, log }) {
  const last = { low: 0, high: 0, predictHigh: 0, predictLow: 0 };
  const cooldownOk = (key, minutes) => Date.now() - last[key] > minutes * 60_000;
  let lowEpisode = false; // are we inside an alerted low episode?

  async function tick() {
    // Nothing to poll until the CGM credentials exist (first-run setup)
    if (typeof libre.isConfigured === 'function' && !libre.isConfigured()) return;

    let reading;
    try {
      reading = await libre.getLatestReading();
    } catch (err) {
      runtime.lastError = err.message;
      log.warn({ err: err.message }, 'Monitor failed to fetch a reading');
      return;
    }

    // Runtime status + dashboard log (even stale readings get logged if new to us)
    runtime.lastPollAt = Date.now();
    runtime.lastReading = reading;
    runtime.lastError = null;
    if (reading.timestamp) {
      store.addReading({ at: reading.timestamp.getTime(), value: reading.value, dir: reading.trend?.dir ?? 0 });
    }

    // Ignore stale readings (sensor gap, for example)
    if (reading.ageMinutes != null && reading.ageMinutes > 15) return;

    const bg = reading.value;
    const dir = reading.trend?.dir ?? 0;
    const arrow = reading.trend.arrow;
    const muted = isMuted();

    // ===== Actual low (bypasses mute) =====
    if (bg <= config.lowAlert) {
      if (dir >= 1) {
        // Low but rising — recovering, don't nag
        if (lowEpisode) {
          lowEpisode = false;
          await sendToAdmin(t('recovering', { bg, arrow }));
        }
        return;
      }
      if (cooldownOk('low', config.lowCooldownMin)) {
        last.low = Date.now();
        const severe = dir <= -1 || bg <= config.lowAlert - 15;
        const iob = iobAt();
        const lines = [
          lowEpisode ? t('still_low', { bg, arrow }) : t('low_now', { bg, arrow }),
          severe ? t('sugar_severe') : t('sugar_mild'),
        ];
        if (iob >= 0.5) lines.push(t('iob_dropping', { iob: iob.toFixed(1) }));
        lowEpisode = true;
        await sendToAdmin(lines.join('\n'));
      }
      return;
    }

    // Out of the low → one recovery message
    if (lowEpisode) {
      lowEpisode = false;
      await sendToAdmin(t('low_over', { bg, arrow }));
    }

    if (muted) return; // every other alert respects mute

    // The high follow-up chain (in scheduler) owns messaging while active
    const followupActive = store.pendingReminders(['followup_high']).length > 0;

    // ===== Predicted low (proactive) =====
    if (bg <= config.predictLowFrom && dir <= -1) {
      if (cooldownOk('predictLow', config.lowCooldownMin * 2)) {
        last.predictLow = Date.now();
        await sendToAdmin(dir === -2 ? t('pred_low_fast', { bg, arrow }) : t('pred_low_soft', { bg, arrow }));
      }
      return;
    }

    // ===== Actual high =====
    if (bg >= config.highAlert) {
      if (!followupActive && cooldownOk('high', config.highCooldownMin)) {
        last.high = Date.now();
        const iob = iobAt();
        const corr = correctionOnly(reading, iob);
        const lines = [t('high_now', { bg, arrow })];
        if (iob >= 1) {
          lines.push(t('iob_wait', { iob: iob.toFixed(1) }));
        } else if (corr > 0) {
          lines.push(t('corr_suggest', { units: fmt(corr) }));
          const fresh = store.getLastSuggestion(20);
          if (!fresh || fresh.kind !== 'meal') {
            store.setLastSuggestion({ kind: 'correction', units: corr, totalUnits: corr, preBg: bg });
          }
        }
        if (bg >= 300) lines.push(t('ketones'));
        lines.push(t('following', { min: config.followupMin }));
        await sendToAdmin(lines.join('\n'));
        // Keep following up until it settles or drops
        ensureHighFollowup(bg);
      }
      return;
    }

    // ===== Predicted high (proactive) =====
    if (bg >= config.predictHighFrom && dir >= 1) {
      if (!followupActive && cooldownOk('predictHigh', config.highCooldownMin)) {
        last.predictHigh = Date.now();
        await sendToAdmin(t('pred_high', { bg, arrow }));
      }
    }
  }

  // First check 30s after boot, then every POLL_MINUTES
  setTimeout(tick, 30_000);
  const interval = setInterval(tick, config.pollMinutes * 60_000);
  log.info(`Monitor running: checking every ${config.pollMinutes} minutes`);
  return () => clearInterval(interval);
}

module.exports = { startMonitor };
