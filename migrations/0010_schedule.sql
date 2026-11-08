-- Staff schedule: the week grid the store manager builds, replacing the shared
-- Google Sheet. Dates are store-local calendar dates (YYYY-MM-DD) and times are
-- minutes after store-local midnight, so a shift never moves when the clocks
-- change. Every write sets a new random `rev`, and a write names the rev it
-- read, so two managers can't silently overwrite each other.
-- Safe to run more than once.

-- Who appears on the schedule, in the manager's order. Kept apart from `staff`
-- so the time clock and Gusto tables don't change.
CREATE TABLE IF NOT EXISTS schedule_people (
  staff_id TEXT PRIMARY KEY REFERENCES staff(id),
  position INTEGER NOT NULL,
  -- Secret for this person's calendar feed (/staff-calendar/<token>/). Held
  -- in plain text so the manager can copy the link again; it grants no more
  -- than this database already holds, and replacing it turns the old link off.
  calendar_token TEXT UNIQUE,
  calendar_token_created_at TEXT,
  added_at TEXT NOT NULL
);

-- At most one shift per person per day, like a cell in the sheet.
CREATE TABLE IF NOT EXISTS schedule_shifts (
  staff_id TEXT NOT NULL REFERENCES staff(id),
  date TEXT NOT NULL,
  -- NULL start: a task with no hours yet ("Mart"). NULL end: no end time yet ("9-?").
  start_min INTEGER CHECK (start_min IS NULL OR start_min BETWEEN 0 AND 1439),
  end_min INTEGER CHECK (end_min IS NULL OR end_min BETWEEN 1 AND 1440),
  label TEXT NOT NULL DEFAULT '',
  -- Working away from the store (market, warehouse), so not counted as cover.
  away INTEGER NOT NULL DEFAULT 0 CHECK (away IN (0, 1)),
  rev TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (staff_id, date),
  CHECK (start_min IS NOT NULL OR end_min IS NULL),
  CHECK (end_min IS NULL OR end_min > start_min)
);

CREATE INDEX IF NOT EXISTS idx_schedule_shifts_date ON schedule_shifts(date);

-- One row per person per day off. A vacation is several rows; the admin groups
-- consecutive days back into ranges for display.
CREATE TABLE IF NOT EXISTS schedule_time_off (
  staff_id TEXT NOT NULL REFERENCES staff(id),
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('off', 'pto', 'vacation', 'sick')),
  note TEXT NOT NULL DEFAULT '',
  rev TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (staff_id, date)
);

CREATE INDEX IF NOT EXISTS idx_schedule_time_off_date ON schedule_time_off(date);

-- A note for a day ("Sip & Shop", "Thanksgiving") and whether the store is closed.
CREATE TABLE IF NOT EXISTS schedule_days (
  date TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A week's note, and what staff were last shown. Calendar feeds and the store
-- tablet read published_json, so a half-built week never reaches anyone's phone.
CREATE TABLE IF NOT EXISTS schedule_weeks (
  week_start TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  published_json TEXT,
  published_at TEXT,
  published_by TEXT,
  updated_by TEXT,
  updated_at TEXT
);

-- Append-only history of every change, with who made it. Also how long a week
-- takes to build is measured from here.
CREATE TABLE IF NOT EXISTS schedule_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  staff_id TEXT,
  date TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedule_events_date ON schedule_events(date);
CREATE INDEX IF NOT EXISTS idx_schedule_events_created ON schedule_events(created_at);

-- Never holds a row. A write batch inserts 0 here when a cell changed since the
-- manager read it; the CHECK fails, and D1 rolls the whole batch back.
CREATE TABLE IF NOT EXISTS schedule_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
