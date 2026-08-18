# CLIO v2 Design Spec

Date: 2026-08-18
Status: awaiting user approval
Design preview: reviewed and approved by Serge on 2026-08-18 (with the WhatsApp takeover addition).

## Goal

Take CLIO from a working prototype to a launch-ready, white-label product: fully de-branded, a rebuilt frontend for both operators and admins, WhatsApp reminders through Meta's official Cloud API with an admin inbox and human takeover, a reviewed and documented workflow, and 24/7 hosting on Railway deployed from a private GitHub repo.

## Scope

1. De-branding: remove every STAMiNA remnant; delete the outdated `clio-agent/output/` demos and assets.
2. Full frontend rebuild of `clio-agent/public/` (operator portal + admin console), no build step, vanilla HTML/CSS/JS.
3. WhatsApp integration rebuilt on the Meta Cloud API (drop Twilio), with a threaded inbox in the admin console, agent auto-replies, and per-thread human takeover.
4. Full code and workflow review, delivered as a designed, self-contained `docs/workflow.html` the user can inspect and annotate.
5. Git repo at the project root, pushed to a private GitHub repo on the `sergeadaimy-hash` account; Railway deployment (hash Railway account) with a persistent volume.

Out of scope for this cycle: production WhatsApp number registration (Meta Business verification), multi-event support, authentication overhaul beyond what the code review flags as necessary.

## 1. De-branding

* Delete `clio-agent/output/` entirely (STAMiNA-branded demos, old logo, slide images).
* Grep sweep for `STAMiNA`, `stamina`, `F8FF00`, `#101820` across every served file, both Python generators, `.env.example`, and `README.md`; replace with neutral copy or brand tokens.
* Default identity stays "CLIO" with the neutral slate + blue token palette; everything visual flows from the admin Brand tab config.

## 2. Frontend rebuild ("Control Room Calm")

Design direction as shown in the approved preview: dark, precise show-control aesthetic. Type system (revised per Serge's feedback on 2026-08-18): Sora across the board, with heavy weights (700 to 800) for display headings, and JetBrains Mono for data (times, percentages, counts). Two accents: blue `#3B82F6` for interactive elements (buttons, sliders, progress fills, active states) and yellow `#FACC15` for mono labels, field labels, kickers, and contrast hairlines. Status colors (green submitted, amber pending, red blocked) are fixed across brands; brand accents, backgrounds, text, and fonts come from the Brand tab as CSS custom properties injected at page load.

### Operator portal (`public/index.html`, mobile first)

* Screen 1, department select: event header from config, date and day number, deadline countdown pill, department cards showing live team status (submitted with timestamp, or pending) and HOD name.
* Guided 3-step flow replacing the single long form:
  * Step 1 Progress: large percent readout with a touch-friendly slider.
  * Step 2 Notes: status, highlights, blockers, schedule updates.
  * Step 3 Photos: photo grid with per-photo caption fields (captions print under photos in the PPTX).
* Draft autosave to localStorage keyed by department + date; restore on reload; visible "draft saved" indicator.
* Submission success screen with timestamp receipt, note that AI polishes the text, and an edit path open until the deadline.
* Existing API contract preserved (`/api/status`, `/api/submission/:id`, `/api/submit` multipart).

### Admin console (`public/admin.html`)

* Sidebar navigation replacing the 8-tab strip. Sections: Overview, Departments, WhatsApp (new), Brand, Report, Delivery, Schedule, Archive, Project. Brand lockup at top, environment status at bottom.
* Overview rebuilt as a control surface: KPI row (submitted count, average progress, blocker count, next report run), per-department progress bars with stream colors and per-department NUDGE action, submission donut, primary actions (generate report, remind pending, download last).
* All other sections keep their current capabilities with the new visual system and clearer forms.
* Existing admin API preserved; new endpoints only for WhatsApp.

## 2b. Department hierarchy and new placeholder departments (added 2026-08-18 per Serge)

* Placeholder departments (seed defaults and dev data) become: Overlay & Venue Infrastructure, Event Experience, Venue Operations Management, Guest Management, Food & Beverage, Technical Production, Hospitality. Sub-departments under Venue Operations Management: Security, Clean & Waste Management, Traffic Management, Accreditation, Staffing.
* Model: `departments.parent_id` (nullable, references departments). Every department, parent or child, is a full reporting unit: own HOD, own submission, own report section. Parents with children act as group headers in the portal, admin, and PPTX; a parent with children and no HOD contact simply never submits or gets reminders.
* Portal: department cards grouped under parent headers. Admin: parent selector in Departments CRUD (only parentless departments are selectable as parents; one level deep). Report: sections ordered parent first, then its children, then the next parent.

## 2c. Report builder: template import, layout guidelines, admin preview (added 2026-08-18 per Serge)

* Template import: the admin Report section gains an "Import template (.pptx)" upload, stored under the data dir (uploads/brand/report_template.pptx). When present and enabled, `generate_report.py` opens it as the base presentation (python-pptx), inheriting slide size, masters, and theme, and appends the generated slides. `report_config.template_mode`: `tokens` (default, current brand-token styling) or `template` (imported template drives the look; a sub-toggle chooses template theme colors vs admin brand colors for chart and text accents).
* Layout guidelines: `report_config` expands to a builder schema: ordered slide list (cover, overview, department pages, photo pages, schedule) with enable/disable and reorder, plus per-slide options (cover style, logo position, photos per page, page numbers, donut on/off, status badges, timestamps).
* Admin preview, two tiers (updated 2026-08-18: Serge wants pixel-true previews, deploy weight accepted):
  * Instant tier: a live HTML preview pane renders an approximation of each enabled slide using the current report config, brand tokens, and real data from the latest submissions; updates on every config change.
  * True tier: a "Render true preview" action generates the real PPTX for a chosen date, rasterizes every slide server-side (LibreOffice headless converts PPTX to PDF, pdftoppm converts pages to PNGs), and shows the actual slide images in the preview pane with a filmstrip navigator. Renders are cached per date + config hash under the data dir and invalidated when config or template changes. If LibreOffice is not installed (typical local dev), the UI degrades gracefully to the instant tier with a notice; the Railway image includes libreoffice and poppler_utils via nixpacks.
  * A "Generate test deck" action still downloads the raw PPTX.

## 2d. HOD accounts and desktop portal layout (added 2026-08-18 per Serge, post-deploy)

* `departments` gains `username` (unique, nullable), `password_hash` (salted scrypt, `salt:hash` hex), `credentials_updated_at`. Passwords are generated server-side (12 chars, unambiguous alphabet), returned exactly once at generation, and only the hash is stored.
* Admin Departments section: per-department Credentials control: generate (auto username from the department name, editable) and regenerate; the response shows the one-time password with a copy action. `GET /api/admin/departments` exposes `username` and a `has_credentials` flag, never hashes. Endpoints: `POST /api/admin/departments/:id/credentials` `{username?}` and `DELETE` to revoke.
* Portal login: `POST /api/portal/login` `{username, password}` returns `{token, department}`. Token = HMAC-signed payload `{d: deptId, exp: now + 30 days}` (secret: `SESSION_SECRET` env, fallback derived from `ADMIN_PASSWORD`), stored in localStorage, sent as `x-portal-token`.
* Protection: `GET /api/submission/:id` requires the token department to match (admin password also accepted), `POST /api/submit` forces `department_id` to the token's department, `POST /api/review-text` requires a valid portal token or admin auth (no longer public). `GET /api/status` stays public (login screen needs brand + event identity; progress numbers are low sensitivity).
* Portal flow after login: HOD lands on their own department (form or readonly), with the team status list visible read-only; logout control present. Departments without credentials cannot log in; the login screen says to ask the admin.
* Desktop layout: at 900px and above the portal becomes two-pane (left rail: event identity, deadline, team status; right: the 3-step flow / readonly / success), phone layout unchanged below that.

## 3. WhatsApp via Meta Cloud API

### Sending

* New `whatsapp.js` module calling the Graph API (`https://graph.facebook.com/v20.0/{phone_number_id}/messages`) with plain fetch. Remove the `twilio` dependency and all Twilio code paths.
* Env vars: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`.
* Test mode: Meta's free test number, up to 5 verified recipient numbers. The admin WhatsApp section displays a test-mode banner with the recipient limit.
* Reminders at the scheduled time go as template messages (test number ships with `hello_world`; we register a `daily_reminder` template when moving past smoke tests). Free-form text is used inside the 24 hour customer service window opened by an inbound HOD message; outside the window CLIO falls back to a template automatically.

### Receiving

* `GET /api/whatsapp/webhook`: Meta verification handshake (echo `hub.challenge` when `hub.verify_token` matches).
* `POST /api/whatsapp/webhook`: validate `X-Hub-Signature-256` with the app secret; ingest inbound messages and delivery status updates (sent, delivered, read, failed).

### Data model

* New table `whatsapp_threads`: id, wa_number, department_id (nullable), display_name, mode (`agent` | `human`), last_message_at, unread_count.
* New table `whatsapp_messages`: id, thread_id, direction (`in` | `out`), body, message_type (text | template), template_name, wa_message_id, status, sent_by (`agent` | `human` | `system`), created_at.

### Agent auto-reply and human takeover

* Default mode per thread is `agent`: inbound HOD messages get a context-aware auto-reply generated with the Claude API (same key as content review), grounded in live data: submission status, deadline, event name. Strict guardrails: short replies, reporting topics only, at most 5 auto-replies per thread per day, silent fallback if no API key.
* "Take over" button on each thread switches mode to `human`: the agent stops replying, the composer unlocks for the admin, and outgoing messages are marked as human-sent. "Return to agent" hands the thread back. Mode is visible in the thread list.

### Admin inbox UI

* Two-pane layout: searchable thread list (avatar, name, department tag, preview, unread dot) and conversation view (day dividers, outbound bubbles with template tag and delivery ticks, inbound bubbles, composer). Unread total badges on the sidebar nav item.
* Polling refresh (no websockets) at a modest interval while the tab is open.

## 4. Code review + workflow document

* Full review pass over `server.js`, `notifications.js`, both Python generators, and the new frontend: dead Twilio paths, unauthenticated portal endpoints (`/api/submit`, `/api/review-text` and friends), upload validation, webhook security, cron correctness, SQLite WAL handling on a volume.
* Findings that are quick and safe get fixed in this cycle; larger items get flagged in the workflow document for Serge to prioritize.
* Deliverable: `docs/workflow.html`, a designed, self-contained page mapping the entire system: daily timeline (reminder, submission, LLM polish, report generation, email delivery), every actor, endpoint, cron job, and data store, plus flagged weak spots. Also published as a private artifact link.

## 5. Git + Railway

* Repo root: the project folder (contains `CLAUDE.md`, `docs/`, `clio-agent/`). Root `.gitignore` excludes runtime data (SQLite db, uploads, reports, PPTX), `.env`, `node_modules`, caches.
* Private GitHub repo on the `sergeadaimy-hash` account (gh CLI already authenticated, hash active). Push `main`.
* Railway (hash account): service root directory `clio-agent`; `railway.json` + `nixpacks.toml` providing Node 18+ and Python 3 with `requirements.txt` installed; start command `node server.js`.
* One persistent volume mounted at a data path; `db/`, `uploads/`, and `reports/` resolve to it via env var (`DATA_DIR`) with local-relative fallback for development.
* Cron jobs already run in-process, so an always-on Railway service gives 24/7 reminders and reports. The Railway public URL is the Meta webhook callback URL.
* Env vars set in Railway: `ADMIN_PASSWORD`, SMTP settings, `ANTHROPIC_API_KEY` (or the admin-panel-stored key), the four `WHATSAPP_*` vars, `TZ` handling stays as configured timezone in settings.

## Build order

1. Git init and initial commit (done at spec time), de-brand sweep, delete `output/`.
2. Code review pass with quick fixes.
3. Frontend rebuild: portal, then admin.
4. WhatsApp module, webhook, tables, inbox UI, takeover.
5. `docs/workflow.html`.
6. Railway config, GitHub push, deploy, volume, env vars.
7. Meta app setup walkthrough with Serge (app creation, test number, verified recipients, webhook subscribe) and end-to-end WhatsApp smoke test.

## Testing

* Portal: submit a full report from a phone-sized viewport (draft autosave, photo captions, edit before deadline) against the local server.
* Admin: every section loads and saves; nudge sends a real reminder; report generation produces a PPTX with the new brand tokens.
* WhatsApp: webhook verification handshake, signed webhook ingestion (sample payloads), template send to a verified test recipient, auto-reply guardrails, takeover toggle persistence.
* Deploy: fresh Railway deploy boots with empty volume, creates schema, survives a redeploy with data intact.

## User inputs needed along the way

* Meta for Developers app creation clicks and tokens (guided walkthrough).
* Up to 5 HOD phone numbers to verify as test recipients.
* Railway project creation confirmation on the hash account.
