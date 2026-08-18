// server.js: CLIO main application
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const multer = require('multer');
const sharp = require('sharp');
const cron = require('node-cron');
const { DateTime } = require('luxon');

const notifications = require('./notifications');

// ── Paths ───────────────────────────────────────────────────
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'db', 'clio.db');
const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const REPORTS_DIR = path.join(ROOT, 'reports');

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

// Seed departments on first run
const DEFAULT_DEPARTMENTS = [
  { name: 'STAGE',          slug: 'STAGE',          color: '#F87171' },
  { name: 'LIGHTING',       slug: 'LIGHTING',       color: '#FBBF24' },
  { name: 'AV',             slug: 'AV',             color: '#60A5FA' },
  { name: 'SCENIC',         slug: 'SCENIC',         color: '#34D399' },
  { name: 'RIGGING',        slug: 'RIGGING',        color: '#A78BFA' },
  { name: 'SHOW DIRECTION', slug: 'SHOW_DIRECTION', color: '#F472B6' },
  { name: 'LOGISTICS',      slug: 'LOGISTICS',      color: '#FB923C' }
];

const deptCount = db.prepare('SELECT COUNT(*) AS c FROM departments').get().c;
if (deptCount === 0) {
  const insert = db.prepare(`
    INSERT INTO departments (name, head_name, head_email, head_whatsapp, stream_color)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const d of DEFAULT_DEPARTMENTS) {
    insert.run(
      d.name,
      `${d.name} HOD`,
      process.env[`DEPT_EMAIL_${d.slug}`] || '',
      process.env[`DEPT_WHATSAPP_${d.slug}`] || '',
      d.color
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
function getLogoUrl() {
  const brand = getBrandConfig();
  if (!brand.logo_path) return null;
  try {
    const stat = fs.statSync(brand.logo_path);
    return `/uploads/brand/logo.png?v=${stat.mtimeMs}`;
  } catch { return null; }
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
const app = express();
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

app.post('/api/generate-report', requireApiKey, async (req, res) => {
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

app.get('/api/report/:date', requireApiKey, (req, res) => {
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

app.post('/api/admin/verify', (req, res) => {
  if (req.body?.password === process.env.ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

app.post('/api/admin/send-reminders', requireAdmin, async (req, res) => {
  try {
    const reminded = await sendPendingReminders();
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
      delivery_config: deliveryConfig
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

// ── Admin: Department CRUD ──────────────────────────────────
app.get('/api/admin/departments', requireAdmin, (req, res) => {
  try {
    const depts = db.prepare('SELECT * FROM departments ORDER BY id').all();
    res.json(depts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/departments', requireAdmin, (req, res) => {
  try {
    const { name, head_name, head_email, head_whatsapp, stream_color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const info = db.prepare(`
      INSERT INTO departments (name, head_name, head_email, head_whatsapp, stream_color)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      name.trim().toUpperCase(),
      head_name || `${name.trim()} HOD`,
      head_email || '',
      head_whatsapp || '',
      stream_color || '#3B82F6'
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
    const { name, head_name, head_email, head_whatsapp, stream_color } = req.body;
    db.prepare(`
      UPDATE departments SET name = ?, head_name = ?, head_email = ?, head_whatsapp = ?, stream_color = ?
      WHERE id = ?
    `).run(
      name !== undefined ? name.trim().toUpperCase() : dept.name,
      head_name !== undefined ? head_name : dept.head_name,
      head_email !== undefined ? head_email : dept.head_email,
      head_whatsapp !== undefined ? head_whatsapp : dept.head_whatsapp,
      stream_color !== undefined ? stream_color : dept.stream_color,
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
    db.prepare('DELETE FROM departments WHERE id = ?').run(dept.id);
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

async function runGenerateReport(date) {
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
async function sendPendingReminders() {
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
