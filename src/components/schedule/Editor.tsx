/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  clock,
  describeParse,
  hoursLabel,
  OVERTIME_MINUTES,
  parseCell,
  parsedToCell,
  shiftMinutes,
  TIME_OFF_LABELS,
} from '@/lib/schedule/core.mjs';
import type { Cell, Hours } from './model';

export type Move = 'down' | 'up' | 'right' | 'left' | 'none';

export interface EditorContext {
  name: string;
  /** Cells being set at once; more than one when a range is selected. */
  count: number;
  replacesOff: Cell['off'];
  closedNote: string | null;
  /** This person's scheduled minutes this week without the cell being edited. */
  otherMinutes: number | null;
  overtimeEligible: boolean;
}

export interface EditorProps {
  title: string;
  initial: string;
  selectAll: boolean;
  hours: Hours | null;
  picks: Array<{ start: number; end: number }>;
  context: EditorContext;
  placement: { top: number; left: number; above: boolean } | null;
  onCommit: (cell: Cell, move: Move) => void;
  onCancel: () => void;
  /** Keys typed while the editor was opening, before it could take focus. */
  typeAhead: { current: { text: string; key: { key: string; shift: boolean } | null } };
}

export function Editor({ title, initial, selectAll, hours, picks, context, placement, onCommit, onCancel, typeAhead }: EditorProps) {
  const [text, setText] = useState(initial);
  const [away, setAway] = useState<boolean | null>(null);
  const [shake, setShake] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const parsed = parseCell(text, hours);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    const early = typeAhead.current;
    typeAhead.current = { text: '', key: null };
    // Typing over a selected value replaces it, as in a spreadsheet.
    const full = early.text ? (selectAll ? early.text : initial + early.text) : initial;
    if (full !== initial) {
      el.value = full;
      setText(full);
    }
    el.focus({ preventScroll: true });
    if (selectAll && !early.text) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
    if (early.key) {
      const { key, shift } = early.key;
      if (key === 'Escape') onCancel();
      else commitText(full, key === 'Enter' ? (shift ? 'up' : 'down') : shift ? 'left' : 'right');
    }
  }, []);

  useEffect(() => {
    if (!shake) return;
    const t = setTimeout(() => setShake(0), 400);
    return () => clearTimeout(t);
  }, [shake]);

  const awayNow = parsed.type === 'shift' ? (away ?? parsed.away) : false;

  function commitText(value: string, move: Move) {
    const reading = parseCell(value, hours);
    const cell = parsedToCell(reading);
    if (!cell) {
      setShake((n) => n + 1);
      input.current?.focus();
      return;
    }
    if (cell.shift && reading.type === 'shift') cell.shift.away = away ?? reading.away;
    onCommit(cell, move);
  }

  function commit(move: Move) {
    commitText(input.current?.value ?? text, move);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(event.shiftKey ? 'up' : 'down');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      commit(event.shiftKey ? 'left' : 'right');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }

  const warnings: string[] = [];
  if (context.count > 1) warnings.push(`Sets ${context.count} cells at once`);
  if (parsed.type === 'shift' && context.replacesOff) {
    const kind = context.replacesOff.kind;
    const what = kind === 'off' ? 'day off' : kind === 'pto' ? 'PTO' : TIME_OFF_LABELS[kind].toLowerCase();
    warnings.push(`Replaces ${context.name}’s ${what}`);
  }
  if (parsed.type === 'shift' && context.closedNote !== null && !awayNow) {
    warnings.push(`The store is closed this day${context.closedNote ? ` (${context.closedNote})` : ''}`);
  }
  if (parsed.type === 'shift' && context.overtimeEligible && context.otherMinutes !== null && context.count === 1) {
    const total = context.otherMinutes + shiftMinutes(parsed);
    if (total > OVERTIME_MINUTES) {
      warnings.push(`Puts ${context.name} at ${hoursLabel(total)} hours, ${hoursLabel(total - OVERTIME_MINUTES)} overtime`);
    }
  }

  const tone = parsed.type === 'error' ? 'bad' : parsed.type === 'clear' ? 'muted' : 'good';
  const style = placement ? { top: `${placement.top}px`, left: `${placement.left}px` } : undefined;

  return (
    <div
      class={`editor${placement ? '' : ' editor--sheet'}${placement?.above ? ' editor--above' : ''}${shake ? ' editor--shake' : ''}`}
      style={style}
      role="dialog"
      aria-label={`Edit ${title}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div class="editor-head">
        <span class="editor-title" id="editor-title">{title}</span>
        <button type="button" class="icon-btn editor-close" aria-label="Cancel" onClick={onCancel}>
          <svg class="icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
          </svg>
        </button>
      </div>
      <input
        ref={input}
        class="editor-input"
        value={text}
        onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
        placeholder="9-5, 10:30-6, off, pto, Mart 9-5"
        aria-labelledby="editor-title" aria-describedby="editor-preview"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        enterKeyHint="done"
      />
      <p id="editor-preview" class={`editor-preview editor-preview--${tone}`} aria-live="polite">
        {describeParse(parsed)}
      </p>
      {warnings.length > 0 && (
        <ul class="editor-warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {parsed.type === 'shift' && (
        <label class="editor-away">
          <input type="checkbox" checked={awayNow} onChange={(e) => setAway((e.currentTarget as HTMLInputElement).checked)} />
          Away from the store <span>(market, warehouse)</span>
        </label>
      )}
      <div class="editor-picks" role="group" aria-label="Quick picks">
        {picks.map((p) => (
          <button
            key={`${p.start}-${p.end}`}
            type="button"
            class="pick"
            onClick={() => onCommit({ shift: { start: p.start, end: p.end, label: '', away: false }, off: null }, 'none')}
          >
            {clock(p.start)}–{clock(p.end)}
            <span>{hoursLabel(p.end - p.start)}h</span>
          </button>
        ))}
        <button type="button" class="pick pick--off" onClick={() => onCommit({ shift: null, off: { kind: 'off', note: '' } }, 'none')}>
          Off
        </button>
        <button type="button" class="pick pick--off" onClick={() => onCommit({ shift: null, off: { kind: 'pto', note: '' } }, 'none')}>
          PTO
        </button>
        <button type="button" class="pick pick--clear" onClick={() => onCommit({ shift: null, off: null }, 'none')}>
          Clear
        </button>
      </div>
      <div class="editor-foot">
        <span class="editor-keys" aria-hidden="true">
          <kbd>Enter</kbd> save <kbd>Tab</kbd> next <kbd>Esc</kbd> cancel
        </span>
        <button type="button" class="btn btn-primary btn-small" onClick={() => commit('none')}>
          Save
        </button>
      </div>
    </div>
  );
}
