/**
 * Reads a time the way people type it into a cell: "5p", "5:30 pm", "530p",
 * "17:30", "1730", "9", "noon". Without am/pm, the hour is read as whichever of
 * morning or afternoon is closer to `near`, the time the cell already had (or a
 * sensible guess), so "5" typed over a 9:12 PM clock-out means 5 PM.
 * @param {string} text
 * @param {number} near minutes after midnight to lean toward
 * @returns {number|null} minutes after midnight
 */
export function parseTypedTime(text, near) {
  let raw = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, ':');
  if (!raw) return null;
  if (raw === 'noon') return 12 * 60;
  if (raw === 'midnight') return 0;
  // "530p" and "1730": hours and minutes typed without a colon.
  const compact = /^(\d{1,2})(\d{2})(a|am|p|pm)?$/.exec(raw);
  if (compact) raw = `${compact[1]}:${compact[2]}${compact[3] ?? ''}`;
  const match = /^(\d{1,2})(?::(\d{2}))?(a|am|p|pm)?$/.exec(raw);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (minute > 59) return null;
  const suffix = match[3];
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix.startsWith('p') && hour !== 12) hour += 12;
    if (suffix.startsWith('a') && hour === 12) hour = 0;
    return hour * 60 + minute;
  }
  if (hour > 23) return null;
  if (hour === 0 || hour > 12) return hour * 60 + minute;
  // 1 to 12 with no am/pm: morning or afternoon, whichever is nearer.
  const morning = (hour % 12) * 60 + minute;
  const afternoon = morning + 12 * 60;
  return Math.abs(afternoon - near) < Math.abs(morning - near) ? afternoon : morning;
}

/** Minutes after midnight as "5:30 PM". */
export function formatMinutes(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  return `${h % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
