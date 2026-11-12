/**
 * Schedule texts: who gets one when a week is published, and what it says.
 * Plain JS so the API, the admin page and `npm test` share the same rules.
 *
 * The wording must match the sent.dm templates carriers approved, so the
 * bodies here are the templates with their variables filled in:
 *   week:   "Sunny & Ranney schedule, {{week}}: {{shifts}}. Reply STOP to opt out, HELP for help."
 *   signup: the confirmation the terms promise as the first text.
 */

import { cellKey, clockTiny, DAY_SHORT, weekdayOf, weekDates } from './core.mjs';
import { addDays } from '../time-clock/hours.mjs';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** sent.dm template ids. Not secrets: they only work with the store's API key. */
export const TEMPLATE_IDS = {
  week: 'fae476bf-10fd-4c16-a68a-733880885f07',
  signup: '60f30181-08e1-4bc2-9435-596f5435c09a',
};

export const SIGNUP_BODY =
  "Sunny & Ranney: you're signed up for schedule texts, usually 1-2 a week. Msg & data rates may apply. Reply HELP for help, STOP to cancel.";

export function weekBody({ week, shifts }) {
  return `Sunny & Ranney schedule, ${week}: ${shifts}. Reply STOP to opt out, HELP for help.`;
}

// ─── Phone numbers ───────────────────────────────────────────

/**
 * A US number as typed ("(678) 555-1234", "678.555.1234", "+1 678 555 1234")
 * → "+16785551234", or null if it can't be a US number.
 */
export function normalizeUsPhone(input) {
  const text = String(input ?? '').trim();
  if (!text || /[^\d\s().+-]/.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  // North American numbering: area code and exchange can't start with 0 or 1,
  // and N11 codes (411, 911) aren't area codes.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten) || ten.slice(1, 3) === '11') return null;
  return `+1${ten}`;
}

/** "+16785551234" → "678.555.1234", the way the store writes its own number. */
export function formatUsPhone(e164) {
  const ten = String(e164 ?? '').replace(/^\+1/, '');
  return /^\d{10}$/.test(ten) ? `${ten.slice(0, 3)}.${ten.slice(3, 6)}.${ten.slice(6)}` : String(e164 ?? '');
}

// ─── Plain SMS characters ────────────────────────────────────

// GSM 03.38. Anything outside it makes a text Unicode, which cuts each part
// from 160 characters to 70 and can triple the cost.
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENDED = new Set('^{}\\[~]|€');

const LOOKALIKES = [
  [/[‘’‚‛′`´]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/…/g, '...'],
  [/[•·]/g, '-'],
  [/[\s  -​  　]+/g, ' '],
];

/**
 * Text as plain SMS characters on one line: curly quotes and dashes become
 * plain ones, accents are dropped where GSM lacks the letter, and anything
 * else (emoji) is left out. sent.dm also refuses variables with line breaks.
 */
export function toGsm(text) {
  let out = String(text ?? '');
  for (const [pattern, plain] of LOOKALIKES) out = out.replace(pattern, plain);
  let kept = '';
  for (const ch of out) {
    if (ch === '\n' || ch === '\r') kept += ' ';
    else if (GSM_BASIC.has(ch) || GSM_EXTENDED.has(ch)) kept += ch;
    else {
      const bare = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if ([...bare].every((c) => GSM_BASIC.has(c))) kept += bare;
    }
  }
  return kept.replace(/ {2,}/g, ' ').trim();
}

/** How many SMS parts a GSM text takes: 160 characters for one, 153 each after. */
export function smsParts(text) {
  let septets = 0;
  for (const ch of String(text)) septets += GSM_EXTENDED.has(ch) ? 2 : 1;
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

// ─── What a week's text says ─────────────────────────────────

const MAX_LABEL_IN_TEXT = 20;

/** "10a-6p", "10:30a-6p", "9a-?", "Mart 9a-5p", or a label alone ("Mart"). */
export function shiftText(shift) {
  const label = toGsm(shift.label ?? '').slice(0, MAX_LABEL_IN_TEXT).trim();
  if (shift.start === null || shift.start === undefined) return label || 'Work';
  const end = shift.end === null || shift.end === undefined ? '?' : clockTiny(shift.end);
  const time = `${clockTiny(shift.start)}-${end}`;
  return label ? `${label} ${time}` : time;
}

/** "week of Nov 15". */
export function weekLabel(weekStart) {
  const [, m, d] = weekStart.split('-').map(Number);
  return `week of ${MONTH_SHORT[m - 1]} ${d}`;
}

/**
 * One person's shifts on the days still ahead, {date: "10a-6p"}. Days already
 * gone are left out, so fixing Monday's hours on Wednesday texts nobody.
 */
export function upcomingDays({ weekStart, today, staffId, cells }) {
  const days = {};
  for (const date of weekDates(weekStart)) {
    if (date < today) continue;
    const shift = cells.get(cellKey(staffId, date))?.shift;
    if (shift) days[date] = shiftText(shift);
  }
  return days;
}

/** The template's two variables for these days. */
export function weekParams(weekStart, days, updated) {
  const dates = Object.keys(days).sort();
  const shifts = dates.length ? dates.map((date) => `${DAY_SHORT[weekdayOf(date)]} ${days[date]}`).join(', ') : 'no shifts';
  return { week: `${weekLabel(weekStart)}${updated ? ' (updated)' : ''}`, shifts };
}

function sameUpcoming(before, now, today) {
  const dates = new Set([...Object.keys(before), ...Object.keys(now)].filter((d) => d >= today));
  for (const date of dates) if (before[date] !== now[date]) return false;
  return true;
}

/**
 * Who gets a text when this week is published, and what it says.
 *
 * - Nobody is texted about a week that's over.
 * - The first text for a week goes to everyone signed up who has a shift ahead.
 * - After that, someone is texted only when a day still ahead differs from
 *   what their last text said, and the text lists all their days ahead.
 * - A text that failed doesn't count, so the next publish sends it again.
 *
 * @param {{
 *   weekStart: string,
 *   today: string,
 *   people: Array<{ id: string, signup: { phone: string, stopped: boolean } | null }>,
 *   cells: Map<string, { shift?: any }>,
 *   previous: Map<string, Record<string, string>>,
 * }} input `previous` holds each person's days from their last text for this
 *   week that sent.dm accepted.
 * @returns {Array<{ staffId: string, send: boolean, reason: string, days: Record<string, string>,
 *   params: { week: string, shifts: string } | null, body: string | null }>}
 *   reason is one of: first, update, no-number, stopped, no-shifts, unchanged, past.
 */
export function planWeekTexts({ weekStart, today, people, cells, previous }) {
  const over = addDays(weekStart, 6) < today;
  return people.map((person) => {
    const days = upcomingDays({ weekStart, today, staffId: person.id, cells });
    const skip = (reason) => ({ staffId: person.id, send: false, reason, days, params: null, body: null });
    if (over) return skip('past');
    if (!person.signup) return skip('no-number');
    if (person.signup.stopped) return skip('stopped');
    const before = previous.get(person.id);
    if (!before && Object.keys(days).length === 0) return skip('no-shifts');
    if (before && sameUpcoming(before, days, today)) return skip('unchanged');
    const params = weekParams(weekStart, days, Boolean(before));
    return { staffId: person.id, send: true, reason: before ? 'update' : 'first', days, params, body: weekBody(params) };
  });
}

// ─── Delivery ────────────────────────────────────────────────

/** Statuses that mean the text reached sent.dm and is on its way or there. */
export const ACCEPTED_STATUSES = new Set(['sending', 'queued', 'sent', 'delivered']);

const STATUS_FROM_SENT_DM = {
  QUEUED: 'queued',
  ROUTED: 'queued',
  SCHEDULED: 'queued',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'delivered',
  FAILED: 'failed',
  FILTERED: 'filtered',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
};

/** sent.dm's message_status → ours, or null for one we don't know. */
export function statusFromSentDm(value) {
  return STATUS_FROM_SENT_DM[String(value ?? '').toUpperCase()] ?? null;
}

/** sent.dm reason codes that mean the number replied STOP. */
export const OPTED_OUT_CODES = new Set(['BUSINESS_004', 'ERR_CONSENT_BLOCKED']);

// Stop words are sent.dm's plus the carriers' (CTIA), so anything that reads
// as STOP stops texts here. Start words are only sent.dm's, since a number it
// still holds as opted out can't be texted anyway.
const OPT_OUT_WORDS = new Set(['STOP', 'STOPALL', 'CANCEL', 'UNSUBSCRIBE', 'QUIT', 'END', 'OPTOUT', 'REVOKE']);
const OPT_IN_WORDS = new Set(['START', 'UNSTOP', 'SUBSCRIBE']);

/** 'stop', 'start' or null for an incoming text. The whole message must be the word. */
export function keywordOf(text) {
  const word = String(text ?? '').trim().toUpperCase();
  if (OPT_OUT_WORDS.has(word)) return 'stop';
  if (OPT_IN_WORDS.has(word)) return 'start';
  return null;
}

/** What the manager sees for a text's status. */
export function statusLabel(status, reasonCode) {
  switch (status) {
    case 'sending':
    case 'queued':
      return 'Sending';
    case 'sent':
      return 'Sent';
    case 'delivered':
      return 'Delivered';
    case 'filtered':
      return OPTED_OUT_CODES.has(reasonCode ?? '') ? 'Not sent: they replied STOP' : 'Not sent: sent.dm held it back';
    case 'blocked':
      if (reasonCode === 'BUSINESS_003') return 'Not sent: the sent.dm balance is too low';
      return 'Not sent: sent.dm isn’t cleared to text yet';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Not delivered: the phone company refused it';
    default:
      return 'Not sent: couldn’t reach sent.dm';
  }
}
