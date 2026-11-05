const $ = (id) => document.getElementById(id);
const root = document.documentElement.style;

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
  theme: { background: '#0c0c0c' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('terminal'));
fit.fit();

// Ctrl+Shift+C copies the terminal selection (plain Ctrl+C stays as interrupt).
term.attachCustomKeyEventHandler((e) => {
  if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
    navigator.clipboard.writeText(term.getSelection());
    return false;
  }
  return true;
});

term.onData((data) => window.airlock.ptyInput(data));
term.onResize(({ cols, rows }) => window.airlock.ptyResize({ cols, rows }));
window.airlock.onPtyData((data) => term.write(data));
window.airlock.onPtyExit((code) => term.write(`\r\n[shell exited with code ${code}]\r\n`));
new ResizeObserver(() => fit.fit()).observe($('terminal'));

// --- Shell picker -----------------------------------------------------------------------

const shellPicker = $('shell');
function startShell() {
  term.reset();
  window.airlock.ptyStart({ cols: term.cols, rows: term.rows, shellId: shellPicker.value });
  term.focus();
}
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
  term.paste(text);
  window.airlock.ptyInput('\r');
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
