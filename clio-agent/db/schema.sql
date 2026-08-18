CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  head_name TEXT,
  head_email TEXT,
  head_whatsapp TEXT,
  stream_color TEXT DEFAULT '#3B82F6',
  parent_id INTEGER REFERENCES departments(id),
  username TEXT UNIQUE,
  password_hash TEXT,
  credentials_updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dept_username
  ON departments(username) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS daily_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER NOT NULL,
  submission_date TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  overall_progress INTEGER DEFAULT 0,
  status_text TEXT,
  highlights TEXT,
  blockers TEXT,
  schedule_updates TEXT,
  photos TEXT,
  is_submitted INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE INDEX IF NOT EXISTS idx_subs_dept_date
  ON daily_submissions(department_id, submission_date);

CREATE TABLE IF NOT EXISTS submission_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER,
  submission_date TEXT,
  action TEXT,
  timestamp TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Photo captions: JSON map of filename -> caption
-- Added via ALTER TABLE if column doesn't exist (handled in server.js migration)

CREATE TABLE IF NOT EXISTS whatsapp_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_number TEXT NOT NULL UNIQUE,
  department_id INTEGER,
  display_name TEXT,
  mode TEXT NOT NULL DEFAULT 'agent',
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  body TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  template_name TEXT,
  wa_message_id TEXT,
  status TEXT,
  sent_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES whatsapp_threads(id)
);

CREATE INDEX IF NOT EXISTS idx_wa_msgs_thread ON whatsapp_messages(thread_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_msgs_waid
  ON whatsapp_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
