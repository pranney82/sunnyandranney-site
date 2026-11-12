/**
 * Schedule texts on the server: who's signed up, sending through sent.dm when
 * a week is published, and what sent.dm reports back by webhook.
 * The rules (who gets a text, what it says) are in texts.mjs.
 */
import { cellsFromSnapshot, weekDates } from '@/lib/schedule/core.mjs';
import {
  ACCEPTED_STATUSES,
  keywordOf,
  normalizeUsPhone,
  OPTED_OUT_CODES,
  planWeekTexts,
  SIGNUP_BODY,
  smsParts,
  statusFromSentDm,
  statusLabel,
  TEMPLATE_IDS,
} from '@/lib/schedule/texts.mjs';
import { createWebhook, sendTemplate } from '@/lib/sent-dm.mjs';
import { localDate } from '@/lib/time-clock/hours.mjs';

/** The parts of the Worker's env this needs. */
export interface TextingEnv {
  SENT_DM_API_KEY?: string;
  /** A stand-in sent.dm for local tests. Never set in production. */
  SENT_DM_API_BASE?: string;
  /** "1" sends with sent.dm's sandbox flag: checked, never delivered. */
  SENT_DM_SANDBOX?: string;
}

export interface TextSignup {
  phone: string;
  signedOn: string;
  enteredBy: string;
  enteredAt: string;
  stopped: boolean;
}

export interface TextRecord {
  status: string;
  label: string;
  ok: boolean;
  at: string;
  body: string;
}

export interface PersonTexts {
  signup: TextSignup | null;
  /** The latest sign-up confirmation sent to their current number. */
  signupText: TextRecord | null;
  /** The latest text about the week on screen. */
  weekText: TextRecord | null;
  /** What publishing the week as saved would do for them. */
  plan: { send: boolean; reason: string; body: string | null; parts: number };
}

export interface TextsState {
  /** sent.dm's key is set, so texts can go out. */
  ready: boolean;
  /** The delivery webhook is set up, so statuses update. */
  connected: boolean;
  people: Record<string, PersonTexts>;
}

const nowIso = () => new Date().toISOString();

type Cells = Map<string, { shift: unknown; off: unknown }>;
const sandboxOf = (env: TextingEnv) => env.SENT_DM_SANDBOX === '1';

interface SignupRow {
  staff_id: string;
  phone: string;
  consent_signed_on: string;
  entered_by: string;
  entered_at: string;
  stopped_at: string | null;
}

interface TextRow {
  id: string;
  staff_id: string;
  kind: 'signup' | 'week';
  week_start: string | null;
  phone: string;
  days_json: string | null;
  body: string;
  status: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function toSignup(row: SignupRow): TextSignup {
  return {
    phone: row.phone,
    signedOn: row.consent_signed_on,
    enteredBy: row.entered_by,
    enteredAt: row.entered_at,
    stopped: row.stopped_at !== null,
  };
}

/**
 * A row still 'sending' after ten minutes means the Worker stopped between
 * writing it and hearing from sent.dm. It counts as not sent, so the next
 * publish sends it again under a new key.
 */
const STUCK_MS = 10 * 60 * 1000;
function settled(row: TextRow): TextRow {
  return row.status === 'sending' && Date.parse(row.created_at) < Date.now() - STUCK_MS ? { ...row, status: 'error', reason: 'STUCK' } : row;
}

function toRecord(row: TextRow): TextRecord {
  return {
    status: row.status,
    label: statusLabel(row.status, row.reason),
    ok: ACCEPTED_STATUSES.has(row.status),
    at: row.updated_at,
    body: row.body,
  };
}

/** Everything about texts for one week, newest text last. */
export async function readTexting(db: D1Database, weekStart: string) {
  const [signups, texts, hook] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT staff_id, phone, consent_signed_on, entered_by, entered_at, stopped_at FROM schedule_text_signups`),
    db
      .prepare(
        `SELECT id, staff_id, kind, week_start, phone, days_json, body, status, reason, created_at, updated_at
         FROM schedule_texts WHERE kind = 'signup' OR week_start = ? ORDER BY created_at, rowid`,
      )
      .bind(weekStart),
    db.prepare(`SELECT 1 AS ok FROM sent_dm_webhook WHERE id = 1`),
  ]);
  const signupById = new Map((signups.results as unknown as SignupRow[]).map((r) => [r.staff_id, toSignup(r)]));
  const rows = (texts.results as unknown as TextRow[]).map(settled);

  // Per person: the days in their last accepted text this week, their latest
  // text this week, and whether their current number has had the confirmation.
  const previous = new Map<string, Record<string, string>>();
  const latestWeek = new Map<string, TextRow>();
  const latestSignup = new Map<string, TextRow>();
  const confirmed = new Set<string>();
  for (const row of rows) {
    const signup = signupById.get(row.staff_id);
    if (row.kind === 'signup') {
      if (!signup || row.phone !== signup.phone) continue;
      latestSignup.set(row.staff_id, row);
      if (ACCEPTED_STATUSES.has(row.status)) confirmed.add(row.staff_id);
    } else {
      latestWeek.set(row.staff_id, row);
      if (ACCEPTED_STATUSES.has(row.status) && row.days_json) previous.set(row.staff_id, JSON.parse(row.days_json));
    }
  }
  return { signupById, previous, latestWeek, latestSignup, confirmed, connected: hook.results.length > 0 };
}

export type Texting = Awaited<ReturnType<typeof readTexting>>;

/** Texts for the week on screen. `cells` are the saved cells, which are what publishing sends. */
export function textsState(
  t: Texting,
  input: { weekStart: string; today: string; peopleIds: string[]; cells: Cells; ready: boolean },
): TextsState {
  const plan = planWeekTexts({
    weekStart: input.weekStart,
    today: input.today,
    people: input.peopleIds.map((id) => ({ id, signup: t.signupById.get(id) ?? null })),
    cells: input.cells,
    previous: t.previous,
  });
  const people: Record<string, PersonTexts> = {};
  for (const p of plan) {
    const signupText = t.latestSignup.get(p.staffId);
    const weekText = t.latestWeek.get(p.staffId);
    people[p.staffId] = {
      signup: t.signupById.get(p.staffId) ?? null,
      signupText: signupText ? toRecord(signupText) : null,
      weekText: weekText ? toRecord(weekText) : null,
      plan: { send: p.send, reason: p.reason, body: p.body, parts: p.body ? smsParts(p.body) : 0 },
    };
  }
  return { ready: input.ready, connected: t.connected, people };
}

// ─── Sending ─────────────────────────────────────────────────

interface Outgoing {
  staffId: string;
  kind: 'signup' | 'week';
  weekStart: string | null;
  phone: string;
  days: Record<string, string> | null;
  params: Record<string, string>;
  body: string;
}

type SendOutcome = 'sent' | 'duplicate' | 'failed';

/**
 * Records the text, then asks sent.dm to send it. The row's id is the
 * Idempotency-Key, and the insert refuses a copy of a text accepted in the
 * last ten minutes, so a double publish can't text anyone twice.
 */
async function sendOne(db: D1Database, env: TextingEnv, text: Outgoing, actor: string): Promise<SendOutcome> {
  const id = crypto.randomUUID();
  const now = nowIso();
  const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const inserted = await db
    .prepare(
      `INSERT INTO schedule_texts (id, staff_id, kind, week_start, phone, days_json, body, status, sent_by, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'sending', ?8, ?9, ?9
       WHERE NOT EXISTS (
         SELECT 1 FROM schedule_texts
         WHERE staff_id = ?2 AND kind = ?3 AND COALESCE(week_start, '') = COALESCE(?4, '') AND phone = ?5 AND body = ?7
           AND status IN ('sending', 'queued', 'sent', 'delivered') AND created_at > ?10)`,
    )
    .bind(id, text.staffId, text.kind, text.weekStart, text.phone, text.days ? JSON.stringify(text.days) : null, text.body, actor, now, recent)
    .run();
  if (!inserted.meta.changes) return 'duplicate';

  const result = await sendTemplate({
    apiKey: env.SENT_DM_API_KEY!,
    base: env.SENT_DM_API_BASE,
    to: text.phone,
    templateId: TEMPLATE_IDS[text.kind],
    parameters: text.params,
    idempotencyKey: id,
    sandbox: sandboxOf(env),
  });
  if (result.ok) {
    await db
      .prepare(`UPDATE schedule_texts SET status = ?, message_id = ?, updated_at = ? WHERE id = ? AND status = 'sending'`)
      .bind(statusFromSentDm(result.status) ?? 'queued', result.messageId, nowIso(), id)
      .run();
    return 'sent';
  }
  console.error('sent.dm send failed', result.status, result.code, result.message);
  await db
    .prepare(`UPDATE schedule_texts SET status = 'error', reason = ?, updated_at = ? WHERE id = ?`)
    .bind(result.code, nowIso(), id)
    .run();
  return 'failed';
}

function signupText(staffId: string, phone: string): Outgoing {
  return { staffId, kind: 'signup', weekStart: null, phone, days: null, params: {}, body: SIGNUP_BODY };
}

export interface SendSummary {
  ready: boolean;
  texted: string[];
  failed: string[];
}

/**
 * After a week is published: texts everyone the plan says to, from the
 * snapshot just published. Anyone whose number hasn't had the sign-up
 * confirmation gets it first.
 */
export async function sendWeekTexts(
  db: D1Database,
  env: TextingEnv,
  input: { weekStart: string; actor: string; onlyStaffId?: string },
): Promise<SendSummary> {
  const summary: SendSummary = { ready: Boolean(env.SENT_DM_API_KEY), texted: [], failed: [] };
  if (!summary.ready) return summary;

  const [week, onSchedule] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT published_json FROM schedule_weeks WHERE week_start = ?`).bind(input.weekStart),
    // The same people the schedule page lists, so what's sent is what the Publish sheet showed.
    db.prepare(`SELECT staff_id FROM schedule_people`),
  ]);
  const publishedJson = (week.results[0] as { published_json: string | null } | undefined)?.published_json;
  if (!publishedJson) return summary;
  const cells = cellsFromSnapshot(JSON.parse(publishedJson)) as Cells;
  const dates = new Set(weekDates(input.weekStart));
  const ids = new Set((onSchedule.results as Array<{ staff_id: string }>).map((r) => r.staff_id));
  for (const key of cells.keys()) if (dates.has(key.split('|')[1])) ids.add(key.split('|')[0]);
  if (input.onlyStaffId) {
    if (!ids.has(input.onlyStaffId)) return summary;
    ids.clear();
    ids.add(input.onlyStaffId);
  }

  const t = await readTexting(db, input.weekStart);
  const plan = planWeekTexts({
    weekStart: input.weekStart,
    today: localDate(nowIso()),
    people: [...ids].map((id) => ({ id, signup: t.signupById.get(id) ?? null })),
    cells,
    previous: t.previous,
  });

  await Promise.all(
    plan
      .filter((p) => p.send)
      .map(async (p) => {
        const phone = t.signupById.get(p.staffId)!.phone;
        if (!t.confirmed.has(p.staffId)) await sendOne(db, env, signupText(p.staffId, phone), input.actor);
        const outcome = await sendOne(
          db,
          env,
          { staffId: p.staffId, kind: 'week', weekStart: input.weekStart, phone, days: p.days, params: p.params!, body: p.body! },
          input.actor,
        );
        if (outcome === 'sent') summary.texted.push(p.staffId);
        else if (outcome === 'failed') summary.failed.push(p.staffId);
      }),
  );
  return summary;
}

// ─── Sign-ups ────────────────────────────────────────────────

export class SignupError extends Error {}

/**
 * Saves someone's number and the date on their signed form, then texts the
 * confirmation the terms promise. A new number starts with STOP cleared.
 */
export async function saveTextSignup(
  db: D1Database,
  env: TextingEnv,
  input: { staffId: string; phone: string; signedOn: string; today: string },
  actor: string,
): Promise<{ texted: boolean }> {
  const phone = normalizeUsPhone(input.phone);
  if (!phone) throw new SignupError('That doesn’t look like a US mobile number. Type all ten digits.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.signedOn) || input.signedOn > input.today) {
    throw new SignupError('Use the date on their signed form. It can’t be in the future.');
  }
  const exists = await db.prepare(`SELECT 1 FROM staff WHERE id = ? AND active = 1`).bind(input.staffId).first();
  if (!exists) throw new SignupError('That person isn’t on staff.');

  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO schedule_text_signups (staff_id, phone, consent_signed_on, entered_by, entered_at, stopped_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?5)
       ON CONFLICT (staff_id) DO UPDATE SET
         stopped_at = CASE WHEN schedule_text_signups.phone = excluded.phone THEN schedule_text_signups.stopped_at ELSE NULL END,
         phone = excluded.phone, consent_signed_on = excluded.consent_signed_on,
         entered_by = excluded.entered_by, entered_at = excluded.entered_at, updated_at = excluded.updated_at`,
    )
    .bind(input.staffId, phone, input.signedOn, actor, now)
    .run();

  if (!env.SENT_DM_API_KEY) return { texted: false };
  const confirmed = await db
    .prepare(
      `SELECT 1 FROM schedule_texts WHERE staff_id = ? AND kind = 'signup' AND phone = ?
         AND (status IN ('queued', 'sent', 'delivered') OR (status = 'sending' AND created_at > ?))`,
    )
    .bind(input.staffId, phone, new Date(Date.now() - STUCK_MS).toISOString())
    .first();
  if (confirmed) return { texted: false };
  return { texted: (await sendOne(db, env, signupText(input.staffId, phone), actor)) === 'sent' };
}

/** Stops texts to someone. Their past texts stay on record. */
export async function removeTextSignup(db: D1Database, staffId: string): Promise<void> {
  await db.prepare(`DELETE FROM schedule_text_signups WHERE staff_id = ?`).bind(staffId).run();
}

/** Tries again for one person: their confirmation if it never went, and this week if it's due. */
export async function retryTexts(db: D1Database, env: TextingEnv, input: { weekStart: string; staffId: string; actor: string }) {
  if (!env.SENT_DM_API_KEY) return { texted: false };
  const t = await readTexting(db, input.weekStart);
  const signup = t.signupById.get(input.staffId);
  if (!signup || signup.stopped) return { texted: false };
  let texted = false;
  const published = await db.prepare(`SELECT 1 FROM schedule_weeks WHERE week_start = ? AND published_json IS NOT NULL`).bind(input.weekStart).first();
  if (published) {
    const summary = await sendWeekTexts(db, env, { weekStart: input.weekStart, actor: input.actor, onlyStaffId: input.staffId });
    texted = summary.texted.length > 0;
  }
  // No week text was due, so send the confirmation alone if it never went.
  if (!texted && !(await readTexting(db, input.weekStart)).confirmed.has(input.staffId)) {
    texted = (await sendOne(db, env, signupText(input.staffId, signup.phone), input.actor)) === 'sent';
  }
  return { texted };
}

// ─── What sent.dm reports back ───────────────────────────────

async function setStopped(db: D1Database, phone: unknown, stopped: boolean, at: string) {
  const number = normalizeUsPhone(typeof phone === 'string' ? phone : '');
  if (!number) return;
  await db
    .prepare(
      stopped
        ? `UPDATE schedule_text_signups SET stopped_at = ?1, updated_at = ?2 WHERE phone = ?3 AND stopped_at IS NULL`
        : // A START older than the STOP on record (events can arrive out of order) changes nothing.
          `UPDATE schedule_text_signups SET stopped_at = NULL, updated_at = ?2 WHERE phone = ?3 AND stopped_at <= ?1`,
    )
    .bind(at, nowIso(), number)
    .run();
}

export type EventOutcome = 'applied' | 'unknown-message' | 'ignored';

interface SentDmEvent {
  field?: string;
  event?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

/**
 * Applies one webhook event. Message statuses update the text they belong
 * to, unless a newer status is already recorded. STOP and START replies (and
 * a send refused because the number opted out) update the sign-up.
 */
export async function applyTextEvent(db: D1Database, event: SentDmEvent): Promise<EventOutcome> {
  const p = event.payload ?? {};
  const at = [p.updated_at, p.received_at, event.timestamp].find((v): v is string => typeof v === 'string') ?? nowIso();

  if (event.field === 'contact') {
    if (event.event === 'contact.opt_out') await setStopped(db, p.from, true, at);
    else if (event.event === 'contact.opt_in') await setStopped(db, p.from, false, at);
    else return 'ignored';
    return 'applied';
  }

  if (event.field !== 'message') return 'ignored';

  if (event.event === 'message.received') {
    const keyword = keywordOf(p.text);
    if (!keyword) return 'ignored';
    await setStopped(db, p.inbound_number, keyword === 'stop', at);
    return 'applied';
  }

  const status = statusFromSentDm(p.message_status);
  if (!status || typeof p.message_id !== 'string') return 'ignored';
  const reason = typeof p.reason_code === 'string' ? p.reason_code : null;
  const result = await db
    .prepare(
      `UPDATE schedule_texts SET status = ?1, reason = ?2, status_at = ?3, updated_at = ?4
       WHERE message_id = ?5 AND (status_at IS NULL OR status_at <= ?3)`,
    )
    .bind(status, reason, at, nowIso(), p.message_id)
    .run();
  if (!result.meta.changes) {
    const known = await db.prepare(`SELECT 1 FROM schedule_texts WHERE message_id = ?`).bind(p.message_id).first();
    if (!known) return 'unknown-message';
  }
  if (status === 'filtered' && reason && OPTED_OUT_CODES.has(reason)) await setStopped(db, p.outbound_number, true, at);
  return 'applied';
}

// ─── The webhook itself ──────────────────────────────────────

export async function webhookSecret(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`SELECT signing_secret FROM sent_dm_webhook WHERE id = 1`).first<{ signing_secret: string }>();
  return row?.signing_secret ?? null;
}

/**
 * Creates the sent.dm webhook and keeps its signing secret, once. The secret
 * goes from sent.dm's answer straight into D1.
 */
export async function connectWebhook(
  db: D1Database,
  env: TextingEnv,
  input: { endpointUrl: string; actor: string },
): Promise<{ ok: true; created: boolean } | { ok: false; message: string }> {
  if (!env.SENT_DM_API_KEY) return { ok: false, message: 'sent.dm’s key isn’t set.' };
  const existing = await db.prepare(`SELECT endpoint_url FROM sent_dm_webhook WHERE id = 1`).first<{ endpoint_url: string }>();
  if (existing) return { ok: true, created: false };
  const result = await createWebhook({ apiKey: env.SENT_DM_API_KEY, base: env.SENT_DM_API_BASE, endpointUrl: input.endpointUrl });
  if (!result.ok) return { ok: false, message: result.message };
  await db
    .prepare(
      `INSERT INTO sent_dm_webhook (id, webhook_id, signing_secret, endpoint_url, created_by, created_at)
       VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    )
    .bind(result.id, result.secret, input.endpointUrl, input.actor, nowIso())
    .run();
  return { ok: true, created: true };
}

