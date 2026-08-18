# CLIO: Event Daily Report Agent

CLIO is a white-label automated daily reporting system for live event productions. Department heads (HODs) submit end-of-day progress from their phone via a mobile-first, three-step portal: completion percent, status notes, schedule updates, and photos with captions. Every night CLIO stitches the submissions into a branded PowerPoint report and emails it to the PM team.

Around the core loop, CLIO also: reminds pending HODs by email and WhatsApp at a configurable time, notifies the PM team in real time on every submission, polishes all submitted text with Claude Haiku (fail-soft), answers HOD WhatsApp replies with a capped AI agent that any admin can take over per conversation, and exposes a full admin console: overview control surface, department hierarchy management, WhatsApp inbox, brand theming, a report builder with template import and true rendered previews, delivery settings, scheduling, and a browsable archive.

Everything brand-related (logo, colors, fonts, company name) is configured per deployment from the admin Brand section. Nothing in the codebase is tied to any company.

---

## Prerequisites

- **Node.js 18+** (20 recommended)
- **Python 3.9+** with `pip3`
- An **SMTP account** for outgoing email (Gmail app password works)
- Optional, for WhatsApp: a **Meta for Developers** app with the WhatsApp product (the free test number works for up to 5 verified recipients)
- Optional, for true report previews: **LibreOffice** and **poppler** (`brew install libreoffice poppler` on macOS; included in the Railway build)

---

## Installation

```bash
cd clio-agent
./setup.sh          # npm install, pip3 install, directory + db setup, .env scaffold
node server.js      # portal at http://localhost:3000
```

- **Portal for HODs:** `{BASE_URL}/`
- **Admin console:** `{BASE_URL}/admin.html` (password from `ADMIN_PASSWORD`)
- **Health check:** `GET {BASE_URL}/health`

---

## Configuration

Runtime behavior lives in the database and is edited from the admin console (event identity, brand, report structure, PM emails, delivery options, schedule). The `.env` file holds secrets and deployment shape:

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Admin console password |
| `REPORT_API_KEY` | Shared secret for report automation endpoints |
| `SMTP_*`, `SENDER_NAME` | Outgoing email |
| `PM_EMAILS`, `PM_WHATSAPP` | Seed values; the admin Delivery section is the live source |
| `WHATSAPP_ENABLED` | Master switch for all WhatsApp sending |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta Cloud API phone number id |
| `WHATSAPP_ACCESS_TOKEN` | Meta access token (test tokens expire in about 24h) |
| `WHATSAPP_VERIFY_TOKEN` | Any string; must match the webhook config in Meta |
| `WHATSAPP_APP_SECRET` | Meta app secret, used to verify webhook signatures |
| `TIMEZONE` | IANA TZ, default `Asia/Riyadh`; submissions bucket by this local date |
| `BASE_URL` | Public URL, used in email CTAs and the WhatsApp agent |
| `DATA_DIR` | Set to the mounted volume path in production (e.g. `/data`); unset locally |
| `EVENT_NAME`, `EVENT_EDITION` | First-run seeds only; the admin Project section is the live source |
| `REPORT_DATE_OVERRIDE` | Testing: force a fixed reporting date |
| `DEPT_EMAIL_*`, `DEPT_WHATSAPP_*` | Optional contact seeds for the default departments (see `.env.example`) |

The Anthropic API key is not in `.env`: it is set from the admin Delivery section and stored in the database. Text polish and the WhatsApp agent skip silently when it is absent.

---

## Departments

Twelve placeholder departments are seeded on first run, with one level of hierarchy (Venue Operations Management contains Security, Clean & Waste Management, Traffic Management, Accreditation, and Staffing). Every department, parent or child, is a full reporting unit with its own HOD and report. Manage everything (names, contacts, colors, parents) from the admin Departments section.

---

## WhatsApp (Meta Cloud API)

1. Create an app at developers.facebook.com (type Business) and add the WhatsApp product.
2. Copy the test number's **Phone number ID**, a **temporary access token**, and the **App secret** into `.env`, set `WHATSAPP_ENABLED=true`, and pick any `WHATSAPP_VERIFY_TOKEN`.
3. Add up to 5 recipient numbers in Meta and verify them (test-number limit).
4. In Meta's WhatsApp Configuration, set the webhook to `{BASE_URL}/api/whatsapp/webhook` with your verify token and subscribe to `messages`.
5. Reminders and receipts now go out over WhatsApp, HOD replies land in the admin WhatsApp inbox, and the CLIO agent answers them (5 replies per thread per day, 50 globally) unless you press Take over on a thread.

For production: register a permanent system-user token and a message template, and move off the test number. Set `WHATSAPP_ENABLED=false` to switch all of it off.

---

## Reports

The nightly deck generates automatically at the configured time and is emailed to the PM list (toggle in Delivery). From the admin Report section you can also:

- Import a `.pptx` template; the deck then inherits its masters, theme, and slide size (with an option to adopt the template's accent color).
- Reorder, enable, and configure the slide types.
- See a live HTML approximation of every slide, or render a **true preview** (actual slides as images) when LibreOffice is installed.
- Generate a test deck for any date.

Automation endpoints (admin password or `x-api-key`):

```bash
curl -X POST {BASE_URL}/api/generate-report \
  -H "x-api-key: $REPORT_API_KEY" -H "Content-Type: application/json" \
  -d '{"date":"2026-08-18","send_email":true}'

curl -H "x-api-key: $REPORT_API_KEY" "{BASE_URL}/api/weekly-summary?end=2026-08-18"
```

---

## Deployment (Railway)

The repo ships `nixpacks.toml` and `railway.json` in `clio-agent/`. Point a Railway service at the GitHub repo with root directory `clio-agent`, mount a volume at `/data`, and set `DATA_DIR=/data` plus the env vars above. The build includes Node, Python with the pip requirements, LibreOffice, and poppler, so report generation and true previews work out of the box. Cron jobs run in-process, so an always-on service is all the scheduling you need. The Railway public URL doubles as the Meta webhook callback.

---

## Folder Structure

```
clio-agent/
├── server.js              # Express app, API, cron, WhatsApp handlers
├── notifications.js       # Email + WhatsApp notification templates
├── whatsapp.js            # Meta Cloud API sender
├── whatsapp-webhook.js    # Webhook verification, parsing, routes
├── whatsapp-store.js      # Thread + message persistence
├── render-preview.js      # PPTX to PNG rasterization (LibreOffice + poppler)
├── nixpacks.toml          # Railway build (Node, Python, LibreOffice, poppler)
├── railway.json           # Railway deploy config
├── db/schema.sql          # Schema, IF NOT EXISTS style
├── scripts/
│   ├── generate_report.py        # Daily PPTX generator (brand + template aware)
│   └── generate_weekly_report.py # Weekly PPTX generator
├── test/                  # node:test suites (npm test)
└── public/
    ├── index.html + app.js       # HOD portal (3-step flow, autosave)
    ├── admin.html + admin.js     # Admin console (9 sections)
    └── style.css                 # Design system, brand-token driven
```

Runtime data (`db/clio.db`, `uploads/`, `reports/`) resolves under `DATA_DIR` when set, otherwise under `clio-agent/`.

---

## Troubleshooting

**SMTP authentication failures**: Gmail needs an app-specific password when 2FA is on: https://myaccount.google.com/apppasswords into `SMTP_PASS`.

**WhatsApp sends silently skipped**: check `WHATSAPP_ENABLED=true` and that all four Meta vars are set; test tokens expire after about 24 hours. The server logs `[wa] skipped` lines with the reason.

**Webhook verification fails in Meta**: the verify token in Meta must exactly match `WHATSAPP_VERIFY_TOKEN`, and the URL must be publicly reachable over HTTPS.

**True preview says renderer not installed**: install LibreOffice and poppler locally, or use the live approximation; the Railway image already includes both.

**HEIC photos failing to convert**: keep `libvips` current (`brew upgrade vips` or `apt install libvips-dev`, then `npm rebuild sharp`).

**Cron didn't run**: node-cron runs in-process, so CLIO must be running at the scheduled time. On Railway the always-on service covers this; locally use a process supervisor.

**Report missing submissions**: check `TIMEZONE`; submissions bucket by the local date in that timezone.

---

## License

White-label product. © the deploying organization.
