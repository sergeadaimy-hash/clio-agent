# CLIO: Event Daily Report Agent

## What is CLIO
Automated daily reporting system for live event productions. White-label: every brand element (logo, colors, fonts, company name) is set per-deployment from the admin console. Department heads (HODs) submit end-of-day progress via a mobile-first web portal. CLIO generates branded PowerPoint reports, emails them to the PM team, handles WhatsApp reminders and replies through an AI agent with human takeover, and archives all data.

## Tech Stack
- **Backend:** Node.js / Express, SQLite (better-sqlite3), multer for uploads
- **Frontend:** Vanilla HTML/CSS/JS, Sora + JetBrains Mono, mobile-first, no build step
- **Reports:** Python (python-pptx, matplotlib, Pillow), generates PPTX from DB data; optional imported .pptx template drives the look; LibreOffice + poppler rasterize true previews
- **Notifications:** Nodemailer (SMTP) + Meta WhatsApp Cloud API (signed webhook, thread store)
- **Scheduling:** node-cron (in-process, configurable from admin)
- **AI:** Claude API (Haiku) for content polish and the WhatsApp auto-reply agent (capped 5/thread/day, 50/day global, per-thread human takeover)
- **Tests:** node:test (`npm test`) covering the WhatsApp sender and webhook
- **Hosting:** Railway (nixpacks build in `clio-agent/`), persistent volume via `DATA_DIR`

## Project Structure
```
clio-agent/
  server.js              : Express app, API, cron jobs, WhatsApp handlers, LLM endpoints
  notifications.js       : Email + WhatsApp notification templates
  whatsapp.js            : Meta Cloud API sender (fail-soft)
  whatsapp-webhook.js    : Webhook verification (HMAC), parsing, routes
  whatsapp-store.js      : whatsapp_threads / whatsapp_messages persistence
  render-preview.js      : PPTX to PNG rasterization (soffice + pdftoppm, staged atomic cache)
  nixpacks.toml          : Railway build (Node 20, Python 3.12, LibreOffice, poppler)
  railway.json           : Railway deploy config
  scripts/
    generate_report.py   : Daily PPTX (brand tokens or imported template, hierarchy-ordered)
    generate_weekly_report.py : Weekly PPTX (still v1-era, not template-aware)
  public/
    index.html + app.js  : HOD portal: 3-step flow (progress, notes, photos+captions),
                           localStorage draft autosave, brand token injection
    admin.html + admin.js: Admin console, 9 sidebar sections, x-admin-password header auth
    style.css            : Design system: slate dark default, blue interactive accent,
                           yellow label accent, all overridable from admin Brand
  db/schema.sql          : IF NOT EXISTS schema; migrations are try/catch ALTERs in server.js
  test/                  : node:test suites
docs/
  design-preview.html    : Approved visual reference ("Control Room Calm")
  workflow.html          : System map: timeline, actors, endpoints, stores, weak spots
  superpowers/           : Spec and implementation plan for the v2 build
```

## Admin Console (9 sections, password via ADMIN_PASSWORD)
| Section | Purpose |
|---------|---------|
| Overview | KPIs, per-department streams with per-dept NUDGE, donut, generate/download, activity log |
| Departments | CRUD with one-level parent hierarchy, HOD contacts, stream colors |
| WhatsApp | Threaded inbox, delivery ticks, agent/human mode with Take over, reply composer |
| Brand | Logo, company name, six colors + label color, font; live preview |
| Report | Builder: template import (.pptx), slide toggles/reorder/options, live preview, true render, test deck |
| Delivery | PM emails, sender name, auto-email toggle, Anthropic API key, archive path |
| Schedule | Reminder + report times, deadline text; cron restarts on save |
| Archive | Browsable by date: submissions + photos |
| Project | Event name, edition |

## Database Tables
- `departments`: id, name, head contacts, stream_color, parent_id (one level; parents with children act as group headers)
- `daily_submissions`: per-dept per-date; progress, texts, schedule, photos, photo_captions, version
- `submission_log`: audit trail
- `settings`: key/value JSON blobs (event, brand_config, report_config, pm_emails, delivery_config, schedule_config)
- `whatsapp_threads`: per number; department link, mode (agent/human), unread count
- `whatsapp_messages`: direction, body, template name, wa_message_id (unique, dedups Meta redeliveries), status, sent_by

## Key Conventions
- All department names stored uppercase; seed slugs are uppercase with underscores
- Photos auto-converted to JPEG via sharp (handles HEIC); captions keyed by original filename
- Submissions bucketed by local date in configured timezone (default Asia/Riyadh)
- Runtime data (db, uploads, reports) resolves under `DATA_DIR` when set (Railway volume), app dir otherwise
- Config flow: Admin UI -> settings table JSON blobs -> server helpers at request time and Python on each run
- Anthropic API key lives in delivery_config (DB), not .env; all AI paths fail soft without it
- Report generation is serialized per date (preview renders, test decks, and cron share one lock)
- Admin API calls send the password as `x-admin-password`; only archive/preview image URLs may use `?password=` (img tags cannot send headers)
- Writing style: never use em-dashes, en-dashes, or double-hyphen punctuation anywhere (user-wide rule)

## Development
```bash
cd clio-agent
npm install && pip3 install -r requirements.txt
cp .env.example .env  # edit with real credentials
node server.js        # port 3000
npm test              # node:test suites
```

## Deployment
- GitHub: private repo `sergeadaimy-hash/clio-agent` (hash account, never AZ)
- Railway (hash account): service root `clio-agent`, volume at `/data`, `DATA_DIR=/data`
- Meta WhatsApp: test number (5 verified recipients), webhook at `{BASE_URL}/api/whatsapp/webhook`
- Known gaps and their priorities live in `docs/workflow.html`
