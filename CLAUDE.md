# CLIO: Event Daily Report Agent

## What is CLIO
Automated daily reporting system for live event productions. White-label: every brand element (logo, colors, fonts, company name) is set per-deployment from the admin panel. Department heads (HODs) submit end-of-day progress via a mobile-first web portal. CLIO generates branded PowerPoint reports, emails them to the PM team, and archives all data.

## Tech Stack
- **Backend:** Node.js / Express, SQLite (better-sqlite3), multer for uploads
- **Frontend:** Vanilla HTML/CSS/JS, Sora font, mobile-first
- **Reports:** Python (python-pptx, matplotlib, Pillow), generates PPTX from DB data
- **Notifications:** Nodemailer (SMTP) + Twilio (WhatsApp)
- **Scheduling:** node-cron (in-process, configurable from admin)
- **AI:** Claude API (Haiku) for content review, polishes grammar, spelling, and writing style

## Project Structure
```
clio-agent/
  server.js              : Express server, API, cron jobs, LLM review endpoint
  notifications.js       : Email + WhatsApp helpers (reads PM emails from DB)
  scripts/
    generate_report.py   : Daily PPTX generator (reads brand/report config from DB)
    generate_weekly_report.py
  public/
    index.html           : HOD portal (4 screens: select, readonly, form, success)
    admin.html           : Admin panel (8 tabs)
    style.css            : Neutral dark theme by default (#0F172A slate + #3B82F6 blue), all colors overridable from admin Brand tab
    app.js               : Portal JS logic + LLM review + photo captions
    assets/              : Empty by default; admin-uploaded logo lands in uploads/brand/logo.png
  db/
    schema.sql           : departments, daily_submissions, submission_log, settings
    clio.db              : SQLite database
  uploads/               : Photo uploads: {date}/{DEPT_SLUG}/{files}
  reports/               : Generated PPTX reports: {date}/daily_report.pptx
```

## Admin Panel (8 Tabs)
Password: set via `ADMIN_PASSWORD` in `.env`

| Tab | Purpose |
|-----|---------|
| Overview | Submission status, report gen/download, send reminders, logs |
| Project | Event name, edition/phase |
| Departments | CRUD departments with HOD name, email, WhatsApp, stream color |
| Brand | Logo upload, company name, report colors (bg/primary/text/muted/panel), font |
| Report | Slide structure: enable/disable/reorder 5 slide types, per-slide options, dimensions |
| Delivery | PM team emails (add/remove), auto-email toggle, Anthropic API key, cloud storage path |
| Schedule | Configurable reminder time, report generation time, deadline text, timezone display |
| Archive | Browsable data directory by date > department > photos + raw submission data |

## Database Tables
- `departments`: id, name, head_name, head_email, head_whatsapp, stream_color
- `daily_submissions`: per-dept per-date, holds progress, text, schedule, photos, photo_captions, polished_* fields
- `submission_log`: audit trail
- `settings`: key/value pairs for event_name, event_edition, brand_config, report_config, pm_emails, delivery_config, schedule_config

## Key Features
- **Photo captions:** HODs describe each photo; captions stored per-submission and displayed under photos in PPTX
- **LLM content review:** On submission, all text fields (status, highlights, blockers, captions) sent to Claude Haiku API for grammar/spelling/style polishing. Fails gracefully if no API key configured.
- **Configurable scheduling:** Reminder time and report generation time set from admin (default 21:00 / 23:00). Cron jobs restart when schedule is updated.
- **Auto-email delivery:** Reports can be auto-emailed to PM team on generation. PM emails managed from admin panel (stored in DB, not .env).
- **Brand-driven reports:** All PPTX slides use admin-configured brand colors, font, logo. Logo appears on every slide.
- **Report structure control:** Admin can enable/disable slide types, reorder them, configure per-slide options (show/hide donut chart, badges, timestamps, photos per page, etc.)

## Development
```bash
cd clio-agent
npm install && pip3 install -r requirements.txt
cp .env.example .env  # edit with real credentials
node server.js        # runs on port 3000
```

## Key Conventions
- All department names stored uppercase
- Photos auto-converted to JPEG via sharp (handles HEIC)
- Submissions bucketed by local date in configured timezone (default: Asia/Riyadh)
- Report generation: Python reads directly from SQLite DB
- Config flow: Admin UI -> settings table (JSON blobs) -> Python reads on each run
- Notifications module reads PM emails from DB via injected accessors (falls back to .env)
