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
  term.focus();
}
$('run').addEventListener('click', runAirlock);
airlockText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runAirlock(); }
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
