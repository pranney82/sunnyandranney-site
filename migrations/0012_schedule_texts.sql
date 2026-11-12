-- Schedule texts: staff who signed the paper consent form (/text-consent/)
-- get their shifts by text when a week is published, through sent.dm.
-- Safe to run more than once.

-- Who gets texts, and the consent behind it. Kept apart from `staff` and
-- `schedule_people` so turning texts off never touches the clock or the grid.
CREATE TABLE IF NOT EXISTS schedule_text_signups (
  staff_id TEXT PRIMARY KEY REFERENCES staff(id),
  -- US mobile number in E.164 (+16785551234).
  phone TEXT NOT NULL,
  -- The date on the signed form, as the manager read it off the paper.
  consent_signed_on TEXT NOT NULL,
  entered_by TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  -- Set when the number replies STOP, cleared when it replies START. Copied
  -- from sent.dm, which refuses to text an opted-out number either way.
  stopped_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedule_text_signups_phone ON schedule_text_signups(phone);

-- Every text, sent or tried. A row is written as 'sending' before sent.dm is
-- called, and its id is the request's Idempotency-Key, so a retry can't text
-- anyone twice.
CREATE TABLE IF NOT EXISTS schedule_texts (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  kind TEXT NOT NULL CHECK (kind IN ('signup', 'week')),
  week_start TEXT,
  phone TEXT NOT NULL,
  -- The days still ahead when it was sent, {"2026-11-17": "Tue 10a-6p"}. The
  -- next publish texts this person only if one of those days has changed.
  days_json TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'queued', 'sent', 'delivered', 'failed', 'filtered', 'blocked', 'cancelled', 'error')),
  reason TEXT,
  message_id TEXT UNIQUE,
  -- When sent.dm reported the current status, so a late event can't undo a newer one.
  status_at TEXT,
  sent_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (kind = 'signup' OR week_start IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_schedule_texts_person ON schedule_texts(staff_id, kind, week_start, created_at);

-- The sent.dm webhook that reports delivery and STOP replies. Its signing
-- secret comes back once, when the admin creates it, and lands here without
-- anyone handling it. A table of its own so nothing that reads `settings`
-- can ever return it.
CREATE TABLE IF NOT EXISTS sent_dm_webhook (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  webhook_id TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
