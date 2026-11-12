/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Email, FIRST_SCREEN, render } from '@/lib/sunny-side/email.mjs';
import { KINDS, LIMITS, LINKS, WHERE, check, clean, defaults, draftSale, isDiscount, previewBrief, sendLabel, termsLine, whole } from '@/lib/sunny-side/special.mjs';

type Kind = keyof typeof KINDS;
type Where = keyof typeof WHERE;
interface Special {
  kind: Kind | '';
  headline: string;
  tiers: { spend: number | null; percent: number | null }[];
  percent: number | null;
  what: string;
  where: Where | '';
  label: string;
  cta: string;
  link: string;
  ends: string;
  details: string;
}
interface Week { send: string; label: string; set: boolean; summary: string }
interface Other { send: string; label: string; summary: string; special: Special }
export interface AppProps {
  send: string;
  label: string;
  weeks: Week[];
  record: { special: Special; updatedAt: string; updatedBy: string } | null;
  others: Other[];
}

/** The form as typed: numbers stay text until they're read, so "1,0" isn't fought while typing. */
interface Form {
  kind: Kind | '';
  headline: string;
  tiers: { spend: string; percent: string }[];
  percent: string;
  what: string;
  where: Where | '';
  label: string;
  cta: string;
  link: string;
  linkOther: boolean;
  ends: string;
  details: string;
}

/** What the special API answers. */
interface Reply {
  error?: string;
  updatedAt: string;
  updatedBy: string;
}

const OTHER = '__other';
/** Leaving a number field tidies it to what will be saved: "1000" becomes "1,000", "20%" becomes "20". */
const tidyMoney = (v: string) => {
  const n = whole(v);
  return n === null ? v : n.toLocaleString('en-US');
};
const tidyPercent = (v: string) => {
  const n = whole(v);
  return n === null ? v : String(n);
};
const num = (n: number | null) => (n === null ? '' : String(n));
/** Amounts load the way leaving the field tidies them: 1,000. */
const money = (n: number | null) => (n === null ? '' : n.toLocaleString('en-US'));
function formOf(s: Special | null): Form {
  if (!s) {
    return { kind: '', headline: '', tiers: [{ spend: '', percent: '' }, { spend: '', percent: '' }], percent: '', what: 'everything', where: '', label: '', cta: '', link: '', linkOther: false, ends: '', details: '' };
  }
  const tiers = s.tiers?.length ? s.tiers.map((t) => ({ spend: money(t.spend), percent: num(t.percent) })) : [{ spend: '', percent: '' }, { spend: '', percent: '' }];
  return {
    kind: s.kind,
    headline: s.headline ?? '',
    tiers,
    percent: num(s.percent ?? null),
    what: s.what || 'everything',
    where: s.where ?? '',
    label: s.label ?? '',
    cta: s.cta ?? '',
    link: s.link ?? '',
    linkOther: Boolean(s.link) && !LINKS.some((l) => l.path === s.link),
    ends: s.ends ?? '',
    details: s.details ?? '',
  };
}
const specialOf = (f: Form): Special => clean(f) as Special;
/** Only what saving would keep, so switching kinds and back doesn't count as a change. */
function snapshot(f: Form): string {
  const s = specialOf(f);
  const keep: Record<string, unknown> = { kind: s.kind, label: s.label, cta: s.cta, link: s.link, details: s.details };
  if (isDiscount(s.kind)) Object.assign(keep, { where: s.where, ends: s.ends });
  if (s.kind === 'tiers') Object.assign(keep, { headline: s.headline, tiers: s.tiers });
  if (s.kind === 'percent') Object.assign(keep, { percent: s.percent, what: s.what });
  if (s.kind === 'headline') keep.headline = s.headline;
  return JSON.stringify(keep);
}

const at = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const who = (email: string) => email.split('@')[0].replace(/^./, (c) => c.toUpperCase());

// ── The preview ────────────────────────────────────────────────────────────
/** The email's own font, served by the admin: its CSP keeps Google Fonts out. */
const FONT = "<style>@font-face{font-family:'DM Sans';src:url('/fonts/DMSans-Variable.woff2') format('woff2');font-weight:100 1000;font-style:normal;}</style>";
const TOP = ['masthead', 'hero', 'offer'];

/** The top of the real email for this special, with the font swapped for the admin's copy. */
function previewHtml(sale: Record<string, unknown>, send: string): string {
  const html = render(previewBrief(sale, send), TOP);
  const swapped = html.replace(/<!--\[if !mso\]><!--><link href="https:\/\/fonts\.googleapis\.com[^>]*><!--<!\[endif\]-->/, FONT);
  if (swapped === html) throw new Error('The email’s font link changed; update the preview’s font swap.');
  return swapped;
}

/** Writes a whole document into a frame, and keeps clicks in the preview from opening the store. */
function writeFrame(frame: HTMLIFrameElement, html: string): Document | null {
  const doc = frame.contentDocument;
  if (!doc) return null;
  doc.open();
  doc.write(html);
  doc.close();
  doc.addEventListener('click', (e) => e.preventDefault(), true);
  return doc;
}

/** Swaps just the offer in a frame that already shows the top of the email, so the photo doesn't flash. */
function swapOffer(frame: HTMLIFrameElement, sale: Record<string, unknown>, send: string): boolean {
  const doc = frame.contentDocument;
  const table = doc?.querySelector<HTMLTableElement>('table[style*="max-width:600px"]');
  const row = table?.tBodies[0]?.rows[2];
  if (!row) return false;
  row.outerHTML = new Email(previewBrief(sale, send)).offer();
  return true;
}

interface Fit { buttonAt: number; spill: boolean }
async function measure(frame: HTMLIFrameElement): Promise<Fit | null> {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) return null;
  await doc.fonts?.ready;
  const button = doc.querySelector('a[href*="utm_content=offer-button"]');
  if (!button) return null;
  const spill = [...doc.querySelectorAll<HTMLElement>('p,h1,h2')].some((t) => t.getBoundingClientRect().width && t.scrollWidth > t.clientWidth + 1);
  return { buttonAt: Math.round(button.getBoundingClientRect().bottom + win.scrollY), spill };
}

// ── Small pieces ───────────────────────────────────────────────────────────
function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p class="sp-error" id={id}>
      {message}
    </p>
  ) : null;
}

function Counter({ value, limit }: { value: string; limit: number }) {
  const n = value.trim().length;
  return n > limit * 0.7 ? <span class={`sp-count${n > limit ? ' sp-over' : ''}`}>{n} of {limit}</span> : null;
}

const FIELD_ORDER = ['kind', 'headline', 'tiers', 'percent', 'what', 'where', 'ends', 'details', 'cta', 'link', 'label'];
const fieldId = (key: string) => `sp-${key.replace(/\./g, '-')}`;

export default function SpecialApp(props: AppProps) {
  const { send, label, weeks, others } = props;
  const [form, setForm] = useState<Form>(() => formOf(props.record?.special ?? null));
  const [version, setVersion] = useState<{ updatedAt: string; updatedBy: string } | null>(props.record ? { updatedAt: props.record.updatedAt, updatedBy: props.record.updatedBy } : null);
  const [savedSnap, setSavedSnap] = useState(() => (props.record ? snapshot(formOf(props.record.special)) : ''));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [view, setView] = useState<'phone' | 'computer'>('phone');
  const [fit, setFit] = useState<{ small: Fit | null; phone: Fit | null }>({ small: null, phone: null });
  const [scale, setScale] = useState(1);
  const [frameHeight, setFrameHeight] = useState(680);
  const [weekSet, setWeekSet] = useState(() => Object.fromEntries(weeks.map((w) => [w.send, w.set])));

  const special = useMemo(() => specialOf(form), [form]);
  const errors = useMemo(() => check(special, send), [special, send]);
  const kind = form.kind;
  const dirty = kind !== '' && snapshot(form) !== savedSnap;
  const d = defaults(kind || 'tiers', special.what);
  const terms = termsLine({ ...special, ends: errors.ends ? '' : special.ends });
  const sale = useMemo(() => draftSale(special), [special]);

  const layoutProblem =
    fit.small && fit.phone
      ? Math.max(fit.small.buttonAt, fit.phone.buttonAt) > FIRST_SCREEN
        ? `On a phone the button lands ${Math.max(fit.small.buttonAt, fit.phone.buttonAt) - FIRST_SCREEN} px below the first screen. Shorten the headline${kind === 'tiers' ? ' or use fewer tiers' : ''}.`
        : fit.small.spill || fit.phone.spill
          ? 'Something is too wide for a small phone. Shorten the longest words or amounts.'
          : null
      : null;
  const shown = (key: string) => (attempted || touched[key.split('.').slice(0, key.startsWith('tiers.') ? 3 : 1).join('.')] ? errors[key] : undefined);

  // ── Preview frames ──
  const frame = useRef<HTMLIFrameElement>(null);
  const small = useRef<HTMLIFrameElement>(null);
  const phone = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drawn = useRef(false);

  const width = view === 'phone' ? 390 : 640;
  // Full draws only when the frame's width changes; otherwise only the offer is swapped.
  useEffect(() => {
    drawn.current = false;
  }, [view]);

  useEffect(() => {
    const t = window.setTimeout(async () => {
      const frames = [frame.current, small.current, phone.current].filter(Boolean) as HTMLIFrameElement[];
      for (const f of frames) {
        if (!(f === frame.current ? drawn.current : f.dataset.drawn) || !swapOffer(f, sale, send)) {
          writeFrame(f, previewHtml(sale, send));
          if (f === frame.current) drawn.current = true;
          else f.dataset.drawn = '1';
        }
      }
      const [a, b] = await Promise.all([small.current ? measure(small.current) : null, phone.current ? measure(phone.current) : null]);
      setFit({ small: a, phone: b });
      const doc = frame.current?.contentDocument;
      if (doc) {
        await doc.fonts?.ready;
        setFrameHeight(Math.ceil(doc.documentElement.scrollHeight));
      }
    }, 120);
    return () => window.clearTimeout(t);
  }, [sale, send, view]);

  // The preview shrinks to fit its column, at the email's real width.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setScale(Math.min(1, entry.contentRect.width / width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  // ── Leaving with unsaved changes ──
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ── Editing ──
  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setProblem(null);
  };
  const touch = (key: string) => setTouched((t) => ({ ...t, [key]: true }));
  const setTier = (k: number, patch: Partial<Form['tiers'][number]>) => set({ tiers: form.tiers.map((t, i) => (i === k ? { ...t, ...patch } : t)) });
  const addTier = () => {
    set({ tiers: [...form.tiers, { spend: '', percent: '' }] });
    window.setTimeout(() => document.getElementById(fieldId(`tiers.${form.tiers.length}.spend`))?.focus(), 0);
  };
  const removeTier = (k: number) => set({ tiers: form.tiers.filter((_, i) => i !== k) });

  const startFrom = (sendOfOther: string) => {
    const other = others.find((o) => o.send === sendOfOther);
    if (!other) return;
    set({ ...formOf(other.special), ends: '' });
    setTouched({});
    setAttempted(false);
    document.dispatchEvent(new CustomEvent('admin:toast', { detail: { message: `Filled in from the ${other.label} email. Check it, then save.` } }));
  };

  // ── Saving ──
  const summaryRef = useRef<HTMLDivElement>(null);
  const firstError = () => FIELD_ORDER.flatMap((f) => Object.keys(errors).filter((k) => k === f || k.startsWith(`${f}.`)))[0];

  async function save() {
    if (saving) return;
    setAttempted(true);
    if (Object.keys(errors).length || layoutProblem) {
      window.setTimeout(() => summaryRef.current?.focus(), 0);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const res = await fetch('/api/admin/special/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ send, special: form, since: version?.updatedAt ?? null }),
      });
      const body = (await res.json().catch(() => ({}))) as Reply;
      if (!res.ok) {
        setProblem(body.error || 'The special couldn’t be saved. Try again.');
        return;
      }
      setVersion({ updatedAt: body.updatedAt, updatedBy: body.updatedBy });
      setSavedSnap(snapshot(form));
      setWeekSet((w) => ({ ...w, [send]: true }));
      document.dispatchEvent(new CustomEvent('admin:toast', { detail: { message: `Saved the special for ${label}` } }));
    } catch {
      setProblem('The special couldn’t be saved: the connection dropped. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    if (!version) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/special/', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ send, since: version.updatedAt }),
      });
      const body = (await res.json().catch(() => ({}))) as Reply;
      if (!res.ok) {
        setProblem(body.error || 'The special couldn’t be cleared. Try again.');
        return;
      }
      setVersion(null);
      setSavedSnap('');
      setForm(formOf(null));
      setTouched({});
      setAttempted(false);
      setConfirmClear(false);
      setWeekSet((w) => ({ ...w, [send]: false }));
      document.dispatchEvent(new CustomEvent('admin:toast', { detail: { message: `Cleared the special for ${label}` } }));
    } catch {
      setProblem('The special couldn’t be cleared: the connection dropped. Try again.');
    } finally {
      setSaving(false);
    }
  }

  // ⌘S / Ctrl+S saves
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const allErrors = Object.entries(errors).sort(([a], [b]) => FIELD_ORDER.indexOf(a.split('.')[0]) - FIELD_ORDER.indexOf(b.split('.')[0]));
  const invalid = (key: string) => (shown(key) ? { 'aria-invalid': true, 'aria-describedby': `${fieldId(key)}-error` } : {});
  const linkChoice = form.linkOther ? OTHER : form.link;
  const fold = fit.phone && fit.small ? Math.max(fit.phone.buttonAt, fit.small.buttonAt) : null;

  return (
    <div class="sp">
      <div class="page-header">
        <div>
          <h1>Weekly special</h1>
          <p class="muted">What the Sunny Side email offers. Pick the kind of special and fill it in. The preview shows exactly how the top of the email will look.</p>
        </div>
      </div>

      <nav class="sp-weeks" aria-label="Which email">
        {weeks.map((w) => (
          <a class="sp-week" href={`/admin/special/?send=${w.send}`} aria-current={w.send === send ? 'page' : undefined}>
            <span class="sp-week-label">{w.label}</span>
            <span class={`badge ${weekSet[w.send] ? 'badge-approved' : 'badge-pending'}`}>{weekSet[w.send] ? 'Set' : 'Not set'}</span>
          </a>
        ))}
      </nav>

      <div class="sp-grid">
        <form
          class="sp-form card"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h2 class="sp-title">The {label} email</h2>

          {attempted && (allErrors.length > 0 || layoutProblem) && (
            <div class="sp-summary" role="alert" tabIndex={-1} ref={summaryRef}>
              <p>
                <strong>{allErrors.length + (layoutProblem ? 1 : 0) === 1 ? 'One thing needs fixing' : `${allErrors.length + (layoutProblem ? 1 : 0)} things need fixing`} before it can be saved:</strong>
              </p>
              <ul>
                {allErrors.map(([key, message]) => (
                  <li>
                    <a href={`#${fieldId(key)}`}>{message}</a>
                  </li>
                ))}
                {layoutProblem && <li>{layoutProblem}</li>}
              </ul>
            </div>
          )}

          {problem && (
            <div class="notice" role="alert">
              <div>
                <strong>{problem}</strong>{' '}
                {/reload/i.test(problem) && (
                  <button type="button" class="btn btn-small" onClick={() => location.reload()}>
                    Reload
                  </button>
                )}
              </div>
            </div>
          )}

          <fieldset class="sp-kinds" id={fieldId('kind')} {...invalid('kind')}>
            <legend>What kind of special?</legend>
            {(Object.keys(KINDS) as Kind[]).map((k) => (
              <label class="sp-kind">
                <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => set({ kind: k })} />
                <span class="sp-kind-body">
                  <span class="sp-kind-title">{KINDS[k].title}</span>
                  <span class="sp-kind-hint">{KINDS[k].hint}</span>
                </span>
              </label>
            ))}
            <FieldError id={`${fieldId('kind')}-error`} message={shown('kind')} />
          </fieldset>

          {kind !== '' && (
            <>
              {kind !== 'percent' && (
                <div class="field">
                  <label for={fieldId('headline')}>
                    Headline <Counter value={form.headline} limit={LIMITS.headline} />
                  </label>
                  <textarea
                    id={fieldId('headline')}
                    rows={2}
                    value={form.headline}
                    placeholder={kind === 'tiers' ? 'The holidays are here. So are the savings.' : 'Black Friday sneak peeks start this Friday.'}
                    onInput={(e) => set({ headline: (e.target as HTMLTextAreaElement).value.replace(/\n/g, ' ') })}
                    onBlur={() => touch('headline')}
                    {...invalid('headline')}
                  />
                  <p class="sp-hint">The big line at the top of the gold panel.</p>
                  <FieldError id={`${fieldId('headline')}-error`} message={shown('headline')} />
                </div>
              )}

              {kind === 'tiers' && (
                <fieldset class="sp-tiers" id={fieldId('tiers')}>
                  <legend>The tiers</legend>
                  <ol class="sp-tier-list">
                    {form.tiers.map((t, k) => (
                      <li class="sp-tier">
                        <div class="sp-tier-field">
                          <label for={fieldId(`tiers.${k}.spend`)}>Spend at least</label>
                          <span class="sp-affix">
                            <span aria-hidden="true">$</span>
                            <input
                              id={fieldId(`tiers.${k}.spend`)}
                              inputMode="numeric"
                              autoComplete="off"
                              value={t.spend}
                              placeholder={['250', '500', '1,000', '2,500'][k]}
                              onInput={(e) => setTier(k, { spend: (e.target as HTMLInputElement).value })}
                              onBlur={() => {
                                setTier(k, { spend: tidyMoney(t.spend) });
                                touch(`tiers.${k}`);
                              }}
                              {...invalid(`tiers.${k}.spend`)}
                            />
                          </span>
                        </div>
                        <div class="sp-tier-field">
                          <label for={fieldId(`tiers.${k}.percent`)}>Percent off</label>
                          <span class="sp-affix sp-affix-end">
                            <input
                              id={fieldId(`tiers.${k}.percent`)}
                              inputMode="numeric"
                              autoComplete="off"
                              value={t.percent}
                              placeholder={['10', '15', '20', '25'][k]}
                              onInput={(e) => setTier(k, { percent: (e.target as HTMLInputElement).value })}
                              onBlur={() => {
                                setTier(k, { percent: tidyPercent(t.percent) });
                                touch(`tiers.${k}`);
                              }}
                              {...invalid(`tiers.${k}.percent`)}
                            />
                            <span aria-hidden="true">%</span>
                          </span>
                        </div>
                        <button
                          type="button"
                          class="btn btn-ghost btn-icon sp-remove"
                          aria-label={`Remove tier ${k + 1}`}
                          disabled={form.tiers.length <= LIMITS.tiers[0]}
                          onClick={() => removeTier(k)}
                        >
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                        <FieldError id={`${fieldId(`tiers.${k}.spend`)}-error`} message={shown(`tiers.${k}.spend`)} />
                        <FieldError id={`${fieldId(`tiers.${k}.percent`)}-error`} message={shown(`tiers.${k}.percent`)} />
                      </li>
                    ))}
                  </ol>
                  <button type="button" class="btn btn-small" onClick={addTier} disabled={form.tiers.length >= LIMITS.tiers[1]}>
                    Add a tier
                  </button>
                  <span class="sp-hint sp-inline">{form.tiers.length >= LIMITS.tiers[1] ? `${LIMITS.tiers[1]} tiers is the most the email shows.` : `${LIMITS.tiers[0]} to ${LIMITS.tiers[1]} tiers.`}</span>
                  <FieldError id={`${fieldId('tiers')}-error`} message={attempted ? errors.tiers : undefined} />
                </fieldset>
              )}

              {kind === 'percent' && (
                <div class="field-row">
                  <div class="field">
                    <label for={fieldId('percent')}>Percent off</label>
                    <span class="sp-affix sp-affix-end">
                      <input
                        id={fieldId('percent')}
                        inputMode="numeric"
                        autoComplete="off"
                        value={form.percent}
                        placeholder="20"
                        onInput={(e) => set({ percent: (e.target as HTMLInputElement).value })}
                        onBlur={() => {
                          set({ percent: tidyPercent(form.percent) });
                          touch('percent');
                        }}
                        {...invalid('percent')}
                      />
                      <span aria-hidden="true">%</span>
                    </span>
                    <FieldError id={`${fieldId('percent')}-error`} message={shown('percent')} />
                  </div>
                  <div class="field">
                    <label for={fieldId('what')}>
                      Off what <Counter value={form.what} limit={LIMITS.what} />
                    </label>
                    <input
                      id={fieldId('what')}
                      value={form.what}
                      placeholder="everything"
                      onInput={(e) => set({ what: (e.target as HTMLInputElement).value })}
                      onBlur={() => touch('what')}
                      {...invalid('what')}
                    />
                    <p class="sp-hint">Like everything, all rugs, or lighting.</p>
                    <FieldError id={`${fieldId('what')}-error`} message={shown('what')} />
                  </div>
                </div>
              )}

              {isDiscount(kind) && (
                <div class="sp-terms">
                  <fieldset class="sp-where" id={fieldId('where')} {...invalid('where')}>
                    <legend>Where the sale applies</legend>
                    {(Object.keys(WHERE) as Where[]).map((w) => (
                      <label class="sp-kind">
                        <input
                          type="radio"
                          name="where"
                          value={w}
                          checked={form.where === w}
                          onChange={() => {
                            set({ where: w });
                            touch('where');
                          }}
                        />
                        <span class="sp-kind-body">
                          <span class="sp-kind-title">{WHERE[w]}</span>
                        </span>
                      </label>
                    ))}
                    <FieldError id={`${fieldId('where')}-error`} message={shown('where')} />
                  </fieldset>
                  <div class="field sp-ends">
                    <label for={fieldId('ends')}>Last day of the sale</label>
                    <input
                      id={fieldId('ends')}
                      type="date"
                      value={form.ends}
                      min={send}
                      onInput={(e) => set({ ends: (e.target as HTMLInputElement).value })}
                      onBlur={() => touch('ends')}
                      {...invalid('ends')}
                    />
                    <FieldError id={`${fieldId('ends')}-error`} message={shown('ends')} />
                  </div>
                  <p class="sp-hint">{terms ? `The fine print under the button says “${terms}”` : 'The fine print under the button says where the sale applies and when it ends.'}</p>
                </div>
              )}

              <fieldset class="sp-details">
                <legend>Details, if you want them</legend>
                <div class="field">
                  <label for={fieldId('details')}>
                    {isDiscount(kind) ? 'More fine print' : 'Fine print'} <Counter value={form.details} limit={LIMITS.details} />
                  </label>
                  <input
                    id={fieldId('details')}
                    value={form.details}
                    placeholder={isDiscount(kind) ? 'Can’t be combined with other offers.' : 'Free gift wrap all week.'}
                    onInput={(e) => set({ details: (e.target as HTMLInputElement).value })}
                    onBlur={() => touch('details')}
                    {...invalid('details')}
                  />
                  {isDiscount(kind) && <p class="sp-hint">Anything else customers should know. It comes after the terms.</p>}
                  <FieldError id={`${fieldId('details')}-error`} message={shown('details')} />
                </div>
                <div class="field-row">
                  <div class="field">
                    <label for={fieldId('cta')}>
                      Button says <Counter value={form.cta} limit={LIMITS.cta} />
                    </label>
                    <input
                      id={fieldId('cta')}
                      value={form.cta}
                      placeholder={d.cta}
                      onInput={(e) => set({ cta: (e.target as HTMLInputElement).value })}
                      onBlur={() => touch('cta')}
                      {...invalid('cta')}
                    />
                    <FieldError id={`${fieldId('cta')}-error`} message={shown('cta')} />
                  </div>
                  <div class="field">
                    <label for={fieldId('link')}>Button goes to</label>
                    <select
                      id={fieldId('link')}
                      value={linkChoice}
                      onChange={(e) => {
                        const v = (e.target as HTMLSelectElement).value;
                        set(v === OTHER ? { linkOther: true, link: '' } : { linkOther: false, link: v });
                        if (v === OTHER) window.setTimeout(() => document.getElementById(fieldId('link-path'))?.focus(), 0);
                      }}
                      {...(form.linkOther ? {} : invalid('link'))}
                    >
                      <option value="">Usual: {LINKS.find((l) => l.path === d.link)?.label}</option>
                      {LINKS.map((l) => (
                        <option value={l.path}>{l.label}</option>
                      ))}
                      <option value={OTHER}>Another page on the site…</option>
                    </select>
                    {form.linkOther && (
                      <input
                        id={fieldId('link-path')}
                        class="sp-path"
                        aria-label="The page's address on sunnyandranney.com"
                        value={form.link}
                        placeholder="/shop/?collection=rugs"
                        onInput={(e) => set({ link: (e.target as HTMLInputElement).value })}
                        onBlur={() => touch('link')}
                        {...invalid('link')}
                      />
                    )}
                    <FieldError id={`${fieldId('link')}-error`} message={shown('link')} />
                  </div>
                </div>
                <div class="field">
                  <label for={fieldId('label')}>
                    Small label over the headline <Counter value={form.label} limit={LIMITS.label} />
                  </label>
                  <input
                    id={fieldId('label')}
                    value={form.label}
                    placeholder={d.label}
                    onInput={(e) => set({ label: (e.target as HTMLInputElement).value })}
                    onBlur={() => touch('label')}
                    {...invalid('label')}
                  />
                  <FieldError id={`${fieldId('label')}-error`} message={shown('label')} />
                </div>
              </fieldset>
            </>
          )}

          <div class="sp-actions">
            <button type="submit" class="btn btn-primary" disabled={saving || kind === '' || (!dirty && Boolean(version))}>
              {saving ? 'Saving…' : version && !dirty ? 'Saved' : 'Save the special'}
            </button>
            <span class="sp-status" aria-live="polite">
              {dirty ? 'Unsaved changes' : version ? `Saved ${at.format(new Date(version.updatedAt))} by ${who(version.updatedBy)}` : 'Not set yet'}
            </span>
          </div>

          <div class="sp-more">
            {others.length > 0 && (
              <div class="field sp-start">
                <label for={fieldId('start')}>Start from another week’s special</label>
                <select
                  id={fieldId('start')}
                  value=""
                  onChange={(e) => {
                    startFrom((e.target as HTMLSelectElement).value);
                    (e.target as HTMLSelectElement).value = '';
                  }}
                >
                  <option value="">Pick one…</option>
                  {others.map((o) => (
                    <option value={o.send}>
                      {o.label}: {o.summary}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {version &&
              (confirmClear ? (
                <div class="sp-confirm" role="group" aria-label="Clear the special">
                  <span>Clear the special for {label}?</span>
                  <button type="button" class="btn btn-small" onClick={() => setConfirmClear(false)}>
                    Keep it
                  </button>
                  <button type="button" class="btn btn-small btn-danger" onClick={() => void clear()} disabled={saving}>
                    Clear it
                  </button>
                </div>
              ) : (
                <button type="button" class="btn btn-ghost btn-small btn-danger" onClick={() => setConfirmClear(true)}>
                  Clear this week
                </button>
              ))}
          </div>
        </form>

        <section class="sp-preview card" aria-labelledby="sp-preview-title">
          <div class="sp-preview-head">
            <h2 class="sp-title" id="sp-preview-title">
              Preview
            </h2>
            <div class="btn-group" role="group" aria-label="Preview size">
              <button type="button" class="btn btn-small" aria-pressed={view === 'phone'} onClick={() => setView('phone')}>
                Phone
              </button>
              <button type="button" class="btn btn-small" aria-pressed={view === 'computer'} onClick={() => setView('computer')}>
                Computer
              </button>
            </div>
          </div>
          <p class="sp-hint">The top of the email, exactly as customers will see it. The photo is the photographer’s each week.</p>

          <ul class="sp-checks" aria-live="polite">
            {fold === null ? (
              <li class="sp-check">Checking the fit…</li>
            ) : (
              <>
                <li class={`sp-check ${fold <= FIRST_SCREEN ? 'is-ok' : 'is-bad'}`}>
                  {fold <= FIRST_SCREEN
                    ? `The button is on a phone’s first screen (${fold} of ${FIRST_SCREEN} px).`
                    : `The button lands ${fold - FIRST_SCREEN} px below a phone’s first screen.`}
                </li>
                <li class={`sp-check ${fit.small?.spill || fit.phone?.spill ? 'is-bad' : 'is-ok'}`}>
                  {fit.small?.spill || fit.phone?.spill ? 'Something is too wide for a small phone.' : 'Everything fits a small phone (320 px).'}
                </li>
              </>
            )}
          </ul>

          <div class="sp-stage" ref={stage}>
            <div class={`sp-device sp-${view}`} style={{ width: `${width * scale}px`, height: `${frameHeight * scale}px` }}>
              <iframe
                ref={frame}
                title={`Preview of the email at ${view === 'phone' ? 'phone' : 'computer'} width`}
                tabIndex={-1}
                style={{ width: `${width}px`, height: `${frameHeight}px`, transform: `scale(${scale})` }}
              />
              {view === 'phone' && (
                <div class="sp-fold" style={{ top: `${FIRST_SCREEN * scale}px` }} aria-hidden="true">
                  <span>A phone shows this much before scrolling</span>
                </div>
              )}
            </div>
          </div>

          <div class="sp-measure" aria-hidden="true">
            <iframe ref={small} tabIndex={-1} title="" style={{ width: '320px', height: '700px' }} />
            <iframe ref={phone} tabIndex={-1} title="" style={{ width: '390px', height: '700px' }} />
          </div>
        </section>
      </div>
    </div>
  );
}
