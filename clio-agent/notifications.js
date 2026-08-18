// notifications.js: Email (Nodemailer) + WhatsApp (Twilio) helpers
// All functions fail-soft: a notification failure must never crash
// the server or block report generation.

const nodemailer = require('nodemailer');

let twilioClient = null;
try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
} catch (err) {
  console.error('Twilio init failed:', err.message);
}

// DB accessors, injected by server.js via init()
let _dbAccessors = {};
function init(accessors) { _dbAccessors = accessors; }

// ── SMTP transporter (lazy) ────────────────────────────────
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  return transporter;
}

function fromAddress() {
  const name = process.env.SENDER_NAME || 'CLIO Report Agent';
  return `"${name}" <${process.env.SMTP_USER}>`;
}

function pmEmails() {
  if (_dbAccessors.getPmEmails) {
    const dbEmails = _dbAccessors.getPmEmails();
    if (dbEmails && dbEmails.length) return dbEmails;
  }
  return (process.env.PM_EMAILS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function pmWhatsapps() {
  return (process.env.PM_WHATSAPP || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

// ── Core senders ────────────────────────────────────────────
async function sendEmail({ to, subject, html, attachments }) {
  if (!to || (Array.isArray(to) && to.length === 0)) {
    console.warn('sendEmail skipped: no recipient');
    return;
  }
  try {
    const info = await getTransporter().sendMail({
      from: fromAddress(),
      to: Array.isArray(to) ? to.join(',') : to,
      subject,
      html,
      attachments: attachments || []
    });
    console.log(`[email] ${subject} -> ${to} (${info.messageId})`);
  } catch (err) {
    console.error(`[email] failed "${subject}" -> ${to}:`, err.message);
  }
}

async function sendWhatsApp(to, message) {
  if (process.env.WHATSAPP_ENABLED !== 'true') return;
  if (!twilioClient) {
    console.warn('[wa] skipped, twilio not configured');
    return;
  }
  if (!to) {
    console.warn('[wa] skipped, no recipient');
    return;
  }
  try {
    const res = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${to}`,
      body: message
    });
    console.log(`[wa] -> ${to} (${res.sid})`);
  } catch (err) {
    console.error(`[wa] failed -> ${to}:`, err.message);
  }
}

// ── Template helpers ────────────────────────────────────────
function brandPalette() {
  const fallback = {
    background_color: '#0F172A',
    primary_color: '#3B82F6',
    text_color: '#F1F5F9'
  };
  if (_dbAccessors.getBrandConfig) {
    const b = _dbAccessors.getBrandConfig() || {};
    return {
      bg: b.background_color || fallback.background_color,
      accent: b.primary_color || fallback.primary_color,
      text: b.text_color || fallback.text_color
    };
  }
  return { bg: fallback.background_color, accent: fallback.primary_color, text: fallback.text_color };
}

function htmlShell({ title, color, body }) {
  const p = brandPalette();
  const accent = color || p.accent;
  return `<!doctype html><html><body style="margin:0;padding:0;background:${p.bg};font-family:Arial,Helvetica,sans-serif;color:${p.text}">
<div style="max-width:640px;margin:0 auto;padding:32px 24px;">
  <div style="border-left:6px solid ${accent};padding-left:16px;margin-bottom:24px;">
    <h1 style="margin:0;font-size:22px;color:${accent};">${title}</h1>
  </div>
  ${body}
  <hr style="border:none;border-top:1px solid #1f2937;margin:32px 0;" />
  <p style="font-size:12px;color:#6B7280;margin:0;">This is an automated message from CLIO.</p>
</div>
</body></html>`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Specific notifications ──────────────────────────────────

// Email 1: HOD submission confirmation
async function notifyHodSubmissionConfirmation(dept, submission, stats) {
  const subject = `✓ CLIO received your update: ${dept.name} | ${submission.submission_date}`;
  const html = htmlShell({
    title: `${dept.name}: Update Received`,
    color: dept.stream_color,
    body: `
      <p>Submitted at: <b>${escapeHtml(submission.submitted_at)}</b></p>
      <p>Completion: <b style="color:${dept.stream_color};font-size:20px">${submission.overall_progress}%</b></p>
      <p>Photos uploaded: <b>${stats.photoCount}</b></p>
      <p>Activities logged: <b>${stats.activityCount}</b></p>
      <p style="margin-top:24px;">You're all set for today. Thank you.</p>
    `
  });
  await sendEmail({ to: dept.head_email, subject, html });

  const wa = `✅ CLIO: Update Received
Department: ${dept.name}
Date: ${submission.submission_date}
Progress: ${submission.overall_progress}%
Photos uploaded: ${stats.photoCount}
Activities logged: ${stats.activityCount}
You're all set for today.`;
  await sendWhatsApp(dept.head_whatsapp, wa);
}

// Email 2: PM notification on each submission
async function notifyPmOnSubmission(dept, submission, stats, statusList) {
  const subject = `${dept.name} submitted their daily update (${submission.overall_progress}% complete)`;
  const submitted = statusList.filter(s => s.submitted).map(s => s.name).join(', ') || 'None';
  const pending = statusList.filter(s => !s.submitted).map(s => s.name).join(', ') || 'None';
  const blockersBlock = submission.blockers
    ? `<div style="border-left:4px solid #F87171;padding:8px 12px;margin:12px 0;background:#1a0a0a;">
         <b style="color:#F87171;">Blockers</b><br/>${escapeHtml(submission.blockers)}
       </div>` : '';
  const html = htmlShell({
    title: `${dept.name}: ${submission.overall_progress}% complete`,
    color: dept.stream_color,
    body: `
      <p>HOD: <b>${escapeHtml(dept.head_name || 'n/a')}</b></p>
      <p>Status:</p>
      <p style="padding:8px 12px;background:#0d1117;border-radius:6px;">${escapeHtml(submission.status_text || '')}</p>
      ${submission.highlights ? `<div style="border-left:4px solid #4ADE80;padding:8px 12px;margin:12px 0;background:#071a0d;"><b style="color:#4ADE80;">Highlights</b><br/>${escapeHtml(submission.highlights)}</div>` : ''}
      ${blockersBlock}
      <p><a href="${process.env.BASE_URL}" style="color:${dept.stream_color};">View Portal Status →</a></p>
      <p style="font-size:12px;color:#6B7280;">Submitted: ${escapeHtml(submitted)}<br/>Pending: ${escapeHtml(pending)}</p>
    `
  });
  await sendEmail({ to: pmEmails(), subject, html });
}

// Email 3: reminder (deadline pulled from schedule config)
async function sendReminderToHod(dept, submittedList, ctx = {}) {
  const deadline = ctx.deadlineText || 'tonight';
  const total = ctx.totalDepartments || submittedList.length;
  const subject = `⏰ CLIO Reminder: Daily report due ${deadline}`;
  const submittedNames = submittedList.map(s => s.name).join(', ') || 'None yet';
  const html = htmlShell({
    title: `${dept.name}: Report Due`,
    color: dept.stream_color,
    body: `
      <p>Your department update is due by <b>${escapeHtml(deadline)}</b>.</p>
      <p style="font-size:13px;color:#6B7280;">Departments submitted so far: ${escapeHtml(submittedNames)}</p>
      <p style="margin:24px 0;">
        <a href="${process.env.BASE_URL}" style="background:${dept.stream_color};color:#06080D;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Open Portal →</a>
      </p>
      <p style="font-size:12px;color:#6B7280;">The report generates automatically at ${escapeHtml(ctx.reportTime || 'the scheduled time')}.</p>
    `
  });
  await sendEmail({ to: dept.head_email, subject, html });

  const wa = `⏰ CLIO Reminder
${dept.name}, your daily report is due ${deadline}.
Submitted so far: ${submittedList.length}/${total} departments
Open the portal:
${process.env.BASE_URL}`;
  await sendWhatsApp(dept.head_whatsapp, wa);
}

// Email 4: 11PM report delivery
async function sendReportDelivery({ date, reportPath, departments, submissions }) {
  const eventName = (_dbAccessors.getEventName && _dbAccessors.getEventName()) || process.env.EVENT_NAME || 'Event';
  const submittedSubs = submissions.filter(s => s);
  const avg = submittedSubs.length
    ? Math.round(submittedSubs.reduce((a, s) => a + (s.overall_progress || 0), 0) / submittedSubs.length)
    : 0;

  const rows = departments.map(dept => {
    const sub = submissions.find(s => s && s.department_id === dept.id);
    if (!sub) {
      return `<tr><td style="padding:8px;border-bottom:1px solid #1f2937;">${escapeHtml(dept.name)}</td>
        <td style="padding:8px;border-bottom:1px solid #1f2937;">${escapeHtml(dept.head_name || 'n/a')}</td>
        <td style="padding:8px;border-bottom:1px solid #1f2937;color:#F87171;">No Data</td>
        <td style="padding:8px;border-bottom:1px solid #1f2937;color:#F87171;">n/a</td></tr>`;
    }
    return `<tr><td style="padding:8px;border-bottom:1px solid #1f2937;">${escapeHtml(dept.name)}</td>
      <td style="padding:8px;border-bottom:1px solid #1f2937;">${escapeHtml(dept.head_name || 'n/a')}</td>
      <td style="padding:8px;border-bottom:1px solid #1f2937;color:#4ADE80;">✓ ${escapeHtml(sub.submitted_at)}</td>
      <td style="padding:8px;border-bottom:1px solid #1f2937;">${sub.overall_progress}%</td></tr>`;
  }).join('');

  const html = htmlShell({
    title: `📊 CLIO Daily Report: ${eventName}`,
    color: brandPalette().accent,
    body: `
      <p><b>Date:</b> ${escapeHtml(date)}</p>
      <p><b>Overall average completion:</b> ${avg}%</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px;">
        <thead><tr style="color:#6B7280;text-align:left;">
          <th style="padding:8px;">Department</th><th style="padding:8px;">HOD</th>
          <th style="padding:8px;">Submitted</th><th style="padding:8px;">Progress</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:24px;font-size:12px;color:#6B7280;">This report was generated automatically by CLIO at 11:00 PM.</p>
    `
  });

  const attachments = reportPath ? [{ filename: `CLIO_${date}.pptx`, path: reportPath }] : [];
  await sendEmail({
    to: pmEmails(),
    subject: `📊 CLIO Daily Report: ${eventName} | ${date}`,
    html,
    attachments
  });

  const wa = `📊 CLIO Daily Report Ready
Event: ${eventName}
Date: ${date}
Submitted: ${submittedSubs.length}/${departments.length} departments
Overall progress: ${avg}%
The report has been sent to your email.
Check your inbox for the full PPTX.`;
  for (const num of pmWhatsapps()) {
    await sendWhatsApp(num, wa);
  }
}

// Email 5: generation failure
async function sendGenerationFailure({ date, error, submissions, departments }) {
  const rawJson = JSON.stringify(submissions, null, 2);
  const submittedNames = submissions.map(s => {
    const d = departments.find(x => x.id === s.department_id);
    return d ? d.name : `#${s.department_id}`;
  }).join(', ') || 'None';
  const notSubmitted = departments
    .filter(d => !submissions.find(s => s.department_id === d.id))
    .map(d => d.name).join(', ') || 'None';

  const html = htmlShell({
    title: '⚠️ CLIO Report Error: Manual Review Required',
    color: '#F87171',
    body: `
      <p><b>Date:</b> ${escapeHtml(date)}</p>
      <p><b>Error:</b></p>
      <pre style="background:#1a0a0a;padding:12px;border-radius:6px;color:#F87171;white-space:pre-wrap;word-break:break-word;">${escapeHtml(error)}</pre>
      <p><b>Submitted:</b> ${escapeHtml(submittedNames)}</p>
      <p><b>Not submitted:</b> ${escapeHtml(notSubmitted)}</p>
      <p>Raw data:</p>
      <pre style="background:#0d1117;padding:12px;border-radius:6px;font-size:11px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(rawJson)}</pre>
      <p>Manually trigger regeneration from the admin panel: <a href="${process.env.BASE_URL}/admin.html" style="color:${brandPalette().accent};">${process.env.BASE_URL}/admin.html</a></p>
    `
  });
  await sendEmail({
    to: pmEmails(),
    subject: `⚠️ CLIO Report Error: ${date} | Manual Review Required`,
    html
  });

  const wa = `⚠️ CLIO Report Error
The daily report could not be generated for ${date}.
An error email with full data has been sent.
Check the admin panel or contact your system admin.
${process.env.BASE_URL}/admin.html`;
  for (const num of pmWhatsapps()) {
    await sendWhatsApp(num, wa);
  }
}

module.exports = {
  init,
  sendEmail,
  sendWhatsApp,
  notifyHodSubmissionConfirmation,
  notifyPmOnSubmission,
  sendReminderToHod,
  sendReportDelivery,
  sendGenerationFailure,
  pmEmails,
  pmWhatsapps
};
