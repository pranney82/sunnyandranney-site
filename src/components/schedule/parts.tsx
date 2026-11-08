/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  clock,
  clockLong,
  clockStatus,
  clockTiny,
  dateRangeLabel,
  dayLabel,
  hoursLabel,
  shiftMinutes,
  shiftShort,
  TIME_OFF_LABELS,
} from '@/lib/schedule/core.mjs';
import type { Cell, Hours } from './model';

// ─── One cell ────────────────────────────────────────────────

export type Punch = { in: number; out: number | null };

export interface CellWhen {
  isPast: boolean;
  isToday: boolean;
  nowMinutes: number;
  clockInUse: boolean;
}

export function describeCell(name: string, date: string, cell: Cell): string {
  const day = dayLabel(date);
  const parts: string[] = [];
  if (cell.shift) {
    const s = cell.shift;
    if (s.start === null) parts.push(`${s.label}, no hours`);
    else if (s.end === null) parts.push(`${clockLong(s.start)} until not set${s.label ? `, ${s.label}` : ''}`);
    else parts.push(`${clockLong(s.start)} to ${clockLong(s.end)}, ${hoursLabel(shiftMinutes(s))} hours${s.label ? `, ${s.label}` : ''}`);
    if (s.away) parts.push('away from the store');
  }
  if (cell.off) parts.push(`${TIME_OFF_LABELS[cell.off.kind]}${cell.off.note ? `, ${cell.off.note}` : ''}`);
  return `${name}, ${day}: ${parts.length ? parts.join('; ') : 'nothing scheduled'}`;
}

function PunchLine({ shift, punches, when }: { shift: Cell['shift']; punches: Punch[]; when: CellWhen }) {
  if (!when.clockInUse || (!when.isPast && !when.isToday)) return null;
  const status = clockStatus(shift, punches, when);
  const span = (from?: number, to?: number | null) => (from === undefined ? '' : `${clock(from)}–${to === null || to === undefined ? 'now' : clock(to)}`);
  switch (status.kind) {
    case 'on-time':
      return (
        <span class="punch punch--ok" title="Clocked in on time">
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.2 2.2 4.8-5" /></svg>
          {span(status.in, status.out)}
        </span>
      );
    case 'late':
      return <span class="punch punch--late">Late {status.minutes} min · {span(status.in, status.out)}</span>;
    case 'working':
      return <span class="punch punch--live">{status.minutes ? `In ${status.minutes} min late` : `In since ${clock(status.in!)}`}</span>;
    case 'no-show':
      return <span class="punch punch--miss">No clock-in</span>;
    case 'unscheduled':
      return <span class="punch punch--extra">Worked {span(status.in, status.out)}</span>;
    default:
      return null;
  }
}

export function CellContent({
  cell,
  color,
  punches,
  when,
  changed,
  inBand = false,
  hint = false,
  dot = 'none',
}: {
  cell: Cell;
  color: number;
  punches: Punch[];
  when: CellWhen;
  changed: boolean;
  /** Part of a run of days off drawn as one band across the row. */
  inBand?: boolean;
  /** The focused empty cell says what to type. */
  hint?: boolean;
  /** "fading" once the change is published, so the dot leaves gently. */
  dot?: 'none' | 'fading';
}) {
  const { shift, off } = cell;
  return (
    <>
      {shift && (
        <span
          class={`chip c${color}${shift.away ? ' chip--away' : ''}${shift.start === null || shift.end === null ? ' chip--loose' : ''}${off ? ' chip--clash' : ''}`}
        >
          <span class="chip-time">{shift.start === null ? shift.label : shiftShort(shift)}</span>
          <span class="chip-meta">
            {shift.start === null
              ? shift.away
                ? 'Away · no hours'
                : 'No hours'
              : [shift.label, shift.end === null ? 'no end' : `${hoursLabel(shiftMinutes(shift))}h`, shift.away && !shift.label ? 'away' : '']
                  .filter(Boolean)
                  .join(' · ')}
          </span>
        </span>
      )}
      {off && !inBand && (
        <span class={`off off--${off.kind}${shift ? ' off--tag' : ''}`}>
          <span class="off-kind">{TIME_OFF_LABELS[off.kind]}</span>
          {off.note && !shift && <span class="off-note">{off.note}</span>}
        </span>
      )}
      {!shift && !off && (hint ? <span class="cell-hint" aria-hidden="true">type 9-5</span> : <span class="cell-add" aria-hidden="true">+</span>)}
      <PunchLine shift={shift} punches={punches} when={when} />
      {(changed || dot === 'fading') && <span class={`cell-dot${dot === 'fading' && !changed ? ' is-fading' : ''}`} title="Changed since you published" />}
    </>
  );
}

/** A run of days off drawn as one bar across the days it covers. */
export function OffBand({
  kind,
  note,
  from,
  to,
  startCol,
  endCol,
  cutLeft,
  cutRight,
}: {
  kind: 'off' | 'pto' | 'vacation' | 'sick';
  note: string;
  from: string;
  to: string;
  startCol: number;
  endCol: number;
  cutLeft: boolean;
  cutRight: boolean;
}) {
  return (
    <div
      class={`band band--${kind}${cutLeft ? ' cut-l' : ''}${cutRight ? ' cut-r' : ''}`}
      style={{ gridColumn: `${startCol + 2} / ${endCol + 3}`, gridRow: '1' }}
      aria-hidden="true"
    >
      <span class="band-kind">{TIME_OFF_LABELS[kind]}</span>
      <span class="band-range">
        {dateRangeLabel(from, to)}
        {note ? ` · ${note}` : ''}
      </span>
    </div>
  );
}

/** A number that eases to its new value instead of jumping. */
export function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    const from = current.current;
    if (from === value) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      current.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 460);
      const v = p === 1 ? value : from + (value - from) * (1 - Math.pow(1 - p, 3));
      current.current = v;
      setShown(v);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  // Mid-flight values snap to half hours so the digits don't flicker.
  return <>{format(shown === value ? value : Math.round(shown / 30) * 30)}</>;
}

// ─── Who's in the store through a day ───────────────────────

export interface Axis {
  from: number;
  to: number;
}

export function weekAxis(days: Array<{ hours: Hours | null; cover: { from: number | null; to: number | null } }>): Axis {
  let from = 10 * 60;
  let to = 17 * 60;
  for (const { hours, cover } of days) {
    if (hours) {
      from = Math.min(from, hours.open);
      to = Math.max(to, hours.close);
    }
    if (cover.from !== null) from = Math.min(from, cover.from);
    if (cover.to !== null) to = Math.max(to, cover.to);
  }
  return { from: Math.floor(from / 60) * 60, to: Math.ceil(to / 60) * 60 };
}

/**
 * Who's in the store, half an hour at a time: each bar's height is how many
 * people are on, open hours sit on a darker baseline, and a gap in open hours
 * is a red bar. Heights ease when shifts change.
 */
export function CoverageBars({
  segments,
  gaps,
  hours,
  axis,
  label,
  now,
}: {
  segments: Array<{ from: number; to: number; count: number }>;
  gaps: Array<{ from: number; to: number }>;
  hours: Hours | null;
  axis: Axis;
  label: string;
  now: number | null;
}) {
  const span = axis.to - axis.from || 1;
  const pct = (m: number) => `${(((Math.min(Math.max(m, axis.from), axis.to) - axis.from) / span) * 100).toFixed(3)}%`;
  const bins: Array<{ t: number; count: number; open: boolean; gap: boolean }> = [];
  for (let t = axis.from; t < axis.to; t += 30) {
    const mid = t + 15;
    bins.push({
      t,
      count: segments.find((s) => s.from <= mid && mid < s.to)?.count ?? 0,
      open: Boolean(hours && mid >= hours.open && mid < hours.close),
      gap: gaps.some((g) => g.from <= mid && mid < g.to),
    });
  }
  const spoken = segments
    .filter((s) => s.count > 0)
    .map((s) => `${s.count} ${s.count === 1 ? 'person' : 'people'} ${clockTiny(s.from)} to ${clockTiny(s.to)}`)
    .join(', ');
  const gapText = gaps.map((g) => `nobody ${clockTiny(g.from)} to ${clockTiny(g.to)}`).join(', ');
  return (
    <div
      class="cov"
      role="img"
      aria-label={`${label}: ${hours ? `open ${clockTiny(hours.open)} to ${clockTiny(hours.close)}` : 'closed'}. ${spoken || 'Nobody scheduled'}${gapText ? `. ${gapText}` : ''}.`}
    >
      <div class="cov-bars">
        {bins.map((b) => (
          <span
            key={b.t}
            class={`cov-bin${b.open ? ' is-open' : ''}${b.gap ? ' is-gap' : ''}${b.count === 0 ? ' is-none' : ''}`}
            style={{ '--h': String(Math.min(b.count, 3) / 3) } as Record<string, string>}
          />
        ))}
        {now !== null && now > axis.from && now < axis.to && <span class="cov-now" style={{ left: pct(now) }} />}
      </div>
      <div class="cov-base">{hours && <span style={{ left: pct(hours.open), width: `calc(${pct(hours.close)} - ${pct(hours.open)})` }} />}</div>
      {hours && (
        <div class="cov-axis" aria-hidden="true">
          <span style={{ left: pct(hours.open) }}>{clockTiny(hours.open)}</span>
          <span style={{ left: pct(hours.close) }}>{clockTiny(hours.close)}</span>
        </div>
      )}
    </div>
  );
}

// ─── Icons (inline, so the admin's CSP needs nothing more) ──

export function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    left: 'M12.5 4.5L7 10l5.5 5.5',
    right: 'M7.5 4.5L13 10l-5.5 5.5',
    copy: 'M7 7V4.8c0-.4.4-.8.8-.8h7.4c.4 0 .8.4.8.8v7.4c0 .4-.4.8-.8.8H13M4.8 7h7.4c.4 0 .8.4.8.8v7.4c0 .4-.4.8-.8.8H4.8c-.4 0-.8-.4-.8-.8V7.8c0-.4.4-.8.8-.8z',
    plane: 'M3 11.5l14-6-4.5 11-2.5-4.5L3 11.5zM10 12l2.5-2.5',
    print: 'M6 8V3.5h8V8M6 14H4.5c-.6 0-1-.4-1-1V9c0-.6.4-1 1-1h11c.6 0 1 .4 1 1v4c0 .6-.4 1-1 1H14M6 11.5h8v5H6z',
    text: 'M4 5.5h12M4 9.5h12M4 13.5h7',
    calendar: 'M4.5 6h11v10h-11zM4.5 9h11M7.5 4v3M12.5 4v3',
    people: 'M8 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3.5 16c.3-2.6 2.2-4.5 4.5-4.5s4.2 1.9 4.5 4.5M13 4.3a2.5 2.5 0 010 4.4M14.5 11.8c1.3.6 2.2 2.1 2.4 4.2',
    keyboard: 'M3 6h14v9H3zM6 9h.01M9 9h.01M12 9h.01M14.5 9h.01M6.5 12h7',
    more: 'M5 10h.01M10 10h.01M15 10h.01',
    check: 'M4.5 10.5l3.5 3.5 7.5-8',
    alert: 'M10 7v4M10 14h.01M8.6 3.6L2.8 14a1.6 1.6 0 001.4 2.4h11.6a1.6 1.6 0 001.4-2.4L11.4 3.6a1.6 1.6 0 00-2.8 0z',
    undo: 'M7.5 6.5L4 10l3.5 3.5M4.5 10h7a4 4 0 010 8h-2',
    close: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
    up: 'M5.5 12.5L10 8l4.5 4.5',
    down: 'M5.5 7.5L10 12l4.5-4.5',
    send: 'M4 10h11M11 5.5l4.5 4.5-4.5 4.5',
    link: 'M8.5 11.5l3-3M9.5 6l1.4-1.4a3 3 0 014.3 4.3L13.8 10.3M10.5 14l-1.4 1.4a3 3 0 01-4.3-4.3L6.2 9.7',
    trash: 'M4.5 6h11M8 6V4.5h4V6M6 6l.7 10h6.6L14 6',
    plus: 'M10 4.5v11M4.5 10h11',
    note: 'M5 4h10v12H5zM7.5 8h5M7.5 11h5',
  };
  return (
    <svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d={paths[name] ?? ''} />
    </svg>
  );
}
