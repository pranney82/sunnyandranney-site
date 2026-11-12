/**
 * Behaviour every admin page shares: short confirmations (toasts), refreshing
 * part of a page without a reload, the ⌘K search, and keyboard shortcuts.
 * Loaded once by AdminBase as a bundled module, so the admin's CSP holds.
 */

// ─── Toasts ──────────────────────────────────────────────────

let region: HTMLElement | null = null;

/** A short confirmation at the bottom of the screen. Screen readers hear it too. */
export function toast(message: string, tone: "ok" | "error" = "ok"): void {
  if (!region) {
    region = document.createElement("div");
    region.className = "toasts";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  const item = document.createElement("p");
  item.className = `toast toast-${tone}`;
  item.textContent = message;
  region.appendChild(item);
  setTimeout(
    () => item.classList.add("toast-out"),
    tone === "error" ? 6000 : 3200,
  );
  setTimeout(() => item.remove(), tone === "error" ? 6400 : 3600);
}

// ─── Refresh in place ────────────────────────────────────────

/**
 * Re-renders the parts of this page matching `selectors` from the server, so
 * a change shows without a reload, keeping scroll position and focus where it
 * can. Pages bind their buttons with event delegation, so swapped-in markup
 * works at once.
 */
export async function refreshParts(...selectors: string[]): Promise<boolean> {
  try {
    const res = await fetch(location.href, {
      headers: { Accept: "text/html" },
    });
    if (!res.ok) return false;
    const next = new DOMParser().parseFromString(await res.text(), "text/html");
    const focusedId = document.activeElement?.id;
    for (const selector of selectors) {
      const now = document.querySelector(selector);
      const fresh = next.querySelector(selector);
      if (now && fresh) now.replaceWith(document.importNode(fresh, true));
    }
    if (focusedId)
      document.getElementById(focusedId)?.focus({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}

// ─── Command palette (⌘K) ────────────────────────────────────

interface Command {
  label: string;
  hint: string;
  href: string;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
let palette: HTMLDialogElement | null = null;
let people: Command[] | null = null;

function pageCommands(): Command[] {
  const seen = new Set<string>();
  return [...document.querySelectorAll<HTMLAnchorElement>(".side-link")]
    .filter((link) => !seen.has(link.href) && seen.add(link.href))
    .map((link) => ({
      label: link.textContent?.trim() ?? "",
      hint: "Page",
      href: link.href,
    }));
}

async function loadPeople(): Promise<Command[]> {
  if (people) return people;
  try {
    const res = await fetch("/api/admin/people/", {
      headers: { Accept: "application/json" },
    });
    const data = res.ok
      ? ((await res.json()) as { people: Array<{ id: string; name: string }> })
      : { people: [] };
    people = data.people.map((p) => ({
      label: p.name,
      hint: "Person",
      href: `/admin/staff/${encodeURIComponent(p.id)}/`,
    }));
  } catch {
    people = [];
  }
  return people;
}

/** Matches every typed word against the start of a word in the label. */
function matches(label: string, query: string): boolean {
  const words = label.toLowerCase().split(/[\s&-]+/);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(
      (part) =>
        words.some((word) => word.startsWith(part)) ||
        label.toLowerCase().includes(part),
    );
}

function openPalette(): void {
  if (!palette) palette = buildPalette();
  const input = palette.querySelector<HTMLInputElement>("input")!;
  input.value = "";
  palette.showModal();
  render(palette, "");
  void loadPeople().then(() => palette?.open && render(palette, input.value));
}

function buildPalette(): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.className = "palette";
  dialog.setAttribute("aria-label", "Go to");
  dialog.innerHTML = `
    <div class="palette-box">
      <input type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
        placeholder="Go to a page or a person" autocomplete="off" spellcheck="false" />
      <ul id="palette-list" role="listbox"></ul>
      <p class="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> to choose · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close</p>
    </div>`;
  document.body.appendChild(dialog);
  const input = dialog.querySelector<HTMLInputElement>("input")!;
  input.addEventListener("input", () => render(dialog, input.value));
  input.addEventListener("keydown", (event) => {
    const options = [
      ...dialog.querySelectorAll<HTMLElement>('[role="option"]'),
    ];
    const current = options.findIndex(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
        options.length;
      select(input, options, next);
    } else if (event.key === "Enter" && options[current]) {
      event.preventDefault();
      location.href = options[current].dataset.href!;
    }
  });
  dialog.addEventListener("click", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>(
      '[role="option"]',
    );
    if (option) location.href = option.dataset.href!;
    else if (event.target === dialog) dialog.close();
  });
  return dialog;
}

function select(
  input: HTMLInputElement,
  options: HTMLElement[],
  index: number,
): void {
  options.forEach((option, i) =>
    option.setAttribute("aria-selected", String(i === index)),
  );
  const chosen = options[index];
  if (chosen) {
    input.setAttribute("aria-activedescendant", chosen.id);
    chosen.scrollIntoView({ block: "nearest" });
  }
}

function render(dialog: HTMLDialogElement, query: string): void {
  const list = dialog.querySelector("ul")!;
  const all = [...pageCommands(), ...(people ?? [])];
  // Nothing typed: every page, so none is out of reach. Typed: the best dozen.
  const found = query.trim()
    ? all.filter((command) => matches(command.label, query)).slice(0, 12)
    : pageCommands();
  list.textContent = "";
  found.forEach((command, index) => {
    const li = document.createElement("li");
    li.id = `palette-${index}`;
    li.setAttribute("role", "option");
    li.dataset.href = command.href;
    const label = document.createElement("span");
    label.textContent = command.label;
    const hint = document.createElement("span");
    hint.className = "palette-hint";
    hint.textContent = command.hint;
    li.appendChild(label);
    li.appendChild(hint);
    list.appendChild(li);
  });
  if (found.length === 0) {
    const empty = document.createElement("li");
    empty.className = "palette-empty";
    empty.textContent = "Nothing matches.";
    list.appendChild(empty);
  }
  select(
    dialog.querySelector("input")!,
    [...list.querySelectorAll<HTMLElement>('[role="option"]')],
    0,
  );
}

// ─── Keyboard shortcuts ──────────────────────────────────────

const GO: Record<string, { href: string; label: string }> = {
  t: { href: "/admin/", label: "Today" },
  h: { href: "/admin/hours/", label: "Hours" },
  s: { href: "/admin/staff/", label: "Staff" },
  p: { href: "/admin/payroll/", label: "Payroll" },
  c: { href: "/admin/schedule/", label: "Schedule" },
};

let help: HTMLDialogElement | null = null;

function openHelp(): void {
  if (!help) {
    help = document.createElement("dialog");
    help.className = "shortcuts";
    help.setAttribute("aria-labelledby", "shortcuts-title");
    const available = Object.entries(GO).filter(([, go]) =>
      document.querySelector(`.side-link[href="${go.href}"]`),
    );
    help.innerHTML = `
      <h2 id="shortcuts-title">Keyboard shortcuts</h2>
      <dl>
        <dt><kbd>${isMac ? "⌘" : "Ctrl"}</kbd><kbd>K</kbd></dt><dd>Go to a page or a person</dd>
        ${available.map(([key, go]) => `<dt><kbd>G</kbd><kbd>${key.toUpperCase()}</kbd></dt><dd>${go.label}</dd>`).join("")}
        <dt><kbd>?</kbd></dt><dd>This list</dd>
      </dl>
      <form method="dialog"><button class="btn">Close</button></form>`;
    document.body.appendChild(help);
  }
  help.showModal();
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(
    el?.closest('input, textarea, select, [contenteditable="true"]'),
  );
}

let pendingG = 0;
if (!isMac)
  document
    .querySelectorAll(".search-kbd")
    .forEach((kbd) => (kbd.textContent = "Ctrl K"));
if (document.querySelector(".side-link")) {
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (palette?.open) palette.close();
      else openPalette();
      return;
    }
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      typing(event.target) ||
      document.querySelector("dialog[open]")
    )
      return;
    if (event.key === "?") {
      event.preventDefault();
      openHelp();
    } else if (event.key === "g") {
      pendingG = Date.now();
    } else if (Date.now() - pendingG < 1200 && GO[event.key]) {
      const link = document.querySelector<HTMLAnchorElement>(
        `.side-link[href="${GO[event.key].href}"]`,
      );
      if (link) location.href = link.href;
      pendingG = 0;
    }
  });
  document
    .querySelector("[data-open-palette]")
    ?.addEventListener("click", openPalette);
}

// ─── Navigation ──────────────────────────────────────────────

// The sidebar list scrolls on an iPad or a short window. Bring the current page
// into view, and mark the edges that have more, since Safari hides scrollbars.
const sideNav = document.querySelector<HTMLElement>(".side-nav");
if (sideNav) {
  const current = sideNav.querySelector<HTMLElement>('[aria-current="page"]');
  if (current) {
    const box = sideNav.getBoundingClientRect();
    const row = current.getBoundingClientRect();
    if (row.bottom > box.bottom) sideNav.scrollTop += row.bottom - box.bottom + box.height / 3;
  }
  const markEdges = () => {
    sideNav.classList.toggle("more-above", sideNav.scrollTop > 1);
    sideNav.classList.toggle(
      "more-below",
      sideNav.scrollTop + sideNav.clientHeight < sideNav.scrollHeight - 1,
    );
  };
  sideNav.addEventListener("scroll", markEdges, { passive: true });
  new ResizeObserver(markEdges).observe(sideNav);
  markEdges();
}

// The phone's More sheet closes like an iOS menu: a tap outside it, or Escape.
// That tap only closes the sheet, so it can't press a button on the page under
// it; the other tabs still work, as in a tab bar.
const more = document.querySelector<HTMLDetailsElement>(".tab-more");
if (more) {
  let closedAt = -Infinity;
  document.addEventListener("pointerdown", (event) => {
    if (!more.open || more.contains(event.target as Node)) return;
    more.open = false;
    if (!(event.target as Element).closest(".tabbar")) closedAt = event.timeStamp;
  });
  document.addEventListener("pointercancel", () => (closedAt = -Infinity));
  document.addEventListener(
    "click",
    (event) => {
      if (event.timeStamp - closedAt > 1000) return;
      closedAt = -Infinity;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !more.open) return;
    more.open = false;
    more.querySelector("summary")?.focus();
  });
}
