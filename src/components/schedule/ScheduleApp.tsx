/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  cellKey,
  cellToInput,
  hoursOn,
  clockTiny,
  copyWeekChanges,
  dateRangeLabel,
  DAY_SHORT,
  dayLabel,
  dayOfMonth,
  emptyCell,
  hoursLabel,
  isEmptyCell,
  OVERTIME_MINUTES,
  parseCell,
  parsedToCell,
  sameCell,
  shiftMinutes,
  shiftShort,
  TIME_OFF_LABELS,
  weekDates,
  weekRangeLabel,
  weekText,
} from '@/lib/schedule/core.mjs';
import { addDays } from '@/lib/time-clock/hours.mjs';
import { Editor, type Move } from './Editor';
import {
  cellAt,
  derive,
  fetchWeek,
  firstName,
  listNames,
  formatPublished,
  initials,
  postSchedule,
  storeNowMinutes,
  type ApiResult,
  type Cell,
  type Stamp,
  type WeekState,
} from './model';
import { CalendarPanel, DayPanel, PeoplePanel, PublishPanel, ShortcutsPanel, TimeOffPanel, type TimeOffInput } from './Panels';
import { AnimatedNumber, CellContent, CoverageBars, describeCell, Icon, OffBand, weekAxis } from './parts';
import { PublishTexts, TextsPanel } from './Texts';
import { formatUsPhone } from '@/lib/schedule/texts.mjs';

type Pos = { row: number; col: number };
type Selection = { anchor: Pos; focus: Pos };
type Change = { staffId: string; date: string; before: Cell; after: Cell };
type Action = { label: string; changes: Change[] };
type Item = { staffId: string; date: string; after: Cell; before?: Cell };
type Panel =
  | { kind: 'timeoff'; staffId: string; from: string }
  | { kind: 'people' }
  | { kind: 'calendar' }
  | { kind: 'texts' }
  | { kind: 'publish' }
  | { kind: 'keys' }
  | { kind: 'day'; date: string }
  | null;
type Toast = { id: number; text: string; tone: 'info' | 'error'; undo: boolean } | null;
type Editing = { pos: Pos; initial: string; selectAll: boolean; keys: string[]; sheet: boolean } | null;
type DragView = { x: number; y: number; target: Pos | null; copy: boolean; from: Pos; cell: Cell } | null;

export interface AppProps {
  initial: WeekState;
  feedOrigin: string;
}

const EMPTY_STAMP: Stamp = { s: '', o: '' };
const NARROW = '(max-width: 759px)';

const rectOf = (sel: Selection) => ({
  r0: Math.min(sel.anchor.row, sel.focus.row),
  r1: Math.max(sel.anchor.row, sel.focus.row),
  c0: Math.min(sel.anchor.col, sel.focus.col),
  c1: Math.max(sel.anchor.col, sel.focus.col),
});

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function ScheduleApp({ initial, feedOrigin }: AppProps) {
  const [state, setState] = useState<WeekState>(initial);
  const [overlay, setOverlay] = useState<Map<string, { cell: Cell; seq: number }>>(() => new Map());
  const [sel, setSel] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number; above: boolean } | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(0);
  const [loading, setLoading] = useState(false);
  const [navDir, setNavDir] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [drag, setDrag] = useState<DragView>(null);
  const [nowMinutes, setNowMinutes] = useState(initial.nowMinutes);
  const [announcement, setAnnouncement] = useState('');
  const [historyTick, setHistoryTick] = useState(0);
  const [noteDraft, setNoteDraft] = useState(initial.weekNote);
  const [noteSaved, setNoteSaved] = useState<'idle' | 'saving' | 'saved'>('idle');
  // Motion: cells that just arrived (copy week), just saved, or just emptied.
  const [arriving, setArriving] = useState<Map<string, number>>(() => new Map());
  const [flash, setFlash] = useState<Set<string>>(() => new Set());
  const [leaving, setLeaving] = useState<Map<string, Cell>>(() => new Map());
  const [fadingDots, setFadingDots] = useState<Set<string>>(() => new Set());
  const [burst, setBurst] = useState(0);
  const [toastPaused, setToastPaused] = useState(false);
  const [dayDir, setDayDir] = useState(0);
  // Phones show one day: today if it's this week, else the first day anyone works or the store opens.
  const [mobileDay, setMobileDay] = useState(() => {
    const i = Math.round((Date.parse(`${initial.today}T00:00:00Z`) - Date.parse(`${initial.weekStart}T00:00:00Z`)) / 86400000);
    if (i >= 0 && i <= 6) return i;
    const first = weekDates(initial.weekStart).findIndex(
      (date) =>
        initial.cells.some((c) => c.date === date && c.shift) ||
        hoursOn(date, initial.storeHours, initial.days.find((d) => d.date === date) ?? null),
    );
    return Math.max(0, first);
  });

  const weekRef = useRef(initial.weekStart);
  const serverRef = useRef(initial);
  const stampsRef = useRef<Map<string, Stamp>>(new Map());
  const cacheRef = useRef(new Map<string, WeekState>([[initial.weekStart, initial]]));
  const historyRef = useRef(new Map<string, { undo: Action[]; redo: Action[] }>());
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const seqRef = useRef(0);
  const toastIdRef = useRef(0);
  const clipRef = useRef<{ text: string; cells: Cell[][] } | null>(null);
  const selRef = useRef<Selection | null>(null);
  const editingRef = useRef<Editing>(null);
  const typeAheadRef = useRef<{ text: string; key: { key: string; shift: boolean } | null }>({ text: '', key: null });
  const boardRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const flipRef = useRef<{ key: string; rect: DOMRect } | null>(null);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pos: Pos;
    x0: number;
    y0: number;
    touch: boolean;
    timer: number | null;
    active: boolean;
    canDrag: boolean;
    cell: Cell;
  } | null>(null);

  const readOnly = state.readOnly;
  const overlayCells = useMemo(() => new Map([...overlay].map(([k, v]) => [k, v.cell])), [overlay]);
  const derived = useMemo(() => derive(state, overlayCells), [state, overlayCells]);
  const rows = state.people;
  const dates = derived.dates;
  // Undo lives in a ref; historyTick re-reads it after each change.
  const weekHistory = useMemo(() => historyRef.current.get(state.weekStart) ?? { undo: [], redo: [] }, [state.weekStart, historyTick]);

  // ─── Server state ─────────────────────────────────────────

  /** The revs the server last gave for each cell of a week, for the next write to name. */
  function rememberStamps(week: WeekState) {
    const weekDays = new Set(weekDates(week.weekStart));
    for (const key of [...stampsRef.current.keys()]) if (weekDays.has(key.split('|')[1])) stampsRef.current.delete(key);
    for (const c of week.cells) stampsRef.current.set(cellKey(c.staffId, c.date), c.stamp);
  }

  if (stampsRef.current.size === 0 && initial.cells.length) rememberStamps(initial);

  function accept(next: WeekState) {
    if (!next.readOnly) rememberStamps(next);
    cacheRef.current.set(next.weekStart, next);
    if (next.weekStart !== weekRef.current) return;
    serverRef.current = next;
    setState(next);
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queueRef.current.then(job, job);
    queueRef.current = run.catch(() => undefined);
    return run;
  }

  function historyFor(week: string) {
    let h = historyRef.current.get(week);
    if (!h) {
      h = { undo: [], redo: [] };
      historyRef.current.set(week, h);
    }
    return h;
  }

  function say(text: string) {
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(text));
  }

  function showToast(text: string, tone: 'info' | 'error' = 'info', undo = false) {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, text, tone, undo });
  }

  // Menus and the checks list close on a click elsewhere or Escape.
  useEffect(() => {
    if (!moreOpen && !alertsOpen) return;
    const close = () => {
      setMoreOpen(false);
      setAlertsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    addEventListener('pointerdown', close);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('pointerdown', close);
      removeEventListener('keydown', onKey);
    };
  }, [moreOpen, alertsOpen]);

  const toastMs = toast?.tone === 'error' ? 9000 : 6000;
  useEffect(() => {
    if (!toast || toastPaused) return;
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toastMs);
    return () => clearTimeout(t);
  }, [toast, toastPaused]);

  /** Adds keys to a short-lived set, for an animation that plays once. */
  function briefly<T>(set: (fn: (prev: T) => T) => void, add: (prev: T) => T, remove: (prev: T) => T, ms: number) {
    set(add);
    setTimeout(() => set(remove), ms);
  }

  function flashKeys(keys: string[]) {
    briefly<Set<string>>(
      setFlash,
      (prev) => new Set([...prev, ...keys]),
      (prev) => new Set([...prev].filter((k) => !keys.includes(k))),
      900,
    );
  }

  // ─── Saving cells ────────────────────────────────────────

  function commit(
    items: Item[],
    opts: { label: string; reason: string; toast?: boolean; record?: 'new' | 'undo' | 'redo'; source?: Action },
  ) {
    if (readOnly || items.length === 0) return;
    const week = weekRef.current;
    const record = opts.record ?? 'new';
    const seqs = new Map<string, number>();
    // What's being emptied fades out rather than vanishing.
    const gone = new Map<string, Cell>();
    for (const item of items) {
      const now = cellAt(latest.current.derived, item.staffId, item.date);
      if (isEmptyCell(item.after) && !isEmptyCell(now)) gone.set(cellKey(item.staffId, item.date), now);
    }
    if (gone.size) {
      briefly<Map<string, Cell>>(
        setLeaving,
        (prev) => new Map([...prev, ...gone]),
        (prev) => new Map([...prev].filter(([k]) => !gone.has(k))),
        320,
      );
    }
    setOverlay((prev) => {
      const next = new Map(prev);
      for (const item of items) {
        seqRef.current += 1;
        const key = cellKey(item.staffId, item.date);
        seqs.set(key, seqRef.current);
        next.set(key, { cell: item.after, seq: seqRef.current });
      }
      return next;
    });
    setBusy((n) => n + 1);

    enqueue(async () => {
      const serverCells = new Map(serverRef.current.cells.map((c) => [cellKey(c.staffId, c.date), c]));
      const changes = items
        .map((item) => {
          const key = cellKey(item.staffId, item.date);
          const row = serverCells.get(key);
          const before = item.before ?? (row ? { shift: row.shift, off: row.off } : emptyCell());
          return { ...item, before, expect: stampsRef.current.get(key) ?? EMPTY_STAMP };
        })
        .filter((c) => !sameCell(c.before, c.after));

      let result: ApiResult | null = null;
      if (changes.length) {
        result = await postSchedule({
          action: 'apply',
          week,
          reason: opts.reason,
          changes: changes.map(({ staffId, date, after, expect }) => ({ staffId, date, value: after, expect })),
        });
        for (const [key, stamp] of Object.entries(result.stamps ?? {})) stampsRef.current.set(key, stamp);
        if (result.state) accept(result.state);
      }

      setOverlay((prev) => {
        const next = new Map(prev);
        for (const [key, seq] of seqs) if (next.get(key)?.seq === seq) next.delete(key);
        return next;
      });
      setBusy((n) => n - 1);
      if (!result) return;
      if (!result.ok) {
        showToast(result.error ?? 'That didn’t save.', 'error');
        return;
      }

      const h = historyFor(week);
      if (record === 'undo' && opts.source) h.redo.push(opts.source);
      else if (record === 'redo' && opts.source) h.undo.push(opts.source);
      else {
        h.undo.push({ label: opts.label, changes: changes.map(({ staffId, date, before, after }) => ({ staffId, date, before, after })) });
        if (h.undo.length > 100) h.undo.shift();
        h.redo = [];
      }
      setHistoryTick((n) => n + 1);
      if (opts.reason !== 'copy-week') flashKeys(changes.filter((c) => !isEmptyCell(c.after)).map((c) => cellKey(c.staffId, c.date)));
      if (opts.toast) showToast(opts.label, 'info', record !== 'undo');
      say(opts.label);
    });
  }

  function undo() {
    const h = historyFor(weekRef.current);
    const action = h.undo.pop();
    if (!action) {
      showToast('Nothing to undo on this week.');
      return;
    }
    setHistoryTick((n) => n + 1);
    commit(
      action.changes.map((c) => ({ staffId: c.staffId, date: c.date, before: c.after, after: c.before })),
      { label: `Undid: ${lowerFirst(action.label)}`, reason: 'undo', record: 'undo', source: action, toast: true },
    );
  }

  function redo() {
    const h = historyFor(weekRef.current);
    const action = h.redo.pop();
    if (!action) {
      showToast('Nothing to redo.');
      return;
    }
    setHistoryTick((n) => n + 1);
    commit(
      action.changes.map((c) => ({ staffId: c.staffId, date: c.date, before: c.before, after: c.after })),
      { label: `Redid: ${lowerFirst(action.label)}`, reason: 'redo', record: 'redo', source: action, toast: true },
    );
  }

  /** For actions that aren't cell edits: run in order, take the fresh week, return any error. */
  async function send(body: Record<string, unknown>): Promise<ApiResult> {
    setBusy((n) => n + 1);
    const result = await enqueue(() => postSchedule({ week: weekRef.current, ...body }));
    setBusy((n) => n - 1);
    for (const [key, stamp] of Object.entries(result.stamps ?? {})) stampsRef.current.set(key, stamp);
    if (result.state) accept(result.state);
    return result;
  }

  // ─── Weeks ───────────────────────────────────────────────

  async function goToWeek(week: string, dir: number, push = true) {
    if (week === weekRef.current) return;
    setEditor(null);
    setMoreOpen(false);
    weekRef.current = week;
    setNavDir(dir);
    if (push) window.history.pushState({ week }, '', `?week=${week}`);
    const cached = cacheRef.current.get(week);
    if (cached) {
      serverRef.current = cached;
      setState(cached);
    } else {
      setLoading(true);
    }
    const fresh = await fetchWeek(week);
    if (weekRef.current === week) setLoading(false);
    if (fresh) accept(fresh);
    else if (!cached) showToast('Couldn’t load that week. Check the connection.', 'error');
  }

  useEffect(() => {
    setNoteDraft(state.weekNote);
    setNoteSaved('idle');
  }, [state.weekStart, state.weekNote]);

  // Load the weeks either side while idle, so moving between them is instant.
  useEffect(() => {
    const t = setTimeout(() => {
      for (const week of [addDays(state.weekStart, -7), addDays(state.weekStart, 7)]) {
        if (cacheRef.current.has(week)) continue;
        fetchWeek(week).then((w) => {
          if (w && !cacheRef.current.has(week)) {
            cacheRef.current.set(week, w);
            if (!w.readOnly) rememberStamps(w);
          }
        });
      }
    }, 400);
    return () => clearTimeout(t);
  }, [state.weekStart]);

  useEffect(() => {
    const onPop = () => {
      const week = new URLSearchParams(location.search).get('week');
      if (week && /^\d{4}-\d{2}-\d{2}$/.test(week)) goToWeek(week, week < weekRef.current ? -1 : 1, false);
    };
    addEventListener('popstate', onPop);
    const tick = setInterval(() => setNowMinutes(storeNowMinutes()), 60000);
    setNowMinutes(storeNowMinutes());
    return () => {
      removeEventListener('popstate', onPop);
      clearInterval(tick);
    };
  }, []);

  // ─── Selection and editing ───────────────────────────────

  const posKey = (pos: Pos) => cellKey(rows[pos.row].id, dates[pos.col]);

  function keysIn(selection: Selection): string[] {
    const r = rectOf(selection);
    const out: string[] = [];
    for (let row = r.r0; row <= r.r1; row++) for (let col = r.c0; col <= r.c1; col++) out.push(posKey({ row, col }));
    return out;
  }

  /** Moves keyboard focus to a cell now, not on the next frame, so a fast typist's next key lands there. */
  function focusCell(pos: Pos) {
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-pos="${pos.row}:${pos.col}"]`);
    el?.focus({ preventScroll: false });
  }

  // Keys can arrive faster than the screen redraws. These refs change the
  // moment a key is handled, so the next key always sees where things are.
  function setSelection(next: Selection | null) {
    selRef.current = next;
    setSel(next);
  }

  function select(pos: Pos, extend = false) {
    const cur = selRef.current;
    setSelection(extend && cur ? { anchor: cur.anchor, focus: pos } : { anchor: pos, focus: pos });
  }

  function moveBy(dRow: number, dCol: number, extend: boolean) {
    if (!rows.length) return;
    const from = selRef.current?.focus ?? { row: 0, col: 0 };
    const pos = { row: clamp(from.row + dRow, 0, rows.length - 1), col: clamp(from.col + dCol, 0, 6) };
    select(pos, extend);
    focusCell(pos);
  }

  function setEditor(next: Editing) {
    editingRef.current = next;
    typeAheadRef.current = { text: '', key: null };
    setEditing(next);
  }

  function openEditor(pos: Pos, typed: string | null, sheet = false) {
    if (readOnly || !rows[pos.row]) return;
    const person = rows[pos.row];
    const cell = cellAt(derived, person.id, dates[pos.col]);
    const current = selRef.current;
    const multi = current && keysIn(current).length > 1 && keysIn(current).includes(posKey(pos));
    setEditor({
      pos,
      initial: typed ?? cellToInput(cell),
      selectAll: typed === null,
      keys: multi && current ? keysIn(current) : [posKey(pos)],
      sheet: sheet || matchMedia(NARROW).matches,
    });
  }

  useLayoutEffect(() => {
    if (!editing || editing.sheet) {
      setPlacement(null);
      return;
    }
    const board = boardRef.current;
    const cell = gridRef.current?.querySelector<HTMLElement>(`[data-pos="${editing.pos.row}:${editing.pos.col}"]`);
    if (!board || !cell) return;
    const b = board.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    const width = 340;
    const left = clamp(c.left - b.left + c.width / 2 - width / 2, 4, Math.max(4, b.width - width - 4));
    const below = innerHeight - c.bottom;
    const above = below < 360 && c.top > 380;
    setPlacement({ left, top: above ? c.top - b.top - 8 : c.bottom - b.top + 8, above });
  }, [editing]);

  function closeEditor(move: Move) {
    const at = editingRef.current?.pos;
    if (!at) {
      setEditor(null);
      return;
    }
    const delta: Record<Move, [number, number]> = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1], none: [0, 0] };
    const [dr, dc] = delta[move];
    const pos = { row: clamp(at.row + dr, 0, rows.length - 1), col: clamp(at.col + dc, 0, 6) };
    const current = selRef.current;
    if (move !== 'none' || (current && keysIn(current).length === 1)) select(pos);
    // Focus the next cell before the editor goes, so no keystroke falls to the page.
    if (!matchMedia(NARROW).matches) focusCell(pos);
    setEditor(null);
  }

  function labelFor(staffId: string, date: string) {
    const person = rows.find((p) => p.id === staffId);
    return `${person ? firstName(person.name) : 'Someone'} ${DAY_SHORT[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${dayOfMonth(date)}`;
  }

  function onEditorCommit(cell: Cell, move: Move) {
    const open = editingRef.current;
    if (!open) return;
    const items = open.keys.map((key) => {
      const [staffId, date] = key.split('|');
      return { staffId, date, after: cell };
    });
    const first = items[0];
    const before = cellAt(derived, first.staffId, first.date);
    const what = cell.shift ? shiftShort(cell.shift) : cell.off ? TIME_OFF_LABELS[cell.off.kind] : 'cleared';
    const cleared = !cell.shift && !cell.off && !isEmptyCell(before);
    const replacedOff = Boolean(cell.shift && before.off && !before.shift);
    const label =
      items.length > 1
        ? `Set ${items.length} cells to ${what}`
        : cleared
          ? `Cleared ${labelFor(first.staffId, first.date)}`
          : replacedOff
            ? `${labelFor(first.staffId, first.date)} is now ${what} instead of time off`
            : `${labelFor(first.staffId, first.date)}: ${what}`;
    commit(items, { label, reason: items.length > 1 ? 'paste' : 'type', toast: items.length > 1 || cleared || replacedOff });
    closeEditor(move);
  }

  function clearSelection() {
    const current = selRef.current;
    if (!current || readOnly) return;
    const items = keysIn(current)
      .map((key) => {
        const [staffId, date] = key.split('|');
        return { staffId, date, after: emptyCell() };
      })
      .filter((i) => !isEmptyCell(cellAt(derived, i.staffId, i.date)));
    if (!items.length) return;
    commit(items, {
      label: items.length === 1 ? `Cleared ${labelFor(items[0].staffId, items[0].date)}` : `Cleared ${items.length} cells`,
      reason: 'clear',
      toast: true,
    });
  }

  // ─── Keyboard ────────────────────────────────────────────

  function onGridKeyDown(e: KeyboardEvent) {
    if (panel) return;
    const opening = editingRef.current;
    if (opening) {
      // The editor is on its way but doesn't have focus yet: keep what's typed for it.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        typeAheadRef.current.text += e.key;
      } else if (['Enter', 'Tab', 'Escape'].includes(e.key)) {
        e.preventDefault();
        typeAheadRef.current.key = { key: e.key, shift: e.shiftKey };
      }
      return;
    }
    const sel = selRef.current;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (mod || e.altKey) return;
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        return moveBy(-1, 0, e.shiftKey);
      case 'ArrowDown':
        e.preventDefault();
        return moveBy(1, 0, e.shiftKey);
      case 'ArrowLeft':
        e.preventDefault();
        return moveBy(0, -1, e.shiftKey);
      case 'ArrowRight':
        e.preventDefault();
        return moveBy(0, 1, e.shiftKey);
      case 'Home':
        e.preventDefault();
        return moveBy(0, -7, e.shiftKey);
      case 'End':
        e.preventDefault();
        return moveBy(0, 7, e.shiftKey);
      case 'Enter':
      case 'F2':
        if (sel) {
          e.preventDefault();
          openEditor(sel.focus, null);
        }
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        return clearSelection();
      case 'Escape':
        if (sel) setSelection({ anchor: sel.focus, focus: sel.focus });
        return;
      default:
        if (!sel || e.key.length !== 1 || e.key === ' ' || readOnly) return;
        if (e.key === '?') {
          e.preventDefault();
          setPanel({ kind: 'keys' });
          return;
        }
        if (e.key === '[' || e.key === ']') return;
        e.preventDefault();
        openEditor(sel.focus, e.key);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (editing || panel || e.metaKey || e.ctrlKey || e.altKey) return;
      if (target && (target.closest('input, textarea, select, [contenteditable]') || target.closest('[role="grid"]'))) {
        if (!(target.closest('[role="grid"]') && (e.key === '[' || e.key === ']'))) return;
      }
      if (e.key === '[') goToWeek(addDays(weekRef.current, -7), -1);
      else if (e.key === ']') goToWeek(addDays(weekRef.current, 7), 1);
      else if (e.key === '?') setPanel({ kind: 'keys' });
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [editing, panel]);

  // ─── Clipboard ───────────────────────────────────────────

  function onCopy(e: ClipboardEvent, cut = false) {
    if (editing || !sel || panel) return;
    const r = rectOf(sel);
    const cells: Cell[][] = [];
    for (let row = r.r0; row <= r.r1; row++) {
      const line: Cell[] = [];
      for (let col = r.c0; col <= r.c1; col++) line.push(cellAt(derived, rows[row].id, dates[col]));
      cells.push(line);
    }
    const text = cells.map((line) => line.map((c) => cellToInput(c)).join('\t')).join('\n');
    e.clipboardData?.setData('text/plain', text);
    e.preventDefault();
    clipRef.current = { text, cells };
    const n = cells.length * cells[0].length;
    if (cut) clearSelection();
    else say(`Copied ${plural(n, 'cell')}`);
  }

  function onPaste(e: ClipboardEvent) {
    if (editing || !sel || panel || readOnly) return;
    const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r/g, '').replace(/\n+$/, '');
    if (!text) return;
    e.preventDefault();
    const r = rectOf(sel);
    const items: Item[] = [];
    let skipped = 0;

    const own = clipRef.current?.text === text ? clipRef.current.cells : null;
    let lines: Array<Array<string | Cell>> = own ?? text.split('\n').map((line) => line.split('\t'));

    // A block copied from the Google Sheet with names down the side: place each
    // row on that person, whatever order they're in.
    const norm = (s: string) => s.replace(/[*\s]/g, '').toLowerCase();
    const byName = new Map(rows.map((p, i) => [norm(firstName(p.name)), i]));
    const named = !own && lines.some((line) => typeof line[0] === 'string' && byName.has(norm(line[0] as string)));

    const place = (row: number, col: number, value: string | Cell) => {
      if (row < 0 || row >= rows.length || col < 0 || col > 6) return;
      let cell: Cell | null;
      if (typeof value === 'string') {
        cell = parsedToCell(parseCell(value, derived.hoursByDate.get(dates[col]) ?? null));
        if (!cell) {
          skipped += 1;
          return;
        }
      } else cell = value;
      items.push({ staffId: rows[row].id, date: dates[col], after: cell });
    };

    if (named) {
      for (const line of lines) {
        const row = byName.get(norm(String(line[0])));
        if (row === undefined) continue;
        line.slice(1, 8).forEach((value, i) => place(row, r.c0 + i, value));
      }
    } else if (lines.length === 1 && lines[0].length === 1) {
      for (let row = r.r0; row <= r.r1; row++) for (let col = r.c0; col <= r.c1; col++) place(row, col, lines[0][0]);
    } else {
      lines.forEach((line, i) => line.forEach((value, j) => place(r.r0 + i, r.c0 + j, value)));
    }

    if (!items.length) {
      showToast(skipped ? 'Nothing in the clipboard could be read as shifts.' : 'Nothing to paste here.', 'error');
      return;
    }
    commit(items, {
      label: `Pasted ${plural(items.length, 'cell')}${skipped ? ` (${skipped} couldn’t be read)` : ''}`,
      reason: 'paste',
      toast: true,
    });
  }

  // ─── Drag to move ────────────────────────────────────────

  const latest = useRef({ derived, rows, dates, readOnly });
  latest.current = { derived, rows, dates, readOnly };

  function posFromPoint(x: number, y: number): Pos | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-pos]');
    if (!el || !gridRef.current?.contains(el)) return null;
    const [row, col] = (el.dataset.pos ?? '').split(':').map(Number);
    return Number.isInteger(row) && Number.isInteger(col) ? { row, col } : null;
  }

  function onCellPointerDown(e: PointerEvent, pos: Pos) {
    if (e.button !== 0) return;
    if (editingRef.current) setEditor(null);
    const touch = e.pointerType !== 'mouse';
    if (!touch) {
      select(pos, e.shiftKey);
    }
    const cell = cellAt(derived, rows[pos.row].id, dates[pos.col]);
    const canDrag = !readOnly && !isEmptyCell(cell) && !e.shiftKey && !matchMedia(NARROW).matches;
    const d = { pos, x0: e.clientX, y0: e.clientY, touch, timer: null as number | null, active: false, canDrag, cell };
    dragRef.current = d;
    if (touch && canDrag) {
      d.timer = window.setTimeout(() => {
        if (dragRef.current === d) {
          d.active = true;
          navigator.vibrate?.(8);
          setDrag({ x: d.x0, y: d.y0, target: pos, copy: false, from: pos, cell });
        }
      }, 380);
    }

    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const dist = Math.hypot(ev.clientX - cur.x0, ev.clientY - cur.y0);
      if (!cur.active) {
        if (!cur.touch && cur.canDrag && dist > 6) {
          cur.active = true;
        } else if (cur.touch && dist > 10) {
          if (cur.timer) clearTimeout(cur.timer);
          dragRef.current = null;
          cleanup();
          return;
        } else return;
      }
      ev.preventDefault();
      setDrag({ x: ev.clientX, y: ev.clientY, target: posFromPoint(ev.clientX, ev.clientY), copy: ev.altKey, from: cur.pos, cell: cur.cell });
    };

    const onUp = (ev: PointerEvent) => {
      const cur = dragRef.current;
      cleanup();
      dragRef.current = null;
      if (!cur) return;
      if (cur.timer) clearTimeout(cur.timer);
      if (cur.active) {
        setDrag(null);
        const target = posFromPoint(ev.clientX, ev.clientY);
        if (target && (target.row !== cur.pos.row || target.col !== cur.pos.col)) drop(cur.pos, target, ev.altKey, cur.cell);
        return;
      }
      if (cur.touch) {
        select(cur.pos);
        openEditor(cur.pos, null, true);
      } else {
        focusCell(cur.pos);
      }
    };

    const onCancel = () => {
      const cur = dragRef.current;
      if (cur?.timer) clearTimeout(cur.timer);
      dragRef.current = null;
      setDrag(null);
      cleanup();
    };

    function cleanup() {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onCancel);
    }

    addEventListener('pointermove', onMove, { passive: false });
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onCancel);
  }

  function drop(from: Pos, to: Pos, copy: boolean, cell: Cell) {
    const { rows: r, dates: d } = latest.current;
    const source = { staffId: r[from.row].id, date: d[from.col] };
    const target = { staffId: r[to.row].id, date: d[to.col] };
    const what = cell.shift ? shiftShort(cell.shift) : cell.off ? TIME_OFF_LABELS[cell.off.kind] : '';
    const items: Item[] = [{ ...target, after: cell }];
    if (!copy) items.push({ ...source, after: emptyCell() });
    const ghost = document.querySelector('.drag-ghost .chip, .drag-ghost .off');
    flipRef.current = ghost ? { key: cellKey(target.staffId, target.date), rect: ghost.getBoundingClientRect() } : null;
    commit(items, {
      label: `${copy ? 'Copied' : 'Moved'} ${firstName(r[from.row].name)}’s ${what} to ${
        from.row === to.row ? `${DAY_SHORT[to.col]} ${dayOfMonth(target.date)}` : labelFor(target.staffId, target.date)
      }`,
      reason: copy ? 'copy' : 'move',
      toast: true,
    });
    select(to);
    focusCell(to);
  }

  // ─── Toolbar actions ─────────────────────────────────────

  async function copyLastWeek() {
    const source = addDays(state.weekStart, -7);
    const prev = cacheRef.current.get(source) ?? (await fetchWeek(source));
    if (!prev) {
      showToast('Couldn’t load last week. Check the connection.', 'error');
      return;
    }
    cacheRef.current.set(source, prev);
    const changes = copyWeekChanges({
      sourceCells: new Map(prev.cells.map((c) => [cellKey(c.staffId, c.date), c])),
      sourceWeekStart: source,
      targetWeekStart: state.weekStart,
      cells: derived.cells,
      peopleIds: rows.filter((p) => p.onSchedule).map((p) => p.id),
      closures: derived.closures,
    });
    if (!changes.length) {
      const had = prev.cells.some((c) => c.shift);
      showToast(had ? 'Every cell with a shift last week already has something this week.' : 'Last week has no shifts to copy.');
      return;
    }
    // The copied shifts fill in day by day.
    const order = [...changes].sort(
      (a: Change, b: Change) => a.date.localeCompare(b.date) || rows.findIndex((p) => p.id === a.staffId) - rows.findIndex((p) => p.id === b.staffId),
    );
    const cascade = new Map(order.map((c: Change, i: number) => [cellKey(c.staffId, c.date), i]));
    briefly<Map<string, number>>(setArriving, () => cascade, () => new Map(), 600 + cascade.size * 35);
    commit(
      changes.map((c: Change) => ({ staffId: c.staffId, date: c.date, after: c.after })),
      { label: `Copied ${plural(changes.length, 'shift')} from ${weekRangeLabel(source)}`, reason: 'copy-week', toast: true },
    );
  }

  async function copyAsText() {
    setMoreOpen(false);
    const text = weekText({
      weekStart: state.weekStart,
      people: rows.map((p) => ({ id: p.id, name: firstName(p.name) })),
      cells: derived.cells,
      hoursByDate: derived.hoursByDate,
      closures: derived.closures,
      weekNote: state.weekNote,
    });
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied the week as text, ready to paste into a group message.');
    } catch {
      showToast('Couldn’t reach the clipboard. Try again.', 'error');
    }
  }

  async function saveNote() {
    if (noteDraft.trim() === state.weekNote.trim()) return;
    setNoteSaved('saving');
    const result = await send({ action: 'weekNote', note: noteDraft });
    if (result.ok) setNoteSaved('saved');
    else {
      setNoteSaved('idle');
      showToast(result.error ?? 'The note didn’t save.', 'error');
    }
  }

  async function addTimeOff(input: TimeOffInput): Promise<string | null> {
    const result = await send({ action: 'timeOff', ...input });
    if (!result.ok) return result.error ?? 'That didn’t save.';
    const person = rows.find((p) => p.id === input.staffId);
    const label = `${person ? firstName(person.name) : 'Time off'}: ${TIME_OFF_LABELS[input.kind]} ${dateRangeLabel(input.from, input.to)}`;
    if (result.undo?.length) {
      const h = historyFor(weekRef.current);
      h.undo.push({ label, changes: result.undo });
      h.redo = [];
      setHistoryTick((n) => n + 1);
    }
    showToast(label, 'info', Boolean(result.undo?.length));
    return null;
  }

  async function clearTimeOff(range: { staffId: string; from: string; to: string }): Promise<string | null> {
    const result = await send({ action: 'timeOff', clear: true, ...range });
    if (!result.ok) return result.error ?? 'That didn’t save.';
    const person = rows.find((p) => p.id === range.staffId);
    const label = `Removed ${person ? firstName(person.name) : 'their'} time off, ${dateRangeLabel(range.from, range.to)}`;
    if (result.undo?.length) {
      const h = historyFor(weekRef.current);
      h.undo.push({ label, changes: result.undo });
      h.redo = [];
      setHistoryTick((n) => n + 1);
    }
    showToast(label, 'info', Boolean(result.undo?.length));
    return null;
  }

  async function simple(body: Record<string, unknown>, success?: string): Promise<string | null> {
    const result = await send(body);
    if (!result.ok) return result.error ?? 'That didn’t save.';
    if (success) showToast(success);
    return null;
  }

  function jumpTo(alert: (typeof derived.alerts)[number]) {
    setAlertsOpen(false);
    const row = alert.staffId ? rows.findIndex((p) => p.id === alert.staffId) : 0;
    const col = alert.date ? dates.indexOf(alert.date) : Math.max(0, dates.findIndex((d) => derived.cells.get(cellKey(alert.staffId ?? '', d))?.shift));
    if (row < 0 || col < 0) return;
    const pos = { row, col };
    select(pos);
    if (matchMedia(NARROW).matches) setMobileDay(col);
    else focusCell(pos);
  }

  // ─── What to show ────────────────────────────────────────

  const changedCount = derived.changed.size;
  const shiftCount = [...derived.cells.values()].filter((c) => c.shift).length;
  const problems = derived.alerts.filter((a) => a.severity === 'problem');
  const warnings = derived.alerts.filter((a) => a.severity !== 'problem');
  const isPublished = Boolean(state.published);
  // Texts due without an edit: someone just signed up, or a text failed.
  const textsDue = state.texts?.ready ? Object.values(state.texts.people).filter((p) => p.plan.send).length : 0;
  const hasAnything = state.cells.length > 0 || overlay.size > 0;
  const axis = weekAxis(dates.map((d) => ({ hours: derived.hoursByDate.get(d) ?? null, cover: derived.coverage.get(d)! })));
  const selKeys = sel ? new Set(keysIn(sel)) : new Set<string>();
  const focusKey = sel && rows[sel.focus.row] ? posKey(sel.focus) : null;
  const thisWeek = state.today >= state.weekStart && state.today <= addDays(state.weekStart, 6);
  const currentWeekStart = addDays(state.today, -new Date(`${state.today}T00:00:00Z`).getUTCDay());
  const peopleWorking = new Set([...derived.cells.values()].filter((c) => c.shift).map((c) => c.staffId)).size;
  const checksTone = problems.length ? 'problem' : warnings.length ? 'warn' : 'ok';
  const when = (date: string) => ({
    isPast: date < state.today,
    isToday: date === state.today,
    nowMinutes,
    clockInUse: state.clockInUse,
  });

  let status: { tone: string; text: string };
  if (readOnly) status = isPublished ? { tone: 'live', text: 'Published' } : { tone: 'draft', text: 'Not published yet' };
  else if (!isPublished) status = hasAnything ? { tone: 'draft', text: 'Draft' } : { tone: 'draft', text: 'Nothing planned yet' };
  else if (changedCount) status = { tone: 'pending', text: `${plural(changedCount, 'change')} not published` };
  else status = { tone: 'live', text: `Published ${formatPublished(state.published!.at)}` };

  const editingPerson = editing ? rows[editing.pos.row] : null;
  const editingDate = editing ? dates[editing.pos.col] : null;
  const editingCell = editing && editingPerson ? cellAt(derived, editingPerson.id, editingDate!) : null;
  const editingTotals = editingPerson ? derived.totals.byPerson.get(editingPerson.id) : null;

  const formatHours = (m: number) => hoursLabel(m);

  // A dropped shift travels from where it was let go to its new cell.
  useLayoutEffect(() => {
    const flip = flipRef.current;
    if (!flip) return;
    flipRef.current = null;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const [staffId, date] = flip.key.split('|');
    const pos = `${rows.findIndex((p) => p.id === staffId)}:${dates.indexOf(date)}`;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-pos="${pos}"] .chip, [data-pos="${pos}"] .off`);
    if (!el) return;
    const last = el.getBoundingClientRect();
    el.animate(
      [
        { transform: `translate(${flip.rect.left - last.left}px, ${flip.rect.top - last.top}px) scale(${flip.rect.width / last.width}) rotate(-2deg)` },
        { transform: 'none' },
      ],
      { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
  });

  /** Runs of two or more days off with nothing else on them, drawn as one band. */
  function bandsFor(person: (typeof rows)[number]) {
    const runs: Array<{ start: number; end: number; kind: 'off' | 'pto' | 'vacation' | 'sick'; note: string }> = [];
    dates.forEach((date, col) => {
      const cell = cellAt(derived, person.id, date);
      const last = runs[runs.length - 1];
      if (cell.off && !cell.shift) {
        if (last && last.end === col - 1 && last.kind === cell.off.kind && last.note === (cell.off.note ?? '')) last.end = col;
        else runs.push({ start: col, end: col, kind: cell.off.kind, note: cell.off.note ?? '' });
      }
    });
    return runs
      .filter((r) => r.end > r.start)
      .map((r) => {
        const range = state.timeOff.find(
          (t) => t.staffId === person.id && t.kind === r.kind && t.from <= dates[r.start] && t.to >= dates[r.end],
        );
        const from = range?.from ?? dates[r.start];
        const to = range?.to ?? dates[r.end];
        return { ...r, from, to, cutLeft: from < dates[r.start], cutRight: to > dates[r.end] };
      });
  }

  // ─── Render ──────────────────────────────────────────────

  const renderCell = (person: (typeof rows)[number], row: number, col: number, banded: Set<number>) => {
    const date = dates[col];
    const key = cellKey(person.id, date);
    const cell = cellAt(derived, person.id, date);
    const severity = derived.alertKeys.get(key);
    const pos = { row, col };
    const isFocus = key === focusKey;
    const isTarget = Boolean(drag?.target && drag.target.row === row && drag.target.col === col && !(drag.from.row === row && drag.from.col === col));
    const isSource = drag && drag.from.row === row && drag.from.col === col;
    const hours = derived.hoursByDate.get(date);
    const arrive = arriving.get(key);
    const gone = isEmptyCell(cell) ? leaving.get(key) : undefined;
    return (
      <div
        key={key}
        role="gridcell"
        class={[
          'cell',
          selKeys.has(key) ? 'is-selected' : '',
          isFocus ? 'is-focus' : '',
          isTarget ? 'is-drop' : '',
          isSource && !drag?.copy ? 'is-lifted' : '',
          severity ? `has-${severity}` : '',
          date === state.today ? 'is-today' : '',
          !hours ? 'is-closed-day' : '',
          overlay.has(key) ? 'is-saving' : '',
          flash.has(key) ? 'is-saved' : '',
          arrive !== undefined ? 'is-arriving' : '',
          readOnly ? 'is-readonly' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ gridColumn: String(col + 2), gridRow: '1', ...(arrive !== undefined ? { '--i': String(arrive) } : {}) } as Record<string, string>}
        data-pos={`${row}:${col}`}
        tabIndex={isFocus || (!focusKey && row === 0 && col === 0) ? 0 : -1}
        aria-selected={selKeys.has(key)}
        aria-label={describeCell(person.name, date, cell)}
        onPointerDown={(e) => onCellPointerDown(e as unknown as PointerEvent, pos)}
        onDblClick={() => openEditor(pos, null)}
        onFocus={() => {
          // Tabbing into the grid selects the cell; focus that came from our own
          // moves already matches the live selection, so a Shift range survives.
          const live = selRef.current;
          if (!live || live.focus.row !== row || live.focus.col !== col) {
            if (!dragRef.current) setSelection({ anchor: pos, focus: pos });
          }
        }}
      >
        <CellContent
          cell={cell}
          color={person.color}
          punches={derived.punches.get(key) ?? []}
          when={when(date)}
          changed={derived.changed.has(key)}
          inBand={banded.has(col)}
          hint={isFocus && !readOnly && !editing && isEmptyCell(cell) && !gone}
          dot={fadingDots.has(key) ? 'fading' : 'none'}
        />
        {gone && (
          <span class="cell-gone" aria-hidden="true">
            <CellContent cell={gone} color={person.color} punches={[]} when={when('9999-12-31')} changed={false} />
          </span>
        )}
        {isTarget && drag && (
          <span class="cell-preview" aria-hidden="true">
            <CellContent cell={drag.cell} color={rows[drag.from.row]?.color ?? 0} punches={[]} when={when('9999-12-31')} changed={false} />
          </span>
        )}
      </div>
    );
  };

  const dayHeader = (date: string, col: number) => {
    const hours = derived.hoursByDate.get(date);
    const closure = derived.closures.get(date);
    const holiday = derived.holidays.get(date);
    const note = closure?.note || holiday?.label || '';
    const gaps = hasAnything && date >= state.today ? derived.coverage.get(date)!.gaps.length : 0;
    return (
      <div
        key={date}
        role="columnheader"
        class={`day-head${date === state.today ? ' is-today' : ''}${!hours ? ' is-closed' : ''}${note ? ' has-note' : ''}`}
      >
        <button
          type="button"
          class="day-btn"
          disabled={readOnly}
          onClick={() => setPanel({ kind: 'day', date })}
          aria-label={`${dayLabel(date)}${note ? `, ${note}` : ''}${!hours ? ', store closed' : ''}. Edit the day’s note.`}
        >
          <span class="day-line">
            <span class="day-name">{DAY_SHORT[col]}</span>
            <span class="day-num">{dayOfMonth(date)}</span>
            {date === state.today && <span class="today-tag">Today</span>}
          </span>
          <span class="day-hours">{hours ? `${clockTiny(hours.open)}–${clockTiny(hours.close)}` : 'Closed'}</span>
          {note && <span class="day-note">{note}</span>}
          {gaps > 0 && <span class="day-gap" aria-hidden="true" />}
        </button>
      </div>
    );
  };

  const personHead = (person: (typeof rows)[number]) => {
    const t = derived.totals.byPerson.get(person.id)!;
    return (
      <div role="rowheader" class="s-person" style={{ gridColumn: '1', gridRow: '1' }}>
        <span class={`s-avatar c${person.color}`} aria-hidden="true">
          {initials(person.name)}
        </span>
        <span class="person-text">
          <span class="person-name">{person.name}</span>
          {!person.onSchedule && <span class="person-sub">Not on the schedule</span>}
          {person.onSchedule && t.shifts > 0 && <span class="person-sub">{plural(t.shifts, 'shift')}</span>}
        </span>
      </div>
    );
  };

  const hoursCell = (person: (typeof rows)[number]) => {
    const t = derived.totals.byPerson.get(person.id)!;
    const over = person.overtimeEligible && t.minutes > OVERTIME_MINUTES;
    return (
      <div role="gridcell" class={`hours${over ? ' is-over' : ''}`} style={{ gridColumn: '9', gridRow: '1' }}>
        <span class="hours-num">
          <AnimatedNumber value={t.minutes} format={formatHours} />
          {t.openEnded ? '+' : ''}
        </span>
        <span class="hours-bar" aria-hidden="true">
          <span class={`c${person.color}`} style={{ width: `${Math.min(100, (t.minutes / OVERTIME_MINUTES) * 100)}%` }} />
        </span>
        {over && <span class="hours-ot">{hoursLabel(t.minutes - OVERTIME_MINUTES)} OT</span>}
      </div>
    );
  };

  const openPicker = () => {
    const input = pickerRef.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.focus();
      input.click();
    }
  };

  const goDay = (next: number) => {
    const col = clamp(next, 0, 6);
    if (col === mobileDay) return;
    setDayDir(col > mobileDay ? 1 : -1);
    setMobileDay(col);
  };

  const timeOffDefaults = () => ({
    kind: 'timeoff' as const,
    staffId: sel ? rows[sel.focus.row]?.id ?? '' : '',
    from: sel ? dates[sel.focus.col] : state.today > state.weekStart ? state.today : state.weekStart,
  });

  return (
    <div class={`sched${readOnly ? ' sched--readonly' : ''}${drag ? ' is-dragging' : ''}`}>
      {/* Header: the week, where it stands, and what to do */}
      <header class="top">
        <div class="top-left">
          <div class="week-switch">
            <button type="button" class="icon-btn nav-btn" aria-label="Previous week" title="Previous week  [" onClick={() => goToWeek(addDays(state.weekStart, -7), -1)}>
              <Icon name="left" />
            </button>
            <button type="button" class="week-title" onClick={openPicker} title="Pick a week">
              <span class="eyebrow">Schedule</span>
              <span class="week-title-row">
                <h1 key={state.weekStart} class={`week-label${navDir < 0 ? ' from-left' : navDir > 0 ? ' from-right' : ''}`}>
                  {weekRangeLabel(state.weekStart)}
                </h1>
                <svg class="caret" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M6 8l4 4 4-4" />
                </svg>
              </span>
            </button>
            <button type="button" class="icon-btn nav-btn" aria-label="Next week" title="Next week  ]" onClick={() => goToWeek(addDays(state.weekStart, 7), 1)}>
              <Icon name="right" />
            </button>
            <input
              ref={pickerRef}
              class="week-picker"
              type="date"
              tabIndex={-1}
              aria-label="Pick a week"
              value={state.weekStart}
              onChange={(e) => {
                const v = (e.currentTarget as HTMLInputElement).value;
                if (!v) return;
                const ws = addDays(v, -new Date(`${v}T00:00:00Z`).getUTCDay());
                goToWeek(ws, ws < state.weekStart ? -1 : 1);
              }}
            />
            {!thisWeek && (
              <button type="button" class="btn btn-small btn-ghost this-week when-wide" onClick={() => goToWeek(currentWeekStart, currentWeekStart < state.weekStart ? -1 : 1)}>
                This week
              </button>
            )}
          </div>
          <p class={`status status--${status.tone}`}>
            <span key={burst} class={`status-dot${burst ? ' is-burst' : ''}`} aria-hidden="true" />
            <span>{status.text}</span>
            {hasAnything && (
              <span class="status-meta">
                <AnimatedNumber value={derived.totals.week} format={formatHours} /> h · {plural(peopleWorking, 'person', 'people')}
              </span>
            )}
            {busy > 0 && <span class="saving">Saving…</span>}
            {!thisWeek && (
              <button type="button" class="link-btn when-narrow" onClick={() => goToWeek(currentWeekStart, currentWeekStart < state.weekStart ? -1 : 1)}>
                This week
              </button>
            )}
          </p>
        </div>

        {!readOnly && (
          <div class="top-right" role="toolbar" aria-label="Schedule actions">
            {hasAnything && (
              <span class="checks-wrap" onPointerDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  key={checksTone}
                  class={`checks-chip is-${checksTone}`}
                  aria-expanded={alertsOpen}
                  aria-haspopup="dialog"
                  onClick={() => setAlertsOpen((o) => !o)}
                  title={derived.alerts[0]?.text ?? 'Every open hour is covered and nobody is double-booked.'}
                >
                  <Icon name={derived.alerts.length ? 'alert' : 'check'} />
                  <span class="when-wide">
                    {derived.alerts.length === 0
                      ? 'All covered'
                      : problems.length
                        ? `${problems.length} to fix${warnings.length ? ` · ${warnings.length} to check` : ''}`
                        : `${warnings.length} to check`}
                  </span>
                  <span class="when-narrow">{derived.alerts.length || ''}</span>
                </button>
                {alertsOpen && (
                  <div class="checks-pop" role="dialog" aria-label="Things to check" onPointerDown={(e) => e.stopPropagation()}>
                    {derived.alerts.length === 0 ? (
                      <p class="checks-ok">
                        <Icon name="check" /> Every open hour is covered and nobody is double-booked.
                      </p>
                    ) : (
                      <ul>
                        {derived.alerts.map((a) => (
                          <li key={a.id} class={`check-item check-item--${a.severity}`}>
                            <button type="button" onClick={() => jumpTo(a)}>
                              {a.text}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </span>
            )}
            <span class="tools">
              <button
                type="button"
                class={`btn tool${!hasAnything && state.lastWeekShifts ? ' tool--suggest' : ''}`}
                onClick={copyLastWeek}
                aria-label="Copy last week"
                title="Copy last week’s shifts into the empty cells"
              >
                <Icon name="copy" />
                <span class="when-wide">Copy last week</span>
              </button>
              <button type="button" class="btn tool" aria-label="Time off" onClick={() => setPanel(timeOffDefaults())}>
                <Icon name="plane" />
                <span class="when-wide">Time off</span>
              </button>
              <button type="button" class="btn btn-icon tool" aria-label="Undo" title="Undo  ⌘Z" disabled={!weekHistory.undo.length} onClick={undo}>
                <Icon name="undo" />
              </button>
              <span class="toolbar-more" onPointerDown={(e) => e.stopPropagation()}>
                <button type="button" class="btn btn-icon tool" aria-label="More" aria-expanded={moreOpen} aria-haspopup="menu" onClick={() => setMoreOpen((o) => !o)}>
                  <Icon name="more" />
                </button>
                {moreOpen && (
                  <div class="menu" role="menu" onPointerDown={(e) => e.stopPropagation()}>
                    <button role="menuitem" type="button" onClick={() => { setMoreOpen(false); print(); }}>
                      <Icon name="print" /> Print this week
                    </button>
                    <button role="menuitem" type="button" onClick={copyAsText}>
                      <Icon name="text" /> Copy as text
                    </button>
                    <button role="menuitem" type="button" onClick={() => { setMoreOpen(false); setPanel({ kind: 'texts' }); }}>
                      <Icon name="phone" /> Schedule texts
                    </button>
                    <button role="menuitem" type="button" onClick={() => { setMoreOpen(false); setPanel({ kind: 'calendar' }); }}>
                      <Icon name="calendar" /> Calendar links
                    </button>
                    <button role="menuitem" type="button" onClick={() => { setMoreOpen(false); setPanel({ kind: 'people' }); }}>
                      <Icon name="people" /> People and order
                    </button>
                    <button role="menuitem" type="button" onClick={() => { setMoreOpen(false); setPanel({ kind: 'keys' }); }}>
                      <Icon name="keyboard" /> Keyboard and typing
                    </button>
                  </div>
                )}
              </span>
            </span>
            <button
              type="button"
              class={`btn btn-primary publish-btn${isPublished && changedCount === 0 && !textsDue ? ' is-done' : ''}`}
              disabled={!hasAnything || (isPublished && changedCount === 0 && !textsDue)}
              onClick={() => setPanel({ kind: 'publish' })}
            >
              <Icon name={isPublished && changedCount === 0 && !textsDue ? 'check' : 'send'} />
              {!isPublished ? 'Publish' : changedCount ? `Publish ${changedCount}` : textsDue ? `Text ${textsDue}` : 'Published'}
            </button>
          </div>
        )}
      </header>

      {readOnly && !isPublished && <p class="readonly-note">This week’s schedule hasn’t been published yet.</p>}

      {/* The board */}
      <div
        ref={boardRef}
        class={`board${loading ? ' is-loading' : ''}${navDir < 0 ? ' slide-from-left' : navDir > 0 ? ' slide-from-right' : ''}`}
        key={state.weekStart}
        aria-busy={loading}
      >
        {rows.length === 0 ? (
          <div class="empty">
            <h2>Who’s on the team?</h2>
            <p>Add the people you schedule. You can bring in anyone already on the Staff page.</p>
            {!readOnly && (
              <button type="button" class="btn btn-primary" onClick={() => setPanel({ kind: 'people' })}>
                <Icon name="people" /> Add people
              </button>
            )}
          </div>
        ) : (
          <>
            {!readOnly && !hasAnything && (
              <div class="starter">
                <div>
                  <strong>Nothing planned for {weekRangeLabel(state.weekStart)} yet.</strong>
                  <span>
                    Click any cell and type it like the sheet: <kbd>9-5</kbd> <kbd>10:30-6</kbd> <kbd>off</kbd>. Tab moves to the next day.
                  </span>
                </div>
                {state.lastWeekShifts > 0 && (
                  <button type="button" class="btn btn-primary" onClick={copyLastWeek}>
                    <Icon name="copy" /> Copy last week’s {plural(state.lastWeekShifts, 'shift')}
                  </button>
                )}
              </div>
            )}

            {/* Week grid (tablet and desktop) */}
            <div
              ref={gridRef}
              class="grid"
              role="grid"
              aria-label={`Schedule for ${weekRangeLabel(state.weekStart)}`}
              aria-rowcount={rows.length + 2}
              aria-colcount={9}
              aria-multiselectable={!readOnly}
              onKeyDown={(e) => onGridKeyDown(e as unknown as KeyboardEvent)}
              onCopy={(e) => onCopy(e as unknown as ClipboardEvent)}
              onCut={(e) => onCopy(e as unknown as ClipboardEvent, true)}
              onPaste={(e) => onPaste(e as unknown as ClipboardEvent)}
            >
              <div role="row" class="grid-row grid-row--head">
                <div role="columnheader" class="corner">
                  Team
                </div>
                {dates.map(dayHeader)}
                <div role="columnheader" class="corner corner--hours">
                  Hours
                </div>
              </div>
              {rows.map((person, row) => {
                const bands = bandsFor(person);
                const banded = new Set(bands.flatMap((b) => Array.from({ length: b.end - b.start + 1 }, (_, i) => b.start + i)));
                return (
                  <div role="row" class="grid-row" key={person.id}>
                    {personHead(person)}
                    {dates.map((_, col) => renderCell(person, row, col, banded))}
                    {bands.map((b) => (
                      <OffBand
                        key={`${b.start}`}
                        kind={b.kind}
                        note={b.note}
                        from={b.from}
                        to={b.to}
                        startCol={b.start}
                        endCol={b.end}
                        cutLeft={b.cutLeft}
                        cutRight={b.cutRight}
                      />
                    ))}
                    {hoursCell(person)}
                  </div>
                );
              })}
              <div role="row" class="grid-row grid-row--cover">
                <div role="rowheader" class="corner corner--cover">
                  In the store
                </div>
                {dates.map((date) => {
                  const cover = derived.coverage.get(date)!;
                  const minutes = derived.totals.byDate.get(date) ?? 0;
                  return (
                    <div role="gridcell" class="cover-cell" key={date}>
                      <CoverageBars
                        segments={cover.segments}
                        gaps={hasAnything && date >= state.today ? cover.gaps : []}
                        hours={derived.hoursByDate.get(date) ?? null}
                        axis={axis}
                        label={dayLabel(date)}
                        now={date === state.today ? nowMinutes : null}
                      />
                      <span class="cover-sum">
                        {minutes ? (
                          <>
                            <AnimatedNumber value={minutes} format={formatHours} />h
                          </>
                        ) : (
                          '—'
                        )}
                        {cover.peak > 1 && <span> · up to {cover.peak}</span>}
                      </span>
                    </div>
                  );
                })}
                <div role="gridcell" class="hours hours--week">
                  <span class="hours-num">
                    <AnimatedNumber value={derived.totals.week} format={formatHours} />
                  </span>
                  {state.usualWeekMinutes !== null && (
                    <span class="hours-usual">usually {hoursLabel(Math.round(state.usualWeekMinutes / 30) * 30)}</span>
                  )}
                </div>
              </div>
            </div>

            {/* Day view (phones) */}
            <div class="dayview">
              <div class="dayview-tabs" role="tablist" aria-label="Day">
                {dates.map((date, col) => {
                  const hasGap = hasAnything && date >= state.today && derived.coverage.get(date)!.gaps.length > 0;
                  const working = rows.filter((p) => derived.cells.get(cellKey(p.id, date))?.shift).length;
                  return (
                    <button
                      key={date}
                      type="button"
                      role="tab"
                      aria-selected={mobileDay === col}
                      class={`dv-tab${mobileDay === col ? ' is-on' : ''}${date === state.today ? ' is-today' : ''}${!derived.hoursByDate.get(date) ? ' is-closed' : ''}`}
                      onClick={() => goDay(col)}
                    >
                      <span>{DAY_SHORT[col]}</span>
                      <strong>{dayOfMonth(date)}</strong>
                      <i class="dv-people" aria-hidden="true">
                        {Array.from({ length: Math.min(working, 4) }, (_, i) => (
                          <b key={i} />
                        ))}
                      </i>
                      {hasGap && <i class="dv-dot" aria-label="gap in cover" />}
                    </button>
                  );
                })}
              </div>
              {(() => {
                const date = dates[mobileDay];
                const hours = derived.hoursByDate.get(date) ?? null;
                const cover = derived.coverage.get(date)!;
                const note = derived.closures.get(date)?.note || derived.holidays.get(date)?.label || '';
                return (
                  <div
                    class={`dv-day${dayDir < 0 ? ' from-left' : dayDir > 0 ? ' from-right' : ''}`}
                    key={date}
                    role="tabpanel"
                    aria-label={dayLabel(date)}
                    onPointerDown={(e) => {
                      swipeRef.current = { x: e.clientX, y: e.clientY };
                    }}
                    onPointerUp={(e) => {
                      const start = swipeRef.current;
                      swipeRef.current = null;
                      if (!start) return;
                      const dx = e.clientX - start.x;
                      if (Math.abs(dx) > 60 && Math.abs(e.clientY - start.y) < 40) goDay(mobileDay + (dx < 0 ? 1 : -1));
                    }}
                  >
                    <div class="dv-summary">
                      <button type="button" class="dv-dayname" disabled={readOnly} onClick={() => setPanel({ kind: 'day', date })}>
                        {dayLabel(date)}
                        <span>
                          {hours ? `Open ${clockTiny(hours.open)}–${clockTiny(hours.close)}` : 'Store closed'}
                          {note ? ` · ${note}` : ''}
                        </span>
                      </button>
                      <CoverageBars
                        segments={cover.segments}
                        gaps={hasAnything && date >= state.today ? cover.gaps : []}
                        hours={hours}
                        axis={axis}
                        label={dayLabel(date)}
                        now={date === state.today ? nowMinutes : null}
                      />
                    </div>
                    <ul class="dv-list">
                      {rows.map((person, row) => {
                        const key = cellKey(person.id, date);
                        const cell = cellAt(derived, person.id, date);
                        const t = derived.totals.byPerson.get(person.id)!;
                        return (
                          <li key={person.id}>
                            <button
                              type="button"
                              class={`dv-row${derived.alertKeys.get(key) ? ` has-${derived.alertKeys.get(key)}` : ''}${flash.has(key) ? ' is-saved' : ''}`}
                              disabled={readOnly}
                              aria-label={describeCell(person.name, date, cell)}
                              onClick={() => {
                                select({ row, col: mobileDay });
                                openEditor({ row, col: mobileDay }, null, true);
                              }}
                            >
                              <span class={`s-avatar c${person.color}`} aria-hidden="true">
                                {initials(person.name)}
                              </span>
                              <span class="dv-name">
                                {person.name}
                                <small>
                                  {hoursLabel(t.minutes)}
                                  {t.openEnded ? '+' : ''} h this week
                                </small>
                              </span>
                              <span class="dv-cell">
                                <CellContent cell={cell} color={person.color} punches={derived.punches.get(key) ?? []} when={when(date)} changed={derived.changed.has(key)} />
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <p class="dv-total">
                      {hoursLabel(derived.totals.byDate.get(date) ?? 0)} hours this day · swipe for the next day
                    </p>
                  </div>
                );
              })()}
            </div>

            {editing && editingPerson && editingDate && editingCell && (
              <>
                {editing.sheet && <div class="scrim" onPointerDown={() => setEditor(null)} />}
                <Editor
                  key={`${editing.pos.row}:${editing.pos.col}`}
                  title={editing.keys.length > 1 ? `${editing.keys.length} cells` : `${firstName(editingPerson.name)} · ${dayLabel(editingDate)}`}
                  initial={editing.initial}
                  selectAll={editing.selectAll}
                  hours={derived.hoursByDate.get(editingDate) ?? null}
                  picks={state.picks[editingPerson.id] ?? []}
                  context={{
                    name: firstName(editingPerson.name),
                    count: editing.keys.length,
                    replacesOff: editingCell.off,
                    closedNote: derived.closures.get(editingDate)?.closed ? derived.closures.get(editingDate)?.note ?? '' : null,
                    otherMinutes: editingTotals ? editingTotals.minutes - shiftMinutes(editingCell.shift) : null,
                    overtimeEligible: editingPerson.overtimeEligible,
                  }}
                  placement={editing.sheet ? null : placement}
                  onCommit={onEditorCommit}
                  onCancel={() => closeEditor('none')}
                  typeAhead={typeAheadRef}
                />
              </>
            )}
          </>
        )}
      </div>

      {/* Week note and time off at a glance */}
      {rows.length > 0 && (
        <div class="below">
          <div class="week-note">
            <label for="week-note" class="eyebrow">
              Notes for the week
            </label>
            {readOnly ? (
              <p class="week-note-text">{state.weekNote || 'No notes.'}</p>
            ) : (
              <>
                <textarea
                  id="week-note"
                  rows={2}
                  maxLength={1000}
                  value={noteDraft}
                  placeholder="Sip & Shop Friday, truck Tuesday, who has keys"
                  onInput={(e) => {
                    setNoteDraft((e.currentTarget as HTMLTextAreaElement).value);
                    setNoteSaved('idle');
                  }}
                  onBlur={saveNote}
                />
                <span class={`note-state${noteSaved === 'saved' ? ' is-saved' : ''}`} aria-live="polite">
                  {noteSaved === 'saving' ? 'Saving…' : noteSaved === 'saved' ? 'Saved' : ''}
                </span>
              </>
            )}
          </div>
          {!readOnly && (
            <div class="week-off">
              <p class="eyebrow">Time off this week</p>
              {(() => {
                const inWeek = state.timeOff.filter((r) => r.to >= state.weekStart && r.from <= dates[6]);
                if (!inWeek.length) return <p class="muted-line">Nobody.</p>;
                return (
                  <ul>
                    {inWeek.map((r) => {
                      const person = rows.find((p) => p.id === r.staffId);
                      return (
                        <li key={`${r.staffId}${r.from}`}>
                          <span class={`kind kind--${r.kind}`}>{TIME_OFF_LABELS[r.kind]}</span>
                          {person ? firstName(person.name) : 'Former staff'} · {dateRangeLabel(r.from, r.to)}
                          {r.note ? ` · ${r.note}` : ''}
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* Printed footer (only on paper) */}
      <div class="print-only print-foot">
        Sunny &amp; Ranney · {weekRangeLabel(state.weekStart)} · {isPublished ? `Published ${formatPublished(state.published!.at)}` : 'Draft'}
      </div>

      {drag && (
        <div class="drag-ghost" style={{ transform: `translate(${drag.x - 40}px, ${drag.y - 24}px)` }} aria-hidden="true">
          <CellContent cell={drag.cell} color={rows[drag.from.row]?.color ?? 0} punches={[]} when={when('9999-12-31')} changed={false} />
          <span class="drag-hint">{drag.copy ? 'Copy' : 'Move'}</span>
        </div>
      )}

      {/* Panels */}
      {panel?.kind === 'timeoff' && (
        <TimeOffPanel state={state} defaults={{ staffId: panel.staffId, from: panel.from }} onAdd={addTimeOff} onClear={clearTimeOff} onClose={() => setPanel(null)} />
      )}
      {panel?.kind === 'people' && (
        <PeoplePanel
          state={state}
          onOp={(op, staffId, name) => simple({ action: 'person', op, staffId, name })}
          onClose={() => setPanel(null)}
        />
      )}
      {panel?.kind === 'texts' && (
        <TextsPanel
          state={state}
          storeOrigin={feedOrigin}
          onSave={async (input) => {
            const result = await send({ action: 'textSignup', ...input, consent: true });
            if (!result.ok) return result.error ?? 'That didn’t save.';
            const name = firstName(rows.find((p) => p.id === input.staffId)?.name ?? '');
            showToast(result.texted ? `Saved. ${name}’s sign-up text is on its way to ${formatUsPhone(input.phone)}.` : `Saved ${name}’s number.`);
            return null;
          }}
          onRemove={(staffId) =>
            simple({ action: 'textSignup', staffId, remove: true }, `${firstName(rows.find((p) => p.id === staffId)?.name ?? 'They')} won’t get schedule texts.`)
          }
          onRetry={async (staffId) => {
            const result = await send({ action: 'textRetry', staffId });
            if (!result.ok) return result.error ?? 'That didn’t send.';
            showToast(result.texted ? 'Sent again.' : 'Nothing was due to send.');
            return null;
          }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel?.kind === 'calendar' && (
        <CalendarPanel state={state} feedOrigin={feedOrigin} onToggle={(staffId, enabled) => simple({ action: 'calendar', staffId, enabled })} onClose={() => setPanel(null)} />
      )}
      {panel?.kind === 'publish' && (
        <PublishPanel
          state={state}
          shifts={shiftCount}
          minutes={derived.totals.week}
          changed={changedCount}
          problems={problems}
          texts={<PublishTexts state={state} onManage={() => setPanel({ kind: 'texts' })} />}
          onPublish={async () => {
            const was = new Set(derived.changed);
            const result = await send({ action: 'publish' });
            if (!result.ok) return result.error ?? 'That didn’t publish.';
            const names = (ids: string[] = []) => ids.map((id) => firstName(rows.find((p) => p.id === id)?.name ?? '')).filter(Boolean);
            const texted = names(result.texts?.texted);
            const failed = names(result.texts?.failed);
            const done = `Published ${weekRangeLabel(state.weekStart)}.`;
            if (failed.length) showToast(`${done} Couldn’t text ${listNames(failed)}. See More → Schedule texts.`, 'error');
            else if (texted.length) showToast(`${done} Texted ${listNames(texted)}.`);
            else showToast(`${done} Calendars and the store tablet now show it.`);
            setPanel(null);
            setBurst((n) => n + 1);
            briefly<Set<string>>(setFadingDots, () => was, () => new Set(), 700);
            return null;
          }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel?.kind === 'day' && (
        <DayPanel
          date={panel.date}
          note={derived.closures.get(panel.date)?.note ?? ''}
          closed={derived.closures.get(panel.date)?.closed ?? false}
          holiday={derived.holidays.get(panel.date) ?? null}
          usual={derived.hoursByDate.get(panel.date) ?? null}
          onSave={(note, closed) => simple({ action: 'day', date: panel.date, note, closed })}
          onClose={() => setPanel(null)}
        />
      )}
      {panel?.kind === 'keys' && <ShortcutsPanel onClose={() => setPanel(null)} />}

      {toast && (
        <div
          class={`toast toast--${toast.tone}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          key={toast.id}
          onMouseEnter={() => setToastPaused(true)}
          onMouseLeave={() => setToastPaused(false)}
        >
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              class="toast-undo"
              onClick={() => {
                setToast(null);
                undo();
              }}
            >
              Undo
            </button>
          )}
          <button type="button" class="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>
            <Icon name="close" />
          </button>
          <span
            key={toastPaused ? 'paused' : 'running'}
            class={`toast-bar${toastPaused ? ' is-paused' : ''}`}
            style={{ animationDuration: `${toastMs}ms` }}
            aria-hidden="true"
          />
        </div>
      )}
      <div class="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
