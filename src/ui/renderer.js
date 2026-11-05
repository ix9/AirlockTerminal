const $ = (id) => document.getElementById(id);
const root = document.documentElement.style;
if (window.airlock.platform === 'darwin') document.documentElement.classList.add('mac');

// --- Chat view follows its placeholder -------------------------------------------------

const chatSlot = $('chat');
function syncChatBounds() {
  const r = chatSlot.getBoundingClientRect();
  window.airlock.setChatBounds({
    x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
  });
}
new ResizeObserver(syncChatBounds).observe(chatSlot);

// --- Terminal ---------------------------------------------------------------------------

const term = new Terminal({
  // Nerd Fonts first so prompt themes (oh-my-posh, starship, powerlevel10k) show their icons.
  fontFamily: '"CaskaydiaCove Nerd Font Mono", "CaskaydiaMono Nerd Font Mono", ' +
    '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Cascadia Mono", Menlo, Consolas, monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: { background: '#181818', foreground: '#cccccc', selectionBackground: '#264f78' },
  // OSC 8 hyperlinks printed by programs (ls --hyperlink, gh, etc.).
  linkHandler: { activate: (_e, uri) => window.airlock.openExternal(uri) },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
// Plain-text URLs.
term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => window.airlock.openExternal(uri)));
term.open($('terminal'));
fit.fit();

// Zoom: Ctrl/Cmd + = / - / 0, and Ctrl+wheel.
const DEFAULT_FONT_SIZE = 13;
function setFontSize(size) {
  term.options.fontSize = Math.min(Math.max(size, 8), 32);
  fit.fit();
}

term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  const mod = e.ctrlKey || e.metaKey;
  // Ctrl+Shift+C copies the terminal selection (plain Ctrl+C stays as interrupt).
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
    navigator.clipboard.writeText(term.getSelection());
    return false;
  }
  if (mod && !e.altKey && (e.key === '=' || e.key === '+')) { setFontSize(term.options.fontSize + 1); return false; }
  if (mod && !e.altKey && (e.key === '-' || e.key === '_')) { setFontSize(term.options.fontSize - 1); return false; }
  if (mod && !e.altKey && e.key === '0') { setFontSize(DEFAULT_FONT_SIZE); return false; }
  return true;
});
$('terminal').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  e.stopPropagation();
  setFontSize(term.options.fontSize + (e.deltaY < 0 ? 1 : -1));
}, { passive: false, capture: true });

term.onData((data) => window.airlock.ptyInput(data));
term.onResize(({ cols, rows }) => window.airlock.ptyResize({ cols, rows }));
window.airlock.onPtyData((data) => term.write(data));
window.airlock.onPtyExit((code) => term.write(`\r\n[shell exited with code ${code}]\r\n`));
new ResizeObserver(() => fit.fit()).observe($('terminal'));

// --- Claude usage in the title bar (ADR 0003) ----------------------------------------------

function untilText(iso) {
  const ms = new Date(iso) - Date.now();
  if (!(ms > 0)) return 'now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return h ? `${h}h ${m}m` : `${m}m`;
}

function usageMeter(label, w) {
  const el = document.createElement('span');
  el.className = 'meter';
  if (w.percent >= 90) el.classList.add('crit');
  else if (w.percent >= 75) el.classList.add('warn');
  const bar = document.createElement('span');
  bar.className = 'bar';
  const fill = document.createElement('span');
  fill.style.width = `${Math.min(w.percent, 100)}%`;
  bar.append(fill);
  el.append(`${label} `, bar, ` ${Math.round(w.percent)}%`);
  if (w.resetsAt) {
    const r = document.createElement('span');
    r.className = 'resets';
    r.textContent = `resets ${untilText(w.resetsAt)}`;
    el.append(r);
    el.title = `${label} usage ${w.percent}%, resets ${new Date(w.resetsAt).toLocaleString()}`;
  }
  return el;
}

window.airlock.onUsage((usage) => {
  const parts = [];
  if (usage?.session) parts.push(usageMeter('Session', usage.session));
  if (usage?.weekly) parts.push(usageMeter('Weekly', usage.weekly));
  $('usage').replaceChildren(...parts);
});
window.airlock.refreshUsage();

// --- Toasts -------------------------------------------------------------------------------

function toast(text, { error = false, code = '' } = {}) {
  const el = document.createElement('div');
  el.className = error ? 'toast error' : 'toast';
  el.textContent = text;
  if (code) {
    const c = document.createElement('code');
    c.textContent = code;
    el.append(' ', c);
  }
  $('toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

window.airlock.onDownloadDone(({ state, displayPath }) => {
  if (state === 'completed') toast('Downloaded to', { code: displayPath });
  else toast(`Download ${state}:`, { error: true, code: displayPath });
});

// --- Shell integration: cwd + environment reported on every prompt (ADR 0002) ----------

const utf8 = new TextDecoder();
const b64 = (s) => utf8.decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

// Variables that change on their own and say nothing about what the user set.
const ENV_IGNORE = /^(PWD|OLDPWD|_|SHLVL|LINES|COLUMNS|PS1|PS2|PROMPT|RPROMPT|PROMPT_COMMAND|POSH_.*|STARSHIP_.*|__.*|COMP_.*|TERM_SESSION_ID|LS_COLORS)$/i;
// Values never shown in full, so the panel is safe to screen-share.
const SECRET = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_KEY|SESSION_KEY)/i;

let envBaseline = null;
let cwd = '';

function parseEnv(s) {
  const env = new Map();
  for (const pair of s.split('\0')) {
    const i = pair.indexOf('=', 1); // names can start with '=' on Windows (=C:)
    if (i > 0) env.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return env;
}

function renderEnv(env) {
  const bar = $('envbar');
  const chips = [];
  for (const [k, v] of env) {
    if (ENV_IGNORE.test(k) || envBaseline.get(k) === v) continue;
    const chip = document.createElement('span');
    chip.className = 'env-chip';
    const shown = SECRET.test(k) ? '••••••' : v;
    chip.innerHTML = '<b></b>=';
    chip.firstChild.textContent = k;
    chip.append(shown);
    chip.title = `${k}=${shown}`;
    chips.push(chip);
  }
  for (const k of envBaseline.keys()) {
    if (ENV_IGNORE.test(k) || env.has(k)) continue;
    const chip = document.createElement('span');
    chip.className = 'env-chip removed';
    chip.textContent = k;
    chip.title = `${k} (unset)`;
    chips.push(chip);
  }
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'ENV';
  bar.replaceChildren(label, ...chips);
  bar.hidden = chips.length === 0;
}

term.parser.registerOscHandler(7337, (data) => {
  const [tag, cwdB64, envB64] = data.split(';');
  if (tag !== 'airlock') return false;
  try {
    cwd = b64(cwdB64 || '');
    const env = parseEnv(b64(envB64 || ''));
    envBaseline ??= env;
    renderEnv(env);
    showAwsProfile(env.get('AWS_PROFILE') || '');
    window.airlock.reportCwd(cwd);
  } catch {}
  return true; // consumed: never shown in the terminal
});

// --- Shell picker -----------------------------------------------------------------------

const shellPicker = $('shell');
function startShell() {
  envBaseline = null;
  cwd = '';
  $('envbar').hidden = true;
  term.reset();
  window.airlock.ptyStart({ cols: term.cols, rows: term.rows, shellId: shellPicker.value });
  loadAwsProfiles();
  term.focus();
}

// Send a command to the terminal as if typed and entered.
function sendCommand(text) {
  term.paste(text);
  window.airlock.ptyInput('\r');
}

// --- AWS profile picker ------------------------------------------------------------------

const awsPicker = $('aws');
async function loadAwsProfiles() {
  const profiles = await window.airlock.awsProfiles();
  awsPicker.replaceChildren(new Option('AWS profile…', ''), ...profiles.map((p) => new Option(`AWS: ${p}`, p)));
  awsPicker.hidden = profiles.length === 0;
}
// Mirror AWS_PROFILE as reported by the shell, however it was set.
function showAwsProfile(name) {
  if ([...awsPicker.options].some((o) => o.value === name)) awsPicker.value = name;
}
// ~/.aws/config may have been edited elsewhere.
window.addEventListener('focus', loadAwsProfiles);
awsPicker.addEventListener('change', async () => {
  const cmd = await window.airlock.awsCommand(awsPicker.value);
  if (cmd) sendCommand(cmd);
  term.focus();
});
window.airlock.listShells().then((shells) => {
  for (const s of shells) shellPicker.add(new Option(s.label, s.id));
  startShell();
});
shellPicker.addEventListener('change', startShell);
$('restart').addEventListener('click', startShell);

// --- Airlock ----------------------------------------------------------------------------

const airlockText = $('airlock-text');
function fillAirlock(text) {
  airlockText.value = text;
  // Brief accent flash so the user notices the new content.
  airlockText.classList.add('filled');
  setTimeout(() => airlockText.classList.remove('filled'), 50);
}
window.airlock.onFill(fillAirlock);
$('paste').addEventListener('click', async () => fillAirlock(await navigator.clipboard.readText()));
$('clear').addEventListener('click', () => { airlockText.value = ''; airlockText.focus(); });

// Run: paste into the terminal (xterm.js applies bracketed paste when the shell asks for it),
// then press Enter. The text stays in the airlock so it can be tweaked and run again.
function runAirlock() {
  const text = airlockText.value.replace(/\s+$/, '');
  if (!text) return;
  sendCommand(text);
  window.airlock.addHistory(text);
  cmdHistory.push({ ts: new Date().toISOString(), command: text });
  if (libraryTab === 'history') renderLibrary();
  term.focus();
}
$('run').addEventListener('click', runAirlock);
airlockText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runAirlock(); }
});

// --- Snippets / History sidebar ----------------------------------------------------------
// Clicking an entry loads it into the airlock; it never runs anything by itself.

let snippets = [];
let cmdHistory = [];
let libraryTab = 'snippets';
const list = $('library-list');

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function item({ label, mono, meta, title, onPick, onDelete }) {
  const li = document.createElement('li');
  li.title = title;
  const name = document.createElement('span');
  name.className = mono ? 'name cmd' : 'name';
  name.textContent = label;
  li.append(name);
  if (meta) {
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = meta;
    li.append(m);
  }
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = '×';
    del.title = 'Delete snippet';
    del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
    li.append(del);
  }
  li.addEventListener('click', onPick);
  return li;
}

function renderLibrary() {
  const q = $('filter').value.trim().toLowerCase();
  const matches = (...fields) => !q || fields.some((f) => f.toLowerCase().includes(q));
  let items;
  if (libraryTab === 'snippets') {
    items = snippets.filter((s) => matches(s.name, s.command)).map((s) => item({
      label: s.name,
      title: s.command,
      onPick: () => fillAirlock(s.command),
      onDelete: async () => {
        snippets = snippets.filter((x) => x !== s);
        await window.airlock.saveSnippets(snippets);
        renderLibrary();
      },
    }));
  } else {
    // Newest first, each command once (its latest run).
    const seen = new Set();
    items = [];
    for (let i = cmdHistory.length - 1; i >= 0; i--) {
      const h = cmdHistory[i];
      if (seen.has(h.command) || !matches(h.command)) continue;
      seen.add(h.command);
      items.push(item({
        label: h.command.split('\n')[0] + (h.command.includes('\n') ? ' …' : ''),
        mono: true,
        meta: ago(h.ts),
        title: h.command,
        onPick: () => fillAirlock(h.command),
      }));
    }
  }
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = q ? 'No matches'
      : libraryTab === 'snippets' ? 'No snippets yet. Use "Save snippet".' : 'Commands you run from the airlock appear here.';
    items = [li];
  }
  list.replaceChildren(...items);
}

function showTab(tab) {
  libraryTab = tab;
  $('tab-snippets').classList.toggle('active', tab === 'snippets');
  $('tab-history').classList.toggle('active', tab === 'history');
  renderLibrary();
}
$('tab-snippets').addEventListener('click', () => showTab('snippets'));
$('tab-history').addEventListener('click', () => showTab('history'));
$('filter').addEventListener('input', renderLibrary);

// Save the airlock text as a snippet (inline name field; Electron has no prompt()).
const snippetForm = $('snippet-form');
function toggleSnippetForm(show) {
  snippetForm.hidden = !show;
  $('save-snippet').hidden = show;
  if (show) $('snippet-name').focus();
}
$('save-snippet').addEventListener('click', () => {
  if (airlockText.value.trim()) toggleSnippetForm(true);
});
$('snippet-cancel').addEventListener('click', () => toggleSnippetForm(false));
snippetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('snippet-name').value.trim();
  const command = airlockText.value.replace(/\s+$/, '');
  if (!name || !command) return;
  snippets = [...snippets.filter((s) => s.name !== name), { name, command }]
    .sort((a, b) => a.name.localeCompare(b.name));
  await window.airlock.saveSnippets(snippets);
  $('snippet-name').value = '';
  toggleSnippetForm(false);
  showTab('snippets');
});

Promise.all([window.airlock.listSnippets(), window.airlock.listHistory()]).then(([s, h]) => {
  snippets = s;
  cmdHistory = h;
  renderLibrary();
});

// --- Dividers ---------------------------------------------------------------------------

function makeSplitter(el, onMove) {
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    window.airlock.setChatVisible(false);
    const move = (ev) => onMove(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.classList.remove('dragging');
      window.airlock.setChatVisible(true);
      syncChatBounds();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
  });
}

makeSplitter($('vsplit'), (e) => {
  const min = 200;
  const x = Math.min(Math.max(e.clientX, min), window.innerWidth - min);
  root.setProperty('--left-width', `${x}px`);
});

makeSplitter($('hsplit'), (e) => {
  const h = Math.min(Math.max(window.innerHeight - e.clientY, 80), window.innerHeight - 100);
  root.setProperty('--airlock-height', `${h}px`);
});
