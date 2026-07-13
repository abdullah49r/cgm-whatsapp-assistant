# 🩸 CGM WhatsApp Assistant — FreeStyle Libre & Dexcom on WhatsApp

**Connect WhatsApp to your FreeStyle Libre or Dexcom continuous glucose
monitor (CGM).** A personal diabetes copilot for Type 1 diabetes that lives
in your WhatsApp: real-time glucose alerts and hypoglycemia warnings around
the clock, AI carb counting from meal photos, insulin bolus dose suggestions
with fixed clinical formulas, insulin-on-board (IOB) tracking, a learning
engine that tunes your real carb ratio from outcomes — and a web dashboard
with live glucose charts.

**Works with:** FreeStyle Libre 2 / Libre 3 (via a LibreLinkUp follower
account) · Dexcom ONE+, G6, G7 (via the Dexcom Share feature) — switchable
at runtime without a restart.

> ## ⚠️ Medical disclaimer — read this first
> This tool is designed **specifically for Type 1 diabetes treated with
> rapid-acting insulin (3–4 hour action)**. It is a **personal, unofficial,
> open-source tool**, not a medical device. It is not reviewed or approved by
> any regulatory authority, Abbott, Dexcom, or WhatsApp. Dose suggestions are
> simple arithmetic on numbers **you** configure — they can be wrong, stale,
> or based on a delayed sensor reading. **By using it you confirm that you
> have consulted your doctor first. Always verify with your own judgment and
> your care team before injecting insulin. Never rely on this tool for
> hypoglycemia safety.** Use entirely at your own risk.

## Features

- 🔔 **24/7 monitoring** — polls your CGM every 5 minutes: low alerts (never
  muted), predictive "heading low/high" warnings, high alerts with automatic
  follow-up every 30 minutes until you're back in range
- 📷 **Meal photos → dose suggestion** — send a photo + short description;
  AI estimates carbs and fat (AI is used *only* for estimation — all dose
  math is fixed formulas: ICR, ISF, IOB deduction, trend adjustment)
- 🧈 **Fatty-meal splitting** — dual-wave style split suggestions with an
  automatic reminder for the second part
- 💉 **Insulin-on-board tracking** — linear decay model, deducted from
  corrections to prevent stacking
- 🧠 **Learning engine** — pure math (no AI): checks 3-hour meal outcomes
  and gradually tunes your carb ratio with strict safety rules
- 🔄 **Two CGM providers** — FreeStyle Libre and Dexcom, switch anytime from
  WhatsApp setup or the dashboard without restarting
- 📊 **Web dashboard** — live glucose + trend chart, IOB, dose/meal history,
  settings editor, provider switching, quick actions; password-protected
- 💬 **Setup happens in WhatsApp** — scan a QR, send a pairing code, answer
  7 questions. No config files needed (but `.env` works too)
- 🌐 **7 languages** — English, العربية, 中文, हिन्दी, Español, Français,
  Português; chosen during setup, switchable anytime with `language`
  (command keywords stay English in every language)
- 🔑 **Guided AI setup** — send a meal photo before configuring an AI key
  and the bot walks you through creating an OpenRouter key, then connects
  it when you paste it into the chat

## How it works

```
┌────────────┐   unofficial     ┌──────────────┐
│ LibreLinkUp │◄────────────────│              │    WhatsApp (Baileys)
│  /  Dexcom  │   follower API  │   Node.js    │◄──────────────────────► You
│    Share    │                 │   process    │
└────────────┘                  │              │◄──── Web dashboard (HTTP)
                                └──────┬───────┘
                                       │ single JSON file
                                  data/db.json
```

Everything runs on **your** machine/server. Readings, doses, meals and
credentials stay in a local JSON file — there is no cloud backend.

## Quick start

**Requirements:** Node.js 20+, a WhatsApp account for the bot (your own
number works — the bot can message you in your own chat), and a CGM with
sharing enabled (see [providers](#cgm-providers)).

```bash
git clone https://github.com/abdullah49r/cgm-whatsapp-assistant.git
cd cgm-whatsapp-assistant
npm install
npm start
```

Then:

1. **Scan the QR code** printed in the terminal
   (WhatsApp → Settings → Linked Devices → Link a Device).
2. **Send the 6-digit pairing code** (also printed in the terminal) to the
   bot's number *from the phone that should receive alerts*. If the bot runs
   on your own number, just send the code to yourself.
3. **Pick your language**, accept the medical notice, then **answer the
   setup questions** in WhatsApp — carb ratio, correction factor, targets,
   then your Libre or Dexcom credentials. The bot tests the connection live
   and confirms with your current reading.

That's it. Send a meal photo with a caption and see what happens.

## WhatsApp commands

| Command | What it does |
|---|---|
| *(photo + caption)* | Analyze the meal → carb estimate + dose suggestion |
| `meal chicken shawarma` | Same, but text-only |
| `dose 45` | Dose for a known amount of carbs |
| `1` / `2` / `3` | Answer a dose suggestion: took it / split it / different amount |
| `took it` / `took 4.5` | Log the suggested dose / a custom amount |
| `split` | Take the first part of a suggested split dose |
| `bg` | Current reading + trend + insulin on board |
| `status` | IOB, learning progress, pending reminders |
| `mute 2` / `unmute` | Silence non-critical alerts (lows always alert) |
| `cancel` | Cancel pending reminders and follow-ups |
| `settings` / `set ratio 10` | Show / change any setting |
| `language` | Change the bot language (7 available) |
| `setup` | Re-run the guided setup |
| `help` | Command list |
| *(paste an `sk-or-...` key)* | Connect your OpenRouter API key |

## CGM providers

### FreeStyle Libre (LibreLinkUp)
The bot signs in as a LibreLinkUp **follower** — the same read-only API the
official follower app uses. One-time setup on your phone:
LibreLink app → Connected Apps → LibreLinkUp → invite yourself (or a spare
email) → accept the invite in the LibreLinkUp app. Use that follower
account's email/password in the bot.

### Dexcom (Share)
The bot uses the Dexcom **Share** service — the same API the Follow app
uses (community-proven by Nightscout, pydexcom and Home Assistant). Enable
Share in your Dexcom app with at least one follower, then use your own
Dexcom credentials (username, email or phone). Region: `ous` (outside US,
default), `us`, or `jp`.

> Both APIs are unofficial and unsupported by the vendors. They can change
> or rate-limit at any time (the bot backs off automatically on 429/430).
> Using them may violate the vendors' terms of service — your call.

## Web dashboard

Set `DASH_PASSWORD` (8+ characters) in `.env` and restart. Open
`http://your-server:8080`, sign in, and you get: live glucose tile + trend
chart with alert thresholds, IOB, quick actions (mute, manual dose, cancel),
full settings editor, dose/meal history with outcomes, and provider
test/switch.

> The dashboard is plain HTTP. Run it behind a reverse proxy with TLS
> (Caddy makes this a one-liner) or keep it on a trusted network / VPN.

## Configuration

Everything can be set in three places, later ones win:
**`.env`** (defaults) → **WhatsApp setup / `set` commands** → **dashboard**.
Changed values persist in `data/db.json`.

See [.env.example](.env.example) for the full annotated list. Highlights:

| Variable | Default | Meaning |
|---|---|---|
| `CARB_RATIO` | 10 | 1 unit covers X g of carbs |
| `CORRECTION_FACTOR` | 50 | 1 unit lowers glucose X mg/dL |
| `TARGET_BG` | 110 | correction target (mg/dL) |
| `MAX_BOLUS` | 15 | hard cap per suggestion (units) |
| `DIA_HOURS` | 4 | insulin action duration for IOB |
| `HIGH_ALERT` / `LOW_ALERT` | 220 / 70 | alert thresholds (mg/dL) |
| `FAT_SPLIT_G` | 25 | fat (g) that triggers a split suggestion |
| `POLL_MINUTES` | 5 | CGM polling interval |
| `OPENROUTER_API_KEY` | — | enables AI meal analysis ([openrouter.ai](https://openrouter.ai)) |
| `LANGUAGE` | en | bot language: en, ar, zh, hi, es, fr, pt |
| `DASH_PASSWORD` | — | enables the dashboard |

## Run it 24/7 (systemd)

```ini
# /etc/systemd/system/cgm-assistant.service
[Unit]
Description=CGM WhatsApp Assistant
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/cgm-whatsapp-assistant
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now cgm-assistant
journalctl -u cgm-assistant -f
```

Run `npm start` interactively once first to scan the QR and pair — the
session persists in `auth/` afterwards.

## Privacy & data

- All data stays on your machine: `data/db.json` (readings, doses, meals,
  settings — including CGM credentials you enter during setup) and `auth/`
  (WhatsApp session keys, CGM tokens). Both are git-ignored — **never commit
  or share them**.
- Meal photos are sent to the AI model you configure via OpenRouter for carb
  estimation. No other data leaves your server.
- WhatsApp connectivity uses [Baileys](https://github.com/WhiskeySockets/Baileys),
  an unofficial WhatsApp Web library — accounts used with unofficial
  libraries risk being banned by WhatsApp. A dedicated number is safer.

## Roadmap ideas

PRs welcome: mmol/L display, more locales, Nightscout as a provider,
basal logging, exercise tagging, Telegram transport.

## License

[MIT](LICENSE)
