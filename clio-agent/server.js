// server.js: CLIO main application
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const multer = require('multer');
const sharp = require('sharp');
const cron = require('node-cron');
const { DateTime } = require('luxon');

const notifications = require('./notifications');
const renderPreview = require('./render-preview');

// ── Paths ───────────────────────────────────────────────────
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || ROOT;
const DB_PATH = path.join(DATA_DIR, 'db', 'clio.db');
const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

for (const d of [path.dirname(DB_PATH), UPLOADS_DIR, REPORTS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// ── DB init ─────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// Migrations
try {
  db.exec('ALTER TABLE daily_submissions ADD COLUMN photo_captions TEXT');
} catch (e) { /* column already exists */ }
try {
  db.exec('ALTER TABLE daily_submissions ADD COLUMN polished_status_text TEXT');
  db.exec('ALTER TABLE daily_submissions ADD COLUMN polished_highlights TEXT');
  db.exec('ALTER TABLE daily_submissions ADD COLUMN polished_blockers TEXT');
  db.exec('ALTER TABLE daily_submissions ADD COLUMN polished_photo_captions TEXT');
} catch (e) { /* columns already exist */ }
try {
  db.exec('ALTER TABLE departments ADD COLUMN parent_id INTEGER');
} catch (e) { /* column already exists */ }

// Seed departments on first run. Flat array with an optional `parent` field
// (parent referenced by name). One level deep: a child never has children.
const DEFAULT_DEPARTMENTS = [
  { name: 'OVERLAY & VENUE INFRASTRUCTURE', slug: 'OVERLAY_VENUE_INFRASTRUCTURE', color: '#F97316' },
  { name: 'EVENT EXPERIENCE',               slug: 'EVENT_EXPERIENCE',             color: '#A78BFA' },
  { name: 'VENUE OPERATIONS MANAGEMENT',    slug: 'VENUE_OPERATIONS_MANAGEMENT',  color: '#3B82F6' },
  { name: 'SECURITY',                       slug: 'SECURITY',                     color: '#60A5FA', parent: 'VENUE OPERATIONS MANAGEMENT' },
  { name: 'CLEAN & WASTE MANAGEMENT',       slug: 'CLEAN_WASTE_MANAGEMENT',       color: '#34D399', parent: 'VENUE OPERATIONS MANAGEMENT' },
  { name: 'TRAFFIC MANAGEMENT',             slug: 'TRAFFIC_MANAGEMENT',           color: '#FBBF24', parent: 'VENUE OPERATIONS MANAGEMENT' },
  { name: 'ACCREDITATION',                  slug: 'ACCREDITATION',                color: '#F472B6', parent: 'VENUE OPERATIONS MANAGEMENT' },
  { name: 'STAFFING',                       slug: 'STAFFING',                     color: '#22D3EE', parent: 'VENUE OPERATIONS MANAGEMENT' },
  { name: 'GUEST MANAGEMENT',               slug: 'GUEST_MANAGEMENT',             color: '#EAB308' },
  { name: 'FOOD & BEVERAGE',                slug: 'FOOD_BEVERAGE',                color: '#FB923C' },
  { name: 'TECHNICAL PRODUCTION',           slug: 'TECHNICAL_PRODUCTION',         color: '#818CF8' },
  { name: 'HOSPITALITY',                    slug: 'HOSPITALITY',                  color: '#2DD4BF' }
];

const deptCount = db.prepare('SELECT COUNT(*) AS c FROM departments').get().c;
if (deptCount === 0) {
  const insert = db.prepare(`
    INSERT INTO departments (name, head_name, head_email, head_whatsapp, stream_color, parent_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const idByName = {};
  // Pass 1: parentless departments first, so children can resolve parent_id.
  for (const d of DEFAULT_DEPARTMENTS.filter(d => !d.parent)) {
    const info = insert.run(
      d.name,
      `${d.name} HOD`,
      process.env[`DEPT_EMAIL_${d.slug}`] || '',
      process.env[`DEPT_WHATSAPP_${d.slug}`] || '',
      d.color,
      null
    );
    idByName[d.name] = info.lastInsertRowid;
  }
  // Pass 2: children, resolved against their parent's id.
  const resolveParentId = (d) => {
    if (!(d.parent in idByName)) console.warn(`[db] seed: parent "${d.parent}" not found for ${d.name}, seeding as top-level`);
    return idByName[d.parent] || null;
  };
  for (const d of DEFAULT_DEPARTMENTS.filter(d => d.parent)) {
    insert.run(
      d.name,
      `${d.name} HOD`,
      process.env[`DEPT_EMAIL_${d.slug}`] || '',
      process.env[`DEPT_WHATSAPP_${d.slug}`] || '',
      d.color,
      resolveParentId(d)
    );
  }
  console.log(`[db] seeded ${DEFAULT_DEPARTMENTS.length} departments`);
}

// Refresh contact info from .env on every start (idempotent)
function syncDeptContacts() {
  const upd = db.prepare('UPDATE departments SET head_email = ?, head_whatsapp = ? WHERE name = ?');
  for (const d of DEFAULT_DEPARTMENTS) {
    const email = process.env[`DEPT_EMAIL_${d.slug}`];
    const wa = process.env[`DEPT_WHATSAPP_${d.slug}`];
    if (email || wa) {
      upd.run(email || '', wa || '', d.name);
    }
  }
}
syncDeptContacts();

// ── Settings (DB-backed, falls back to .env) ───────────────
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
function getEventName() {
  return getSetting('event_name') || process.env.EVENT_NAME || 'Event Name';
}
function getEventEdition() {
  return getSetting('event_edition') || process.env.EVENT_EDITION || '';
}

// PM team & delivery helpers
function getPmEmails() {
  try {
    const raw = getSetting('pm_emails');
    if (raw) return JSON.parse(raw);
  } catch {}
  return (process.env.PM_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
}
function getDeliveryConfig() {
  try {
    const raw = getSetting('delivery_config');
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}
function getBrandConfig() {
  try {
    const raw = getSetting('brand_config');
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}
function getReportConfig() {
  try {
    const raw = getSetting('report_config');
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}
function getLogoUrl() {
  const brand = getBrandConfig();
  if (!brand.logo_path) return null;
  try {
    const stat = fs.statSync(brand.logo_path);
    return `/uploads/brand/logo.png?v=${stat.mtimeMs}`;
  } catch { return null; }
}
// Public-safe subset of brand_config. Only whitelisted keys are returned;
// logo_path (a filesystem path) must never be exposed via the public API.
function getPublicBrand() {
  const b = getBrandConfig();
  return {
    company_name: b.company_name || '',
    background_color: b.background_color || '#0F172A',
    primary_color: b.primary_color || '#3B82F6',
    label_color: b.label_color || '#FACC15',
    text_color: b.text_color || '#E2E8F0',
    muted_color: b.muted_color || '#64748B',
    panel_color: b.panel_color || '#1E293B',
    font_family: b.font_family || 'Sora'
  };
}

// Seed settings from .env on first run
if (!getSetting('event_name') && process.env.EVENT_NAME) {
  setSetting('event_name', process.env.EVENT_NAME);
}
if (!getSetting('event_edition') && process.env.EVENT_EDITION) {
  setSetting('event_edition', process.env.EVENT_EDITION);
}
if (!getSetting('pm_emails') && process.env.PM_EMAILS) {
  setSetting('pm_emails', JSON.stringify(
    process.env.PM_EMAILS.split(',').map(s => s.trim()).filter(Boolean)
  ));
}

// Pass DB accessors to notifications module
notifications.init({ getPmEmails, getEventName, getSetting, getBrandConfig });

// ── Helpers ─────────────────────────────────────────────────
function tz() { return process.env.TIMEZONE || 'Asia/Riyadh'; }

function today() {
  if (process.env.REPORT_DATE_OVERRIDE) return process.env.REPORT_DATE_OVERRIDE;
  return DateTime.now().setZone(tz()).toFormat('yyyy-LL-dd');
}

function nowStamp() {
  return DateTime.now().setZone(tz()).toFormat('yyyy-LL-dd HH:mm:ss');
}

function slugify(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function logAction(department_id, submission_date, action) {
  db.prepare(`
    INSERT INTO submission_log (department_id, submission_date, action, timestamp)
    VALUES (?, ?, ?, ?)
  `).run(department_id, submission_date, action, nowStamp());
}

function getStatusList(date) {
  const depts = db.prepare('SELECT * FROM departments ORDER BY id').all();
  const subs = db.prepare(`
    SELECT * FROM daily_submissions WHERE submission_date = ? AND is_submitted = 1
  `).all(date);
  return depts.map(d => {
    const sub = subs.find(s => s.department_id === d.id);
    return {
      id: d.id,
      name: d.name,
      stream_color: d.stream_color,
      parent_id: d.parent_id,
      submitted: !!sub,
      submitted_at: sub ? sub.submitted_at : null,
      overall_progress: sub ? sub.overall_progress : 0
    };
  });
}

function parseSchedule(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// ── WhatsApp threads, inbound handling, agent auto-reply ────
const waStore = require('./whatsapp-store');
const wa = require('./whatsapp');
waStore.init(db);

function findDeptByWhatsapp(waNumber) {
  const clean = wa.normalizeNumber(waNumber);
  if (!clean) return null;
  return db.prepare('SELECT * FROM departments').all()
    .find(d => wa.normalizeNumber(d.head_whatsapp) === clean) || null;
}

async function agentAutoReply(thread, inboundBody) {
  let apiKey = '';
  try { apiKey = JSON.parse(getSetting('delivery_config') || '{}').anthropic_api_key || ''; } catch {}
  if (!apiKey) return null;
  const datePrefix = new Date().toISOString().slice(0, 10);
  if (waStore.countAgentRepliesTodayGlobal(datePrefix) >= 50) return null;
  if (waStore.countAgentRepliesToday(thread.id, datePrefix) >= 5) return null;

  const status = getStatusList(today());
  const dept = thread.department_id ? status.find(s => s.id === thread.department_id) : null;
  const cfg = getScheduleConfig();
  const system = thread.department_id
    ? `You are CLIO, the daily reporting assistant for the event "${getEventName()}".
You are replying to a department head on WhatsApp. Reply in 1 to 3 short sentences, friendly and factual.
Only discuss daily report topics: whether they submitted, the deadline, how to submit. If asked anything else, politely redirect to the report.
Facts: today is ${today()}. Report generation time: ${cfg.report_time || '23:00'}. Portal: ${process.env.BASE_URL || ''}.
${dept ? `Their department: ${dept.name}. Submitted today: ${dept.submitted ? 'yes at ' + dept.submitted_at : 'not yet'}.` : ''}
Submitted so far: ${status.filter(s => s.submitted).length} of ${status.length} departments.`
    : `You are CLIO, the reporting assistant for the event "${getEventName()}".
This WhatsApp number is not registered for daily reporting. Reply in 1 to 2 short sentences, friendly and factual.
Tell the sender this number is not set up for daily reporting and that they should contact the production office to get registered.
Do not mention or include any portal URL, the event schedule, submission counts, or department statuses. Do not guess who they are.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300, system,
        messages: [{ role: 'user', content: String(inboundBody || '').slice(0, 1000) }]
      })
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.content?.[0]?.text || null;
  } catch { return null; }
}

const inFlightAgentReplies = new Set();

async function handleInboundWhatsApp(msg) {
  if (msg.wa_message_id && waStore.findMessageByWaId(msg.wa_message_id)) {
    console.log('[wa] duplicate delivery ignored');
    return;
  }
  const dept = findDeptByWhatsapp(msg.from);
  const thread = waStore.upsertThread(wa.normalizeNumber(msg.from), { name: msg.name, departmentId: dept ? dept.id : null });
  waStore.recordMessage(thread.id, { direction: 'in', body: msg.body, messageType: msg.type || 'text', waMessageId: msg.wa_message_id });
  if (thread.mode !== 'agent') return;
  if (msg.type !== 'text') return;
  if (inFlightAgentReplies.has(thread.id)) return;
  inFlightAgentReplies.add(thread.id);
  try {
    const replyText = await agentAutoReply(thread, msg.body);
    if (!replyText) return;
    const sent = await wa.sendText(msg.from, replyText);
    waStore.recordMessage(thread.id, {
      direction: 'out', body: replyText, sentBy: 'agent',
      waMessageId: sent ? sent.wa_message_id : null, status: sent ? 'sent' : 'failed'
    });
  } finally {
    inFlightAgentReplies.delete(thread.id);
  }
}

function handleWhatsAppStatus(st) {
  waStore.updateStatus(st.wa_message_id, st.status);
}

// ── Multer upload ───────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 20, fileSize: 50 * 1024 * 1024 }
});

async function savePhotos(files, dept, date) {
  if (!files || files.length === 0) return [];
  const deptSlug = slugify(dept.name);
  const dir = path.join(UPLOADS_DIR, date, deptSlug);
  fs.mkdirSync(dir, { recursive: true });

  const saved = [];
  for (const f of files) {
    try {
      const ts = DateTime.now().setZone(tz()).toFormat('HH-mm-ss');
      const orig = (f.originalname || 'photo').replace(/[^\w.\-]+/g, '_');
      const isHeic = /\.hei[cf]$/i.test(orig) || /image\/heic|image\/heif/i.test(f.mimetype || '');
      const baseName = isHeic ? orig.replace(/\.hei[cf]$/i, '.jpg') : orig;
      const finalName = `${deptSlug}_${date}_${ts}_${baseName}`;
      const outPath = path.join(dir, finalName);

      let buffer = f.buffer;
      // Always re-encode through Sharp (handles HEIC→JPEG + normalises)
      try {
        if (isHeic || /\.(jpg|jpeg)$/i.test(baseName)) {
          buffer = await sharp(f.buffer).rotate().jpeg({ quality: 88 }).toBuffer();
        } else {
          buffer = await sharp(f.buffer).rotate().toBuffer();
        }
      } catch (shErr) {
        console.warn('[sharp] fallback, saving raw:', shErr.message);
        buffer = f.buffer;
      }

      fs.writeFileSync(outPath, buffer);
      saved.push(outPath);
    } catch (err) {
      console.error('photo save failed:', err.message);
    }
  }
  return saved;
}

// ── Express ─────────────────────────────────────────────────
const waWebhook = require('./whatsapp-webhook');
const app = express();
// Behind Railway's proxy req.ip is the proxy socket without this; per-IP
// rate limiting would collapse into one shared bucket.
app.set('trust proxy', 1);
waWebhook.mount(app, { onInbound: handleInboundWhatsApp, onStatus: handleWhatsAppStatus });
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: nowStamp(), event: process.env.EVENT_NAME || '' });
});

// GET /api/status
app.get('/api/status', (req, res) => {
  try {
    res.json({
      date: today(),
      event_name: getEventName(),
      event_edition: getEventEdition(),
      logo_url: getLogoUrl(),
      brand: getPublicBrand(),
      timezone: tz(),
      report_time: (getScheduleConfig().report_time || '23:00'),
      departments: getStatusList(today())
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/submission/:department_id
app.get('/api/submission/:department_id', (req, res) => {
  try {
    const date = today();
    const row = db.prepare(`
      SELECT * FROM daily_submissions
      WHERE department_id = ? AND submission_date = ? AND is_submitted = 1
      ORDER BY version DESC LIMIT 1
    `).get(req.params.department_id, date);
    if (!row) return res.json(null);
    row.schedule_updates = parseSchedule(row.schedule_updates);
    row.photos = row.photos ? JSON.parse(row.photos) : [];
    try { row.photo_captions = JSON.parse(row.photo_captions || '{}'); } catch { row.photo_captions = {}; }
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/submit
app.post('/api/submit', upload.array('photos', 20), async (req, res) => {
  try {
    const {
      department_id,
      overall_progress,
      status_text,
      highlights,
      blockers,
      schedule_updates,
      photo_captions
    } = req.body;

    if (!department_id || overall_progress === undefined || !status_text) {
      return res.status(400).json({ error: 'department_id, overall_progress, status_text are required' });
    }

    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(department_id);
    if (!dept) return res.status(404).json({ error: 'Department not found' });

    const date = today();
    const submitted_at = nowStamp();
    const schedule = parseSchedule(schedule_updates);
    const photoPaths = await savePhotos(req.files, dept, date);

    // Check existing
    const existing = db.prepare(`
      SELECT * FROM daily_submissions
      WHERE department_id = ? AND submission_date = ?
      ORDER BY version DESC LIMIT 1
    `).get(dept.id, date);

    let submission_id, version;
    if (existing) {
      version = (existing.version || 1) + 1;
      // Merge photos from existing if any
      const oldPhotos = existing.photos ? JSON.parse(existing.photos) : [];
      const allPhotos = oldPhotos.concat(photoPaths);
      // Merge captions
      let oldCaptions = {};
      try { oldCaptions = JSON.parse(existing.photo_captions || '{}'); } catch {}
      const newCaptions = photo_captions ? (typeof photo_captions === 'string' ? JSON.parse(photo_captions) : photo_captions) : {};
      const allCaptions = { ...oldCaptions, ...newCaptions };

      db.prepare(`
        UPDATE daily_submissions SET
          submitted_at = ?, overall_progress = ?, status_text = ?,
          highlights = ?, blockers = ?, schedule_updates = ?,
          photos = ?, photo_captions = ?, is_submitted = 1, version = ?
        WHERE id = ?
      `).run(
        submitted_at, parseInt(overall_progress, 10) || 0, status_text,
        highlights || '', blockers || '', JSON.stringify(schedule),
        JSON.stringify(allPhotos), JSON.stringify(allCaptions), version, existing.id
      );
      submission_id = existing.id;
      logAction(dept.id, date, `resubmit v${version}`);
    } else {
      version = 1;
      const captionsObj = photo_captions ? (typeof photo_captions === 'string' ? JSON.parse(photo_captions) : photo_captions) : {};
      const info = db.prepare(`
        INSERT INTO daily_submissions
          (department_id, submission_date, submitted_at, overall_progress,
           status_text, highlights, blockers, schedule_updates, photos,
           photo_captions, is_submitted, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        dept.id, date, submitted_at, parseInt(overall_progress, 10) || 0,
        status_text, highlights || '', blockers || '',
        JSON.stringify(schedule), JSON.stringify(photoPaths),
        JSON.stringify(captionsObj), version
      );
      submission_id = info.lastInsertRowid;
      logAction(dept.id, date, 'submit');
    }

    // Fire notifications, fail-soft
    const stats = { photoCount: photoPaths.length, activityCount: schedule.length };
    const submission = {
      submission_date: date,
      submitted_at,
      overall_progress: parseInt(overall_progress, 10) || 0,
      status_text,
      highlights,
      blockers,
      department_id: dept.id
    };
    const statusList = getStatusList(date);

    notifications.notifyHodSubmissionConfirmation(dept, submission, stats)
      .catch(e => console.error('HOD notify err:', e.message));
    notifications.notifyPmOnSubmission(dept, submission, stats, statusList)
      .catch(e => console.error('PM notify err:', e.message));

    res.json({ success: true, submission_id, version });
  } catch (err) {
    console.error('submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generate-report
function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.REPORT_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/api/generate-report', requireAdminOrApiKey, async (req, res) => {
  const date = (req.body && req.body.date) || today();
  const sendEmail = req.body && req.body.send_email;
  try {
    const result = await runGenerateReport(date);
    if (sendEmail) {
      const depts = db.prepare('SELECT * FROM departments').all();
      const submissions = db.prepare(
        'SELECT * FROM daily_submissions WHERE submission_date = ? AND is_submitted = 1'
      ).all(date);
      notifications.sendReportDelivery({
        date, reportPath: result.report_path, departments: depts, submissions
      }).catch(e => console.error('email delivery err:', e.message));
    }
    res.json({ success: true, ...result, emailed: !!sendEmail });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/report/:date', requireAdminOrApiKey, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT ds.*, d.name AS department_name, d.stream_color, d.head_name
      FROM daily_submissions ds
      JOIN departments d ON d.id = ds.department_id
      WHERE ds.submission_date = ? AND ds.is_submitted = 1
      ORDER BY ds.submitted_at
    `).all(req.params.date);
    rows.forEach(r => {
      r.schedule_updates = parseSchedule(r.schedule_updates);
      r.photos = r.photos ? JSON.parse(r.photos) : [];
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/weekly-summary', requireApiKey, async (req, res) => {
  const end = req.query.end || today();
  try {
    const result = await runGenerateWeeklyReport(end);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin ───────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pass = req.body?.password || req.query?.password || req.header('x-admin-password');
  if (!pass || pass !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Admin password OR report API key. Used on report endpoints so the
// admin console can trigger generation without knowing REPORT_API_KEY,
// while existing automation keyed on x-api-key keeps working.
function requireAdminOrApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (key && key === process.env.REPORT_API_KEY) return next();
  return requireAdmin(req, res, next);
}

app.post('/api/admin/verify', (req, res) => {
  if (req.body?.password === process.env.ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

app.post('/api/admin/send-reminders', requireAdmin, async (req, res) => {
  try {
    const reminded = await sendPendingReminders(req.body?.department_id || null);
    res.json({ success: true, reminded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/logs', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT sl.*, d.name AS department_name
      FROM submission_log sl
      LEFT JOIN departments d ON d.id = sl.department_id
      ORDER BY sl.id DESC LIMIT 100
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/download/:date', requireAdmin, (req, res) => {
  const date = req.params.date;
  const file = path.join(REPORTS_DIR, date, 'daily_report.pptx');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'report not found' });
  res.download(file, `CLIO_${date}.pptx`);
});

// ── Admin: WhatsApp threads ──────────────────────────────────
app.get('/api/admin/whatsapp/threads', requireAdmin, (req, res) => {
  res.json(waStore.listThreads());
});

app.get('/api/admin/whatsapp/threads/:id/messages', requireAdmin, (req, res) => {
  waStore.markRead(req.params.id);
  res.json(waStore.listMessages(req.params.id));
});

app.post('/api/admin/whatsapp/threads/:id/mode', requireAdmin, (req, res) => {
  const threadId = parseInt(req.params.id, 10);
  if (Number.isNaN(threadId)) {
    return res.status(400).json({ error: 'invalid thread id' });
  }
  const mode = req.body.mode;
  if (mode !== 'human' && mode !== 'agent') {
    return res.status(400).json({ error: "mode must be 'human' or 'agent'" });
  }
  const thread = db.prepare('SELECT * FROM whatsapp_threads WHERE id = ?').get(threadId);
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  waStore.setMode(threadId, mode);
  logAction(null, today(), `wa_thread_${threadId}_mode_${mode}`);
  res.json({ success: true, mode });
});

app.post('/api/admin/whatsapp/threads/:id/reply', requireAdmin, async (req, res) => {
  const thread = db.prepare('SELECT * FROM whatsapp_threads WHERE id = ?').get(req.params.id);
  if (!thread) return res.status(404).json({ error: 'thread not found' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const sent = await wa.sendText(thread.wa_number, text);
  const msgId = waStore.recordMessage(thread.id, {
    direction: 'out', body: text, sentBy: 'human',
    waMessageId: sent ? sent.wa_message_id : null, status: sent ? 'sent' : 'failed'
  });
  res.json({ success: !!sent, message_id: msgId });
});

// ── Admin: Project Settings ─────────────────────────────────
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    let brandConfig = {};
    let reportConfig = {};
    try { brandConfig = JSON.parse(getSetting('brand_config') || '{}'); } catch {}
    try { reportConfig = JSON.parse(getSetting('report_config') || '{}'); } catch {}
    let deliveryConfig = {};
    try { deliveryConfig = JSON.parse(getSetting('delivery_config') || '{}'); } catch {}
    res.json({
      event_name: getEventName(),
      event_edition: getEventEdition(),
      brand_config: brandConfig,
      report_config: reportConfig,
      pm_emails: getPmEmails(),
      delivery_config: deliveryConfig,
      whatsapp: {
        enabled: process.env.WHATSAPP_ENABLED === 'true',
        configured: wa.configured()
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    const { event_name, event_edition, brand_config, report_config, pm_emails, delivery_config } = req.body;
    if (event_name !== undefined) setSetting('event_name', event_name);
    if (event_edition !== undefined) setSetting('event_edition', event_edition);
    if (brand_config !== undefined) setSetting('brand_config', JSON.stringify(brand_config));
    if (report_config !== undefined) setSetting('report_config', JSON.stringify(report_config));
    if (pm_emails !== undefined) setSetting('pm_emails', JSON.stringify(pm_emails));
    if (delivery_config !== undefined) setSetting('delivery_config', JSON.stringify(delivery_config));
    logAction(null, today(), 'settings_updated');
    res.json({ success: true, event_name: getEventName(), event_edition: getEventEdition() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: Brand Logo Upload ────────────────────────────────
const BRAND_DIR = path.join(UPLOADS_DIR, 'brand');
fs.mkdirSync(BRAND_DIR, { recursive: true });

app.post('/api/admin/brand-logo', requireAdmin, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
    const outPath = path.join(BRAND_DIR, 'logo.png');
    // Convert to PNG via sharp for consistency
    await sharp(req.file.buffer).png().toFile(outPath);
    // Update brand_config with logo path
    let brandConfig = {};
    try { brandConfig = JSON.parse(getSetting('brand_config') || '{}'); } catch {}
    brandConfig.logo_path = outPath;
    setSetting('brand_config', JSON.stringify(brandConfig));
    logAction(null, today(), 'brand_logo_uploaded');
    res.json({ success: true, logo_path: outPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve brand assets
app.use('/uploads/brand', express.static(BRAND_DIR));

// ── Admin: Report Template & Preview ────────────────────────
const REPORT_TEMPLATE_PATH = path.join(BRAND_DIR, 'report_template.pptx');

app.post('/api/admin/report-template', requireAdmin, upload.single('template'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
    const name = req.file.originalname || '';
    if (!/\.pptx$/i.test(name)) return res.status(400).json({ error: 'file must be a .pptx' });
    const buf = req.file.buffer;
    // PPTX files are ZIP archives: magic bytes PK\x03\x04
    if (!buf || buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B || buf[2] !== 0x03 || buf[3] !== 0x04) {
      return res.status(400).json({ error: 'not a valid PowerPoint file' });
    }
    fs.writeFileSync(REPORT_TEMPLATE_PATH, buf);
    const cfg = getReportConfig();
    cfg.template_path = REPORT_TEMPLATE_PATH;
    cfg.template_filename = name;
    cfg.template_uploaded_at = nowStamp();
    setSetting('report_config', JSON.stringify(cfg));
    logAction(null, today(), 'report_template_uploaded');
    res.json({ success: true, filename: name, size: buf.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/report-template', requireAdmin, (req, res) => {
  try {
    if (fs.existsSync(REPORT_TEMPLATE_PATH)) fs.unlinkSync(REPORT_TEMPLATE_PATH);
    const cfg = getReportConfig();
    delete cfg.template_path;
    delete cfg.template_filename;
    delete cfg.template_uploaded_at;
    cfg.template_mode = 'tokens';
    setSetting('report_config', JSON.stringify(cfg));
    logAction(null, today(), 'report_template_removed');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Everything the live (HTML/CSS) preview needs to draw itself with real data.
app.get('/api/admin/report-preview-data', requireAdmin, (req, res) => {
  try {
    const { logo_path, ...brand } = getBrandConfig();
    brand.logo_url = getLogoUrl();
    const departments = db.prepare(
      'SELECT id, name, stream_color, parent_id FROM departments ORDER BY id'
    ).all();
    const latestRow = db.prepare(
      'SELECT MAX(submission_date) AS d FROM daily_submissions WHERE is_submitted = 1'
    ).get();
    const date = (latestRow && latestRow.d) || today();
    const rows = db.prepare(
      'SELECT * FROM daily_submissions WHERE submission_date = ? AND is_submitted = 1'
    ).all(date);
    const submissions = rows.map(r => {
      let photos = [];
      try { photos = JSON.parse(r.photos || '[]'); } catch {}
      let captions = {};
      try { captions = JSON.parse(r.photo_captions || '{}'); } catch {}
      return {
        department_id: r.department_id,
        overall_progress: r.overall_progress || 0,
        status_text: r.polished_status_text || r.status_text || '',
        highlights: r.polished_highlights || r.highlights || '',
        blockers: r.polished_blockers || r.blockers || '',
        photo_count: photos.length,
        captions: Object.values(captions).filter(Boolean).slice(0, 4)
      };
    });
    res.json({
      brand,
      event_name: getEventName(),
      event_edition: getEventEdition(),
      report_config: getReportConfig(),
      departments,
      latest: { date, submissions }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// True preview: generate the deck for a date and rasterize it to PNGs.
// Results cached per date + config hash; concurrent renders serialized.
const inFlightRenders = new Map();

app.post('/api/admin/report-preview-render', requireAdmin, async (req, res) => {
  const date = req.body && req.body.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  try {
    const reportConfig = getReportConfig();
    let templateStamp = '0';
    if (reportConfig.template_path) {
      try { templateStamp = String(fs.statSync(reportConfig.template_path).mtimeMs); } catch {}
    }
    const confighash = crypto.createHash('sha1')
      .update(JSON.stringify(reportConfig) + templateStamp)
      .digest('hex');
    const dir = path.join(REPORTS_DIR, date, 'preview', confighash);
    const listPngs = () => (
      fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort()
        : []
    );

    let pngs = listPngs();
    if (!pngs.length) {
      const key = `${date}:${confighash}`;
      let job = inFlightRenders.get(key);
      if (!job) {
        job = (async () => {
          const { report_path } = await runGenerateReport(date);
          await renderPreview.renderDeckToImages(report_path, dir);
        })().finally(() => inFlightRenders.delete(key));
        inFlightRenders.set(key, job);
      }
      await job;
      pngs = listPngs();
    }

    const images = pngs.map(f => {
      const rel = path.relative(REPORTS_DIR, path.join(dir, f));
      return `/api/admin/report-preview-image?f=${encodeURIComponent(rel)}`;
    });
    res.json({ available: true, date, images });
  } catch (err) {
    if (err.code === 'SOFFICE_UNAVAILABLE') {
      return res.json({ available: false, reason: 'renderer not installed' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Preview slide image. <img> tags cannot send headers, so this endpoint also
// accepts ?password= (requireAdmin already reads the query), like the archive
// photo exception.
app.get('/api/admin/report-preview-image', requireAdmin, (req, res) => {
  try {
    const f = String(req.query.f || '');
    const p = path.normalize(path.join(REPORTS_DIR, f));
    if (!p.startsWith(REPORTS_DIR + path.sep) || !p.endsWith('.png')) {
      return res.status(400).json({ error: 'bad path' });
    }
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
    res.sendFile(p);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: Department CRUD ──────────────────────────────────
app.get('/api/admin/departments', requireAdmin, (req, res) => {
  try {
    const depts = db.prepare('SELECT * FROM departments ORDER BY id').all();
    res.json(depts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validate a parent_id for one-level-deep hierarchy. Returns an error string
// on violation, or null when the value is acceptable. `deptId` is the id of
// the department being written (null for a new department) so a self-parent
// or a parent-with-children check can exclude the row being edited.
function validateParentId(parent_id, deptId) {
  if (parent_id === undefined || parent_id === null || parent_id === '') return null;
  const pid = Number(parent_id);
  if (!Number.isInteger(pid)) return 'parent_id must be an integer';
  if (deptId != null && pid === Number(deptId)) return 'a department cannot be its own parent';
  const parent = db.prepare('SELECT * FROM departments WHERE id = ?').get(pid);
  if (!parent) return 'parent_id does not reference an existing department';
  if (parent.parent_id != null) return 'parent_id must reference a top-level department (one level of nesting only)';
  return null;
}

// A department that already has children cannot itself be given a parent.
function hasChildren(deptId) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM departments WHERE parent_id = ?').get(deptId);
  return row.c > 0;
}

app.post('/api/admin/departments', requireAdmin, (req, res) => {
  try {
    const { name, head_name, head_email, head_whatsapp, stream_color, parent_id } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const parentErr = validateParentId(parent_id, null);
    if (parentErr) return res.status(400).json({ error: parentErr });
    const info = db.prepare(`
      INSERT INTO departments (name, head_name, head_email, head_whatsapp, stream_color, parent_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      name.trim().toUpperCase(),
      head_name || `${name.trim()} HOD`,
      head_email || '',
      head_whatsapp || '',
      stream_color || '#3B82F6',
      parent_id ? Number(parent_id) : null
    );
    logAction(info.lastInsertRowid, today(), 'department_created');
    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(info.lastInsertRowid);
    res.json(dept);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/departments/:id', requireAdmin, (req, res) => {
  try {
    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
    if (!dept) return res.status(404).json({ error: 'department not found' });
    const { name, head_name, head_email, head_whatsapp, stream_color, parent_id } = req.body;

    if (parent_id !== undefined) {
      const parentErr = validateParentId(parent_id, dept.id);
      if (parentErr) return res.status(400).json({ error: parentErr });
      if (parent_id && hasChildren(dept.id)) {
        return res.status(400).json({ error: 'a department with children cannot be given a parent' });
      }
    }

    db.prepare(`
      UPDATE departments SET name = ?, head_name = ?, head_email = ?, head_whatsapp = ?, stream_color = ?, parent_id = ?
      WHERE id = ?
    `).run(
      name !== undefined ? name.trim().toUpperCase() : dept.name,
      head_name !== undefined ? head_name : dept.head_name,
      head_email !== undefined ? head_email : dept.head_email,
      head_whatsapp !== undefined ? head_whatsapp : dept.head_whatsapp,
      stream_color !== undefined ? stream_color : dept.stream_color,
      parent_id !== undefined ? (parent_id ? Number(parent_id) : null) : dept.parent_id,
      dept.id
    );
    logAction(dept.id, today(), 'department_updated');
    const updated = db.prepare('SELECT * FROM departments WHERE id = ?').get(dept.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/departments/:id', requireAdmin, (req, res) => {
  try {
    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
    if (!dept) return res.status(404).json({ error: 'department not found' });
    // Deleting a parent orphans its children rather than cascading the delete.
    db.transaction(() => {
      db.prepare('UPDATE departments SET parent_id = NULL WHERE parent_id = ?').run(dept.id);
      db.prepare('DELETE FROM departments WHERE id = ?').run(dept.id);
    })();
    logAction(dept.id, today(), `department_deleted: ${dept.name}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Uploaded photos served for admin/debug (password-protected via query)
app.get('/api/admin/photo', requireAdmin, (req, res) => {
  try {
    const p = path.normalize(req.query.path || '');
    if (!p.startsWith(UPLOADS_DIR + path.sep)) return res.status(400).json({ error: 'bad path' });
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
    res.sendFile(p);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Archive: browsable data directory ───────────────────────
app.get('/api/archive', requireAdmin, (req, res) => {
  try {
    const dates = [];
    if (fs.existsSync(UPLOADS_DIR)) {
      for (const d of fs.readdirSync(UPLOADS_DIR).sort().reverse()) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          const deptDirs = fs.readdirSync(path.join(UPLOADS_DIR, d))
            .filter(f => fs.statSync(path.join(UPLOADS_DIR, d, f)).isDirectory());
          dates.push({ date: d, departments: deptDirs });
        }
      }
    }
    res.json(dates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/archive/:date', requireAdmin, (req, res) => {
  try {
    const date = req.params.date;
    const depts = db.prepare('SELECT * FROM departments ORDER BY id').all();
    const subs = db.prepare(`
      SELECT ds.*, d.name AS department_name, d.stream_color
      FROM daily_submissions ds
      JOIN departments d ON d.id = ds.department_id
      WHERE ds.submission_date = ? AND ds.is_submitted = 1
      ORDER BY d.name
    `).all(date);

    const result = depts.map(dept => {
      const sub = subs.find(s => s.department_id === dept.id);
      const slug = slugify(dept.name);
      const photoDir = path.join(UPLOADS_DIR, date, slug);
      let photos = [];
      if (fs.existsSync(photoDir)) {
        photos = fs.readdirSync(photoDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
      }
      return {
        department: dept.name,
        stream_color: dept.stream_color,
        submitted: !!sub,
        submission: sub ? {
          submitted_at: sub.submitted_at,
          overall_progress: sub.overall_progress,
          status_text: sub.status_text,
          highlights: sub.highlights,
          blockers: sub.blockers,
          schedule_updates: parseSchedule(sub.schedule_updates),
          photo_count: photos.length
        } : null,
        photos: photos.map(f => ({
          filename: f,
          url: `/api/archive/${date}/${slug}/${f}?password=${req.query.password || ''}`
        }))
      };
    });
    res.json({ date, departments: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/archive/:date/:dept/:file', requireAdmin, (req, res) => {
  const filePath = path.normalize(path.join(UPLOADS_DIR, req.params.date, req.params.dept, req.params.file));
  if (!filePath.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'not found' });
  }
  res.sendFile(filePath);
});

// ── LLM Content Review ─────────────────────────────────────
// Light in-memory rate limit for the public review endpoint
const reviewHits = new Map();
// Sweep stale IPs so the map cannot grow without bound on a public endpoint.
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, hits] of reviewHits) {
    const live = hits.filter(t => t > cutoff);
    if (live.length === 0) reviewHits.delete(ip);
    else reviewHits.set(ip, live);
  }
}, 10 * 60_000).unref();
function reviewRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;
  const hits = (reviewHits.get(ip) || []).filter(t => now - t < windowMs);
  if (hits.length >= 20) return res.status(429).json({ polished: req.body?.text || '', error: 'rate limited' });
  hits.push(now);
  reviewHits.set(ip, hits);
  next();
}

app.post('/api/review-text', reviewRateLimit, async (req, res) => {
  try {
    const { text, field_type } = req.body;
    if (!text || !text.trim()) return res.json({ polished: text || '' });
    if (text.length > 4000) return res.json({ polished: text, skipped: true });

    let apiKey = '';
    try { apiKey = JSON.parse(getSetting('delivery_config') || '{}').anthropic_api_key || ''; } catch {}
    if (!apiKey) return res.json({ polished: text, skipped: true });

    const systemPrompt = `You are a professional editor for event production reports.
Rewrite the following ${field_type || 'text'} to be:
- Technically accurate and professional
- Concise and straight to the point
- Free of spelling and grammar errors
- Written in third person, present tense where appropriate
- Consistent in tone: factual, confident, no filler words

Return ONLY the polished text. Do not add quotes, explanations, or commentary.
If the text is already well-written, return it as-is with only minor corrections.
Keep all technical terms, department names, and numbers unchanged.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: text.trim() }]
      })
    });

    if (!response.ok) {
      console.error('[llm] API error:', response.status);
      return res.json({ polished: text, error: 'API error' });
    }

    const data = await response.json();
    const polished = data.content?.[0]?.text || text;
    res.json({ polished });
  } catch (err) {
    console.error('[llm] review failed:', err.message);
    res.json({ polished: req.body?.text || '', error: err.message });
  }
});

// ── Python runners ──────────────────────────────────────────
function runPython(script, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [script, ...args], { cwd: ROOT });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`python exited ${code}: ${stderr || stdout}`));
    });
  });
}

// The generator writes to a fixed per-date path, so concurrent runs for the
// same date (preview render, test deck, nightly cron) would tear the file.
// Serialize per date; different dates still run in parallel.
const reportLocks = new Map();
function runGenerateReport(date) {
  const prev = reportLocks.get(date) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => runGenerateReportUnlocked(date));
  const tail = run.catch(() => {});
  reportLocks.set(date, tail);
  tail.then(() => { if (reportLocks.get(date) === tail) reportLocks.delete(date); });
  return run;
}

async function runGenerateReportUnlocked(date) {
  const script = path.join(ROOT, 'scripts', 'generate_report.py');
  const { stdout } = await runPython(script, [date]);
  const report_path = stdout.split('\n').pop().trim();
  return { report_path, date };
}

async function runGenerateWeeklyReport(endDate) {
  const script = path.join(ROOT, 'scripts', 'generate_weekly_report.py');
  const { stdout } = await runPython(script, [endDate]);
  const report_path = stdout.split('\n').pop().trim();
  return { report_path, endDate };
}

// ── Cron: reminders + report ───────────────────────────────
async function sendPendingReminders(onlyDeptId = null) {
  if (onlyDeptId != null) {
    onlyDeptId = Number(onlyDeptId);
    if (Number.isNaN(onlyDeptId)) throw new Error('invalid department_id');
  }
  const date = today();
  const status = getStatusList(date);
  const submitted = status.filter(s => s.submitted);
  const pending = status.filter(s => !s.submitted);
  const depts = db.prepare('SELECT * FROM departments').all();
  const cfg = getScheduleConfig();
  const ctx = {
    deadlineText: cfg.deadline_text || `by ${cfg.report_time || '23:00'}`,
    reportTime: cfg.report_time || '23:00',
    totalDepartments: depts.length
  };

  const remindedNames = [];
  for (const p of pending) {
    if (onlyDeptId != null && p.id !== onlyDeptId) continue;
    const dept = depts.find(d => d.id === p.id);
    if (!dept) continue;
    try {
      await notifications.sendReminderToHod(dept, submitted, ctx);
      logAction(dept.id, date, 'reminder_sent');
      remindedNames.push(dept.name);
    } catch (err) {
      console.error('reminder failed:', err.message);
    }
  }
  return remindedNames;
}

async function runNightlyReport() {
  const date = today();
  const depts = db.prepare('SELECT * FROM departments').all();
  const submissions = db.prepare(`
    SELECT * FROM daily_submissions WHERE submission_date = ? AND is_submitted = 1
  `).all(date);

  try {
    const { report_path } = await runGenerateReport(date);
    logAction(null, date, 'report_generated');
    // auto_email defaults on; the admin Delivery toggle can switch it off.
    if (getDeliveryConfig().auto_email === false) {
      console.log('[cron] auto email disabled, report generated only');
      return;
    }
    await notifications.sendReportDelivery({
      date, reportPath: report_path, departments: depts, submissions
    });
  } catch (err) {
    console.error('[cron] report generation failed:', err.message);
    logAction(null, date, `report_failed: ${err.message}`);
    await notifications.sendGenerationFailure({
      date, error: err.message, submissions, departments: depts
    });
  }
}

// ── Configurable cron scheduling ────────────────────────────
function getScheduleConfig() {
  try {
    const raw = getSetting('schedule_config');
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

let cronJobs = [];
function setupCronJobs() {
  // Clear existing
  cronJobs.forEach(j => j.stop());
  cronJobs = [];

  const cfg = getScheduleConfig();
  const reminderTime = cfg.reminder_time || '21:00';
  const reportTime = cfg.report_time || '23:00';

  const [rH, rM] = reminderTime.split(':').map(Number);
  const [gH, gM] = reportTime.split(':').map(Number);

  const reminderJob = cron.schedule(`${rM} ${rH} * * *`, () => {
    console.log(`[cron] ${reminderTime} reminders`);
    sendPendingReminders().catch(e => console.error(e));
  }, { timezone: tz() });

  const reportJob = cron.schedule(`${gM} ${gH} * * *`, () => {
    console.log(`[cron] ${reportTime} report generation`);
    runNightlyReport().catch(e => console.error(e));
  }, { timezone: tz() });

  cronJobs.push(reminderJob, reportJob);
  console.log(`[cron] Reminder: ${reminderTime}, Report: ${reportTime} (${tz()})`);
}

// API to update schedule and restart cron
app.get('/api/admin/schedule', requireAdmin, (req, res) => {
  res.json(getScheduleConfig());
});

app.put('/api/admin/schedule', requireAdmin, (req, res) => {
  try {
    setSetting('schedule_config', JSON.stringify(req.body));
    setupCronJobs();
    logAction(null, today(), 'schedule_updated');
    res.json({ success: true, ...getScheduleConfig() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

setupCronJobs();

// ── Start ───────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`CLIO running at ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`Event: ${getEventName()} | TZ: ${tz()} | Today: ${today()}`);
});
