# CLIO: Event Daily Report Agent

CLIO is an automated daily reporting system for live event productions. Department heads (HODs) submit their end-of-day progress from their phone via a mobile-first web portal: completion %, status notes, schedule, and photos. Every night at 11:00 PM, CLIO stitches the submissions into a polished branded PowerPoint report and emails it to the PM team, with a WhatsApp ping for good measure.

CLIO also reminds HODs at 9:00 PM if they haven't submitted yet, notifies the PM team in real time on every submission, and exposes an admin panel for manual report generation, reminder dispatch, and historical reports.

---

## Prerequisites

- **Node.js 18+**
- **Python 3.9+** (with `pip3`)
- An **SMTP account** (Gmail app password works, enable 2FA and create an app-specific password)
- A **Twilio account** with the WhatsApp sandbox enabled (for testing) or an approved WhatsApp Business number (for production)

---

## Installation

```bash
cd clio-agent
./setup.sh
```

This will:
1. Install Node dependencies (`npm install`)
2. Install Python dependencies (`pip3 install -r requirements.txt`)
3. Create `uploads/`, `reports/`, `db/` directories
4. Initialize the SQLite database at `db/clio.db` (runs schema migration)
5. Copy `.env.example` to `.env`

Then edit `.env` with your credentials and run:

```bash
node server.js
```

The portal will be live at `http://localhost:3000/` (or whatever `BASE_URL` is set to in `.env`).

---

## Configuration via `.env`

Every setting lives in `.env`. Key fields:

| Variable | Purpose |
|---|---|
| `EVENT_NAME` | Shown in reports and emails |
| `EVENT_EDITION` | E.g., `Day 1`, `Festival Week` |
| `TIMEZONE` | IANA TZ (default `Asia/Riyadh`) |
| `BASE_URL` | Public URL of the portal (used in email CTAs) |
| `SMTP_*` | SMTP credentials for outgoing email |
| `PM_EMAILS` | Comma-separated list of PM emails |
| `PM_WHATSAPP` | Comma-separated list of PM WhatsApp numbers |
| `DEPT_EMAIL_*` | HOD email per department |
| `DEPT_WHATSAPP_*` | HOD WhatsApp per department |
| `TWILIO_*` | Twilio credentials |
| `WHATSAPP_ENABLED` | `true` / `false`, flip to `false` to disable all WA calls |
| `REPORT_API_KEY` | Shared secret for `/api/generate-report` |
| `ADMIN_PASSWORD` | Admin panel password |
| `REPORT_DATE_OVERRIDE` | Optional. Force CLIO to treat every submission/report as this date |

HOD contact info is pulled from `.env` on every server start and synced into the `departments` table.

---

## Accessing CLIO

- **Portal for HODs:** `{BASE_URL}/`
- **Admin panel:** `{BASE_URL}/admin.html`
- **Health check:** `GET {BASE_URL}/health`

---

## Adding or Modifying Departments

The 7 default departments are seeded on first run:
STAGE, LIGHTING, AV, SCENIC, RIGGING, SHOW DIRECTION, LOGISTICS.

To modify:
- **Change contact info** → edit `.env` (`DEPT_EMAIL_*`, `DEPT_WHATSAPP_*`) and restart. Contacts are re-synced on every startup.
- **Rename or add a department** → open `db/clio.db` with any SQLite client and `INSERT`/`UPDATE` the `departments` table. Don't forget to add matching `DEPT_EMAIL_*` / `DEPT_WHATSAPP_*` entries using the new slug (uppercase, underscores).
- **Change stream color** → update `stream_color` in the `departments` row (hex with `#`).

---

## Manually Triggering a Report

Via admin panel: log in and click **Generate Report Now**, or pick a date and click **Generate Historical Report**.

Via curl:

```bash
curl -X POST http://localhost:3000/api/generate-report \
  -H "x-api-key: $REPORT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"date":"2025-04-15"}'
```

Returns JSON `{ success, report_path }`. On success the PPTX is written to `reports/{date}/daily_report.pptx` (but manually generated runs do **not** trigger the email delivery; use the cron at 11PM, or email it manually from the admin download button).

## Manually Triggering Reminders

Admin panel: **Send Reminders Now**.

Via API:

```bash
curl -X POST http://localhost:3000/api/admin/send-reminders \
  -H "Content-Type: application/json" \
  -d '{"password":"YOUR_ADMIN_PASSWORD"}'
```

## Weekly Report

```bash
curl -H "x-api-key: $REPORT_API_KEY" \
  "http://localhost:3000/api/weekly-summary?end=2025-04-15"
```

Output saved to `reports/weekly/weekly_report_{end}.pptx`.

---

## Cron Schedule

| Time (TZ from `.env`) | Action |
|---|---|
| **21:00** | Send reminder email + WhatsApp to any HOD who hasn't submitted yet |
| **23:00** | Run `generate_report.py`, email PPTX to PM team, WhatsApp ping; on error send fallback email with raw data |

Cron runs in-process via `node-cron` using the configured `TIMEZONE`.

---

## Folder Structure

```
clio-agent/
├── server.js              # Express server + cron + API
├── notifications.js       # Email + WhatsApp helpers
├── package.json
├── requirements.txt
├── setup.sh
├── .env.example
├── db/
│   ├── schema.sql         # Migrations
│   └── clio.db            # SQLite DB (created on first run)
├── scripts/
│   ├── generate_report.py        # Daily PPTX generator
│   └── generate_weekly_report.py # Weekly PPTX generator
├── templates/
│   └── base_template.pptx # Optional base template (ignored if absent)
├── uploads/
│   └── {YYYY-MM-DD}/{DEPT}/...  # Photos, HEIC auto-converted to JPEG
├── reports/
│   └── {YYYY-MM-DD}/daily_report.pptx
└── public/
    ├── index.html   # HOD portal
    ├── admin.html   # Admin dashboard
    ├── style.css
    └── app.js
```

---

## Troubleshooting

**SMTP authentication failures**
Gmail requires an app-specific password when 2FA is enabled (the regular account password will not work). Generate one at https://myaccount.google.com/apppasswords and paste into `SMTP_PASS`.

**Twilio WhatsApp not delivering**
For testing you must use the Twilio sandbox. HODs need to first send the sandbox join code from their WhatsApp to `+14155238886`. In production, you need an approved WhatsApp Business sender. To disable WhatsApp entirely, set `WHATSAPP_ENABLED=false`.

**HEIC photos failing to convert**
`sharp` handles HEIC on macOS and most Linux distros out of the box. If you hit issues, ensure `libvips` is up-to-date: `brew upgrade vips` or `apt install libvips-dev` then `npm rebuild sharp`.

**Python script can't find modules**
Re-run `pip3 install -r requirements.txt`. If you're on a system with multiple Python installs, check which `python3` is on the server's PATH.

**Cron didn't run**
node-cron runs in-process. If `node server.js` wasn't running at 11PM, nothing happens. For production, use `pm2`, `systemd`, or a process supervisor to keep CLIO running 24/7.

**Report missing submissions**
Check `TIMEZONE` in `.env`. Submissions are bucketed by the local date in that TZ. If your server is UTC but your event is in Riyadh, you must set `TIMEZONE=Asia/Riyadh` so the "today" bucket aligns with the event day.

---

## WhatsApp Setup Note

Twilio's WhatsApp sandbox is great for development but has two limitations:
1. Recipients must opt in by messaging the sandbox join code first.
2. Templates are restricted and messages expire out of the 24h window quickly.

For production use, you'll need an **approved WhatsApp Business Number** through Twilio (or any WhatsApp BSP). Set `TWILIO_WHATSAPP_FROM=whatsapp:+<your_approved_number>` once approved. Template approval is required for proactive messages (reminders, report-ready pings); see Twilio's docs for the approval flow.

---

## License

Internal tool, © Your Company.
