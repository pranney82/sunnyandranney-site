-- Staff time clock. Hours are recorded and approved here, then pushed to Gusto
-- as approved time sheets once per pay period (scripts/gusto-hours.mjs).
-- Timestamps are UTC ISO-8601 strings from Date#toISOString, so they compare
-- correctly as text.

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  -- Access login, when this person has one. Blocks approving their own hours.
  email TEXT,
  pin_hash TEXT,
  pin_salt TEXT,
  gusto_employee_uuid TEXT UNIQUE,
  gusto_job_uuid TEXT,
  overtime_eligible INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  -- The Gusto account can hold more than the store, so nobody's Gusto hours or
  -- pay reach a manager until they are marked as store staff.
  store_staff INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  clock_in_at TEXT NOT NULL,
  clock_out_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  source TEXT NOT NULL DEFAULT 'clock' CHECK (source IN ('clock', 'manual')),
  note TEXT NOT NULL DEFAULT '',
  -- Optimistic lock: every write must name the version it read.
  version INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT,
  approved_at TEXT,
  -- NULL until pushed. 'pushing' is written before the Gusto call, so a crash
  -- mid-push can never be silently retried into a duplicate time sheet.
  push_state TEXT CHECK (push_state IN ('pushing', 'pushed')),
  gusto_time_sheet_uuid TEXT,
  pushed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (clock_out_at IS NULL OR clock_out_at > clock_in_at)
);

CREATE INDEX IF NOT EXISTS idx_time_entries_clock_in ON time_entries(clock_in_at);
CREATE INDEX IF NOT EXISTS idx_time_entries_staff ON time_entries(staff_id, clock_in_at);

-- One open shift per person, enforced by the database so a double tap on the
-- kiosk cannot start two shifts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_one_open_shift
  ON time_entries(staff_id)
  WHERE clock_out_at IS NULL AND status <> 'rejected';

-- Append-only history of every change to a shift.
CREATE TABLE IF NOT EXISTS time_entry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES time_entries(id),
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_time_entry_events_entry ON time_entry_events(entry_id);

-- Read-only history imported from Gusto. Deliberately separate from
-- time_entries: nothing here can be approved or pushed, so imported hours can
-- never be sent back to Gusto and paid twice.
CREATE TABLE IF NOT EXISTS gusto_time_records (
  record_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  gusto_employee_uuid TEXT,
  employee_name TEXT,
  started_at TEXT,
  ended_at TEXT,
  started_on TEXT,
  hours REAL,
  status TEXT,
  raw_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gusto_time_records_started_on ON gusto_time_records(started_on);

-- Read-only pay imported from Gusto for store staff, one row per person per
-- payroll. Managers read this table, so it holds gross pay and hours only: net
-- pay, taxes, deductions, benefits and payment details stay in Gusto.
CREATE TABLE IF NOT EXISTS gusto_pay_records (
  payroll_uuid TEXT NOT NULL,
  gusto_employee_uuid TEXT NOT NULL,
  check_date TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('regular', 'off_cycle', 'reversal')),
  -- 1 when Gusto reversed this payroll afterward, in full or in part.
  reversed INTEGER NOT NULL DEFAULT 0,
  gross_cents INTEGER NOT NULL,
  regular_hours REAL NOT NULL DEFAULT 0,
  overtime_hours REAL NOT NULL DEFAULT 0,
  time_off_hours REAL NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (payroll_uuid, gusto_employee_uuid)
);

CREATE INDEX IF NOT EXISTS idx_gusto_pay_records_check_date ON gusto_pay_records(check_date);

-- This site's connection to one Gusto company, made by an owner through OAuth.
-- Tokens are AES-GCM ciphertext (src/lib/gusto/tokens.mjs). Gusto's refresh
-- tokens work once, so refresh_lock_until keeps two requests from racing and
-- killing the connection.
CREATE TABLE IF NOT EXISTS gusto_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  environment TEXT NOT NULL CHECK (environment IN ('demo', 'production')),
  company_uuid TEXT NOT NULL,
  company_name TEXT,
  redirect_uri TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_lock_until INTEGER NOT NULL DEFAULT 0,
  needs_reconnect INTEGER NOT NULL DEFAULT 0,
  employees_synced_at TEXT,
  connected_by TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Space-separated permissions Gusto granted at sign-in. Decides whether the
  -- admin may add hours to Gusto or only read.
  scopes TEXT
);

-- Payrolls already read for store staff. Paid payrolls rarely change, so each
-- page load only asks Gusto for ones it hasn't seen. Cleared when someone is
-- newly marked as store staff, so their past pay gets picked up.
CREATE TABLE IF NOT EXISTS gusto_pay_read (
  payroll_uuid TEXT PRIMARY KEY,
  check_date TEXT NOT NULL,
  read_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gusto_pay_read_check_date ON gusto_pay_read(check_date);
