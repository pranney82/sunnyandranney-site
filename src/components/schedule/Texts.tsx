/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatUsPhone, normalizeUsPhone } from '@/lib/schedule/texts.mjs';
import type { PersonTexts, TextRecord } from '@/lib/schedule/texting';
import { firstName, initials, type Person, type WeekState } from './model';
import { Sheet } from './Panels';
import { Icon } from './parts';

function Avatar({ person }: { person: Pick<Person, 'name' | 'color'> }) {
  return (
    <span class={`s-avatar c${person.color}`} aria-hidden="true">
      {initials(person.name)}
    </span>
  );
}

/** "Nov 9" from "2026-11-09". */
function shortDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "7:23 PM" today, otherwise "Nov 9, 7:23 PM", in store time. */
function whenLabel(iso: string, today: string): string {
  const zone = 'America/New_York';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(iso));
  const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  return day === today ? time : `${shortDate(day)}, ${time}`;
}

const SKIP_REASONS: Record<string, string> = {
  'no-number': 'no mobile number',
  stopped: 'replied STOP',
  'no-shifts': 'no shifts',
  unchanged: 'nothing ahead changed',
  past: 'week is over',
};

function tone(record: TextRecord | null): 'ok' | 'wait' | 'bad' | null {
  if (!record) return null;
  if (record.status === 'delivered' || record.status === 'sent') return 'ok';
  if (record.ok) return 'wait';
  return 'bad';
}

function TextStatus({ label, record, today }: { label: string; record: TextRecord | null; today: string }) {
  if (!record) return null;
  return (
    <span class={`tx-status tx-status--${tone(record)}`}>
      <span class="tx-dot" aria-hidden="true" />
      {`${label}: ${record.label}`}
      {' · '}
      <span class="tx-when">{whenLabel(record.at, today)}</span>
    </span>
  );
}

// ─── What publishing will text ───────────────────────────────

/** The texts section of the Publish sheet: who gets what, word for word. */
export function PublishTexts({ state, onManage }: { state: WeekState; onManage: () => void }) {
  const texts = state.texts;
  if (!texts) return null;
  const people = state.people.filter((p) => texts.people[p.id]);
  const sending = people.filter((p) => texts.people[p.id].plan.send);
  const skipped = people.filter((p) => !texts.people[p.id].plan.send);
  const anyoneSignedUp = people.some((p) => texts.people[p.id].signup);

  if (!texts.ready) {
    return <p class="muted-line">Texts are off: sent.dm isn’t set up on this site.</p>;
  }
  if (!anyoneSignedUp) {
    return (
      <div class="tx-publish">
        <h3 class="sheet-h3">Texts</h3>
        <p class="muted-line">Nobody gets a text yet.</p>
        <button type="button" class="btn btn-small" onClick={onManage}>
          <Icon name="phone" /> Add mobile numbers
        </button>
      </div>
    );
  }
  return (
    <div class="tx-publish">
      <h3 class="sheet-h3">{sending.length ? `Texts ${sending.length === 1 ? '1 person' : `${sending.length} people`}` : 'No texts this time'}</h3>
      <ul class="tx-outbox">
        {sending.map((p) => {
          const plan = texts.people[p.id].plan;
          return (
            <li key={p.id}>
              <div class="tx-who">
                <Avatar person={p} />
                <strong>{firstName(p.name)}</strong>
                {plan.reason === 'update' && <span class="tx-tag">Changed</span>}
                <span class="tx-number">{formatUsPhone(texts.people[p.id].signup?.phone ?? '')}</span>
              </div>
              <p class="tx-bubble">{plan.body}</p>
            </li>
          );
        })}
      </ul>
      {skipped.length > 0 && (
        <p class="tx-skipped">
          <span>No text:</span>{' '}
          {skipped.map((p, i) => (
            <span key={p.id}>
              {firstName(p.name)} ({SKIP_REASONS[texts.people[p.id].plan.reason] ?? texts.people[p.id].plan.reason})
              {i < skipped.length - 1 ? ', ' : ''}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

// ─── Numbers and consent ─────────────────────────────────────

export interface SignupInput {
  staffId: string;
  phone: string;
  signedOn: string;
}

function SignupForm({
  person,
  today,
  initial,
  onSave,
  onCancel,
}: {
  person: Person;
  today: string;
  initial: { phone: string; signedOn: string } | null;
  onSave: (input: SignupInput) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [phone, setPhone] = useState(initial ? formatUsPhone(initial.phone) : '');
  const [signedOn, setSignedOn] = useState(initial?.signedOn ?? today);
  const [consent, setConsent] = useState(Boolean(initial));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const normalized = normalizeUsPhone(phone);
  const id = `tx-${person.id}`;
  const phoneRef = useRef<HTMLInputElement>(null);
  useEffect(() => phoneRef.current?.focus(), []);

  return (
    <form
      class="tx-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!normalized) return setError('Type all ten digits of a US mobile number.');
        setBusy(true);
        const message = await onSave({ staffId: person.id, phone: normalized, signedOn });
        setBusy(false);
        if (message) setError(message);
      }}
    >
      <div class="field-pair">
        <div class="field">
          <label for={`${id}-phone`}>Mobile number</label>
          <input
            id={`${id}-phone`}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="678.555.1234"
            value={phone}
            onInput={(e) => {
              setPhone((e.currentTarget as HTMLInputElement).value);
              setError('');
            }}
            onBlur={() => normalized && setPhone(formatUsPhone(normalized))}
            ref={phoneRef}
          />
        </div>
        <div class="field">
          <label for={`${id}-date`}>Date on their form</label>
          <input id={`${id}-date`} type="date" max={today} value={signedOn} onInput={(e) => setSignedOn((e.currentTarget as HTMLInputElement).value)} />
        </div>
      </div>
      <label class="check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent((e.currentTarget as HTMLInputElement).checked)} />
        {firstName(person.name)} signed the schedule text consent form
      </label>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
      <div class="tx-form-actions">
        <button type="submit" class="btn btn-primary btn-small" disabled={busy || !consent || !phone.trim() || !signedOn}>
          {busy ? 'Saving…' : initial ? 'Save' : 'Save and text them'}
        </button>
        <button type="button" class="btn btn-small btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function TextsPanel({
  state,
  storeOrigin,
  onSave,
  onRemove,
  onRetry,
  onClose,
}: {
  state: WeekState;
  storeOrigin: string;
  onSave: (input: SignupInput) => Promise<string | null>;
  onRemove: (staffId: string) => Promise<string | null>;
  onRetry: (staffId: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState('');
  const texts = state.texts;
  const people = state.people.filter((p) => p.onSchedule || texts?.people[p.id]?.signup);
  const signedUp = people.filter((p) => texts?.people[p.id]?.signup).length;

  const run = async (work: Promise<string | null>) => setError((await work) ?? '');

  return (
    <Sheet
      title="Schedule texts"
      subtitle="People who sign the consent form get their shifts by text when you publish, and again only if their days ahead change."
      onClose={onClose}
    >
      <ol class="steps">
        <li>
          Print the{' '}
          <a href={`${storeOrigin}/text-consent/`} target="_blank" rel="noopener">
            consent form
          </a>{' '}
          and have them sign it. Keep it on file.
        </li>
        <li>Add their mobile number here. They get a text confirming the sign-up.</li>
        <li>Publish as usual. The Publish sheet shows each text before it goes.</li>
      </ol>
      {texts && !texts.ready && <p class="form-error">Texts are off: sent.dm isn’t set up on this site.</p>}

      <h3 class="sheet-h3">
        {signedUp} of {people.length} signed up
      </h3>
      <ul class="tx-list">
        {people.map((p) => {
          const t: PersonTexts | undefined = texts?.people[p.id];
          const signup = t?.signup ?? null;
          const isEditing = editing === p.id;
          // Offer to try again only when something is actually due: this week's
          // text failed and still differs from what they have, or the sign-up text failed.
          const failed = Boolean(
            signup && !signup.stopped && ((t?.weekText && !t.weekText.ok && t.plan.send) || (t?.signupText && !t.signupText.ok)),
          );
          return (
            <li key={p.id} class={isEditing ? 'is-editing' : ''}>
              <div class="tx-row">
                <Avatar person={p} />
                <div class="cal-what">
                  <strong>{p.name}</strong>
                  {signup ? (
                    <>
                      <span class="tx-meta">
                        <span class="nowrap">{formatUsPhone(signup.phone)}</span> · <span class="nowrap">signed {shortDate(signup.signedOn)}</span>
                      </span>
                      {signup.stopped ? (
                        <span class="tx-status tx-status--bad">
                          <span class="tx-dot" aria-hidden="true" />
                          Replied STOP. They can text START to get texts again.
                        </span>
                      ) : (
                        <>
                          <TextStatus label="This week" record={t?.weekText ?? null} today={state.today} />
                          {(!t?.weekText || (t.signupText && !t.signupText.ok)) && (
                            <TextStatus label="Sign-up text" record={t?.signupText ?? null} today={state.today} />
                          )}
                          {failed && (
                            <button type="button" class="link-btn tx-retry" onClick={() => run(onRetry(p.id))}>
                              Send again
                            </button>
                          )}
                        </>
                      )}
                    </>
                  ) : (
                    <span class="muted-line tx-meta">No texts</span>
                  )}
                </div>
                {!isEditing && (
                  <div class="cal-actions">
                    {signup ? (
                      confirmRemove === p.id ? (
                        <>
                          <button
                            type="button"
                            class="btn btn-small btn-danger"
                            onClick={async () => {
                              setConfirmRemove(null);
                              await run(onRemove(p.id));
                            }}
                          >
                            Stop texts
                          </button>
                          <button type="button" class="btn btn-small btn-ghost" onClick={() => setConfirmRemove(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" class="btn btn-small btn-ghost" onClick={() => setEditing(p.id)}>
                            Change
                          </button>
                          <button type="button" class="icon-btn" aria-label={`Stop texting ${p.name}`} onClick={() => setConfirmRemove(p.id)}>
                            <Icon name="trash" />
                          </button>
                        </>
                      )
                    ) : (
                      <button type="button" class="btn btn-small" onClick={() => setEditing(p.id)}>
                        Add number
                      </button>
                    )}
                  </div>
                )}
              </div>
              {isEditing && (
                <SignupForm
                  person={p}
                  today={state.today}
                  initial={signup ? { phone: signup.phone, signedOn: signup.signedOn } : null}
                  onSave={async (input) => {
                    const message = await onSave(input);
                    if (!message) setEditing(null);
                    return message;
                  }}
                  onCancel={() => setEditing(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
      <p class="muted-line">
        Texts list only days still ahead, so fixing a day that’s passed texts nobody. Anyone can reply STOP to end them or HELP for
        the store’s number. Each text is one message for a usual week.
      </p>
    </Sheet>
  );
}
