// --- Inline suggestions (ADR 0013) -----------------------------------------------------------
// Grey text after the cursor as you type at a prompt: the rest of a command from this tab's
// history or the airlock's, and, when turned on, from the local model (the server in Ask AI).
// → accepts, by typing the rest into the shell exactly as if it had been typed. Enter still runs
// only what's on the line, so a suggestion never runs by itself.
// Two styles (Settings): Stacked shows history after the cursor and the model's suggestion on a
// faint line underneath (⇧→); List shows a small list above the line (↑↓, →, esc). Ctrl+Space
// opens the list in either. Loaded after palette.js, whose terminalContext and agoMs it uses.

const suggestGhost = $('suggest-ghost');
const suggestAlt = $('suggest-alt');
const suggestList = $('suggest-list');
const SUGGEST_MIN_HISTORY = 2; // characters typed before history suggests anything
const SUGGEST_MIN_AI = 3;
let suggestFrame = 0;
let shown = null; // what's on screen: { tab, line, typed, items, primary, alt, listOpen }
let listIndex = 0;
let listHiddenFor = null; // the line Esc hid the list on
let listForcedFor = null; // the line Ctrl+Space opened it on
const aiCompletions = new Map(); // `${tab id}\n${line}` → [{ rest, risk }]
let aiTimer = null;
let aiSeq = 0;
let aiWaitingFor = null;
let aiQuietUntil = 0; // after the model server failed: a pause before trying it again
let spacing = null; // letter-spacing that puts the overlay's characters on the terminal's cells

const suggestionsOn = (kind) => (kind === 'history' ? prefs.suggestHistory !== false : prefs.suggestAI === true);
const suggestStyle = () => (prefs.suggestStyle === 'list' ? 'list' : 'stacked');

// --- What's been typed ---

// The line at the prompt, from where its first key landed (ADR 0007) to the cursor, if the cursor
// is at the end of it. Null for anything else: a running program, a full-screen one, a terminal
// scrolled back, a line typed over several lines, or text after the cursor. That last one is also
// how another tool's suggestions (zsh-autosuggestions, PowerShell's) make these stand aside.
function typedLine(tab) {
  const { term } = tab;
  const buf = term.buffer.active;
  if (buf.type !== 'normal' || buf.viewportY !== buf.baseY) return null;
  const block = promptBlock(tab);
  if (!block?.input || block.input.line < 0) return null;
  const cursorLine = buf.baseY + buf.cursorY;
  const startLine = block.input.line;
  if (cursorLine < startLine || cursorLine - startLine > 20) return null;
  let text = '';
  for (let y = startLine; y <= cursorLine; y++) {
    const line = buf.getLine(y);
    if (!line || (y > startLine && !line.isWrapped)) return null;
    const from = y === startLine ? block.inputX : 0;
    const to = y === cursorLine ? buf.cursorX : term.cols;
    if (to < from) return null;
    text += line.translateToString(false, from, to);
  }
  // A right-hand prompt is allowed if it's well clear of the cursor; the suggestion stops short of it.
  const after = buf.getLine(cursorLine).translateToString(false, buf.cursorX, term.cols);
  let room = term.cols - buf.cursorX;
  if (after.trim()) {
    const gap = after.length - after.trimStart().length;
    if (gap < 4) return null;
    room = gap - 2;
  }
  const below = buf.getLine(cursorLine + 1);
  if (below?.isWrapped && below.translateToString(true).trim()) return null;
  return { text, room, cursorX: buf.cursorX, cursorY: buf.cursorY };
}

// --- Where suggestions come from ---

// The newest commands starting with what's been typed: this tab's first, then the airlock's.
function historyMatches(tab, line, max) {
  if (line.trim().length < SUGGEST_MIN_HISTORY) return [];
  const seen = new Set();
  const found = [];
  const consider = (command, meta) => {
    if (found.length >= max || seen.has(command) || command.length <= line.length || !command.startsWith(line) || command.includes('\n')) return;
    seen.add(command);
    found.push({ rest: command.slice(line.length), source: 'history', meta });
  };
  for (let i = tab.commands.length - 1; i >= 0 && found.length < max; i--) consider(tab.commands[i].command, agoMs(tab.commands[i].at));
  for (let i = cmdHistory.length - 1; i >= 0 && found.length < max; i--) consider(cmdHistory[i].command, ago(cmdHistory[i].ts));
  return found;
}

const aiKey = (tab, line) => `${tab.id}\n${line}`;

// Asks the model once typing pauses. Every keystroke resets the wait, and an answer for a line
// that's since changed is kept (typing back to it shows it) but doesn't redraw anything.
function wantAICompletion(tab, line) {
  const key = aiKey(tab, line);
  if (aiCompletions.has(key) || aiWaitingFor === key || Date.now() < aiQuietUntil) return;
  clearTimeout(aiTimer);
  aiWaitingFor = key;
  const seq = ++aiSeq;
  aiTimer = setTimeout(async () => {
    const result = await window.airlock.aiComplete({ line, ...terminalContext(tab), recent: tab.commands.slice(-5).map((c) => c.command) });
    if (aiWaitingFor === key) aiWaitingFor = null;
    if (result?.error) aiQuietUntil = Date.now() + 30000; // the server's down: don't ask on every pause
    aiCompletions.set(key, result?.completions ?? []);
    if (aiCompletions.size > 300) aiCompletions.delete(aiCompletions.keys().next().value);
    if (seq === aiSeq) scheduleSuggestions();
  }, prefs.suggestDelay ?? 300);
}

// --- Working out what to show ---

function scheduleSuggestions() {
  if (suggestFrame) return;
  suggestFrame = requestAnimationFrame(() => {
    suggestFrame = 0;
    updateSuggestions();
  });
}

function hideSuggestions() {
  suggestGhost.hidden = true;
  suggestAlt.hidden = true;
  suggestList.hidden = true;
  shown = null;
}

function updateSuggestions() {
  const tab = activeTab;
  const useHistory = suggestionsOn('history');
  const useAI = suggestionsOn('ai');
  if (!tab || (!useHistory && !useAI) || view !== 'terminal' || !palette.hidden || !tab.term.element?.contains(document.activeElement)) {
    hideSuggestions();
    return;
  }
  const typed = typedLine(tab);
  if (!typed?.text.trim()) { hideSuggestions(); return; }
  const line = typed.text;
  if (useAI && line.trim().length >= SUGGEST_MIN_AI) wantAICompletion(tab, line);
  const history = useHistory ? historyMatches(tab, line, 3) : [];
  const ai = (useAI ? aiCompletions.get(aiKey(tab, line)) ?? [] : []).map((c) => ({ ...c, source: 'ai' }));
  // When history and the model agree, that's one suggestion, marked as both.
  if (history[0] && ai.some((a) => a.rest === history[0].rest)) history[0].agree = true;
  const items = [...history, ...ai.filter((a) => !history.some((h) => h.rest === a.rest))];
  if (!items.length) { hideSuggestions(); return; }

  const listOpen = listForcedFor === line || (suggestStyle() === 'list' && listHiddenFor !== line);
  if (!shown || shown.line !== line || shown.items.length !== items.length) listIndex = 0;
  listIndex = Math.min(listIndex, items.length - 1);
  const primary = listOpen ? items[listIndex] : history[0] ?? ai[0];
  const alt = !listOpen && history[0] ? ai.find((a) => a.rest !== history[0].rest) ?? null : null;
  shown = { tab, line, typed, items, primary, alt, listOpen };
  drawSuggestions();
}

// --- Drawing ---

// Where the terminal's character cells are, inside #terminal-wrap.
function cellGeometry(tab) {
  const screen = tab.term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (!screen?.width) return null;
  const wrap = $('terminal-wrap').getBoundingClientRect();
  return { x: screen.left - wrap.left, y: screen.top - wrap.top, w: screen.width / tab.term.cols, h: screen.height / tab.term.rows };
}

// Same font and size as the terminal, spaced so each character lands on its cell.
function matchTerminalFont(el, tab, cell) {
  const font = `${tab.term.options.fontSize}px ${tab.term.options.fontFamily}`;
  if (spacing?.font !== font || spacing.w !== cell.w) {
    const ctx = (matchTerminalFont.canvas ??= document.createElement('canvas')).getContext('2d');
    ctx.font = font;
    spacing = { font, w: cell.w, px: cell.w - ctx.measureText('M'.repeat(50)).width / 50 };
  }
  el.style.fontFamily = tab.term.options.fontFamily;
  el.style.fontSize = `${tab.term.options.fontSize}px`;
  el.style.lineHeight = `${cell.h}px`;
  el.style.height = `${cell.h}px`;
  el.style.letterSpacing = `${spacing.px}px`;
}

const SPARK = '✦';
const HISTORY_MARK = '↺';

function hintFor(item, key) {
  const hint = document.createElement('span');
  hint.className = 'sg-hint';
  const mark = item.agree ? `${HISTORY_MARK} ${SPARK}` : item.source === 'ai' ? SPARK : HISTORY_MARK;
  hint.append(mark, ' ');
  const kbd = document.createElement('kbd');
  kbd.textContent = key;
  hint.append(kbd);
  if (item.source === 'ai' && item.risk === 'changes') hint.append(Object.assign(document.createElement('span'), { className: 'sg-risk', textContent: 'changes things' }));
  return hint;
}

function drawSuggestions() {
  const { tab, typed, primary, alt, listOpen } = shown;
  const cell = cellGeometry(tab);
  if (!cell) { hideSuggestions(); return; }

  // The ghost: the rest of the line, after the cursor.
  const text = document.createElement('span');
  text.className = 'sg-text';
  text.textContent = primary.rest;
  suggestGhost.replaceChildren(text, ...(listOpen ? [] : [hintFor(primary, '→')]));
  suggestGhost.className = primary.source === 'ai' && !primary.agree ? 'ai' : '';
  matchTerminalFont(suggestGhost, tab, cell);
  suggestGhost.style.left = `${cell.x + typed.cursorX * cell.w}px`;
  suggestGhost.style.top = `${cell.y + typed.cursorY * cell.h}px`;
  suggestGhost.style.maxWidth = `${typed.room * cell.w}px`;
  text.style.maxWidth = `${typed.room * cell.w}px`;
  suggestGhost.hidden = false;

  // Stacked: the model's other idea on a faint line under this one (above it on the bottom row).
  suggestAlt.hidden = !alt;
  if (alt) {
    const altText = document.createElement('span');
    altText.className = 'sg-text';
    altText.textContent = `└ ${alt.rest}`;
    suggestAlt.replaceChildren(altText, hintFor(alt, '⇧→'));
    matchTerminalFont(suggestAlt, tab, cell);
    const row = typed.cursorY + 1 < tab.term.rows ? typed.cursorY + 1 : typed.cursorY - 1;
    const col = Math.max(typed.cursorX - 2, 0);
    suggestAlt.style.left = `${cell.x + col * cell.w}px`;
    suggestAlt.style.top = `${cell.y + row * cell.h}px`;
    suggestAlt.style.maxWidth = `${(tab.term.cols - col) * cell.w}px`;
  }

  suggestList.hidden = !listOpen;
  if (listOpen) drawSuggestionList(cell);
}

function drawSuggestionList(cell) {
  const { tab, line, typed, items } = shown;
  const nodes = [];
  const prefix = line.length > 40 ? `…${line.slice(-40)}` : line;
  let lastSource = null;
  items.forEach((item, i) => {
    if (item.source !== lastSource) {
      lastSource = item.source;
      nodes.push(Object.assign(document.createElement('h6'), {
        className: item.source === 'ai' ? 'ai' : '', textContent: item.source === 'ai' ? `${SPARK} AI` : `${HISTORY_MARK} History`,
      }));
    }
    const row = document.createElement('div');
    row.className = `sg-row${i === listIndex ? ' on' : ''}`;
    const cmd = document.createElement('span');
    cmd.className = 'sg-cmd';
    cmd.append(Object.assign(document.createElement('i'), { textContent: prefix }), item.rest);
    const meta = document.createElement('span');
    meta.className = 'sg-meta';
    if (item.source === 'ai') {
      meta.append(Object.assign(document.createElement('span'), { className: 'pal-chip', textContent: RISK_LABELS[item.risk] ?? '' }));
      meta.lastChild.dataset.risk = item.risk;
    } else meta.textContent = item.agree ? `${item.meta} · ${SPARK} agrees` : item.meta;
    row.append(cmd, meta);
    row.addEventListener('mousedown', (e) => { e.preventDefault(); listIndex = i; acceptSuggestion(items[i]); });
    nodes.push(row);
  });
  const foot = document.createElement('div');
  foot.className = 'sg-foot';
  foot.textContent = '↑↓ choose · → accept · esc hide · Enter runs only what\'s on the line';
  nodes.push(foot);
  suggestList.replaceChildren(...nodes);
  // Above the line if it fits, else below it.
  const wrap = $('terminal-wrap').getBoundingClientRect();
  suggestList.style.width = `${Math.min(680, wrap.width - 40)}px`;
  suggestList.style.left = `${Math.max(cell.x, 12)}px`;
  const lineTop = cell.y + typed.cursorY * cell.h;
  const height = suggestList.offsetHeight;
  suggestList.style.top = `${lineTop - height - 6 >= 4 ? lineTop - height - 6 : lineTop + cell.h + 6}px`;
}

// --- Keys ---

// Typing the rest of the line into the shell, as if typed. Control characters never get through,
// so this can't press Enter.
function acceptSuggestion(item) {
  const tab = shown?.tab;
  const text = item?.rest.replace(/[\x00-\x1f\x7f]/g, '');
  if (!tab || !text) return;
  hideSuggestions();
  listForcedFor = null;
  noteBlockInput(tab, text);
  window.airlock.ptyInput(tab.id, text);
}

// Called first for every key in a terminal (renderer.js). True means the key was used here.
function suggestionKey(tab, e) {
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (e.code === 'Space' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    if (!suggestionsOn('history') && !suggestionsOn('ai')) return false;
    const typed = typedLine(tab);
    if (!typed?.text.trim()) return false;
    listForcedFor = listForcedFor === typed.text ? null : typed.text; // again closes it
    listHiddenFor = listForcedFor ? null : typed.text;
    updateSuggestions();
    return true;
  }
  if (!shown || shown.tab !== tab || suggestGhost.hidden) return false;
  if (e.key === 'ArrowRight' && plain && !e.shiftKey) { acceptSuggestion(shown.primary); return true; }
  if (e.key === 'ArrowRight' && e.shiftKey && plain && shown.alt) { acceptSuggestion(shown.alt); return true; }
  if (shown.listOpen && plain && !e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    listIndex = Math.max(0, Math.min(listIndex + (e.key === 'ArrowDown' ? 1 : -1), shown.items.length - 1));
    shown.primary = shown.items[listIndex];
    drawSuggestions();
    return true;
  }
  if (shown.listOpen && e.key === 'Escape' && plain && !e.shiftKey) {
    listHiddenFor = shown.line;
    listForcedFor = null;
    updateSuggestions();
    return true;
  }
  return false;
}

// Each terminal tells us when its screen or cursor changes (renderer.js calls this for every tab).
function watchSuggestions(tab) {
  const later = () => { if (tab === activeTab) scheduleSuggestions(); };
  tab.term.onWriteParsed(later);
  tab.term.onCursorMove(later);
  tab.term.onScroll(later);
  tab.term.onResize(later);
  tab.host.addEventListener('focusin', later);
  tab.host.addEventListener('focusout', later);
}
window.addEventListener('resize', scheduleSuggestions);

// --- The toolbar toggles and Settings ---

function syncSuggestControls() {
  for (const kind of ['history', 'ai']) {
    const on = suggestionsOn(kind);
    $(`suggest-${kind}`).classList.toggle('on', on);
    $(`suggest-${kind}`).setAttribute('aria-pressed', String(on));
    $(`setting-suggest-${kind}`).checked = on;
  }
  $('suggest-history').title = `History suggestions: ${suggestionsOn('history') ? 'on' : 'off'}. The rest of a command from this tab's history or the airlock's, in grey after the cursor. Click to turn ${suggestionsOn('history') ? 'off' : 'on'}.`;
  $('suggest-ai').title = `AI suggestions: ${suggestionsOn('ai') ? 'on' : 'off'}. The local model finishes the line when you pause typing (the server in Settings > Ask AI). Click to turn ${suggestionsOn('ai') ? 'off' : 'on'}.`;
  for (const radio of document.querySelectorAll('input[name="suggest-style"]')) radio.checked = radio.value === suggestStyle();
  $('setting-suggest-delay').value = String(prefs.suggestDelay ?? 300);
}

function setSuggestions(kind, on) {
  saveSetting(kind === 'history' ? 'suggestHistory' : 'suggestAI', on);
  if (kind === 'ai' && on) aiQuietUntil = 0;
  syncSuggestControls();
  scheduleSuggestions();
}
for (const kind of ['history', 'ai']) {
  $(`suggest-${kind}`).addEventListener('mousedown', (e) => e.preventDefault()); // the terminal keeps the focus
  $(`suggest-${kind}`).addEventListener('click', () => {
    setSuggestions(kind, !suggestionsOn(kind));
    toast(`${kind === 'ai' ? 'AI' : 'History'} suggestions ${suggestionsOn(kind) ? 'on' : 'off'}`);
  });
  $(`setting-suggest-${kind}`).addEventListener('change', (e) => setSuggestions(kind, e.target.checked));
}
for (const radio of document.querySelectorAll('input[name="suggest-style"]')) {
  radio.addEventListener('change', () => { saveSetting('suggestStyle', radio.value); listHiddenFor = null; syncSuggestControls(); });
}
$('setting-suggest-delay').addEventListener('change', (e) => saveSetting('suggestDelay', Number(e.target.value)));
syncSuggestControls();
