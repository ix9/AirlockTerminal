const $ = (id) => document.getElementById(id);
const root = document.documentElement.style;
if (window.airlock.platform === 'darwin') document.documentElement.classList.add('mac');

// --- Settings -----------------------------------------------------------------------------

const prefs = { ...window.airlock.initial.settings };
function saveSetting(key, value) {
  prefs[key] = value;
  window.airlock.setSettings({ [key]: value });
}

if (prefs.leftWidth) root.setProperty('--left-width', `${prefs.leftWidth}%`);
if (prefs.airlockHeight) root.setProperty('--airlock-height', `${prefs.airlockHeight}%`);
if (prefs.scratchLeft) root.setProperty('--scratch-left', `${prefs.scratchLeft}%`);

let theme = window.airlock.initial.theme;
document.documentElement.dataset.theme = theme;

// --- Chat view follows its placeholder -------------------------------------------------

const chatSlot = $('chat');
function syncChatBounds() {
  const r = chatSlot.getBoundingClientRect();
  window.airlock.setChatBounds({
    x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
  });
}
new ResizeObserver(syncChatBounds).observe(chatSlot);

// --- Terminals ----------------------------------------------------------------------------
// One xterm.js per tab. Tabs in the background keep running and keep receiving output.

const DEFAULT_FONT_SIZE = 13;
const SCROLLBACK_LINES = 5000;

const tabs = [];
const tabsById = new Map();
const shellLabels = new Map();
let activeTab = null;
let nextTabId = 1;
let fontSize = prefs.fontSize ?? DEFAULT_FONT_SIZE;
let outputChanged = false;

const terminalAppearance = () => ({
  theme: TERMINAL_THEMES[theme].colors,
  minimumContrastRatio: TERMINAL_THEMES[theme].minimumContrastRatio,
});

// Zoom: Ctrl/Cmd + = / - / 0, and Ctrl+wheel. Applies to every tab.
function setFontSize(size) {
  fontSize = Math.min(Math.max(size, 8), 32);
  for (const tab of tabs) {
    tab.term.options.fontSize = fontSize;
    tab.fit.fit();
  }
  saveSetting('fontSize', fontSize);
}
$('terminal').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  e.stopPropagation();
  setFontSize(fontSize + (e.deltaY < 0 ? 1 : -1));
}, { passive: false, capture: true });
new ResizeObserver(() => { for (const tab of tabs) tab.fit.fit(); }).observe($('terminal'));

function tabLabel(tab) {
  const shellName = (shellLabels.get(tab.shellId) ?? 'Terminal').split(/[\\/]/).pop();
  return tab.cwd.split(/[\\/]/).filter(Boolean).pop() || tab.cwd || shellName;
}
// The status bar's right side describes the active terminal.
function updateStatusBar() {
  if (!activeTab) return;
  $('status-cwd').textContent = activeTab.cwd;
  $('status-cwd').title = activeTab.cwd;
  $('status-shell').textContent = shellLabels.get(activeTab.shellId) ?? '';
  const aws = activeTab.env?.get('AWS_PROFILE');
  $('status-aws').textContent = aws ? `AWS: ${aws}` : '';
}
function updateTabLabel(tab) {
  if (tab === activeTab) updateStatusBar();
  tab.labelEl.textContent = tabLabel(tab);
  tab.el.title = [tab.cwd, shellLabels.get(tab.shellId)].filter(Boolean).join('\n');
  tab.el.classList.toggle('exited', tab.exited);
}

function createTab(shellId) {
  const host = document.createElement('div');
  host.className = 'terminal-host';
  $('terminal').append(host);

  const term = new Terminal({
    // Nerd Fonts first so prompt themes (oh-my-posh, starship, powerlevel10k) show their icons.
    fontFamily: '"CaskaydiaCove Nerd Font Mono", "CaskaydiaMono Nerd Font Mono", ' +
      '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Cascadia Mono", Menlo, Consolas, monospace',
    fontSize,
    scrollback: SCROLLBACK_LINES,
    cursorBlink: true,
    ...terminalAppearance(),
    // OSC 8 hyperlinks printed by programs (ls --hyperlink, gh, etc.).
    linkHandler: { activate: (_e, uri) => window.airlock.openExternal(uri) },
  });
  const fit = new FitAddon.FitAddon();
  const serializer = new SerializeAddon.SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(serializer);
  // Plain-text URLs.
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => window.airlock.openExternal(uri)));
  term.open(host);
  fit.fit();

  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  const closeButton = document.createElement('button');
  closeButton.className = 'tab-close';
  closeButton.textContent = '×';
  closeButton.title = 'Close terminal';
  const el = document.createElement('div');
  el.className = 'tab';
  el.append(labelEl, closeButton);
  $('terminal-tabs').append(el);

  const tab = {
    id: nextTabId++, shellId, host, term, fit, serializer, el, labelEl,
    cwd: '', env: null, envBaseline: null, awsProfiles: [], exited: false,
  };
  tabs.push(tab);
  tabsById.set(tab.id, tab);
  updateTabLabel(tab);

  el.addEventListener('click', () => activateTab(tab));
  el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(tab); });
  closeButton.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab); });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    // Ctrl+Shift+C copies the terminal selection (plain Ctrl+C stays as interrupt).
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (mod && !e.altKey && (e.key === '=' || e.key === '+')) { setFontSize(fontSize + 1); return false; }
    if (mod && !e.altKey && (e.key === '-' || e.key === '_')) { setFontSize(fontSize - 1); return false; }
    if (mod && !e.altKey && e.key === '0') { setFontSize(DEFAULT_FONT_SIZE); return false; }
    return true;
  });
  term.onData((data) => window.airlock.ptyInput(tab.id, data));
  term.onResize(({ cols, rows }) => window.airlock.ptyResize(tab.id, { cols, rows }));
  term.parser.registerOscHandler(7337, (data) => handleShellReport(tab, data));
  return tab;
}

function startShell(tab, { keepOutput = false } = {}) {
  tab.env = null;
  tab.envBaseline = null;
  tab.cwd = '';
  tab.exited = false;
  if (!keepOutput) tab.term.reset();
  window.airlock.ptyStart({ id: tab.id, cols: tab.term.cols, rows: tab.term.rows, shellId: tab.shellId });
  updateTabLabel(tab);
  if (tab === activeTab) showTabState();
  loadAwsProfiles(tab);
}

function activateTab(tab) {
  activeTab?.host.classList.remove('active');
  activeTab?.el.classList.remove('active');
  activeTab = tab;
  tab.host.classList.add('active');
  window.airlock.ptyActivate(tab.id);
  showTabState();
  showView('terminal');
  tab.el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// The controls above the terminal describe the active tab.
function showTabState() {
  updateStatusBar();
  shellPicker.value = activeTab.shellId;
  renderEnv(activeTab);
  renderAwsPicker();
}

function newTab() {
  const tab = createTab(activeTab?.shellId ?? defaultShellId());
  activateTab(tab);
  startShell(tab);
  outputChanged = true;
}

async function closeTab(tab) {
  if (tab.closing) return;
  tab.closing = true;
  if (!(await window.airlock.ptyConfirmClose(tab.id))) { tab.closing = false; return; }
  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  tabsById.delete(tab.id);
  window.airlock.ptyClose(tab.id);
  tab.term.dispose();
  tab.host.remove();
  tab.el.remove();
  outputChanged = true;
  if (activeTab === tab) {
    activeTab = null;
    const next = tabs[Math.min(index, tabs.length - 1)];
    if (next) activateTab(next);
    else newTab(); // there's always a terminal to run things in
  }
}

window.airlock.onPtyData((id, data) => {
  tabsById.get(id)?.term.write(data);
  outputChanged = true;
});
window.airlock.onPtyExit((id, code) => {
  const tab = tabsById.get(id);
  if (!tab) return;
  tab.exited = true;
  tab.term.write(`\r\n[shell exited with code ${code}]\r\n`);
  updateTabLabel(tab);
});

$('new-tab').addEventListener('click', newTab);

// Cmd on macOS. Elsewhere Ctrl+Shift, since the shell uses plain Ctrl+T and Ctrl+W.
window.addEventListener('keydown', (e) => {
  if (!activeTab) return; // still starting up
  const appKey = window.airlock.platform === 'darwin'
    ? e.metaKey && !e.ctrlKey && !e.shiftKey
    : e.ctrlKey && e.shiftKey && !e.metaKey;
  let action = null;
  if (appKey && !e.altKey && e.code === 'KeyT') action = newTab;
  else if (appKey && !e.altKey && e.code === 'KeyW') action = () => { if (view === 'terminal') closeTab(activeTab); };
  else if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
    action = () => activateTab(tabs[(tabs.indexOf(activeTab) + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]);
  }
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  action();
}, { capture: true });

// --- Terminal, Scratchpad and Settings share the terminal area ------------------------------

let view = 'terminal';
function showView(next, { focus = true } = {}) {
  view = next;
  $('scratchpad').hidden = view !== 'scratchpad';
  $('settings').hidden = view !== 'settings';
  $('terminal-wrap').classList.toggle('overlay-open', view !== 'terminal');
  activeTab?.el.classList.toggle('active', view === 'terminal');
  $('tab-scratchpad').classList.toggle('active', view === 'scratchpad');
  $('tab-settings').classList.toggle('active', view === 'settings');
  if (!focus) return;
  if (view === 'terminal') activeTab?.term.focus();
  else if (view === 'scratchpad') activePad.textarea.focus();
}
const toggleView = (name) => showView(view === name ? 'terminal' : name);
$('tab-scratchpad').addEventListener('click', () => toggleView('scratchpad'));
$('tab-settings').addEventListener('click', () => toggleView('settings'));

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

// --- Status bar ----------------------------------------------------------------------------

let statusTimer = null;
function setStatus(text, ms) {
  clearTimeout(statusTimer);
  $('status-message').textContent = text;
  statusTimer = setTimeout(() => { $('status-message').textContent = ''; }, ms);
}

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

function parseEnv(s) {
  const env = new Map();
  for (const pair of s.split('\0')) {
    const i = pair.indexOf('=', 1); // names can start with '=' on Windows (=C:)
    if (i > 0) env.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return env;
}

function renderEnv(tab) {
  const { env, envBaseline } = tab;
  const bar = $('envbar');
  if (!env) { bar.hidden = true; return; }
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

function handleShellReport(tab, data) {
  const [tag, cwdB64, envB64] = data.split(';');
  if (tag !== 'airlock') return false;
  try {
    tab.cwd = b64(cwdB64 || '');
    tab.env = parseEnv(b64(envB64 || ''));
    tab.envBaseline ??= tab.env;
    updateTabLabel(tab);
    window.airlock.reportCwd(tab.id, tab.cwd);
    if (tab === activeTab) {
      renderEnv(tab);
      showAwsProfile(tab);
    }
  } catch {}
  return true; // consumed: never shown in the terminal
}

// --- Shell picker -----------------------------------------------------------------------

const shellPicker = $('shell');
const defaultShellId = () => (shellLabels.has(prefs.lastShell) ? prefs.lastShell : shellLabels.keys().next().value);

// Send a command to the active terminal as if typed and entered.
function sendCommand(text, { focus = true } = {}) {
  if (view !== 'terminal') showView('terminal', { focus }); // nothing runs out of sight
  activeTab.term.paste(text);
  window.airlock.ptyInput(activeTab.id, '\r');
}

// --- AWS profile picker ------------------------------------------------------------------

const awsPicker = $('aws');
async function loadAwsProfiles(tab) {
  const profiles = await window.airlock.awsProfiles(tab.id);
  tab.awsProfiles = profiles;
  if (tab === activeTab) renderAwsPicker();
}
function renderAwsPicker() {
  const profiles = activeTab.awsProfiles;
  awsPicker.replaceChildren(new Option('AWS profile…', ''), ...profiles.map((p) => new Option(`AWS: ${p}`, p)));
  awsPicker.hidden = profiles.length === 0;
  showAwsProfile(activeTab);
}
// Mirror AWS_PROFILE as reported by the shell, however it was set.
function showAwsProfile(tab) {
  const name = tab.env?.get('AWS_PROFILE') ?? '';
  awsPicker.value = [...awsPicker.options].some((o) => o.value === name) ? name : '';
}
// ~/.aws/config may have been edited elsewhere.
window.addEventListener('focus', () => { if (activeTab) loadAwsProfiles(activeTab); });
awsPicker.addEventListener('change', async () => {
  const cmd = await window.airlock.awsCommand(activeTab.id, awsPicker.value);
  if (cmd) sendCommand(cmd);
  if (view === 'terminal') activeTab.term.focus();
});
shellPicker.addEventListener('change', () => {
  activeTab.shellId = shellPicker.value;
  saveSetting('lastShell', shellPicker.value);
  startShell(activeTab);
  activeTab.term.focus();
});
$('restart').addEventListener('click', () => {
  startShell(activeTab);
  if (view === 'terminal') activeTab.term.focus();
});

// --- Airlock ----------------------------------------------------------------------------

const airlockText = $('airlock-text');
function fillAirlock(text) {
  airlockText.value = text;
  // Brief accent flash so the user notices the new content.
  airlockText.classList.add('filled');
  setTimeout(() => airlockText.classList.remove('filled'), 50);
}
window.airlock.onFill(({ text, gesture, autoRunOff }) => receiveCopy(text, gesture, { autoRunOff }));
$('paste').addEventListener('click', async () => fillAirlock(await navigator.clipboard.readText()));
$('clear').addEventListener('click', () => { airlockText.value = ''; airlockText.focus(); });

// Copied text goes to the airlock. The same text copied again quickly, by a separate real click
// or key press, also runs (ADR 0005). `gesture` is null if no such press caused the copy, as when
// a page script calls the clipboard itself, and that can never run anything.
const DOUBLE_COPY_MS = 1500;
const STATUS_RAN_MS = 4000;
let lastCopy = null;

function receiveCopy(text, gesture, { autoRunOff = false } = {}) {
  fillAirlock(text);
  const enabled = prefs.doubleCopyRun !== false;
  const now = Date.now();
  const isDouble = enabled && gesture && lastCopy?.gesture && lastCopy.gesture !== gesture
    && lastCopy.text === text && now - lastCopy.at <= DOUBLE_COPY_MS;
  if (!isDouble) {
    lastCopy = { text, gesture, at: now };
    const message = enabled && gesture ? 'Sent to Airlock, copy again quickly to auto-run'
      : autoRunOff ? 'Sent to Airlock. Auto-run is off for this site.' : 'Sent to Airlock';
    setStatus(message, DOUBLE_COPY_MS);
    return;
  }
  lastCopy = null; // a third copy starts over rather than running again
  if (activeTab.exited) {
    setStatus('Not run: this terminal\'s shell has exited', STATUS_RAN_MS);
    return;
  }
  // Focus stays put: on Windows and Linux, another Ctrl+C in the terminal would interrupt the command.
  runText(text, { focus: false });
  setStatus(`Ran in terminal: ${text.trim().split('\n')[0]}`, STATUS_RAN_MS);
}

// Run: paste into the terminal (xterm.js applies bracketed paste when the shell asks for it),
// then press Enter. The text stays in the airlock so it can be tweaked and run again.
function runText(raw, { focus = true } = {}) {
  const text = raw.replace(/\s+$/, '');
  if (!text) return;
  sendCommand(text, { focus });
  window.airlock.addHistory(text);
  cmdHistory.push({ ts: new Date().toISOString(), command: text });
  if (libraryTab === 'history') renderLibrary();
  if (focus) activeTab.term.focus();
}
const runAirlock = () => runText(airlockText.value);
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

// Reports a failure and shows what's really on disk, so the list never claims an unsaved change.
async function storeSnippets(next) {
  const { error } = await window.airlock.saveSnippets(next);
  if (error) {
    toast(error, { error: true });
    await loadSnippets();
    return false;
  }
  snippets = next;
  renderLibrary();
  return true;
}
async function loadSnippets({ quiet = false } = {}) {
  const { list: loaded, error } = await window.airlock.listSnippets();
  snippets = loaded;
  if (error && !quiet) toast(error, { error: true });
  renderLibrary();
}
// A synced folder may have changed while the app was in the background.
window.addEventListener('focus', () => loadSnippets({ quiet: true }));

function renderLibrary() {
  const q = $('filter').value.trim().toLowerCase();
  const matches = (...fields) => !q || fields.some((f) => f.toLowerCase().includes(q));
  let items;
  if (libraryTab === 'snippets') {
    items = snippets.filter((s) => matches(s.name, s.command)).map((s) => item({
      label: s.name,
      title: s.command,
      onPick: () => fillAirlock(s.command),
      onDelete: () => storeSnippets(snippets.filter((x) => x !== s)),
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
  const next = [...snippets.filter((s) => s.name !== name), { name, command }]
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!(await storeSnippets(next))) return;
  $('snippet-name').value = '';
  toggleSnippetForm(false);
  showTab('snippets');
});

loadSnippets();
window.airlock.listHistory().then((h) => {
  cmdHistory = h;
  renderLibrary();
});

// --- Scratchpad ---------------------------------------------------------------------------
// Takes over the terminal area while the shell keeps running underneath.

const scratchpad = $('scratchpad');
const scratchSplit = $('scratch-split');
let activePad;

function makePad() {
  const el = $('pad-template').content.firstElementChild.cloneNode(true);
  const q = (selector) => el.querySelector(selector);
  const textarea = q('textarea');
  const pad = { el, textarea };

  const execute = () => {
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    if (selected.trim()) runText(selected);
    else toast('Highlight the text to execute first.', { error: true });
  };
  q('.execute').addEventListener('click', execute);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); execute(); }
  });
  textarea.addEventListener('focus', () => { activePad = pad; });

  // Inline name field, as for snippets (Electron has no prompt()).
  const form = q('.save-form');
  const name = q('.save-name');
  const toggleSave = (show) => {
    form.hidden = !show;
    q('.save').hidden = show;
    if (show) {
      name.value ||= 'scratchpad.txt';
      name.focus();
      name.setSelectionRange(0, name.value.lastIndexOf('.') > 0 ? name.value.lastIndexOf('.') : name.value.length);
    }
  };
  q('.save').addEventListener('click', () => {
    if (textarea.value.trim()) toggleSave(true);
    else toast('Nothing to save: this pane is empty.', { error: true });
  });
  q('.save-cancel').addEventListener('click', () => { toggleSave(false); textarea.focus(); });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { toggleSave(false); textarea.focus(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error, displayPath } = await window.airlock.saveScratch({ name: name.value, text: textarea.value });
    if (error) { toast(`Not saved: ${error}`, { error: true }); return; }
    toast('Saved to', { code: displayPath });
    toggleSave(false);
    textarea.focus();
  });

  q('.split').addEventListener('click', () => setSplit(true));
  q('.compare').addEventListener('click', openCompare);
  q('.close').addEventListener('click', () => closePad(pad));
  return pad;
}

const padA = makePad();
const padB = makePad();
activePad = padA;
scratchSplit.before(padA.el);
scratchSplit.after(padB.el);

// Both panes and the split survive a restart. Nothing is written until the saved state has
// loaded, so closing the app during startup can't replace it with empty panes.
let scratchRestored = false;
let scratchTimer = null;
function persistScratch() {
  clearTimeout(scratchTimer);
  scratchTimer = null;
  if (!scratchRestored) return;
  window.airlock.saveScratchState({
    a: padA.textarea.value,
    b: padB.textarea.value,
    split: scratchpad.classList.contains('split'),
  });
}
$('scratch-panes').addEventListener('input', () => {
  clearTimeout(scratchTimer);
  scratchTimer = setTimeout(persistScratch, 500);
});
window.addEventListener('beforeunload', () => { if (scratchTimer) persistScratch(); });
window.airlock.loadScratchState().then(({ a, b, split }) => {
  padA.textarea.value = a;
  padB.textarea.value = b;
  scratchpad.classList.toggle('split', split);
  scratchRestored = true;
});

function setSplit(split) {
  scratchpad.classList.toggle('split', split);
  (split ? padB : padA).textarea.focus();
  persistScratch();
}

// The closed pane's text is kept in the hidden second pane, so closing never loses anything.
function closePad(pad) {
  if (pad === padA) [padA.textarea.value, padB.textarea.value] = [padB.textarea.value, padA.textarea.value];
  setSplit(false);
}

function compareCells(side, no, text, other, kind) {
  const num = document.createElement('div');
  num.className = `num side-${side}`;
  const cell = document.createElement('div');
  cell.className = `text side-${side}`;
  if (text === null) {
    cell.classList.add('gap');
    num.classList.add('gap');
    return [num, cell];
  }
  num.textContent = no;
  if (kind) { num.classList.add(kind); cell.classList.add(kind); }
  if (kind && other !== null && text !== other) {
    const [start, end] = changedRange(text, other);
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    cell.append(text.slice(0, start), mark, text.slice(end));
  } else {
    cell.textContent = text;
  }
  return [num, cell];
}

function openCompare() {
  const { rows, changed, tooLarge } = diffLines(padA.textarea.value, padB.textarea.value);
  const cells = [];
  for (const { a, b, aNo, bNo, same } of rows) {
    cells.push(...compareCells('a', aNo, a, b, same ? '' : 'del'), ...compareCells('b', bNo, b, a, same ? '' : 'add'));
  }
  $('compare-rows').replaceChildren(...cells);
  $('compare-rows').scrollTop = 0;
  $('compare-summary').textContent = (changed === 0 ? 'Identical'
    : `${changed} ${changed === 1 ? 'line differs' : 'lines differ'}`)
    + (tooLarge ? ' (too large to align; the differing section is shown as one block)' : '');
  $('scratch-panes').hidden = true;
  $('scratch-compare').hidden = false;
}
$('compare-close').addEventListener('click', () => {
  $('scratch-compare').hidden = true;
  $('scratch-panes').hidden = false;
  activePad.textarea.focus();
});

// --- Right pane: Claude or the Runsheet ----------------------------------------------------

let rightTab = prefs.rightTab ?? 'claude';
// The chat and web pages are native views above this page, so only the current one is shown.
function syncNativeViews() {
  window.airlock.setChatVisible(rightTab === 'claude');
  window.airlock.setWebVisible(rightTab === 'web');
}
function showRightTab(tab) {
  rightTab = tab;
  $('web').hidden = tab !== 'web';
  $('runsheet').hidden = tab !== 'runsheet';
  $('tab-claude').classList.toggle('active', tab === 'claude');
  $('tab-web').classList.toggle('active', tab === 'web');
  $('tab-runsheet').classList.toggle('active', tab === 'runsheet');
  syncNativeViews();
}
function chooseRightTab(tab) {
  showRightTab(tab);
  saveSetting('rightTab', tab);
}
$('tab-claude').addEventListener('click', () => chooseRightTab('claude'));
$('tab-web').addEventListener('click', () => {
  chooseRightTab('web');
  if (!$('web-address').value) $('web-address').focus();
});
$('tab-runsheet').addEventListener('click', () => chooseRightTab('runsheet'));

// --- Web tab -------------------------------------------------------------------------------
// The page is a native view that follows #web-slot, like the chat. See ADR 0005 for what a page
// is allowed to do.

new ResizeObserver(() => {
  const r = $('web-slot').getBoundingClientRect();
  if (!r.width) return; // hidden: keep the last position
  window.airlock.setWebBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
}).observe($('web-slot'));

let webCanAutoRun = false;
window.airlock.onWebState(({ url, title, canGoBack, canGoForward, loading, canAutoRun, autoRun }) => {
  if (document.activeElement !== $('web-address')) $('web-address').value = url;
  $('web-address').title = title;
  $('web-back').disabled = !canGoBack;
  $('web-forward').disabled = !canGoForward;
  $('web-reload').disabled = !url;
  $('web-reload').textContent = loading ? '×' : '↻';
  $('web-reload').title = loading ? 'Stop' : 'Reload';
  $('web-external').disabled = !url;
  webCanAutoRun = canAutoRun;
  const button = $('web-auto-run');
  button.disabled = !canAutoRun;
  button.classList.toggle('on', autoRun);
  button.textContent = autoRun ? 'Auto-run: On' : 'Auto-run: Off';
  button.title = !url ? 'Open a page first'
    : !canAutoRun ? 'Auto-run needs an HTTPS site'
      : autoRun ? 'A double-copy on this site runs in the terminal. Click to turn off.'
        : 'Click to let a double-copy on this site run in the terminal. Only for sites you trust.';
});
window.airlock.onWebError((message) => toast(`Couldn't load ${message}`, { error: true }));
const focusWebAddress = () => { $('web-address').focus(); $('web-address').select(); };
window.airlock.onWebFocusAddress(focusWebAddress);
window.addEventListener('keydown', (e) => {
  const key = window.airlock.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  if (rightTab !== 'web' || !key || e.altKey || e.shiftKey || e.code !== 'KeyL') return;
  // Only from outside the terminal, where Ctrl+L clears the screen.
  if (e.target.closest?.('#left') && window.airlock.platform !== 'darwin') return;
  e.preventDefault();
  focusWebAddress();
}, { capture: true });
$('web-address').addEventListener('focus', () => $('web-address').select());
$('web-form').addEventListener('submit', (e) => {
  e.preventDefault();
  window.airlock.webGo($('web-address').value);
  $('web-address').blur();
});
$('web-back').addEventListener('click', () => window.airlock.webBack());
$('web-forward').addEventListener('click', () => window.airlock.webForward());
$('web-reload').addEventListener('click', () => window.airlock.webReload());
$('web-external').addEventListener('click', () => window.airlock.webExternal());

function renderWebSites(sites) {
  prefs.webAutoRunSites = sites;
  const rows = sites.map((site) => {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = site;
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => renderWebSites(await window.airlock.webRemoveAutoRun(site)));
    li.append(code, remove);
    return li;
  });
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'None';
    rows.push(li);
  }
  $('setting-web-sites').replaceChildren(...rows);
}
$('web-auto-run').addEventListener('click', async () => {
  if (!webCanAutoRun) return;
  renderWebSites(await window.airlock.webSetAutoRun(!$('web-auto-run').classList.contains('on')));
});
renderWebSites(prefs.webAutoRunSites ?? []);
showRightTab(rightTab);

// --- Runsheet ------------------------------------------------------------------------------
// A script shown read-only. Copying from it works like copying from the chat: the text goes to
// the airlock and nothing runs until the user presses Run.

const RUNSHEET_LINE_HEIGHT = 20; // keep in sync with #runsheet-content in style.css
const RUNSHEET_PADDING = 8;
const RUNSHEET_EXTENSIONS = {
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', command: 'bash',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  py: 'python', rb: 'ruby', js: 'javascript', mjs: 'javascript', ts: 'typescript',
  json: 'json', yml: 'yaml', yaml: 'yaml', sql: 'sql', md: 'markdown', markdown: 'markdown', ini: 'ini', toml: 'ini',
};
const RUNSHEET_SHEBANGS = [
  [/\b(ba|z|k|da|a)?sh\b/, 'bash'], [/\bpwsh\b/, 'powershell'], [/\bpython/, 'python'],
  [/\bruby\b/, 'ruby'], [/\bnode\b/, 'javascript'],
];

function runsheetLanguage(name, text) {
  const byExtension = RUNSHEET_EXTENSIONS[name.split('.').pop().toLowerCase()];
  if (name.includes('.') && byExtension) return byExtension;
  const shebang = text.match(/^#!(.*)/)?.[1] ?? '';
  return RUNSHEET_SHEBANGS.find(([pattern]) => pattern.test(shebang))?.[1] ?? 'plaintext';
}

let runsheetText = null;
let runsheetRelative = '';
let runsheetLines = [];
let runsheetBlocks = [];
let runsheetFiles = [];
let hoveredBlock = null;
let filesOpen = false;

// The file list fills the pane until a file opens, then collapses into the bar above it.
function syncRunsheetLayout() {
  const hasFile = runsheetText !== null;
  $('runsheet').classList.toggle('has-file', hasFile);
  $('runsheet-files').hidden = hasFile && !filesOpen;
  for (const id of ['runsheet-toggle', 'runsheet-reload', 'runsheet-airlock', 'runsheet-name', 'runsheet-lang']) $(id).hidden = !hasFile;
  $('runsheet-bar').hidden = !hasFile;
  $('runsheet-toggle').textContent = filesOpen ? 'Files ▴' : 'Files ▾';
  $('runsheet-toggle').setAttribute('aria-expanded', String(filesOpen));
}

function closeRunsheet() {
  runsheetText = null;
  runsheetRelative = '';
  hoveredBlock = null;
  filesOpen = false;
  $('runsheet-view').hidden = true;
  $('runsheet-page').hidden = true;
  syncRunsheetLayout();
  renderRunsheetList();
}

function renderRunsheetList(message = '') {
  const q = $('runsheet-filter').value.trim().toLowerCase();
  const note = (text) => {
    const li = document.createElement('li');
    li.className = 'message';
    li.textContent = text;
    return li;
  };
  const items = runsheetFiles.filter((f) => f.toLowerCase().includes(q)).map((file) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    if (file === runsheetRelative) button.className = 'current';
    button.title = file;
    const slash = file.lastIndexOf('/') + 1;
    if (slash) {
      const folder = document.createElement('span');
      folder.className = 'folder';
      folder.textContent = file.slice(0, slash);
      button.append(folder);
    }
    button.append(file.slice(slash));
    button.addEventListener('click', () => openRunsheetFile(file));
    li.append(button);
    return li;
  });
  if (message) items.unshift(note(message));
  else if (!items.length) {
    items.push(note(!prefs.runsheetFolder ? 'Choose a folder of scripts to work through. Copy any part and it lands in the airlock, ready to check and run.'
      : q ? 'No matches' : 'No scripts or Markdown files in this folder.'));
  }
  $('runsheet-list').replaceChildren(...items);
}

async function loadRunsheetList() {
  const { folder, files, truncated, error } = await window.airlock.listRunsheets();
  const changed = files.join('\0') !== runsheetFiles.join('\0') || Boolean(error);
  runsheetFiles = files;
  $('runsheet-folder-path').textContent = folder;
  $('runsheet-folder-path').title = folder;
  $('setting-runsheet-folder').textContent = folder || 'None chosen';
  if (changed || !$('runsheet-list').children.length) {
    renderRunsheetList(error ? `Can't read ${folder}: ${error}.` : truncated ? `Showing the first ${files.length} files.` : '');
  }
}

async function openRunsheetFile(relative) {
  const sheet = await window.airlock.openRunsheet(relative);
  if (!sheet) return;
  if (sheet.error) { toast(`Can't open ${sheet.name}: ${sheet.error}.`, { error: true }); return; }
  filesOpen = false;
  renderRunsheet(sheet);
}

async function chooseRunsheetFolder() {
  const chosen = await window.airlock.chooseRunsheetFolder();
  if (!chosen) return;
  prefs.runsheetFolder = chosen.folder;
  chooseRightTab('runsheet');
  $('runsheet-filter').value = '';
  runsheetFiles = [];
  closeRunsheet();
  await loadRunsheetList();
}
$('runsheet-folder').addEventListener('click', chooseRunsheetFolder);
$('setting-runsheet-choose').addEventListener('click', chooseRunsheetFolder);
$('runsheet-filter').addEventListener('input', () => renderRunsheetList());
$('runsheet-toggle').addEventListener('click', () => {
  filesOpen = !filesOpen;
  syncRunsheetLayout();
  renderRunsheetList();
  if (filesOpen) loadRunsheetList();
});

function renderScript(text, language) {
  runsheetLines = text.split('\n');
  if (runsheetLines.at(-1) === '') runsheetLines.pop();
  // Blocks are runs of lines between blank lines, each with its own Copy button.
  runsheetBlocks = [];
  let start = null;
  runsheetLines.forEach((line, i) => {
    if (line.trim() && start === null) start = i;
    if (!line.trim() && start !== null) { runsheetBlocks.push([start, i - 1]); start = null; }
  });
  if (start !== null) runsheetBlocks.push([start, runsheetLines.length - 1]);
  // Highlight.js escapes the file's text, so its output is safe to insert as HTML.
  $('runsheet-code').firstElementChild.innerHTML = hljs.highlight(runsheetLines.join('\n'), { language, ignoreIllegals: true }).value;
  $('runsheet-gutter').textContent = runsheetLines.map((_line, i) => i + 1).join('\n');
  showBlock(null);
}

// The sanitizer's usual list of safe addresses, plus file: and Windows paths for local images.
const MARKDOWN_SAFE_URL = /^(?:(?:https?|file|mailto|tel):|[a-z]:[\\/]|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

function renderMarkdown(text, baseUrl) {
  const page = $('runsheet-page');
  // Runsheets can come from anywhere, so everything Markdown allows through as HTML is sanitized.
  page.innerHTML = DOMPurify.sanitize(marked.parse(text), {
    FORBID_TAGS: ['style'], FORBID_ATTR: ['style'], ALLOWED_URI_REGEXP: MARKDOWN_SAFE_URL,
  });
  // Relative images are next to the runsheet, not next to this app's page.
  for (const img of page.querySelectorAll('img')) {
    const src = (img.getAttribute('src') ?? '').replace(/^([a-z]:)[\\/]/i, 'file:///$1/').replace(/\\/g, '/');
    try { img.src = new URL(src, baseUrl).href; } catch {}
    img.referrerPolicy = 'no-referrer';
  }
  for (const code of page.querySelectorAll('pre > code')) {
    const language = code.className.match(/language-([\w+-]+)/)?.[1];
    if (language && hljs.getLanguage(language)) {
      code.innerHTML = hljs.highlight(code.textContent, { language, ignoreIllegals: true }).value; // escaped, as above
    }
    const copy = document.createElement('button');
    copy.className = 'block-copy';
    copy.textContent = 'Copy';
    copy.title = 'Copy this block to the clipboard and the airlock. Copy twice quickly to run it.';
    copy.addEventListener('click', () => {
      copyFromRunsheet(code.textContent.replace(/\n$/, ''));
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, DOUBLE_COPY_MS);
    });
    code.parentElement.append(copy);
  }
}

function renderRunsheet(sheet) {
  const text = sheet.text.replace(/\r\n?/g, '\n');
  if (text === runsheetText && sheet.relative === runsheetRelative) { // keep scroll and selection
    syncRunsheetLayout();
    renderRunsheetList();
    return;
  }
  const isReload = sheet.relative === runsheetRelative;
  const language = runsheetLanguage(sheet.name, text);
  const isPage = language === 'markdown';
  const scroller = isPage ? $('runsheet-page') : $('runsheet-scroll');
  const keepScroll = isReload ? scroller.scrollTop : 0;
  runsheetText = text;
  runsheetRelative = sheet.relative;
  $('runsheet-view').hidden = isPage;
  $('runsheet-page').hidden = !isPage;
  if (isPage) renderMarkdown(text, sheet.baseUrl);
  else renderScript(text, language);
  $('runsheet-name').textContent = sheet.relative;
  $('runsheet-name').title = sheet.path;
  $('runsheet-lang').textContent = language === 'plaintext' ? 'Plain text' : hljs.getLanguage(language).name;
  syncRunsheetLayout();
  renderRunsheetList();
  scroller.scrollTop = keepScroll;
}

async function reloadRunsheet({ quiet = false } = {}) {
  const sheet = await window.airlock.readRunsheet();
  if (!sheet) return;
  if (!sheet.error) { renderRunsheet(sheet); return; }
  // Quiet checks run in the background: only speak up about a file that was open and has gone.
  if (!quiet || runsheetText !== null) toast(`Can't open ${sheet.name}: ${sheet.error}.`, { error: true });
  if (runsheetText !== null) closeRunsheet();
}
$('runsheet-reload').addEventListener('click', () => reloadRunsheet());
// The folder or the open script may have changed while the app was in the background.
window.addEventListener('focus', () => {
  reloadRunsheet({ quiet: true });
  loadRunsheetList();
});

// The selected part of the script or page. A drag can run past it, and only the runsheet counts.
function runsheetSelection() {
  const container = $('runsheet-page').hidden ? $('runsheet-code') : $('runsheet-page');
  const selection = window.getSelection();
  if (!selection.rangeCount) return '';
  if (container.contains(selection.anchorNode) && container.contains(selection.focusNode)) return selection.toString();
  const bounds = document.createRange();
  bounds.selectNodeContents(container);
  const selected = selection.getRangeAt(0).cloneRange();
  if (selected.compareBoundaryPoints(Range.END_TO_START, bounds) >= 0
    || selected.compareBoundaryPoints(Range.START_TO_END, bounds) <= 0) return ''; // outside the runsheet
  if (selected.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) selected.setStart(bounds.startContainer, bounds.startOffset);
  if (selected.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) selected.setEnd(bounds.endContainer, bounds.endOffset);
  return selected.toString();
}

// Copying from a runsheet works like copying in the chat, including double-copy.
function copyFromRunsheet(text) {
  navigator.clipboard.writeText(text);
  receiveCopy(text, window.airlock.copyGesture());
}
for (const id of ['runsheet-code', 'runsheet-page']) {
  $(id).addEventListener('copy', () => {
    const selected = runsheetSelection();
    if (selected.trim()) receiveCopy(selected, window.airlock.copyGesture());
  });
}
// Pressing the button mustn't clear the selection it's about to send.
$('runsheet-airlock').addEventListener('mousedown', (e) => e.preventDefault());
$('runsheet-airlock').addEventListener('click', () => {
  const selected = runsheetSelection();
  if (selected.trim()) {
    fillAirlock(selected);
    setStatus('Sent to Airlock', DOUBLE_COPY_MS);
  } else {
    toast('Highlight the text to send first.', { error: true });
  }
});
// Links open in the system browser, never inside the app.
$('runsheet-page').addEventListener('click', (e) => {
  const link = e.target.closest('a');
  if (!link) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(link.href)) window.airlock.openExternal(link.href);
});

// In scripts, the block under the mouse gets a band and a Copy button, like a code block in the chat.
function showBlock(block) {
  hoveredBlock = block;
  $('runsheet-band').hidden = !block;
  $('runsheet-copy').hidden = !block;
  if (!block) return;
  const top = RUNSHEET_PADDING + block[0] * RUNSHEET_LINE_HEIGHT;
  $('runsheet-band').style.top = `${top}px`;
  $('runsheet-band').style.height = `${(block[1] - block[0] + 1) * RUNSHEET_LINE_HEIGHT}px`;
  // The button sits outside the scrolling area so it stays in view, whatever the scroll position.
  $('runsheet-copy').style.top = `${Math.max(top - $('runsheet-scroll').scrollTop, 0) + 2}px`;
  $('runsheet-copy').textContent = 'Copy';
}
$('runsheet-scroll').addEventListener('mousemove', (e) => {
  if (e.buttons) return; // selecting text
  const y = e.clientY - $('runsheet-content').getBoundingClientRect().top - RUNSHEET_PADDING;
  const line = Math.floor(y / RUNSHEET_LINE_HEIGHT);
  const block = runsheetBlocks.find(([first, last]) => line >= first && line <= last) ?? null;
  if (block !== hoveredBlock) showBlock(block);
});
$('runsheet-scroll').addEventListener('scroll', () => { if (hoveredBlock) showBlock(hoveredBlock); });
$('runsheet-view').addEventListener('mouseleave', () => showBlock(null));
$('runsheet-copy').addEventListener('click', () => {
  if (!hoveredBlock) return;
  copyFromRunsheet(runsheetLines.slice(hoveredBlock[0], hoveredBlock[1] + 1).join('\n'));
  $('runsheet-copy').textContent = 'Copied';
});
syncRunsheetLayout();
loadRunsheetList();
reloadRunsheet();

// --- Settings panel -----------------------------------------------------------------------

function applyTheme(next) {
  theme = next;
  document.documentElement.dataset.theme = theme;
  for (const tab of tabs) Object.assign(tab.term.options, terminalAppearance());
}
window.airlock.onTheme(applyTheme);

$('setting-double-copy').checked = prefs.doubleCopyRun !== false;
$('setting-double-copy').addEventListener('change', (e) => saveSetting('doubleCopyRun', e.target.checked));
$('setting-theme').value = prefs.theme ?? 'dark';
$('setting-theme').addEventListener('change', (e) => saveSetting('theme', e.target.value));

const snippetsDirLabel = () => prefs.snippetsDir || `${window.airlock.initial.dataDir} (default)`;
$('snippets-dir').textContent = snippetsDirLabel();
$('data-dir').textContent = window.airlock.initial.dataDir;
$('data-open').addEventListener('click', () => window.airlock.openDataFolder());
$('snippets-choose').addEventListener('click', async () => {
  const chosen = await window.airlock.chooseSnippetsFolder();
  if (!chosen) return;
  prefs.snippetsDir = chosen.dir;
  $('snippets-dir').textContent = snippetsDirLabel();
  if (chosen.error) toast(chosen.error, { error: true });
  loadSnippets({ quiet: Boolean(chosen.error) });
});
$('snippets-reset').addEventListener('click', async () => {
  await window.airlock.resetSnippetsFolder();
  delete prefs.snippetsDir;
  $('snippets-dir').textContent = snippetsDirLabel();
  loadSnippets();
});

// --- Saved terminal output (opt-in) --------------------------------------------------------

let scrollbackLoaded = false;
function persistScrollback() {
  // Not before the saved tabs are back, so closing during startup can't replace them.
  if (!prefs.saveScrollback || !scrollbackLoaded) return;
  outputChanged = false;
  window.airlock.saveScrollback(tabs.map((tab) => ({
    shellId: tab.shellId,
    data: tab.serializer.serialize({ scrollback: SCROLLBACK_LINES, excludeAltBuffer: true, excludeModes: true }),
  })));
}
setInterval(() => { if (outputChanged) persistScrollback(); }, 30000);
window.addEventListener('beforeunload', persistScrollback);

$('setting-scrollback').checked = prefs.saveScrollback === true;
$('setting-scrollback').addEventListener('change', (e) => {
  saveSetting('saveScrollback', e.target.checked);
  persistScrollback();
});

// --- Startup -------------------------------------------------------------------------------

const RESTORED_MARK = '\x1b[2m--- restored from the previous session ---\x1b[0m\r\n';

Promise.all([window.airlock.listShells(), window.airlock.loadScrollback()]).then(([shells, savedTabs]) => {
  for (const s of shells) {
    shellLabels.set(s.id, s.label);
    shellPicker.add(new Option(s.label, s.id));
  }
  if (!savedTabs.length) {
    newTab();
  } else {
    for (const saved of savedTabs) {
      const tab = createTab(shellLabels.has(saved.shellId) ? saved.shellId : defaultShellId());
      if (!activeTab) activateTab(tab);
      // Old output first, so the new shell's prompt lands below it.
      tab.term.write(`${saved.data}\r\n${RESTORED_MARK}`, () => startShell(tab, { keepOutput: true }));
    }
  }
  scrollbackLoaded = true;
});

// --- Dividers ---------------------------------------------------------------------------

function makeSplitter(el, onMove, onDone) {
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    window.airlock.setChatVisible(false);
    window.airlock.setWebVisible(false);
    const move = (ev) => onMove(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.classList.remove('dragging');
      syncNativeViews();
      syncChatBounds();
      onDone();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
  });
}

// Remembered as percentages, so they still fit if the window comes back a different size.
const dragged = { };
function setDivider(setting, cssVar, percent) {
  dragged[setting] = percent;
  root.setProperty(cssVar, `${percent}%`);
}

makeSplitter($('vsplit'), (e) => {
  const min = 200;
  const x = Math.min(Math.max(e.clientX, min), window.innerWidth - min);
  setDivider('leftWidth', '--left-width', (x / window.innerWidth) * 100);
}, () => saveSetting('leftWidth', dragged.leftWidth));

makeSplitter($('hsplit'), (e) => {
  const r = $('left').getBoundingClientRect();
  const h = Math.min(Math.max(r.bottom - e.clientY, 80), r.height - 100);
  setDivider('airlockHeight', '--airlock-height', (h / r.height) * 100);
}, () => saveSetting('airlockHeight', dragged.airlockHeight));

makeSplitter(scratchSplit, (e) => {
  const r = $('scratch-panes').getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX - r.left, 120), r.width - 120);
  setDivider('scratchLeft', '--scratch-left', (x / r.width) * 100);
}, () => saveSetting('scratchLeft', dragged.scratchLeft));
