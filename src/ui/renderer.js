const $ = (id) => document.getElementById(id);
const root = document.documentElement.style;
const IS_MAC = window.airlock.platform === 'darwin';
if (IS_MAC) document.documentElement.classList.add('mac');

// Shortcut hints on buttons (data-keys="mod+shift+enter"), spelled the way this platform does:
// ⇧⌘↵ on macOS, Ctrl+Shift+Enter elsewhere.
const KEY_NAMES = IS_MAC ? { mod: '⌘', shift: '⇧', enter: '↵' } : { mod: 'Ctrl', shift: 'Shift', enter: 'Enter' };
const KEY_ORDER = IS_MAC ? { shift: 0, mod: 1 } : { mod: 0, shift: 1 };
function keyHint(keys) {
  const parts = keys.split('+').sort((a, b) => (KEY_ORDER[a] ?? 2) - (KEY_ORDER[b] ?? 2));
  return parts.map((k) => KEY_NAMES[k] ?? k.toUpperCase()).join(IS_MAC ? '' : '+');
}
for (const button of document.querySelectorAll('[data-keys]')) {
  const kbd = document.createElement('kbd');
  kbd.textContent = keyHint(button.dataset.keys);
  button.append(kbd);
  button.title = `${button.title} (${kbd.textContent})`;
}
document.getElementById('airlock-text').placeholder = `Copy a command in the chat and it lands here. ${keyHint('mod+enter')} runs it.`;
document.getElementById('find-input').placeholder = `Find (${IS_MAC ? '⌘F' : 'Ctrl+Shift+F'})`;

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
// Ships only as an ES module, unlike the other addons, so it's imported rather than a <script>.
const ligaturesAddon = import('../../node_modules/@xterm/addon-ligatures/lib/addon-ligatures.mjs');

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

// The airlock and the runsheet zoom the same way as the terminal, each keeping its own size.
function paneZoom(el, key, apply) {
  let size = prefs[key] ?? DEFAULT_FONT_SIZE;
  const set = (next) => {
    size = Math.min(Math.max(next, 8), 32);
    apply(size);
    saveSetting(key, size);
  };
  apply(size);
  el.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    set(size + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const next = e.key === '=' || e.key === '+' ? size + 1
      : e.key === '-' || e.key === '_' ? size - 1
        : e.key === '0' ? DEFAULT_FONT_SIZE : null;
    if (next === null) return;
    e.preventDefault();
    set(next);
  });
}

function tabLabel(tab) {
  if (tab.remote) return tab.remote.name;
  const shellName = (shellLabels.get(tab.shellId) ?? 'Terminal').split(/[\\/]/).pop();
  return tab.cwd.split(/[\\/]/).filter(Boolean).pop() || tab.cwd || shellName;
}
// The status bar's right side describes the active terminal.
function updateStatusBar() {
  if (!activeTab) return;
  $('status-cwd').textContent = activeTab.cwd;
  $('status-cwd').title = activeTab.cwd;
  $('status-shell').textContent = activeTab.remote ? remoteDescription(activeTab.remote) : shellLabels.get(activeTab.shellId) ?? '';
  const aws = activeTab.env?.get('AWS_PROFILE');
  $('status-aws').textContent = aws ? `AWS: ${aws}` : '';
}
function updateTabLabel(tab) {
  if (tab === activeTab) updateStatusBar();
  tab.labelEl.textContent = tabLabel(tab);
  tab.el.title = [tab.cwd, tab.remote ? remoteDescription(tab.remote) : shellLabels.get(tab.shellId)].filter(Boolean).join('\n');
  tab.el.classList.toggle('exited', tab.exited);
  // Remote tabs (ADR 0008) carry their environment tag: PROD gets a red strip.
  const env = tab.remote?.env ?? '';
  tab.el.dataset.env = env;
  tab.envEl.textContent = env.toUpperCase();
  tab.envEl.hidden = !env;
}

// `remote`: the remote this tab connects to (ADR 0008), or null for a shell on this machine.
function createTab(shellId, remote = null) {
  const host = document.createElement('div');
  host.className = 'terminal-host';
  $('terminal').append(host);

  const term = new Terminal({
    // Nerd Fonts first so prompt themes (oh-my-posh, starship, powerlevel10k) show their icons.
    // Among those, ligature fonts first: CaskaydiaCove (Cascadia Code) has them, CaskaydiaMono (Cascadia Mono)
    // and Meslo don't. "MesloLGS NF" is powerlevel10k's build; Homebrew's is "MesloLGS Nerd Font Mono".
    fontFamily: '"CaskaydiaCove Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", ' +
      '"CaskaydiaMono Nerd Font Mono", "MesloLGS Nerd Font Mono", "MesloLGS NF", ' +
      '"Cascadia Code", "Cascadia Mono", Menlo, Consolas, monospace',
    fontSize,
    scrollback: SCROLLBACK_LINES,
    cursorBlink: true,
    // Needed by the Unicode addon below.
    allowProposedApi: true,
    ...terminalAppearance(),
    // OSC 8 hyperlinks printed by programs (ls --hyperlink, gh, etc.).
    linkHandler: { activate: (_e, uri) => window.airlock.openExternal(uri) },
  });
  const fit = new FitAddon.FitAddon();
  const serializer = new SerializeAddon.SerializeAddon();
  const search = new SearchAddon.SearchAddon();
  // Character widths as the shells count them (Unicode 15). The default, Unicode 6, makes emoji
  // one column wide where shells use two, so a prompt with emoji in it (oh-my-posh and the like)
  // put every redraw of the line one column out, leaving ghost characters Backspace can't reach.
  term.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  term.loadAddon(fit);
  term.loadAddon(serializer);
  term.loadAddon(search);
  // Plain-text URLs.
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => window.airlock.openExternal(uri)));
  term.open(host);
  fit.fit();
  // Ligatures (=>, !=, ===) are drawn only if the addon joins those cells; it needs the terminal
  // open first. It reads the font through the browser's local-fonts API, and falls back to a
  // built-in set of common ligatures if it can't.
  ligaturesAddon.then((m) => term.loadAddon(new m.LigaturesAddon()))
    .catch((err) => console.warn('Ligatures unavailable:', err));

  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  const envEl = document.createElement('span');
  envEl.className = 'env-badge';
  envEl.hidden = true;
  const closeButton = document.createElement('button');
  closeButton.className = 'tab-close';
  closeButton.textContent = '×';
  closeButton.title = 'Close terminal';
  const el = document.createElement('div');
  el.className = 'tab';
  el.append(labelEl, envEl, closeButton);
  $('terminal-tabs').append(el);

  const tab = {
    id: nextTabId++, shellId, remote, host, term, fit, serializer, search, el, labelEl, envEl,
    cwd: '', env: null, envBaseline: null, awsProfiles: [], exited: false, blocks: [],
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
    const isMac = window.airlock.platform === 'darwin';
    // Cmd+Shift on macOS, Ctrl+Shift elsewhere (plain Ctrl+C stays as interrupt).
    const shiftKey = e.shiftKey && !e.altKey && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
    // Cmd+C on macOS copies the selection, as in any Mac app. It goes to the clipboard only.
    if (isMac && e.code === 'KeyC' && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && term.hasSelection()) {
      copySelection(tab);
      return false;
    }
    if (shiftKey && e.code === 'KeyC') {
      // Elsewhere Ctrl+Shift+C copies the selection. With nothing selected (and always on macOS,
      // where Cmd+C does that) it copies the last command.
      if (!isMac && term.hasSelection()) copySelection(tab);
      else copyLastBlock(tab);
      return false;
    }
    if (shiftKey && e.key === 'Enter') {
      if (term.hasSelection()) sendSelection(tab);
      else sendLastBlock(tab);
      return false;
    }
    // Cmd+F on macOS. Elsewhere Ctrl+Shift+F, since the shell uses Ctrl+F.
    if (e.code === 'KeyF' && !e.altKey && (isMac ? e.metaKey && !e.ctrlKey && !e.shiftKey : shiftKey)) {
      openFind();
      return false;
    }
    if (mod && !e.altKey && (e.key === '=' || e.key === '+')) { setFontSize(fontSize + 1); return false; }
    if (mod && !e.altKey && (e.key === '-' || e.key === '_')) { setFontSize(fontSize - 1); return false; }
    if (mod && !e.altKey && e.key === '0') { setFontSize(DEFAULT_FONT_SIZE); return false; }
    return true;
  });
  term.onData((data) => {
    noteBlockInput(tab, data);
    window.airlock.ptyInput(tab.id, data);
  });
  term.onResize(({ cols, rows }) => window.airlock.ptyResize(tab.id, { cols, rows }));
  term.parser.registerOscHandler(7337, (data) => handleShellReport(tab, data));
  term.parser.registerOscHandler(133, (data) => handlePromptMark(tab, data));
  search.onDidChangeResults((results) => { if (tab === activeTab) showFindCount(results); });
  // Output moves the blocks under the mouse.
  term.onRender(() => { if (tab === activeTab && terminalMouse) showHoveredBlock(); });
  return tab;
}

function startShell(tab, { keepOutput = false } = {}) {
  tab.env = null;
  tab.envBaseline = null;
  tab.cwd = '';
  tab.exited = false;
  clearBlocks(tab);
  if (!keepOutput) tab.term.reset();
  tab.kept = false;
  window.airlock.ptyStart({ id: tab.id, cols: tab.term.cols, rows: tab.term.rows, shellId: tab.shellId, remoteId: tab.remote?.id });
  updateTabLabel(tab);
  if (tab === activeTab) showTabState();
  loadAwsProfiles(tab);
}

function activateTab(tab) {
  const previous = activeTab;
  activeTab?.host.classList.remove('active');
  activeTab?.el.classList.remove('active');
  activeTab = tab;
  tab.host.classList.add('active');
  window.airlock.ptyActivate(tab.id);
  showTabState();
  showView('terminal');
  tab.el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  findFollowsTab(previous);
}

// The controls above the terminal describe the active tab.
function showTabState() {
  updateStatusBar();
  shellPicker.value = activeTab.shellId;
  renderEnv(activeTab);
  renderAwsPicker();
  libraryFollowsTerminal();
  if (typeof showRemoteState === 'function') showRemoteState();
}

function newTab() {
  // A new tab is a shell on this machine, even next to a remote one.
  const tab = createTab(activeTab && !activeTab.remote ? activeTab.shellId : defaultShellId());
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
  if (!tab.remote) tab.term.write(`\r\n[shell exited with code ${code}]\r\n`);
  else tab.term.write(`\r\n\x1b[2m[${tab.kept ? `left the session running on ${tab.remote.name}` : `disconnected from ${tab.remote.name}`}]\x1b[0m\r\n`);
  updateTabLabel(tab);
  if (tab === activeTab && typeof showRemoteState === 'function') showRemoteState();
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

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 7.5;

// A ring that fills clockwise from the top, drawn with a dash the length of the percentage.
function usageRing(percent) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const circumference = 2 * Math.PI * RING_RADIUS;
  for (const cls of ['track', 'fill']) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '10');
    c.setAttribute('cy', '10');
    c.setAttribute('r', String(RING_RADIUS));
    if (cls === 'fill') c.setAttribute('stroke-dasharray', `${circumference * Math.min(Math.max(percent, 0), 100) / 100} ${circumference}`);
    svg.append(c);
  }
  return svg;
}

function usageMeter(label, w) {
  const el = document.createElement('span');
  el.className = 'meter';
  if (w.percent >= 90) el.classList.add('crit');
  else if (w.percent >= 75) el.classList.add('warn');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = `${label} `;
  const pct = document.createElement('span');
  pct.className = 'pct';
  pct.textContent = `${Math.round(w.percent)}%`;
  const top = document.createElement('span');
  top.append(name, pct);
  const text = document.createElement('span');
  text.className = 'text';
  text.append(top);
  el.title = `${label} usage ${w.percent}%`;
  if (w.resetsAt) {
    const r = document.createElement('span');
    r.className = 'resets';
    const until = untilText(w.resetsAt);
    r.textContent = until === 'now' ? 'resets now' : /^\d/.test(until) ? `resets in ${until}` : `resets ${until}`;
    text.append(r);
    el.title += `, resets ${new Date(w.resetsAt).toLocaleString()}`; // still there when the line is hidden
  }
  el.append(usageRing(w.percent), text);
  return el;
}

window.airlock.onUsage((usage) => {
  const parts = [];
  if (usage?.session) parts.push(usageMeter('Session', usage.session));
  if (usage?.weekly) parts.push(usageMeter('Week', usage.weekly));
  $('usage').replaceChildren(...parts);
  fitTitlebar();
});

// The reset times give way when the tabs would otherwise be squeezed. Measured with them shown,
// in one go, so there's no flicker and no flip-flopping between the two.
function fitTitlebar() {
  const bar = $('titlebar');
  const tabsEl = $('terminal-tabs');
  bar.classList.remove('compact');
  if (tabsEl.scrollWidth > tabsEl.clientWidth + 1) bar.classList.add('compact');
}
new ResizeObserver(fitTitlebar).observe($('titlebar'));
new MutationObserver(fitTitlebar).observe($('terminal-tabs'), { childList: true, subtree: true, characterData: true });

if (window.airlock.initial.dev) {
  $('dev-badge').hidden = false;
  document.title = 'Airlock Terminal (dev)';
}
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
  if (tag === 'cmd') { noteBlockCommand(tab, data.slice('cmd;'.length)); return true; }
  if (tag !== 'airlock') return false;
  try {
    const previousCwd = tab.cwd;
    tab.cwd = b64(cwdB64 || '');
    tab.env = parseEnv(b64(envB64 || ''));
    tab.envBaseline ??= tab.env;
    updateTabLabel(tab);
    window.airlock.reportCwd(tab.id, tab.cwd);
    if (tab === activeTab) {
      renderEnv(tab);
      showAwsProfile(tab);
      if (tab.cwd !== previousCwd) libraryFollowsTerminal();
    }
  } catch {}
  return true; // consumed: never shown in the terminal
}

// --- Command blocks: where each command and its output are (ADR 0007) -----------------------
// The shell marks them with OSC 133: A where a prompt starts, C where a command's output starts
// and D;<exit> when it has finished. Before C, our integration also sends the command line itself.
// The positions are xterm.js markers, which follow their line as output scrolls and are
// disposed (line -1) when it falls out of the scrollback.

const MAX_BLOCKS = 200;

function newBlock(tab) {
  const block = { prompt: tab.term.registerMarker(0), input: null, inputX: 0, enter: null,
    output: null, end: null, endX: 0, command: null, exitCode: null };
  tab.blocks.push(block);
  if (tab.blocks.length > MAX_BLOCKS) disposeBlock(tab.blocks.shift());
  return block;
}

function disposeBlock(block) {
  for (const key of ['prompt', 'input', 'enter', 'output', 'end']) block[key]?.dispose();
}

function clearBlocks(tab) {
  tab.blocks.forEach(disposeBlock);
  tab.blocks = [];
}

// The block still waiting for its command to start, if the shell is at a prompt.
function promptBlock(tab) {
  const block = tab.blocks.at(-1);
  return block && !block.output && !block.end ? block : null;
}

function handlePromptMark(tab, data) {
  const [mark, arg] = data.split(';');
  const { term } = tab;
  const cursorX = term.buffer.normal.cursorX;
  if (mark === 'A') newBlock(tab);
  else if (mark === 'B') {
    // Sent by other integrations (iTerm2's, say, over ssh): the prompt ends and input starts here.
    const block = promptBlock(tab);
    if (block && !block.input) { block.input = term.registerMarker(0); block.inputX = cursorX; }
  } else if (mark === 'C') {
    const block = promptBlock(tab) ?? newBlock(tab);
    block.output = term.registerMarker(0);
  } else if (mark === 'D') {
    const block = tab.blocks.at(-1);
    // Only once a command has run: zsh and bash also send D after an empty Enter or Ctrl+C.
    if (block && (block.output || block.enter) && !block.end) {
      block.end = term.registerMarker(0);
      block.endX = cursorX;
      block.exitCode = Number.parseInt(arg, 10) || 0;
    }
  }
  return true; // consumed: never shown in the terminal
}

function noteBlockCommand(tab, commandB64) {
  const block = promptBlock(tab);
  try { if (block) block.command = b64(commandB64); } catch {}
}

// Keys typed at a prompt. The first one shows where the prompt ends, and Enter where the command
// line ends. They're used when the shell doesn't send C or its command line (macOS's bash 3.2).
function noteBlockInput(tab, data) {
  const block = promptBlock(tab);
  if (!block || block.enter) return;
  if (!block.input) {
    block.input = tab.term.registerMarker(0);
    block.inputX = tab.term.buffer.normal.cursorX;
  }
  if (data.includes('\r')) block.enter = tab.term.registerMarker(0);
}

// Text between two buffer positions, joining lines that only wrapped. `to` is exclusive.
function bufferText(term, fromLine, fromX, toLine, toX) {
  const buffer = term.buffer.normal;
  const lines = [];
  let current = '';
  for (let y = fromLine; y <= toLine; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    const start = y === fromLine ? fromX : 0;
    const end = y === toLine ? toX : line.length;
    if (y > fromLine && !line.isWrapped) { lines.push(current.trimEnd()); current = ''; }
    current += line.translateToString(false, start, end);
  }
  lines.push(current.trimEnd());
  return lines.join('\n');
}

// Where a block is in the buffer, if a command ran in it. A running command ends at the cursor.
function blockRange(tab, block) {
  const buffer = tab.term.buffer.normal;
  const outputStart = block.output ?? block.enter;
  if (!outputStart) return null;
  const running = !block.end;
  if (running && block !== tab.blocks.at(-1)) return null; // abandoned when the shell restarted
  const endLine = running ? buffer.baseY + buffer.cursorY : block.end.line;
  const endX = running ? buffer.cursorX : block.endX;
  if (endLine < 0) return null; // scrolled out of the scrollback
  // The start fell out of the scrollback: what's left of it.
  const truncated = outputStart.line < 0;
  const outputLine = truncated ? 0 : outputStart.line + (block.output ? 0 : 1);
  const top = block.prompt && block.prompt.line >= 0 ? block.prompt.line : outputLine;
  const bottom = endX === 0 && endLine > top ? endLine - 1 : endLine;
  return { outputLine, endLine, endX, top, bottom, running, truncated };
}

// A block's command and output, or null if it was an empty Enter.
function readBlock(tab, block) {
  const range = blockRange(tab, block);
  if (!range) return null;
  const { term } = tab;
  const { outputLine, endLine, endX, running, truncated } = range;
  const output = outputLine > endLine || (outputLine === endLine && endX === 0) ? ''
    : bufferText(term, outputLine, 0, endLine, endX).replace(/^\n+|\s+$/g, '');
  let command = block.command;
  if (command === null && block.input && block.input.line >= 0 && !truncated) {
    command = bufferText(term, block.input.line, block.inputX, outputLine - 1, term.cols);
  }
  command = (command ?? '').trim();
  if (!command && !output) return null;
  return { command, output, exitCode: block.exitCode, running, truncated };
}

// The last command that ran, with its output: what's on screen now if it's still running.
function lastBlock(tab) {
  for (let i = tab.blocks.length - 1; i >= 0; i--) {
    const read = readBlock(tab, tab.blocks[i]);
    if (read) return read;
  }
  return null;
}

// The block shown on a buffer line, from its prompt to the end of its output.
function blockAtLine(tab, line) {
  for (let i = tab.blocks.length - 1; i >= 0; i--) {
    const range = blockRange(tab, tab.blocks[i]);
    if (range && line >= range.top && line <= range.bottom) return readBlock(tab, tab.blocks[i]) ? tab.blocks[i] : null;
    if (range && range.bottom < line) return null; // earlier blocks are all higher up
  }
  return null;
}

const isPowerShell = (shellId) => /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(shellId);

// A fence longer than any run of backticks inside, so the text can't close it early.
function fenced(body, language = '') {
  const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}

// A Markdown code block, ready to paste into a chat.
function formatBlock(tab, { command, output, exitCode, running, truncated }) {
  const prompt = isPowerShell(tab.shellId) ? 'PS> ' : '$ ';
  const body = [command && prompt + command.replace(/\n/g, '\n  '), truncated && '[earlier output no longer in the scrollback]', output]
    .filter(Boolean).join('\n');
  let text = fenced(body);
  if (running) text += '\n(Still running.)';
  else if (exitCode) text += `\nExit code: ${exitCode}`;
  return text;
}

function lastBlockOrSay(tab) {
  const read = lastBlock(tab);
  if (!read) {
    toast(tab.blocks.length ? 'No command found in this terminal\'s output yet.'
      : 'No commands found. This works in zsh, bash and PowerShell started by this app.', { error: true });
  }
  return read;
}

const describeBlock = ({ output }) => {
  const lines = output ? output.split('\n').length : 0;
  return `${lines} line${lines === 1 ? '' : 's'} of output`;
};

// `which` names the command in the message: "the last command" or "the command".
async function copyForChat(tab, read, which) {
  try {
    await navigator.clipboard.writeText(formatBlock(tab, read));
    toast(`Copied ${which} and ${describeBlock(read)}:`, { code: read.command || '(command not known)' });
  } catch (err) {
    toast(`Couldn't copy: ${err.message}`, { error: true });
  }
}

async function sendToClaude(tab, read, which) {
  chooseRightTab('claude');
  if (await window.airlock.sendToChat(formatBlock(tab, read))) {
    toast(`Sent ${which} and ${describeBlock(read)} to Claude:`, { code: read.command || '(command not known)' });
  } else {
    toast('Copied, but Claude\'s message box wasn\'t found. Paste it in yourself.', { error: true });
  }
}

function copyLastBlock(tab = activeTab) {
  const read = lastBlockOrSay(tab);
  if (read) copyForChat(tab, read, 'the last command');
}

function sendLastBlock(tab = activeTab) {
  const read = lastBlockOrSay(tab);
  if (read) sendToClaude(tab, read, 'the last command');
}

// --- Highlighted text in the terminal ------------------------------------------------------
// Copying it goes to the clipboard only, never the airlock: it's output to keep, not a command
// to run.

const describeLines = (text) => {
  const lines = text.split('\n').length;
  return `${lines} line${lines === 1 ? '' : 's'}`;
};

// `quiet` (copy on select) shows a status bar note instead of a toast, so it doesn't nag.
async function copySelection(tab = activeTab, { quiet = false } = {}) {
  const text = tab?.term.getSelection();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (quiet) setStatus(`Copied ${describeLines(text)}`, 2000);
    else toast(`Copied ${describeLines(text)} to the clipboard`);
  } catch (err) {
    toast(`Couldn't copy: ${err.message}`, { error: true });
  }
}

async function sendSelection(tab = activeTab) {
  const text = tab?.term.getSelection();
  if (!text) return;
  chooseRightTab('claude');
  if (await window.airlock.sendToChat(fenced(text))) toast(`Sent ${describeLines(text)} to Claude`);
  else toast('Copied, but Claude\'s message box wasn\'t found. Paste it in yourself.', { error: true });
}

// Send to Scratchpad: the text goes on the end of the scratchpad, after a blank line, as plain
// text rather than the Markdown a chat gets. The terminal stays in view.
function appendToScratchpad(text) {
  const pad = scratchpad.classList.contains('split') ? activePad : padA; // padB only shows when split
  const { textarea } = pad;
  const end = textarea.value.length;
  const gap = !end || textarea.value.endsWith('\n\n') ? '' : textarea.value.endsWith('\n') ? '\n' : '\n\n';
  textarea.setRangeText(`${gap}${text.replace(/\s+$/, '')}\n`, end, end, 'end');
  textarea.scrollTop = textarea.scrollHeight;
  textarea.dispatchEvent(new Event('input', { bubbles: true })); // saved, as typing would be
}

function sendBlockToScratchpad(tab, { command, output, exitCode, running, truncated }, which) {
  const prompt = isPowerShell(tab.shellId) ? 'PS> ' : '$ ';
  const text = [command && prompt + command.replace(/\n/g, '\n  '), truncated && '[earlier output no longer in the scrollback]', output,
    running ? '(Still running.)' : exitCode ? `Exit code: ${exitCode}` : ''].filter(Boolean).join('\n');
  appendToScratchpad(text);
  toast(`Added ${which} and ${describeBlock({ output })} to the Scratchpad:`, { code: command || '(command not known)' });
}

function sendSelectionToScratchpad(tab = activeTab) {
  const text = tab?.term.getSelection();
  if (!text) return;
  appendToScratchpad(text);
  toast(`Added ${describeLines(text)} to the Scratchpad`);
}

async function pasteIntoTerminal(tab = activeTab) {
  if (!tab) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) tab.term.paste(text); // bracketed when the shell asks for it, so it doesn't run line by line
  } catch (err) {
    toast(`Couldn't paste: ${err.message}`, { error: true });
  }
  tab.term.focus();
}

const insideTerminal = (target) => Boolean(activeTab?.term.element?.contains(target));

$('terminal-wrap').addEventListener('contextmenu', (e) => {
  if (!insideTerminal(e.target)) return;
  e.preventDefault();
  window.airlock.terminalMenu({ hasSelection: activeTab.term.hasSelection() });
});

window.airlock.onTerminalMenu((action) => {
  const tab = activeTab;
  if (!tab) return;
  if (action === 'copy') copySelection(tab);
  else if (action === 'paste') pasteIntoTerminal(tab);
  else if (action === 'select-all') { tab.term.selectAll(); tab.term.focus(); }
  else if (action === 'send') sendSelection(tab);
  else if (action === 'scratchpad') sendSelectionToScratchpad(tab);
  else if (action === 'find') openFind();
});

// Copy on select (off by default): letting go of the mouse after highlighting copies it, as in
// PuTTY. It watches the mouse rather than the selection, so Find's matches aren't copied.
// A drag can end outside the terminal, so it's where it started that counts.
let selectingInTerminal = false;
$('terminal-wrap').addEventListener('mousedown', (e) => {
  selectingInTerminal = e.button === 0 && insideTerminal(e.target);
});
document.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !selectingInTerminal) return;
  selectingInTerminal = false;
  if (!prefs.copyOnSelect) return;
  // After xterm has finished the selection (a double-click selects a word on the same mouseup).
  setTimeout(() => { if (activeTab?.term.hasSelection()) copySelection(activeTab, { quiet: true }); }, 0);
});

const shortcut = (mac, other) => (window.airlock.platform === 'darwin' ? mac : other);
$('copy-block').title = `Copy the last command and its output, for pasting into a chat (${shortcut('Cmd+Shift+C', 'Ctrl+Shift+C with nothing selected')})`;
$('send-block').title = `Put the last command and its output in Claude's message box (${shortcut('Cmd+Shift+Enter', 'Ctrl+Shift+Enter')} with nothing selected)`;
$('copy-block').addEventListener('click', () => copyLastBlock());
$('send-block').addEventListener('click', () => sendLastBlock());

// The command under the mouse gets a band and buttons, like a block in a Runsheet.
let hoveredCommand = null;
let terminalMouse = null; // where the mouse is over the terminal, or null when it isn't

function showHoveredBlock() {
  const tab = activeTab;
  let block = null;
  let screen = null;
  let cellHeight = 0;
  if (terminalMouse && tab && view === 'terminal' && tab.term.buffer.active.type === 'normal') {
    screen = tab.term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    cellHeight = screen ? screen.height / tab.term.rows : 0;
    if (cellHeight && terminalMouse.y >= screen.top && terminalMouse.y < screen.bottom) {
      block = blockAtLine(tab, tab.term.buffer.active.viewportY + Math.floor((terminalMouse.y - screen.top) / cellHeight));
    }
  }
  hoveredCommand = block && { tab, block };
  $('block-band').hidden = !block;
  $('block-actions').hidden = !block;
  if (!block) return;
  const range = blockRange(tab, block);
  const wrap = $('terminal-wrap').getBoundingClientRect();
  const viewportY = tab.term.buffer.active.viewportY;
  // Clipped to the part that's on screen.
  const top = Math.max(range.top - viewportY, 0);
  const bottom = Math.min(range.bottom - viewportY + 1, tab.term.rows);
  const offset = screen.top - wrap.top;
  $('block-band').style.top = `${offset + top * cellHeight}px`;
  $('block-band').style.height = `${(bottom - top) * cellHeight}px`;
  $('block-actions').style.top = `${offset + top * cellHeight + 2}px`;
}

$('terminal-wrap').addEventListener('mousemove', (e) => {
  if (e.buttons) return; // selecting text
  terminalMouse = { y: e.clientY };
  showHoveredBlock();
});
$('terminal-wrap').addEventListener('mouseleave', () => {
  terminalMouse = null;
  showHoveredBlock();
});
$('block-copy').title = 'Copy this command and its output, for pasting into a chat';
$('block-send').title = 'Put this command and its output in Claude\'s message box';
$('block-scratch').title = 'Add this command and its output to the end of the scratchpad';
for (const [id, action] of [['block-copy', copyForChat], ['block-send', sendToClaude], ['block-scratch', sendBlockToScratchpad]]) {
  $(id).addEventListener('click', () => {
    const read = hoveredCommand && readBlock(hoveredCommand.tab, hoveredCommand.block);
    if (read) action(hoveredCommand.tab, read, 'the command');
  });
}

// --- Find in the terminal -------------------------------------------------------------------

const findOptions = { caseSensitive: false, regex: false };
// Matches are highlighted from typing in the box until Escape.
let findActive = false;

// Match colours must be #RRGGBB. VS Code's, flattened onto each background.
function findDecorations() {
  const light = theme === 'light';
  return {
    matchBackground: light ? '#f8cfaa' : '#5c3415',
    matchOverviewRuler: '#d18616',
    activeMatchBackground: light ? '#a8ac94' : '#9e6a03',
    activeMatchBorder: '#f38518',
    activeMatchColorOverviewRuler: '#f38518',
  };
}

function runFind({ backwards = false, incremental = false } = {}) {
  if (view !== 'terminal') showView('terminal', { focus: false });
  const query = $('find-input').value;
  const { search } = activeTab;
  findActive = Boolean(query);
  if (!query) {
    search.clearDecorations();
    $('find-count').textContent = '';
    $('find-input').classList.remove('invalid');
    return;
  }
  const options = { ...findOptions, incremental, decorations: findDecorations() };
  try {
    if (backwards) search.findPrevious(query, options);
    else search.findNext(query, options);
    $('find-input').classList.remove('invalid');
  } catch {
    // An unfinished regular expression.
    $('find-input').classList.add('invalid');
    $('find-count').textContent = '';
  }
}

function showFindCount({ resultIndex, resultCount }) {
  $('find-count').textContent = !findActive ? ''
    : resultCount === 0 ? 'No results'
      : resultIndex === -1 ? `${resultCount}+ results`
        : `${resultIndex + 1} of ${resultCount}`;
}

function openFind() {
  const input = $('find-input');
  // Start from the selection, as most editors do, if it's on one line.
  const selection = activeTab.term.getSelection();
  if (selection && !selection.includes('\n')) input.value = selection;
  input.select();
  input.focus();
  if (input.value) runFind({ incremental: true });
}

// Escape: the highlights go, the text stays for next time.
function endFind() {
  findActive = false;
  activeTab?.search.clearDecorations();
  $('find-count').textContent = '';
  activeTab?.term.focus();
}

function findFollowsTab(previous) {
  if (!findActive || previous === activeTab) return;
  previous?.search.clearDecorations();
  runFind({ incremental: true });
}

$('find-input').addEventListener('input', () => runFind({ incremental: true }));
$('find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runFind({ backwards: e.shiftKey }); }
  else if (e.key === 'Escape') { e.preventDefault(); endFind(); }
});
$('find-prev').addEventListener('click', () => runFind({ backwards: true }));
$('find-next').addEventListener('click', () => runFind());
for (const [id, option] of [['find-case', 'caseSensitive'], ['find-regex', 'regex']]) {
  $(id).addEventListener('click', () => {
    findOptions[option] = !findOptions[option];
    $(id).setAttribute('aria-pressed', String(findOptions[option]));
    runFind({ incremental: true });
    $('find-input').focus();
  });
}
$('find-input').title = `Find in this terminal's output (${shortcut('Cmd+F', 'Ctrl+Shift+F')})`;

// --- Shell picker -----------------------------------------------------------------------

const shellPicker = $('shell');
const defaultShellId = () => (shellLabels.has(prefs.lastShell) ? prefs.lastShell : shellLabels.keys().next().value);

// Send a command to the active terminal as if typed and entered.
function sendCommand(text, { focus = true } = {}) {
  if (view !== 'terminal') showView('terminal', { focus }); // nothing runs out of sight
  activeTab.term.paste(text);
  noteBlockInput(activeTab, '\r');
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
paneZoom(airlockText, 'airlockFontSize', (size) => root.setProperty('--airlock-font-size', `${size}px`));
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

function receiveCopy(text, gesture, { autoRunOff = false, again = 'copy again quickly to auto-run' } = {}) {
  fillAirlock(text);
  const enabled = prefs.doubleCopyRun !== false;
  const now = Date.now();
  const isDouble = enabled && gesture && lastCopy?.gesture && lastCopy.gesture !== gesture
    && lastCopy.text === text && now - lastCopy.at <= DOUBLE_COPY_MS;
  if (!isDouble) {
    lastCopy = { text, gesture, at: now };
    const message = enabled && gesture ? `Sent to Airlock, ${again}`
      : autoRunOff ? 'Sent to Airlock. Auto-run is off for this site.' : 'Sent to Airlock';
    setStatus(message, DOUBLE_COPY_MS);
    return;
  }
  lastCopy = null; // a third copy starts over rather than running again
  if (activeTab.remote?.env === 'prod') {
    setStatus(`Not run: auto-run is off in PROD tabs. Press Run to run it on ${activeTab.remote.name}.`, STATUS_RAN_MS);
    return;
  }
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
async function runText(raw, { focus = true } = {}) {
  const text = raw.replace(/\s+$/, '');
  if (!text) return;
  // A PROD remote asks first, whatever the command came from (ADR 0008).
  const tab = activeTab;
  if (tab.remote?.env === 'prod' && !(await window.airlock.confirmRemoteRun({ name: tab.remote.name, command: text }))) return;
  if (activeTab !== tab) return; // switched tabs while the question was open
  sendCommand(text, { focus });
  window.airlock.addHistory(text);
  cmdHistory.push({ ts: new Date().toISOString(), command: text });
  if (libraryTab === 'history') renderLibrary();
  if (focus) activeTab.term.focus();
}
const runAirlock = () => runText(airlockText.value);
// Only the highlighted part of the airlock text, for running one line of a longer block.
function runAirlockSelection() {
  const selected = airlockText.value.slice(airlockText.selectionStart, airlockText.selectionEnd);
  if (selected.trim()) runText(selected);
  else toast('Highlight the text to run first.', { error: true });
}
$('run').addEventListener('click', runAirlock);
$('run-selection').addEventListener('click', runAirlockSelection);
airlockText.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  if (e.shiftKey) runAirlockSelection();
  else runAirlock();
});

// In the airlock: Cmd/Ctrl+S saves it as a snippet (or saves the name being typed), and
// Cmd/Ctrl+R saves it to a repo. Only here, so Ctrl+R still reaches the shell and Cmd+S still
// saves a Runsheet.
$('airlock-main').addEventListener('keydown', (e) => {
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey || e.shiftKey || !['KeyS', 'KeyR'].includes(e.code)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'KeyR') $('save-team').click();
  else if (!snippetForm.hidden) snippetForm.requestSubmit();
  else $('save-snippet').click();
});

// The ⋯ menu holds the airlock's less frequent actions, so its header never wraps. It's fixed to
// the window, since the airlock pane would clip it, and opens upward over the terminal.
const airlockMenu = $('airlock-menu');
const airlockMenuItems = () => [...airlockMenu.querySelectorAll('button')];
function setAirlockMenu(open, { focusFirst = false } = {}) {
  airlockMenu.hidden = !open;
  $('airlock-more').setAttribute('aria-expanded', String(open));
  if (!open) return;
  const r = $('airlock-more').getBoundingClientRect();
  airlockMenu.style.right = `${Math.max(window.innerWidth - r.right, 8)}px`;
  airlockMenu.style.bottom = `${window.innerHeight - r.top + 4}px`;
  if (focusFirst) airlockMenuItems()[0].focus();
}
// A click from the keyboard (Enter or Space) has no mouse position, and moves focus into the menu.
$('airlock-more').addEventListener('click', (e) => setAirlockMenu(airlockMenu.hidden, { focusFirst: e.detail === 0 }));
airlockMenu.addEventListener('click', (e) => { if (e.target.closest('button')) setAirlockMenu(false); });
airlockMenu.addEventListener('keydown', (e) => {
  const items = airlockMenuItems();
  const at = items.indexOf(document.activeElement);
  if (e.key === 'Escape') {
    setAirlockMenu(false);
    $('airlock-more').focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  } else return;
  e.stopPropagation();
});
document.addEventListener('mousedown', (e) => {
  if (!airlockMenu.hidden && !airlockMenu.contains(e.target) && !$('airlock-more').contains(e.target)) setAirlockMenu(false);
}, true);
for (const event of ['blur', 'resize']) window.addEventListener(event, () => setAirlockMenu(false));

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

function item({ label, mono, meta, title, className, onPick, onDelete }) {
  const li = document.createElement('li');
  li.title = title;
  if (className) li.className = className;
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
    // Order: snippets for the terminal's folder or a folder it's inside (highlighted), the repo
    // README's code blocks, regular snippets, then other folders' snippets if the box is ticked.
    const here = withinPath(activeTab?.cwd ?? '');
    const local = snippets.filter((s) => s.cwd && here(s.cwd));
    const regular = snippets.filter((s) => !s.cwd);
    const others = prefs.showOtherFolderSnippets ? snippets.filter((s) => s.cwd && !here(s.cwd)) : [];
    const snippetItem = (s) => item({
      label: s.name,
      meta: s.cwd && !here(s.cwd) ? folderName(s.cwd) : '',
      title: s.cwd ? `${s.command}\n\nFor ${s.cwd} and its subfolders` : s.command,
      className: !s.cwd ? '' : here(s.cwd) ? 'local' : 'other',
      onPick: () => fillAirlock(s.command),
      onDelete: () => storeSnippets(snippets.filter((x) => x !== s)),
    });
    items = [
      ...local.filter((s) => matches(s.name, s.command)).map(snippetItem),
      ...readme.blocks.filter((b) => matches(b.name, b.command)).map((b) => item({
        label: b.name,
        meta: 'README',
        title: `${b.command}\n\nFrom the README in ${readme.repo}`,
        className: 'readme',
        onPick: () => fillAirlock(b.command),
      })),
      ...regular.filter((s) => matches(s.name, s.command)).map(snippetItem),
      ...others.filter((s) => matches(s.name, s.command, s.cwd)).map(snippetItem),
    ];
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
  $('other-folders-row').hidden = tab !== 'snippets';
  renderLibrary();
}
$('tab-snippets').addEventListener('click', () => showTab('snippets'));
$('tab-history').addEventListener('click', () => showTab('history'));
$('filter').addEventListener('input', renderLibrary);

// Folders as the shell reports them. Windows paths ignore case and both slashes.
function normalisePath(p) {
  const windows = /^([a-z]:|\\\\)/i.test(p);
  const trimmed = p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
  return windows ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
}
const samePath = (cwd) => {
  const a = normalisePath(cwd);
  return (other) => Boolean(a) && normalisePath(other) === a;
};
// True for a snippet folder that is the terminal's folder or contains it.
const withinPath = (cwd) => {
  const here = normalisePath(cwd);
  return (folder) => {
    const base = normalisePath(folder);
    if (!here || !base) return false;
    const sep = base.includes('\\') ? '\\' : '/';
    return here === base || here.startsWith(base.endsWith(sep) ? base : base + sep);
  };
};
const folderName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

$('other-folders').checked = prefs.showOtherFolderSnippets === true;
$('other-folders').addEventListener('change', (e) => {
  saveSetting('showOtherFolderSnippets', e.target.checked);
  renderLibrary();
});

// Code blocks from the README of the repository the active terminal is in, offered as snippets.
let readme = { key: '', repo: '', blocks: [] };
function readmeBlocks(text) {
  const blocks = [];
  const seen = new Map();
  let heading = '';
  const walk = (tokens) => {
    for (const t of tokens ?? []) {
      if (t.type === 'heading') heading = t.text.replace(/[`*_]/g, '');
      if (t.type === 'code' && t.text.trim()) {
        const base = heading || 'README';
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        blocks.push({ name: n > 1 ? `${base} (${n})` : base, command: t.text });
      }
      walk(t.tokens);
      for (const listItem of t.items ?? []) walk(listItem.tokens);
    }
  };
  walk(marked.lexer(text));
  return blocks;
}
async function loadReadmeSnippets() {
  const tab = activeTab;
  const key = tab ? `${tab.id}\0${tab.cwd}` : '';
  if (key === readme.key) return;
  readme = { key, repo: '', blocks: [] };
  const found = tab?.cwd ? await window.airlock.readmeSnippets(tab.id) : null;
  if (readme.key !== key) return; // the folder or tab changed while reading
  if (found) readme = { key, repo: found.repo, blocks: readmeBlocks(found.text) };
  renderLibrary();
}
// Called whenever the active terminal or its folder changes.
function libraryFollowsTerminal() {
  renderLibrary();
  loadReadmeSnippets();
}

// Save the airlock text as a snippet (inline name field; Electron has no prompt()).
const snippetForm = $('snippet-form');
function toggleSnippetForm(show) {
  snippetForm.hidden = !show;
  $('save-snippet').hidden = show;
  if (!show) return;
  const cwd = activeTab?.cwd ?? '';
  const scope = $('snippet-scope');
  scope.options[1].textContent = cwd ? `Only in ${folderName(cwd)}` : 'Only in this folder';
  scope.options[1].disabled = !cwd;
  scope.title = cwd ? `"Only in" shows the snippet at the top of the list when the terminal is in ${cwd} or a folder inside it` : '';
  scope.value = 'all';
  $('snippet-name').focus();
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
  const cwd = $('snippet-scope').value === 'cwd' ? activeTab?.cwd ?? '' : '';
  // Saving under an existing name replaces it, within the same folder (or among regular snippets).
  const same = (s) => s.name === name && (cwd ? Boolean(s.cwd) && samePath(cwd)(s.cwd) : !s.cwd);
  const next = [...snippets.filter((s) => !same(s)), cwd ? { name, command, cwd } : { name, command }]
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

let rightTab = ['team', 'personal'].includes(prefs.rightTab) ? 'snippets' : prefs.rightTab ?? 'claude';
// The chat and web pages are native views above this page, so only the current one is shown.
function syncNativeViews() {
  window.airlock.setChatVisible(rightTab === 'claude');
  window.airlock.setWebVisible(rightTab === 'web');
}
// One Snippets tab lists Team and Personal repos together. Before, each had its own tab.
const isSnippetTab = (tab) => tab === 'snippets';
function showRightTab(tab) {
  rightTab = tab;
  $('web').hidden = tab !== 'web';
  $('runsheet').hidden = tab !== 'runsheet';
  $('team').hidden = !isSnippetTab(tab);
  $('remotes').hidden = tab !== 'remotes';
  $('tab-remotes').classList.toggle('active', tab === 'remotes');
  $('tab-claude').classList.toggle('active', tab === 'claude');
  $('tab-web').classList.toggle('active', tab === 'web');
  $('tab-runsheet').classList.toggle('active', tab === 'runsheet');
  $('tab-repos').classList.toggle('active', isSnippetTab(tab));
  syncNativeViews();
  // After this script has run, as the snippets section is defined further down.
  if (isSnippetTab(tab)) queueMicrotask(showTeamTab);
  if (tab === 'remotes' && typeof showRemotesTab === 'function') showRemotesTab(); // remotes.js loads later, and opens it then
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
$('tab-repos').addEventListener('click', () => chooseRightTab('snippets'));
$('tab-remotes').addEventListener('click', () => chooseRightTab('remotes'));

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
// A script to work through, always editable (ADR 0009). Ctrl+Enter runs the highlighted text or
// the block at the cursor; each block also has Copy and Run buttons. Copying from it works like
// copying from the chat: the text goes to the airlock and nothing runs until the user presses Run.

// Lines are a fixed height so the mouse position gives the line. It grows with the text size,
// which sets --runsheet-line-height for style.css.
let runsheetLineHeight = 20;
let runsheetCharWidth = 0; // measured when first needed, and again after the text size changes
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

// The editor holds the working copy. runsheetText is the file as last read or saved, so the two
// differ exactly when there are unsaved changes.
const editor = $('runsheet-editor');
let runsheetText = null;
let runsheetRelative = '';
let runsheetName = '';
let runsheetLang = 'plaintext';
let runsheetBaseUrl = '';
let runsheetEditable = true;
let runsheetLines = [];
let runsheetBlocks = [];
let runsheetFiles = [];
let hoveredBlock = null;
let hoveredLine = -1;
let filesOpen = false;
let showSource = false; // Markdown: its source instead of the formatted page
let savingRunsheet = false;

const showingPage = () => runsheetText !== null && runsheetLang === 'markdown' && !showSource;
const hasRunsheetEdits = () => runsheetText !== null && editor.value !== runsheetText;
const runsheetScroller = () => (showingPage() ? $('runsheet-page') : $('runsheet-scroll'));
const runsheetBlockAt = (line) => runsheetBlocks.find(([first, last]) => line >= first && line <= last) ?? null;
const blockText = (block) => runsheetLines.slice(block[0], block[1] + 1).join('\n');
const caretLine = () => editor.value.slice(0, editor.selectionStart).split('\n').length - 1;

// The file list fills the pane until a file opens, then collapses into the bar above it.
function syncRunsheetLayout() {
  const hasFile = runsheetText !== null;
  const edited = hasRunsheetEdits();
  $('runsheet').classList.toggle('has-file', hasFile);
  $('runsheet-files').hidden = hasFile && !filesOpen;
  $('runsheet-bar').hidden = !hasFile;
  $('runsheet-view').hidden = !hasFile || showingPage();
  $('runsheet-page').hidden = !showingPage();
  $('runsheet-source').hidden = runsheetLang !== 'markdown';
  $('runsheet-source').textContent = showSource ? 'Preview' : 'Source';
  $('runsheet-save').disabled = !edited;
  $('runsheet-name').textContent = `${runsheetRelative}${edited ? ' •' : ''}`;
  $('tab-runsheet').textContent = edited ? 'Runsheet •' : 'Runsheet';
  $('runsheet-toggle').textContent = filesOpen ? 'Files ▴' : 'Files ▾';
  $('runsheet-toggle').setAttribute('aria-expanded', String(filesOpen));
}

function closeRunsheet() {
  runsheetText = null;
  runsheetRelative = '';
  runsheetLang = 'plaintext';
  filesOpen = false;
  showSource = false;
  editor.value = '';
  showBlock(null);
  syncRunsheetLayout();
  renderRunsheetList();
}

// The filter takes plain text, which can appear anywhere in the path, or wildcards: * for any
// characters and ? for one. A wildcard pattern matches the file name, or the whole path if it
// has a /. Several patterns, separated by spaces or commas, list files matching any of them.
function runsheetFilter(query) {
  const terms = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!terms.length) return () => true;
  const tests = terms.map((term) => {
    if (!/[*?]/.test(term)) return (file) => file.includes(term);
    const pattern = term.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`);
    return term.includes('/') ? (file) => regex.test(file) : (file) => regex.test(file.slice(file.lastIndexOf('/') + 1));
  });
  return (file) => tests.some((test) => test(file.toLowerCase()));
}

function renderRunsheetList(message = '') {
  const q = $('runsheet-filter').value.trim();
  const matches = runsheetFilter(q);
  const note = (text) => {
    const li = document.createElement('li');
    li.className = 'message';
    li.textContent = text;
    return li;
  };
  const items = runsheetFiles.filter(matches).map((file) => {
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

// Unsaved changes are only thrown away when the user says so.
const mayDiscardRunsheetEdits = async () => !hasRunsheetEdits() || window.airlock.confirmDiscardRunsheet();

async function openRunsheetFile(relative) {
  if (relative === runsheetRelative && runsheetText !== null) { // already open: just put the list away
    filesOpen = false;
    syncRunsheetLayout();
    reloadRunsheet({ quiet: true });
    return;
  }
  if (!(await mayDiscardRunsheetEdits())) return;
  const sheet = await window.airlock.openRunsheet(relative);
  if (!sheet) return;
  if (sheet.error) { toast(`Can't open ${sheet.name}: ${sheet.error}.`, { error: true }); return; }
  filesOpen = false;
  showRunsheet(sheet);
}

async function chooseRunsheetFolder() {
  if (!(await mayDiscardRunsheetEdits())) return;
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

// The highlighted copy under the editor, the line numbers and the blocks all follow its text.
function refreshRunsheetCode() {
  const text = editor.value;
  runsheetLines = text.split('\n');
  // Blocks are runs of lines between blank lines, each with its own Copy and Run buttons.
  runsheetBlocks = [];
  let start = null;
  runsheetLines.forEach((line, i) => {
    if (line.trim() && start === null) start = i;
    if (!line.trim() && start !== null) { runsheetBlocks.push([start, i - 1]); start = null; }
  });
  if (start !== null) runsheetBlocks.push([start, runsheetLines.length - 1]);
  // Highlight.js escapes the text, so its output is safe to insert as HTML. A pre doesn't show a
  // final empty line, but the textarea does, so a space holds it open.
  const highlighted = hljs.highlight(text, { language: runsheetLang, ignoreIllegals: true }).value;
  $('runsheet-code').firstElementChild.innerHTML = highlighted + (!text || text.endsWith('\n') ? ' ' : '');
  $('runsheet-gutter').textContent = runsheetLines.map((_line, i) => i + 1).join('\n');
  showBlock(runsheetBlockAt(hoveredLine));
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
    const actions = document.createElement('div');
    actions.className = 'block-actions';
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.title = 'Copy this block to the clipboard and the airlock';
    const run = document.createElement('button');
    run.textContent = 'Run';
    run.title = 'Run this block in the terminal';
    const text = () => code.textContent.replace(/\n$/, '');
    copy.addEventListener('click', () => copyBlock(text(), copy));
    run.addEventListener('click', () => runText(text()));
    actions.append(copy, run);
    code.parentElement.append(actions);
  }
}

// Shows a file just opened, read again or saved. When the file says what the editor already
// holds, the editor is left alone, so its cursor and undo history survive a save.
function showRunsheet(sheet) {
  const text = sheet.text.replace(/\r\n?/g, '\n');
  const sameFile = runsheetText !== null && sheet.relative === runsheetRelative;
  const scroll = runsheetScroller().scrollTop;
  const language = runsheetLanguage(sheet.name, text);
  runsheetText = text;
  runsheetRelative = sheet.relative;
  runsheetName = sheet.name;
  runsheetBaseUrl = sheet.baseUrl;
  runsheetEditable = sheet.editable;
  if (!savingRunsheet) editor.readOnly = !runsheetEditable;
  $('runsheet-name').title = sheet.path;
  $('runsheet-lang').textContent = (language === 'plaintext' ? 'Plain text' : hljs.getLanguage(language).name)
    + (runsheetEditable ? '' : ' · read-only');
  $('runsheet-lang').title = runsheetEditable ? '' : "It isn't valid UTF-8 or UTF-16, so saving could damage it.";
  if (!sameFile) {
    showSource = false;
    hoveredLine = -1;
  }
  const changed = !sameFile || language !== runsheetLang || editor.value !== text;
  runsheetLang = language;
  if (changed) {
    const { selectionStart, selectionEnd } = editor;
    if (editor.value !== text) editor.value = text;
    if (sameFile) editor.setSelectionRange(Math.min(selectionStart, text.length), Math.min(selectionEnd, text.length));
    else editor.setSelectionRange(0, 0);
    refreshRunsheetCode();
    if (showingPage()) renderMarkdown(text, runsheetBaseUrl);
  }
  syncRunsheetLayout();
  renderRunsheetList();
  if (changed) {
    runsheetScroller().scrollTop = sameFile ? scroll : 0;
    if (!sameFile) $('runsheet-scroll').scrollLeft = 0;
  }
}

async function reloadRunsheet({ quiet = false } = {}) {
  // Background checks leave unsaved changes alone: saving asks if the file changed underneath them.
  if (quiet && hasRunsheetEdits()) return;
  if (!quiet && !(await mayDiscardRunsheetEdits())) return;
  const sheet = await window.airlock.readRunsheet();
  if (!sheet) return;
  if (quiet && hasRunsheetEdits()) return; // typing started while the file was being read
  if (hasRunsheetEdits()) { // the user chose to discard them
    editor.value = runsheetText;
    refreshRunsheetCode();
    if (showingPage()) renderMarkdown(editor.value, runsheetBaseUrl);
    syncRunsheetLayout();
  }
  if (!sheet.error) { showRunsheet(sheet); return; }
  // Quiet checks only speak up about a file that was open and has gone.
  if (!quiet || runsheetText !== null) toast(`Can't open ${sheet.name}: ${sheet.error}.`, { error: true });
  if (runsheetText !== null) closeRunsheet();
}
$('runsheet-reload').addEventListener('click', () => reloadRunsheet());
// The folder or the open script may have changed while the app was in the background.
window.addEventListener('focus', () => {
  reloadRunsheet({ quiet: true });
  loadRunsheetList();
});

async function saveRunsheet() {
  if (savingRunsheet || runsheetText === null) return;
  if (!hasRunsheetEdits()) { setStatus(`No changes to save in ${runsheetName}`, 2000); return; }
  savingRunsheet = true;
  editor.readOnly = true; // what's saved has to be what's on screen
  try {
    const sheet = await window.airlock.saveRunsheet(runsheetRelative, editor.value, runsheetText);
    if (!sheet) return;
    if (sheet.error) { toast(`Can't save ${sheet.name}: ${sheet.error}.`, { error: true }); return; }
    showRunsheet(sheet);
    setStatus(`Saved ${sheet.name}`, 3000);
  } finally {
    savingRunsheet = false;
    editor.readOnly = !runsheetEditable;
  }
}
$('runsheet-save').addEventListener('click', saveRunsheet);
$('runsheet-source').addEventListener('click', () => {
  showSource = !showSource;
  if (!showSource) renderMarkdown(editor.value, runsheetBaseUrl);
  syncRunsheetLayout();
  if (showSource) editor.focus({ preventScroll: true });
});
// Main asks before the window closes with this held open (will-prevent-unload).
window.addEventListener('beforeunload', (e) => { if (hasRunsheetEdits()) e.returnValue = false; });

// --- Runsheet editor ---
// A see-through textarea over the highlighted text (style.css), as tall and wide as its text, so
// the pane around it does the scrolling and keeps the cursor in view.

function charWidth() {
  if (!runsheetCharWidth) {
    const probe = document.createElement('span');
    probe.textContent = 'x'.repeat(100);
    $('runsheet-code').append(probe);
    runsheetCharWidth = probe.getBoundingClientRect().width / 100;
    probe.remove();
  }
  return runsheetCharWidth;
}

function revealCaret() {
  if (document.activeElement !== editor || $('runsheet-view').hidden) return;
  const at = editor.selectionDirection === 'backward' ? editor.selectionStart : editor.selectionEnd;
  const lineStart = editor.value.lastIndexOf('\n', at - 1) + 1;
  let line = 0;
  for (let i = editor.value.indexOf('\n'); i !== -1 && i < lineStart; i = editor.value.indexOf('\n', i + 1)) line++;
  let column = 0;
  for (const ch of editor.value.slice(lineStart, at)) column = ch === '\t' ? column + 4 - (column % 4) : column + 1;
  const scroller = $('runsheet-scroll');
  const top = RUNSHEET_PADDING + line * runsheetLineHeight;
  if (top < scroller.scrollTop) scroller.scrollTop = top - RUNSHEET_PADDING;
  else if (top + runsheetLineHeight > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = top + runsheetLineHeight + RUNSHEET_PADDING - scroller.clientHeight;
  }
  // The line numbers stay put over the left edge, so the text shows from just right of them.
  const x = column * charWidth();
  const visible = scroller.clientWidth - $('runsheet-text').offsetLeft;
  if (x < scroller.scrollLeft) scroller.scrollLeft = Math.max(x - 4 * charWidth(), 0);
  else if (x + 2 * charWidth() > scroller.scrollLeft + visible) scroller.scrollLeft = x + 8 * charWidth() - visible;
}

editor.addEventListener('input', () => {
  refreshRunsheetCode();
  syncRunsheetLayout();
  revealCaret();
});
// The textarea is always big enough for its text, but the browser can still scroll it a moment
// before the highlighted copy catches up. The two must stay lined up.
editor.addEventListener('scroll', () => {
  editor.scrollTop = 0;
  editor.scrollLeft = 0;
});
editor.addEventListener('keydown', (e) => {
  const mod = window.airlock.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyS') {
    e.preventDefault();
    e.stopPropagation();
    saveRunsheet();
  } else if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) || (e.key === 'F8' && plain && !e.shiftKey)) {
    // Ctrl+Enter, as in the airlock. F8, as in the PowerShell ISE and VS Code.
    e.preventDefault();
    e.stopPropagation();
    runFromRunsheet();
  } else if (e.key === 'Tab' && plain && !e.shiftKey) {
    e.preventDefault();
    document.execCommand('insertText', false, '\t'); // unlike setting the value, this can be undone
  } else if (e.key === 'Enter' && plain && !e.shiftKey && !e.isComposing) {
    // A new line starts with the same indentation as the one before.
    const start = editor.selectionStart;
    const lineStart = editor.value.lastIndexOf('\n', start - 1) + 1;
    const indent = editor.value.slice(lineStart, start).match(/^[ \t]*/)[0];
    if (indent) {
      e.preventDefault();
      document.execCommand('insertText', false, `\n${indent}`);
    }
  } else {
    requestAnimationFrame(revealCaret); // arrow keys, Page Down and the like move the cursor
  }
});

// The selected part of the script or page. A drag can run past the page, and only the page counts.
function runsheetSelection() {
  if (!showingPage()) return editor.value.slice(editor.selectionStart, editor.selectionEnd);
  const container = $('runsheet-page');
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


// What Run and To airlock act on: the highlighted text, or else the block the cursor is in.
function runsheetTarget() {
  const selected = runsheetSelection();
  if (selected.trim()) return selected;
  if (showingPage()) return '';
  const block = runsheetBlockAt(caretLine());
  return block ? blockText(block) : '';
}

function runFromRunsheet() {
  const text = runsheetTarget();
  if (text) runText(text);
  else toast('Highlight the text to run, or put the cursor in a block.', { error: true });
}

// A block's Copy button copies to the clipboard and the airlock. It never runs anything: that's
// what the Run button beside it is for.
function copyBlock(text, button) {
  navigator.clipboard.writeText(text);
  fillAirlock(text);
  setStatus('Sent to Airlock', DOUBLE_COPY_MS);
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = 'Copy'; }, DOUBLE_COPY_MS);
}

// Copying from a runsheet works like copying in the chat, including double-copy. Cutting is
// editing, so it doesn't.
for (const el of [editor, $('runsheet-page')]) {
  el.addEventListener('copy', () => {
    const selected = runsheetSelection();
    if (selected.trim()) receiveCopy(selected, window.airlock.copyGesture());
  });
}
// Pressing these buttons mustn't take the focus, or the selection, from the editor.
for (const id of ['runsheet-airlock', 'runsheet-run-selection', 'runsheet-save', 'runsheet-copy', 'runsheet-run']) {
  $(id).addEventListener('mousedown', (e) => e.preventDefault());
}
// To airlock counts as a copy: pressed twice quickly on the same text, it runs (ADR 0005).
$('runsheet-airlock').addEventListener('click', () => {
  const text = runsheetTarget();
  if (text) receiveCopy(text, window.airlock.copyGesture(), { again: 'press again quickly to auto-run' });
  else toast('Highlight the text to send, or put the cursor in a block.', { error: true });
});
$('runsheet-run-selection').addEventListener('click', runFromRunsheet);

// Clicking a line number selects that whole line. Shift+click, or dragging down the numbers,
// selects every line in between.
let gutterAnchor = null;
function lineAt(clientY) {
  const y = clientY - $('runsheet-content').getBoundingClientRect().top - RUNSHEET_PADDING;
  return Math.min(Math.max(Math.floor(y / runsheetLineHeight), 0), runsheetLines.length - 1);
}
function selectRunsheetLines(a, b) {
  const [first, last] = a <= b ? [a, b] : [b, a];
  const lineStart = (i) => runsheetLines.slice(0, i).reduce((n, line) => n + line.length + 1, 0);
  editor.setSelectionRange(lineStart(first), lineStart(last) + runsheetLines[last].length);
}
$('runsheet-gutter').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !runsheetLines.length) return;
  e.preventDefault();
  editor.focus({ preventScroll: true });
  const line = lineAt(e.clientY);
  if (!e.shiftKey || gutterAnchor === null) gutterAnchor = line;
  selectRunsheetLines(gutterAnchor, line);
  const move = (m) => selectRunsheetLines(gutterAnchor, lineAt(m.clientY));
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});
// Links open in the system browser, never inside the app.
$('runsheet-page').addEventListener('click', (e) => {
  const link = e.target.closest('a');
  if (!link) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(link.href)) window.airlock.openExternal(link.href);
});

// The block under the mouse gets a band and Copy and Run buttons, like a code block in the chat.
function showBlock(block) {
  hoveredBlock = block;
  $('runsheet-band').hidden = !block;
  $('runsheet-block-actions').hidden = !block;
  if (!block) return;
  const top = RUNSHEET_PADDING + block[0] * runsheetLineHeight;
  $('runsheet-band').style.top = `${top}px`;
  $('runsheet-band').style.height = `${(block[1] - block[0] + 1) * runsheetLineHeight}px`;
  // The buttons sit outside the scrolling area so they stay in view, whatever the scroll position.
  $('runsheet-block-actions').style.top = `${Math.max(top - $('runsheet-scroll').scrollTop, 0) + 2}px`;
  $('runsheet-copy').textContent = 'Copy';
}
$('runsheet-scroll').addEventListener('mousemove', (e) => {
  if (e.buttons) return; // selecting text
  const y = e.clientY - $('runsheet-content').getBoundingClientRect().top - RUNSHEET_PADDING;
  hoveredLine = Math.floor(y / runsheetLineHeight);
  const block = runsheetBlockAt(hoveredLine);
  if (block?.join() !== hoveredBlock?.join()) showBlock(block);
});
$('runsheet-scroll').addEventListener('scroll', () => { if (hoveredBlock) showBlock(hoveredBlock); });
$('runsheet-view').addEventListener('mouseleave', () => {
  hoveredLine = -1;
  showBlock(null);
});
$('runsheet-copy').addEventListener('click', () => { if (hoveredBlock) copyBlock(blockText(hoveredBlock), $('runsheet-copy')); });
$('runsheet-run').addEventListener('click', () => { if (hoveredBlock) runText(blockText(hoveredBlock)); });

// --- Append to Runsheet ---
// The airlock text goes on the end of the open file as a block of its own, and waits there
// unsaved like any other edit. In a Markdown file it goes in a code block, so it gets Run buttons.

function terminalLanguage() {
  if (activeTab?.remote) return activeTab.remote.transport === 'ssh' ? 'bash' : 'powershell';
  return activeTab && isPowerShell(activeTab.shellId) ? 'powershell' : 'bash';
}

function appendToRunsheet() {
  const text = airlockText.value.replace(/\s+$/, '');
  if (!text.trim()) { toast('The airlock is empty.', { error: true }); return; }
  if (runsheetText === null) {
    chooseRightTab('runsheet');
    toast('Open a file in the Runsheet first.', { error: true });
    return;
  }
  if (!runsheetEditable || savingRunsheet) {
    toast(`Can't add to ${runsheetName}${savingRunsheet ? ' while it saves' : ": it isn't valid UTF-8 or UTF-16"}.`, { error: true });
    return;
  }
  const block = runsheetLang === 'markdown' ? fenced(text, terminalLanguage()) : text;
  const end = editor.value.length;
  const gap = !end || editor.value.endsWith('\n\n') ? '' : editor.value.endsWith('\n') ? '\n' : '\n\n';
  const addition = `${gap}${block}\n`;
  // Typed in, where the editor is showing, so Undo there takes it out again.
  const previous = document.activeElement;
  if (!$('runsheet').hidden && !$('runsheet-view').hidden) editor.focus({ preventScroll: true });
  if (document.activeElement === editor) {
    editor.setSelectionRange(end, end);
    document.execCommand('insertText', false, addition);
    previous?.focus({ preventScroll: true });
  } else {
    editor.setRangeText(addition, end, end, 'end');
    refreshRunsheetCode();
  }
  if (showingPage()) renderMarkdown(editor.value, runsheetBaseUrl);
  syncRunsheetLayout();
  runsheetScroller().scrollTop = runsheetScroller().scrollHeight;
  const saveKey = window.airlock.platform === 'darwin' ? '⌘S' : 'Ctrl+S';
  setStatus(`Appended to ${runsheetName}, not saved yet (${saveKey} in the Runsheet)`, STATUS_RAN_MS);
}
$('append-runsheet').addEventListener('mousedown', (e) => e.preventDefault()); // keep the airlock's focus
$('append-runsheet').addEventListener('click', appendToRunsheet);

// Text size: the script's lines and line numbers, or the whole formatted page.
paneZoom($('runsheet'), 'runsheetFontSize', (size) => {
  runsheetLineHeight = Math.round((size * 20) / DEFAULT_FONT_SIZE);
  runsheetCharWidth = 0;
  root.setProperty('--runsheet-font-size', `${size}px`);
  root.setProperty('--runsheet-line-height', `${runsheetLineHeight}px`);
  root.setProperty('--runsheet-zoom', String(size / DEFAULT_FONT_SIZE));
  if (hoveredBlock) showBlock(hoveredBlock);
});
syncRunsheetLayout();
loadRunsheetList();
reloadRunsheet();

// --- Snippets: Team and Personal snippets kept in git repos -------------------------------
// One combined list from every repo in Settings (ADR 0006). Like the Runsheet, nothing here runs
// on its own: Copy sends to the airlock and Run is an explicit click.

const TEAM_REFRESH_MS = 5 * 60 * 1000;
const snippetRepos = () => prefs.snippetRepos ?? [];
const KIND_NAMES = { team: 'Team', personal: 'Personal' };
const tabRepos = snippetRepos;
// The filter above the list: '' for everything, 'kind:team' or 'kind:personal', or one repo's id.
const repoShown = (r, only = $('team-repo-filter').value) => !only || r.id === only || only === `kind:${r.kind}`;
const repoLabel = (id) => snippetRepos().find((r) => r.id === id)?.label ?? id;
const repoState = new Map(); // repo id → { list, error, loadedAt, busy }
let teamEditing = null; // { repo, file, base } of the snippet being edited; file is null for a new one

// The first heading is the name and the first code block the command; anything else is ignored.
function parseTeamSnippet({ file, text, by, at }, repo) {
  const tokens = marked.lexer(text);
  const heading = tokens.find((t) => t.type === 'heading');
  const code = tokens.find((t) => t.type === 'code');
  return { repo, file, text, by, at, name: heading?.text.trim() || file.replace(/\.md$/, ''), command: code?.text ?? '' };
}

function showTeamState() {
  const states = tabRepos().map((r) => repoState.get(r.id) ?? {});
  const failed = tabRepos().filter((r) => repoState.get(r.id)?.error).map((r) => r.label);
  const el = $('team-state');
  el.textContent = states.some((s) => s.busy) ? 'Syncing…'
    : failed.length ? `Couldn't sync ${failed.join(', ')}`
      : states.some((s) => s.loadedAt) ? `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  el.title = el.textContent;
  el.classList.toggle('error', failed.length > 0);
}

async function loadRepo(repo) {
  const state = repoState.get(repo.id) ?? {};
  if (state.busy) return;
  repoState.set(repo.id, { ...state, busy: true });
  showTeamState();
  const { list, error } = await window.airlock.teamList(repo.id);
  if (!snippetRepos().some((r) => r.id === repo.id)) return; // removed meanwhile
  const next = { ...repoState.get(repo.id), busy: false, error: error ?? '' };
  if (list) Object.assign(next, { list: list.map((s) => parseTeamSnippet(s, repo.id)), loadedAt: Date.now() });
  repoState.set(repo.id, next);
  showTeamState();
  renderTeam();
}
const loadTeam = () => Promise.all(tabRepos().map(loadRepo));

function teamMessage(text, button) {
  const li = document.createElement('li');
  li.className = 'message';
  li.textContent = text;
  if (button) li.append(' ', button);
  return li;
}

function teamButton(label, title, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function teamEntry(s) {
  const li = document.createElement('li');
  const head = document.createElement('div');
  head.className = 'head';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name;
  head.append(name);
  if (tabRepos().length > 1) {
    const repo = document.createElement('span');
    repo.className = 'repo';
    repo.textContent = repoLabel(s.repo);
    head.append(repo);
  }
  if (s.by) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${s.by} · ${ago(s.at)}`;
    meta.title = `Last changed by ${s.by}, ${new Date(s.at).toLocaleString()}`;
    head.append(meta);
  }
  const edit = teamButton('Edit', '', () => openTeamForm({ repo: s.repo, file: s.file, base: s.text, name: s.name, command: s.command }));
  // Delete asks for a second click rather than a dialog.
  let armed = null;
  const del = teamButton('Delete', `Delete from ${repoLabel(s.repo)}`, async () => {
    if (!armed) {
      del.textContent = 'Delete?';
      del.classList.add('confirm');
      armed = setTimeout(() => { armed = null; del.textContent = 'Delete'; del.classList.remove('confirm'); }, 3000);
      return;
    }
    clearTimeout(armed);
    del.disabled = true;
    const result = await window.airlock.teamDelete({ repo: s.repo, file: s.file, base: s.text, name: s.name });
    if (result.error) toast(result.error, { error: true });
    else if (result.conflict) toast(`Someone else changed "${s.name}", so it wasn't deleted. Check their version first.`, { error: true });
    else setStatus(`Deleted "${s.name}" from ${repoLabel(s.repo)}`, STATUS_RAN_MS);
    loadRepo(snippetRepos().find((r) => r.id === s.repo));
  });
  head.append(edit, del);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = s.command;
  const actions = document.createElement('div');
  actions.className = 'block-actions';
  const copy = teamButton('Copy', 'Copy this snippet to the clipboard and the airlock', () => copyBlock(s.command, copy));
  const run = teamButton('Run', 'Run this snippet in the terminal', () => runText(s.command));
  actions.append(copy, run);
  pre.append(code, actions);
  li.append(head, pre);
  return li;
}

// The repo pickers follow Settings: the filter above the list and the one in the form.
function fillRepoPickers() {
  const repos = tabRepos();
  const option = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
  const bothKinds = new Set(repos.map((r) => r.kind)).size > 1;
  const filter = $('team-repo-filter');
  const shown = filter.value;
  filter.replaceChildren(
    option('', 'All snippets'),
    ...(bothKinds ? Object.entries(KIND_NAMES).map(([kind, name]) => option(`kind:${kind}`, name)) : []),
    ...repos.map((r) => option(r.id, bothKinds ? `${r.label} (${KIND_NAMES[r.kind]})` : r.label)),
  );
  filter.value = [...filter.options].some((o) => o.value === shown) ? shown : '';
  filter.hidden = repos.length < 2;
  const picker = $('team-repo');
  const picked = picker.value;
  picker.replaceChildren(...repos.map((r) => option(r.id, bothKinds ? `${r.label} (${KIND_NAMES[r.kind]})` : r.label)));
  if (repos.some((r) => r.id === picked)) picker.value = picked;
  picker.hidden = repos.length < 2;
}

function renderTeam() {
  const list = $('team-list');
  const repos = tabRepos();
  $('team-new').disabled = !repos.length;
  $('team-reload').disabled = !repos.length;
  if (!repos.length) {
    showTeamState();
    const open = teamButton('Open Settings', '', () => showView('settings'));
    list.replaceChildren(teamMessage('Add a Team or Personal git repo in Settings to keep snippets here.', open));
    return;
  }
  const only = $('team-repo-filter').value;
  const words = $('team-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = repos.filter((r) => repoShown(r, only))
    .flatMap((r) => repoState.get(r.id)?.list ?? [])
    .filter((s) => {
      const hay = `${s.name}\n${s.command}\n${s.by ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name) || repoLabel(a.repo).localeCompare(repoLabel(b.repo)));
  const rows = shown.map(teamEntry);
  const errors = repos.filter((r) => repoShown(r, only) && repoState.get(r.id)?.error);
  rows.unshift(...errors.map((r) => teamMessage(`${r.label}: ${repoState.get(r.id).error}`)));
  if (!rows.length) {
    const loaded = repos.some((r) => repoState.get(r.id)?.loadedAt);
    rows.push(teamMessage(!loaded ? 'Loading…'
      : words.length ? 'No snippets match.' : 'No snippets yet. Press New, or Save to Repo in the airlock.'));
  }
  list.replaceChildren(...rows);
}

// A new snippet goes to the repo picked in the form, which starts on the last one used. An
// existing one stays in its own repo.
function openTeamForm({ repo = null, file = null, base = null, name = '', command = '' } = {}) {
  fillRepoPickers();
  const repos = tabRepos();
  // Starts in the repo the list is showing, else the last one used that the list shows.
  const showing = repos.filter((r) => repoShown(r));
  const start = repo ?? (showing.some((r) => r.id === prefs.lastSnippetRepo) ? prefs.lastSnippetRepo : showing[0]?.id ?? repos[0]?.id);
  teamEditing = { file, base };
  $('team-repo').value = start;
  $('team-repo').disabled = Boolean(file);
  $('team-name').value = name;
  $('team-command').value = command;
  $('team-form-note').textContent = '';
  $('team-form').hidden = false;
  $('team-new').hidden = true;
  (name ? $('team-command') : $('team-name')).focus();
}
function closeTeamForm() {
  teamEditing = null;
  $('team-form').hidden = true;
  $('team-new').hidden = false;
}

$('team-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('team-name').value.trim();
  const command = $('team-command').value.replace(/\s+$/, '');
  const repo = $('team-repo').value;
  if (!name || !command || !repo || !teamEditing) return;
  $('team-save').disabled = true;
  const result = await window.airlock.teamSave({ ...teamEditing, repo, name, command });
  $('team-save').disabled = false;
  const repoObject = snippetRepos().find((r) => r.id === repo);
  if (result.error) {
    toast(`${repoLabel(repo)}: ${result.error}`, { error: true });
    return;
  }
  if (result.conflict) {
    // Keep the user's text. Saving again replaces the other version, or adds a deleted one back.
    if (result.text === null) {
      teamEditing = { file: null, base: null };
      $('team-form-note').textContent = 'Someone else deleted this snippet. Save again to add it back.';
    } else {
      teamEditing.base = result.text;
      const theirs = parseTeamSnippet({ file: teamEditing.file, text: result.text }, repo);
      $('team-form-note').textContent = `Someone else changed this since you opened it (now: ${theirs.command.split('\n')[0]}). Save again to replace theirs, or Cancel to keep it.`;
    }
    if (repoObject) loadRepo(repoObject);
    return;
  }
  if (!teamEditing.file) saveSetting('lastSnippetRepo', repo);
  setStatus(`Saved "${name}" to ${repoLabel(repo)}`, STATUS_RAN_MS);
  closeTeamForm();
  if (repoObject) loadRepo(repoObject);
});
$('team-cancel').addEventListener('click', closeTeamForm);
$('team-new').addEventListener('click', () => openTeamForm());
$('team-reload').addEventListener('click', loadTeam);
$('team-filter').addEventListener('input', renderTeam);
$('team-repo-filter').addEventListener('change', renderTeam);
// Copying part of a command works like copying in the chat, including double-copy.
$('team-list').addEventListener('copy', () => {
  const selected = window.getSelection().toString();
  if (selected.trim()) receiveCopy(selected, window.airlock.copyGesture());
});

function showTeamTab() {
  fillRepoPickers();
  renderTeam();
  const stale = (r) => Date.now() - (repoState.get(r.id)?.loadedAt ?? 0) > 30000;
  tabRepos().filter(stale).forEach(loadRepo);
}
setInterval(() => { if (isSnippetTab(rightTab) && !document.hidden) loadTeam(); }, TEAM_REFRESH_MS);

// From the airlock: opens a snippets tab with the command filled in, to name it and pick the repo.
// That's the snippets tab showing, or else the one with the repo used last.
$('save-team').addEventListener('click', () => {
  const command = airlockText.value.replace(/\s+$/, '');
  if (!command.trim()) { toast('Put the command in the airlock first.', { error: true }); return; }
  if (!isSnippetTab(rightTab)) chooseRightTab('snippets');
  showTeamTab();
  openTeamForm({ name: snippetForm.hidden ? '' : $('snippet-name').value.trim(), command });
  if (!$('team-name').value) $('team-name').focus();
});

// Settings: the list of repos. Each field saves when it changes; a repo is only saved once it has
// a label and a valid address, so a half-filled one stays here until it's finished.
const REPO_URL = /^(https:\/\/|ssh:\/\/|git@|file:\/\/)\S+$/;
const repoProblem = (r) => (!r.label.trim() ? 'needs a label'
  : !REPO_URL.test(r.url) ? 'needs a git address starting with https://, ssh:// or git@'
    : /["$`]/.test(r.sshKey ?? '') ? 'has an SSH key path with a quote or $ in it' : '');
let repoDrafts = snippetRepos().map((r) => ({ ...r }));

function saveRepos() {
  const valid = repoDrafts.filter((r) => !repoProblem(r)).map((r) => {
    const clean = { id: r.id, label: r.label.trim(), url: r.url.trim(), kind: r.kind };
    for (const key of ['name', 'email', 'sshKey']) if (r[key]?.trim()) clean[key] = r[key].trim();
    return clean;
  });
  const before = JSON.stringify(snippetRepos());
  if (JSON.stringify(valid) === before) return;
  saveSetting('snippetRepos', valid);
  // Forget what was loaded from repos that changed, so the list never mixes old and new.
  const old = new Map(JSON.parse(before).map((r) => [r.id, JSON.stringify(r)]));
  for (const r of valid) if (old.get(r.id) !== JSON.stringify(r)) repoState.delete(r.id);
  for (const id of repoState.keys()) if (!valid.some((r) => r.id === id)) repoState.delete(id);
  fillRepoPickers();
  if (isSnippetTab(rightTab)) showTeamTab();
}

function renderRepoSettings() {
  const sets = repoDrafts.map((r, i) => {
    const set = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = r.label.trim() || `Repo ${i + 1}`;
    set.append(legend);
    const field = (key, label, placeholder) => {
      const id = `repo-${r.id}-${key}`;
      const l = Object.assign(document.createElement('label'), { htmlFor: id, textContent: label });
      const input = Object.assign(document.createElement('input'), { id, type: 'text', spellcheck: false, placeholder, value: r[key] ?? '' });
      input.addEventListener('change', () => {
        r[key] = input.value;
        legend.textContent = r.label.trim() || `Repo ${i + 1}`;
        const problem = repoProblem(r);
        problemLine.textContent = problem ? `Not saved yet: this repo ${problem}.` : '';
        saveRepos();
      });
      set.append(l, input);
    };
    field('label', 'Label', 'Work');
    const kindId = `repo-${r.id}-kind`;
    const kindLabel = Object.assign(document.createElement('label'), { htmlFor: kindId, textContent: 'Kind' });
    const kind = Object.assign(document.createElement('select'), { id: kindId });
    for (const [value, text] of Object.entries(KIND_NAMES)) kind.append(Object.assign(document.createElement('option'), { value, textContent: text }));
    kind.value = r.kind;
    kind.addEventListener('change', () => { r.kind = kind.value; saveRepos(); });
    set.append(kindLabel, kind);
    field('url', 'Address', 'https://github.com/owner/snippets.git');
    field('name', 'Commit name', 'Blank: your global git name');
    field('email', 'Commit email', 'Blank: your global git email');
    field('sshKey', 'SSH key', 'Optional, for git@ addresses: C:\\Users\\you\\.ssh\\id_ed25519');
    const problemLine = document.createElement('span');
    problemLine.className = 'hint';
    problemLine.style.gridColumn = '1 / -1';
    const problem = repoProblem(r);
    if (problem && r.url) problemLine.textContent = `Not saved yet: this repo ${problem}.`;
    const remove = teamButton('Remove', 'Remove this repo from the app. Nothing on the server changes.', () => {
      repoDrafts = repoDrafts.filter((d) => d !== r);
      renderRepoSettings();
      saveRepos();
    });
    remove.className = 'remove';
    set.append(problemLine, remove);
    return set;
  });
  $('setting-repos').replaceChildren(...sets);
}
$('setting-repo-add').addEventListener('click', () => {
  const id = Math.random().toString(36).slice(2, 10);
  // The first goes to Team Snippets; after that, wherever there's nothing yet.
  const hasTeam = repoDrafts.some((r) => r.kind === 'team');
  repoDrafts.push({ id, label: hasTeam ? '' : 'Team', url: '', kind: hasTeam ? 'personal' : 'team' });
  renderRepoSettings();
  $(`repo-${id}-${repoDrafts.length > 1 ? 'label' : 'url'}`).focus();
});
renderRepoSettings();

// --- Settings panel -----------------------------------------------------------------------

function applyTheme(next) {
  theme = next;
  document.documentElement.dataset.theme = theme;
  for (const tab of tabs) Object.assign(tab.term.options, terminalAppearance());
}
window.airlock.onTheme(applyTheme);

$('setting-double-copy').checked = prefs.doubleCopyRun !== false;
$('setting-double-copy').addEventListener('change', (e) => saveSetting('doubleCopyRun', e.target.checked));
// Updates (ADR 0010): a notice when GitHub has a newer release. Main does the checking.
function describeUpdateCheck(state) {
  if (!state.checkedAt) return state.dev ? 'The DEV copy only checks when you press Check now.' : `You have ${state.current}.`;
  const when = new Date(state.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  if (state.error) return `Couldn't check at ${when}: ${state.error}.`;
  if (state.latest && !state.available) return `${state.latest} is out; you skipped it. You have ${state.current}.`;
  return state.latest ? `${state.latest} is available. You have ${state.current}.` : `Up to date (${state.current}), checked ${when}.`;
}
function showUpdateState(state) {
  if (!state) return;
  $('status-update').hidden = !state.available;
  $('status-update').textContent = state.available ? `Update ${state.available} available` : '';
  $('setting-update-state').textContent = describeUpdateCheck(state);
}
window.airlock.updateState().then(showUpdateState);
window.airlock.onUpdateState(showUpdateState);
$('status-update').addEventListener('click', () => window.airlock.showUpdate().then(showUpdateState));
$('setting-check-updates').checked = prefs.checkUpdates !== false;
$('setting-check-updates').addEventListener('change', (e) => saveSetting('checkUpdates', e.target.checked));
$('setting-update-check').addEventListener('click', async () => {
  $('setting-update-check').disabled = true;
  $('setting-update-state').textContent = 'Checking…';
  try {
    const state = await window.airlock.checkForUpdates();
    showUpdateState(state);
    if (state?.available) window.airlock.showUpdate().then(showUpdateState);
  } finally {
    $('setting-update-check').disabled = false;
  }
});
$('setting-theme').value = prefs.theme ?? 'airlock';
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
    ...(tab.remote && { remote: tab.remote }),
    data: tab.serializer.serialize({ scrollback: SCROLLBACK_LINES, excludeAltBuffer: true, excludeModes: true }),
  })));
}
setInterval(() => { if (outputChanged) persistScrollback(); }, 30000);
window.addEventListener('beforeunload', persistScrollback);

$('setting-copy-on-select').checked = prefs.copyOnSelect === true;
$('setting-copy-on-select').addEventListener('change', (e) => saveSetting('copyOnSelect', e.target.checked));

$('setting-scrollback').checked = prefs.saveScrollback === true;
$('setting-scrollback').addEventListener('change', (e) => {
  saveSetting('saveScrollback', e.target.checked);
  persistScrollback();
});

// --- Startup -------------------------------------------------------------------------------

const RESTORED_MARK = '\x1b[2m--- restored from the previous session ---\x1b[0m\r\n';

// After every script has run (remotes.js comes after this one), since restored tabs use them all.
const allScriptsLoaded = new Promise((resolve) => {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve, { once: true });
  else resolve();
});
Promise.all([window.airlock.listShells(), window.airlock.loadScrollback(), allScriptsLoaded]).then(([shells, savedTabs]) => {
  for (const s of shells) {
    shellLabels.set(s.id, s.label);
    shellPicker.add(new Option(s.label, s.id));
  }
  if (!savedTabs.length) {
    newTab();
  } else {
    for (const saved of savedTabs) {
      const tab = createTab(shellLabels.has(saved.shellId) ? saved.shellId : defaultShellId(), saved.remote ?? null);
      if (!activeTab) activateTab(tab);
      // Old output first, so the new shell's prompt lands below it. Remote tabs wait for Reconnect,
      // so starting the app never signs in to a server by itself.
      if (tab.remote) {
        tab.exited = true;
        tab.term.write(`${saved.data}\r\n${RESTORED_MARK}`, () => { updateTabLabel(tab); if (tab === activeTab) showRemoteState(); });
      } else {
        tab.term.write(`${saved.data}\r\n${RESTORED_MARK}`, () => startShell(tab, { keepOutput: true }));
      }
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
