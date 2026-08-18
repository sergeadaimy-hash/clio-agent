// whatsapp-store.js: DB helpers for threads and messages. Injected db.
let db;
function init(database) { db = database; }

function nowIso() { return new Date().toISOString(); }

function upsertThread(waNumber, { name = '', departmentId = null } = {}) {
  const existing = db.prepare('SELECT * FROM whatsapp_threads WHERE wa_number = ?').get(waNumber);
  if (existing) {
    if (name && !existing.display_name) {
      db.prepare('UPDATE whatsapp_threads SET display_name = ? WHERE id = ?').run(name, existing.id);
    }
    if (departmentId != null && existing.department_id == null) {
      db.prepare('UPDATE whatsapp_threads SET department_id = ? WHERE id = ?').run(departmentId, existing.id);
    }
    return db.prepare('SELECT * FROM whatsapp_threads WHERE id = ?').get(existing.id);
  }
  const info = db.prepare(`
    INSERT INTO whatsapp_threads (wa_number, department_id, display_name, mode, last_message_at)
    VALUES (?, ?, ?, 'agent', ?)
  `).run(waNumber, departmentId, name, nowIso());
  return db.prepare('SELECT * FROM whatsapp_threads WHERE id = ?').get(info.lastInsertRowid);
}

function recordMessage(threadId, { direction, body, messageType = 'text', templateName = null, waMessageId = null, status = null, sentBy = null }) {
  const info = db.prepare(`
    INSERT INTO whatsapp_messages (thread_id, direction, body, message_type, template_name, wa_message_id, status, sent_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(threadId, direction, body, messageType, templateName, waMessageId, status, sentBy, nowIso());
  db.prepare(`
    UPDATE whatsapp_threads SET last_message_at = ?, unread_count = unread_count + ?
    WHERE id = ?
  `).run(nowIso(), direction === 'in' ? 1 : 0, threadId);
  return info.lastInsertRowid;
}

function updateStatus(waMessageId, status) {
  db.prepare('UPDATE whatsapp_messages SET status = ? WHERE wa_message_id = ?').run(status, waMessageId);
}

function setMode(threadId, mode) {
  db.prepare('UPDATE whatsapp_threads SET mode = ? WHERE id = ?').run(mode, threadId);
}

function markRead(threadId) {
  db.prepare('UPDATE whatsapp_threads SET unread_count = 0 WHERE id = ?').run(threadId);
}

function listThreads() {
  return db.prepare(`
    SELECT t.*, d.name AS department_name, d.stream_color,
      (SELECT body FROM whatsapp_messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_body
    FROM whatsapp_threads t LEFT JOIN departments d ON d.id = t.department_id
    ORDER BY t.last_message_at DESC
  `).all();
}

function listMessages(threadId, limit = 200) {
  return db.prepare('SELECT * FROM whatsapp_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?')
    .all(threadId, limit).reverse();
}

function countAgentRepliesToday(threadId, isoDatePrefix) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM whatsapp_messages
    WHERE thread_id = ? AND sent_by = 'agent' AND created_at LIKE ?
  `).get(threadId, isoDatePrefix + '%').c;
}

module.exports = { init, upsertThread, recordMessage, updateStatus, setMode, markRead, listThreads, listMessages, countAgentRepliesToday };
