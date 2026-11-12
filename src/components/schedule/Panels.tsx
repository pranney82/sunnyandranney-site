/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  clockLong,
  dateRangeLabel,
  dayLabel,
  hoursLabel,
  TIME_OFF_LABELS,
  weekRangeLabel,
} from '@/lib/schedule/core.mjs';
import { durationLabel, formatPublished, initials, type Alert, type Hours, type Person, type WeekState } from './model';
import { Icon } from './parts';

// ─── Side sheet ──────────────────────────────────────────────

export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ComponentChildren;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      class={`sheet${wide ? ' sheet--wide' : ''}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div class="sheet-inner">
        <header class="sheet-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p class="sheet-sub">{subtitle}</p>}
          </div>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div class="sheet-body">{children}</div>
      </div>
    </dialog>
  );
}

function Avatar({ person }: { person: Pick<Person, 'name' | 'color'> }) {
  return (
    <span class={`s-avatar c${person.color}`} aria-hidden="true">
      {initials(person.name)}
    </span>
  );
}

// ─── Time off ────────────────────────────────────────────────

export interface TimeOffInput {
  staffId: string;
  from: string;
  to: string;
  kind: 'off' | 'pto' | 'vacation' | 'sick';
  note: string;
  removeShifts: boolean;
}

export function TimeOffPanel({
  state,
  defaults,
  onAdd,
  onClear,
  onClose,
}: {
  state: WeekState;
  defaults: { staffId: string; from: string };
  onAdd: (input: TimeOffInput) => Promise<string | null>;
  onClear: (range: { staffId: string; from: string; to: string }) => Promise<string | null>;
  onClose: () => void;
}) {
  const people = state.people.filter((p) => p.onSchedule);
  const [form, setForm] = useState<TimeOffInput>({
    staffId: defaults.staffId || people[0]?.id || '',
    from: defaults.from,
    to: defaults.from,
    kind: 'vacation',
    note: '',
    removeShifts: true,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const byId = new Map(state.people.map((p) => [p.id, p]));
  // Single days marked "off" are usually someone's regular day off, not a
  // request, so they're counted rather than listed.
  const isRequest = (r: WeekState['timeOff'][number]) => r.kind !== 'off' || r.days > 1 || Boolean(r.note);
  const upcoming = state.timeOff.filter((r) => r.to >= state.today && isRequest(r));
  const singleDays = state.timeOff.filter((r) => r.to >= state.today && !isRequest(r)).length;
  const recent = state.timeOff.filter((r) => r.to < state.today && isRequest(r)).reverse();

  async function submit(event: Event) {
    event.preventDefault();
    if (form.to < form.from) {
      setError('The last day has to be on or after the first.');
      return;
    }
    setBusy(true);
    const message = await onAdd(form);
    setBusy(false);
    if (message) setError(message);
    else {
      setError('');
      setForm((f) => ({ ...f, note: '' }));
    }
  }

  const range = (r: WeekState['timeOff'][number]) => {
    const person = byId.get(r.staffId);
    return (
      <li key={`${r.staffId}${r.from}`} class="timeoff-row">
        {person && <Avatar person={person} />}
        <div class="timeoff-what">
          <strong>{person ? person.name : 'Former staff'}</strong>
          <span>
            {dateRangeLabel(r.from, r.to)} · {r.days} {r.days === 1 ? 'day' : 'days'}
            {r.note ? ` · ${r.note}` : ''}
          </span>
        </div>
        <span class={`kind kind--${r.kind}`}>{TIME_OFF_LABELS[r.kind]}</span>
        <button
          type="button"
          class="icon-btn"
          aria-label={`Remove ${person?.name ?? ''} ${TIME_OFF_LABELS[r.kind]} ${dateRangeLabel(r.from, r.to)}`}
          onClick={async () => {
            const message = await onClear({ staffId: r.staffId, from: r.from, to: r.to });
            if (message) setError(message);
          }}
        >
          <Icon name="trash" />
        </button>
      </li>
    );
  };

  return (
    <Sheet title="Time off" subtitle="Days off show on the schedule, and a shift on one is flagged." onClose={onClose}>
      <form class="form" onSubmit={submit}>
        <div class="field">
          <label for="to-person">Who</label>
          <select id="to-person" value={form.staffId} onChange={(e) => setForm({ ...form, staffId: (e.currentTarget as HTMLSelectElement).value })}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div class="field-pair">
          <div class="field">
            <label for="to-from">First day</label>
            <input
              id="to-from"
              type="date"
              required
              value={form.from}
              onInput={(e) => {
                const from = (e.currentTarget as HTMLInputElement).value;
                setForm((f) => ({ ...f, from, to: f.to < from ? from : f.to }));
              }}
            />
          </div>
          <div class="field">
            <label for="to-to">Last day</label>
            <input
              id="to-to"
              type="date"
              required
              min={form.from}
              value={form.to}
              onInput={(e) => setForm({ ...form, to: (e.currentTarget as HTMLInputElement).value })}
            />
          </div>
        </div>
        <fieldset class="segmented" aria-label="Kind of time off">
          {(['vacation', 'pto', 'off', 'sick'] as const).map((kind) => (
            <label key={kind} class={form.kind === kind ? 'is-on' : ''}>
              <input type="radio" name="to-kind" value={kind} checked={form.kind === kind} onChange={() => setForm({ ...form, kind })} />
              {TIME_OFF_LABELS[kind]}
            </label>
          ))}
        </fieldset>
        <div class="field">
          <label for="to-note">Note (optional)</label>
          <input
            id="to-note"
            maxLength={120}
            value={form.note}
            placeholder="Beach trip, doctor"
            onInput={(e) => setForm({ ...form, note: (e.currentTarget as HTMLInputElement).value })}
          />
        </div>
        <label class="check">
          <input
            type="checkbox"
            checked={form.removeShifts}
            onChange={(e) => setForm({ ...form, removeShifts: (e.currentTarget as HTMLInputElement).checked })}
          />
          Take their shifts off those days
        </label>
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" class="btn btn-primary" disabled={busy || !form.staffId}>
          {busy ? 'Saving…' : 'Add time off'}
        </button>
      </form>

      <h3 class="sheet-h3">Coming up</h3>
      {upcoming.length ? <ul class="timeoff-list">{upcoming.map(range)}</ul> : <p class="muted-line">No time off coming up.</p>}
      {singleDays > 0 && (
        <p class="muted-line">
          Plus {singleDays} single {singleDays === 1 ? 'day' : 'days'} off marked on the schedule. Clear one there with Delete.
        </p>
      )}
      {recent.length > 0 && (
        <>
          <h3 class="sheet-h3">Last two weeks</h3>
          <ul class="timeoff-list timeoff-list--past">{recent.map(range)}</ul>
        </>
      )}
    </Sheet>
  );
}

// ─── People ──────────────────────────────────────────────────

export function PeoplePanel({
  state,
  onOp,
  onClose,
}: {
  state: WeekState;
  onOp: (op: string, staffId?: string, name?: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const people = state.people.filter((p) => p.onSchedule);
  const [pick, setPick] = useState(state.others[0]?.id ?? '');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!state.others.some((o) => o.id === pick)) setPick(state.others[0]?.id ?? '');
  }, [state.others]);

  const run = async (op: string, staffId?: string, newName?: string) => {
    const message = await onOp(op, staffId, newName);
    setError(message ?? '');
    return !message;
  };

  return (
    <Sheet title="People on the schedule" subtitle="The order here is the order of the rows." onClose={onClose}>
      <ol class="people-list">
        {people.map((p, i) => (
          <li key={p.id}>
            <Avatar person={p} />
            <span class="people-name">{p.name}</span>
            <button type="button" class="icon-btn" aria-label={`Move ${p.name} up`} disabled={i === 0} onClick={() => run('up', p.id)}>
              <Icon name="up" />
            </button>
            <button
              type="button"
              class="icon-btn"
              aria-label={`Move ${p.name} down`}
              disabled={i === people.length - 1}
              onClick={() => run('down', p.id)}
            >
              <Icon name="down" />
            </button>
            <button type="button" class="icon-btn" aria-label={`Take ${p.name} off the schedule`} onClick={() => run('remove', p.id)}>
              <Icon name="close" />
            </button>
          </li>
        ))}
      </ol>
      {people.length === 0 && <p class="muted-line">Nobody yet. Add your team below.</p>}

      {state.others.length > 0 && (
        <form
          class="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pick) await run('add', pick);
          }}
        >
          <label for="pp-add">Add from staff</label>
          <div class="inline-row">
            <select id="pp-add" value={pick} onChange={(e) => setPick((e.currentTarget as HTMLSelectElement).value)}>
              {state.others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button type="submit" class="btn btn-small">
              Add
            </button>
          </div>
        </form>
      )}

      <form
        class="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (name.trim() && (await run('create', undefined, name.trim()))) setName('');
        }}
      >
        <label for="pp-new">Someone new</label>
        <div class="inline-row">
          <input id="pp-new" value={name} maxLength={100} placeholder="Name" onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
          <button type="submit" class="btn btn-small" disabled={!name.trim()}>
            Add
          </button>
        </div>
      </form>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
      <p class="muted-line">Clock PINs, overtime and Gusto are set on the Staff page.</p>
    </Sheet>
  );
}

// ─── Calendar links ──────────────────────────────────────────

export function CalendarPanel({
  state,
  feedOrigin,
  onToggle,
  onClose,
}: {
  state: WeekState;
  feedOrigin: string;
  onToggle: (staffId: string, enabled: boolean) => Promise<string | null>;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const people = state.people.filter((p) => p.onSchedule);
  const webcal = feedOrigin.replace(/^https?:/, 'webcal:');

  async function copy(person: Person) {
    const link = `${webcal}/staff-calendar/${person.calendarToken}/`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(person.id);
      setTimeout(() => setCopied(''), 2500);
    } catch {
      setError('Couldn’t copy. Select the link and copy it by hand.');
    }
  }

  const toggle = async (id: string, enabled: boolean) => setError((await onToggle(id, enabled)) ?? '');

  return (
    <Sheet
      title="Calendar links"
      subtitle="Each person gets a private link that puts their published shifts in their phone’s calendar."
      onClose={onClose}
    >
      <ol class="steps">
        <li>Create someone’s link and copy it.</li>
        <li>Text it to them. On an iPhone, tapping it offers to subscribe.</li>
        <li>From then on, every week you publish shows up on its own. Phones check on their own schedule, usually within hours; Google Calendar can take up to a day.</li>
      </ol>
      <ul class="cal-list">
        {people.map((p) => (
          <li key={p.id}>
            <Avatar person={p} />
            <div class="cal-what">
              <strong>{p.name}</strong>
              {p.calendarToken ? (
                <code class="cal-link" title={`${webcal}/staff-calendar/${p.calendarToken}/`}>
                  …/staff-calendar/{p.calendarToken.slice(0, 6)}…
                </code>
              ) : (
                <span class="muted-line">No link</span>
              )}
            </div>
            {p.calendarToken ? (
              <div class="cal-actions">
                <button type="button" class="btn btn-small" onClick={() => copy(p)}>
                  {copied === p.id ? 'Copied' : 'Copy link'}
                </button>
                <button type="button" class="btn btn-small btn-ghost" onClick={() => toggle(p.id, true)} title="Makes a new link. The old one stops working.">
                  New link
                </button>
                <button type="button" class="btn btn-small btn-ghost" onClick={() => toggle(p.id, false)}>
                  Turn off
                </button>
              </div>
            ) : (
              <button type="button" class="btn btn-small" onClick={() => toggle(p.id, true)}>
                Create link
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
      <p class="muted-line">
        Anyone with a link can see that person’s published shifts and who works alongside them, so send it only to them. “New link”
        turns the old one off.
      </p>
    </Sheet>
  );
}

// ─── Publish ─────────────────────────────────────────────────

export function PublishPanel({
  state,
  shifts,
  minutes,
  changed,
  problems,
  texts,
  onPublish,
  onClose,
}: {
  state: WeekState;
  shifts: number;
  minutes: number;
  changed: number;
  problems: Alert[];
  /** Who publishing will text, and what. */
  texts?: ComponentChildren;
  onPublish: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const peopleWorking = new Set(state.cells.filter((c) => c.shift).map((c) => c.staffId)).size;
  const textCount = state.texts?.ready ? Object.values(state.texts.people).filter((p) => p.plan.send).length : 0;
  const publishLabel = `${problems.length ? 'Publish anyway' : 'Publish'}${textCount ? ` and text ${textCount}` : ''}`;
  return (
    <Sheet title={`Publish ${weekRangeLabel(state.weekStart)}`} onClose={onClose}>
      <dl class="pub-stats">
        <div>
          <dt>Shifts</dt>
          <dd>{shifts}</dd>
        </div>
        <div>
          <dt>Hours</dt>
          <dd>{hoursLabel(minutes)}</dd>
        </div>
        <div>
          <dt>People</dt>
          <dd>{peopleWorking}</dd>
        </div>
      </dl>
      {state.published ? (
        <p class="publish-line">
          Last published {formatPublished(state.published.at)}. {changed} {changed === 1 ? 'change' : 'changes'} since.
        </p>
      ) : (
        <p class="publish-line">This week hasn’t been published yet.</p>
      )}
      {state.effort && state.effort.actions > 1 && (
        <p class="publish-line publish-line--muted">
          You spent {durationLabel(state.effort.activeSeconds)} on it across {state.effort.actions} edits.
        </p>
      )}
      {problems.length > 0 && (
        <div class="publish-problems">
          <h3>Still open</h3>
          <ul>
            {problems.map((p) => (
              <li key={p.id}>{p.text}</li>
            ))}
          </ul>
        </div>
      )}
      {texts}
      <p class="muted-line">
        Calendar links and the store tablet show the week as you publish it. Edits after this stay a draft until you publish again.
      </p>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        class="btn btn-primary btn-block"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const message = await onPublish();
          setBusy(false);
          if (message) setError(message);
        }}
      >
        {busy ? (textCount ? 'Publishing and texting…' : 'Publishing…') : publishLabel}
      </button>
    </Sheet>
  );
}

// ─── A day's note and closure ───────────────────────────────

export function DayPanel({
  date,
  note,
  closed,
  holiday,
  usual,
  onSave,
  onClose,
}: {
  date: string;
  note: string;
  closed: boolean;
  holiday: { label: string; closed: boolean } | null;
  usual: Hours | null;
  onSave: (note: string, closed: boolean) => Promise<string | null>;
  onClose: () => void;
}) {
  const [text, setText] = useState(note);
  const [isClosed, setClosed] = useState(closed);
  const [error, setError] = useState('');
  return (
    <Sheet title={dayLabel(date)} onClose={onClose}>
      <form
        class="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const message = await onSave(text.trim(), isClosed);
          if (message) setError(message);
          else onClose();
        }}
      >
        <p class="muted-line">
          {holiday
            ? `Google lists ${holiday.label || 'special hours'}${holiday.closed ? ': closed' : ''}.`
            : usual
              ? `Open ${clockLong(usual.open)} – ${clockLong(usual.close)} that day.`
              : 'The store is usually closed that day.'}
        </p>
        <div class="field">
          <label for="day-note">Note for the day</label>
          <input
            id="day-note"
            value={text}
            maxLength={120}
            placeholder="Sip & Shop, truck day, Black Friday"
            onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          />
        </div>
        <label class="check">
          <input type="checkbox" checked={isClosed} onChange={(e) => setClosed((e.currentTarget as HTMLInputElement).checked)} />
          Store closed this day
        </label>
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" class="btn btn-primary">
          Save
        </button>
      </form>
    </Sheet>
  );
}

// ─── Shortcuts ───────────────────────────────────────────────

export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const mod = typeof navigator !== 'undefined' && /Mac|iPad|iPhone/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const rows: Array<[string, string]> = [
    ['Type', 'Start a cell, like a spreadsheet'],
    ['Enter', 'Edit, or save and go down'],
    ['Tab', 'Save and go to the next day'],
    ['Arrows', 'Move around'],
    ['Shift + arrows', 'Select several cells'],
    ['Delete', 'Clear the selected cells'],
    [`${mod} C / ${mod} V`, 'Copy and paste, including from the Google Sheet'],
    [`${mod} Z`, 'Undo'],
    [`${mod} Shift Z`, 'Redo'],
    ['Drag', 'Move a shift; hold Option to copy it'],
    ['[ and ]', 'Previous and next week'],
    ['?', 'This list'],
  ];
  return (
    <Sheet title="Keyboard" onClose={onClose}>
      <dl class="keys">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h3 class="sheet-h3">What you can type</h3>
      <dl class="keys">
        {[
          ['9-5', '9 AM to 5 PM'],
          ['10:30-6', '10:30 AM to 6 PM'],
          ['3-6', '3 PM to 6 PM'],
          ['9-?', 'No end time yet'],
          ['10-close', 'Until the store closes'],
          ['Mart 9-5', 'A shift with a label; Mart counts as away'],
          ['off, pto, vac, sick', 'Time off (add a note after it)'],
          ['-', 'Clear'],
        ].map(([k, v]) => (
          <div key={k}>
            <dt>
              <code>{k}</code>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}

