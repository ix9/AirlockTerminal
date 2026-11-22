// --- Command palette (ADR 0012) --------------------------------------------------------------
// ⌘K on macOS, Ctrl+Shift+K elsewhere. One box that searches this tab's commands, the airlock's
// history, snippets and Runsheet lines, and that can ask a local model to write a command.
// Picking something runs it; ⌘↵ (Ctrl+Enter) puts it in the airlock instead. A command that
// deletes or overwrites data never runs from here: it always goes through the airlock.
// Loaded after renderer.js, whose functions and state it uses.

const palette = $('palette');
const paletteInput = $('palette-input');
const paletteBody = $('palette-body');
const paletteFoot = $('palette-foot');
const PALETTE_KEY = IS_MAC ? '⌘K' : 'Ctrl+Shift+K';
const AIRLOCK_KEY = keyHint('mod+enter');
const CHAT_KEY = IS_MAC ? '⌥↵' : 'Alt+Enter';
const PER_GROUP = 5; // matches per group when searching
const HISTORY_PAGE = 40; // rows added at a time while browsing history
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'my', 'me', 'all', 'this', 'that', 'is', 'are', 'it', 'get', 'show', 'list', 'how', 'do', 'i', 'what']);
const RISK_LABELS = { 'read-only': '● Read-only', changes: '◆ Changes things', deletes: '▲ Deletes or overwrites' };

let paletteItems = []; // the rows that can be picked, top to bottom
let paletteQueue = []; // rows still to draw: browsing history draws them as the selection nears the end
let paletteIndex = 0;
let paletteMode = 'list'; // or 'answer', showing the model's suggestion
let paletteLines = []; // Runsheet lines, read each time the palette opens
let askSeq = 0; // answers to an older question are ignored
let asking = null; // { question, error? } while a question is out, or after it failed
let answer = null; // the model's suggestion, being edited

$('open-palette').title = `Search commands, or ask AI to write one (${PALETTE_KEY})`;
$('open-palette').addEventListener('click', togglePalette);

// --- Opening and closing ---

// Placed clear of the prompt: above it, ending two lines short (prompts are often two lines), or
// below it when it's near the top of a fresh terminal.
const PALETTE_MIN_HEIGHT = 220;
function positionPalette() {
  const tab = activeTab;
  const wrap = $('terminal-wrap').getBoundingClientRect();
  const screen = tab?.term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  palette.style.top = '';
  palette.style.maxHeight = '';
  if (!screen?.height) return;
  const cell = screen.height / tab.term.rows;
  const cursorTop = screen.top - wrap.top + tab.term.buffer.active.cursorY * cell;
  const above = cursorTop - 2 * cell - 20;
  if (above >= PALETTE_MIN_HEIGHT) {
    palette.style.top = '10px';
    palette.style.maxHeight = `${Math.floor(above)}px`;
  } else {
    const top = cursorTop + cell + 8;
    palette.style.top = `${Math.floor(top)}px`;
    palette.style.maxHeight = `${Math.floor(Math.max(wrap.height - top - 10, 160))}px`;
  }
}
window.addEventListener('resize', () => { if (!palette.hidden) positionPalette(); });

function openPalette() {
  if (!activeTab) return;
  if (view !== 'terminal') showView('terminal', { focus: false });
  palette.hidden = false;
  positionPalette();
  $('terminal-wrap').classList.add('palette-open');
  paletteMode = 'list';
  asking = null;
  answer = null;
  paletteInput.value = '';
  renderPaletteList();
  paletteInput.focus();
  window.airlock.runsheetCommandLines().then((lines) => {
    paletteLines = lines ?? [];
    if (!palette.hidden && paletteMode === 'list') renderPaletteList();
  });
}

function closePalette({ focus = true } = {}) {
  if (palette.hidden) return;
  palette.hidden = true;
  $('terminal-wrap').classList.remove('palette-open');
  askSeq++;
  asking = null;
  answer = null;
  if (focus) activeTab?.term.focus();
}

function togglePalette() {
  if (palette.hidden) openPalette();
  else closePalette();
}

document.addEventListener('mousedown', (e) => {
  if (!palette.hidden && !palette.contains(e.target) && !$('open-palette').contains(e.target)) closePalette({ focus: false });
}, true);

// --- Where the commands come from ---

const OS_NAME = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[window.airlock.platform] ?? 'Linux';

// What the model is told about the terminal: the shell, the OS and the folder, nothing else.
function terminalContext(tab = activeTab) {
  const r = tab?.remote;
  if (r) {
    if (r.transport === 'winrm') return { shell: 'PowerShell', os: 'Windows Server', cwd: tab.cwd };
    if (r.transport === 'pwsh-ssh') return { shell: 'PowerShell 7', os: 'a remote server', cwd: tab.cwd };
    return { shell: 'bash', os: 'a Linux server over SSH', cwd: tab.cwd };
  }
  const id = tab?.shellId ?? '';
  if (id.startsWith('wsl:')) return { shell: 'bash', os: `Linux (WSL, ${id.slice(4)})`, cwd: tab.cwd };
  if (isPowerShell(id)) return { shell: id === 'powershell' ? 'Windows PowerShell' : 'PowerShell 7', os: OS_NAME, cwd: tab.cwd };
  return { shell: id.split(/[\\/]/).pop() || 'bash', os: OS_NAME, cwd: tab?.cwd ?? '' };
}

// Words that carry meaning. A short query must match every one; a longer, more chatty one at
// least half, best matches first.
function paletteWords(query) {
  const all = query.toLowerCase().split(/\s+/).filter(Boolean);
  const meaningful = all.filter((w) => !STOPWORDS.has(w));
  return meaningful.length ? meaningful : all;
}
function matchScore(words, text) {
  if (!words.length) return 1;
  const hay = text.toLowerCase();
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits >= (words.length <= 2 ? words.length : Math.ceil(words.length / 2)) ? hits : 0;
}
function bestMatches(words, entries, hay, limit = PER_GROUP) {
  return entries
    .map((entry, order) => ({ entry, order, score: matchScore(words, hay(entry)) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((m) => m.entry);
}

const agoMs = (ms) => ago(new Date(ms).toISOString());
const uniqueBy = (list, key) => { const seen = new Set(); return list.filter((x) => !seen.has(key(x)) && seen.add(key(x))); };

function paletteGroups(query) {
  const words = paletteWords(query);
  const tab = activeTab;
  const groups = [];
  // With nothing typed it's history to browse, as far back as it goes. Searching shows a few of each.
  const limit = query ? PER_GROUP : Infinity;
  const thisTab = [...(tab?.commands ?? [])].reverse();
  groups.push({
    title: 'This tab', note: tab?.labelEl.textContent ?? '',
    rows: bestMatches(words, thisTab, (c) => c.command, limit).map((c) => ({
      command: c.command, meta: [agoMs(c.at), c.cwd && folderName(c.cwd)].filter(Boolean).join(' · '),
    })),
    empty: query ? '' : 'Commands you run in this tab show here.',
  });
  const airlock = uniqueBy([...cmdHistory].reverse(), (h) => h.command);
  groups.push({
    title: 'Airlock history',
    rows: bestMatches(words, airlock, (h) => h.command, limit).map((h) => ({ command: h.command, meta: ago(h.ts) })),
  });
  if (query) {
    const repoSnippets = snippetRepos().flatMap((r) => (repoState.get(r.id)?.list ?? [])
      .map((s) => ({ name: s.name, command: s.command, where: `${r.label} (${KIND_NAMES[r.kind]})` })));
    const allSnippets = [...snippets.map((s) => ({ name: s.name, command: s.command, where: 'Local' })), ...repoSnippets];
    groups.push({
      title: 'Snippets',
      rows: bestMatches(words, allSnippets, (s) => `${s.name}\n${s.command}`).map((s) => ({ name: s.name, command: s.command, meta: s.where })),
    });
    groups.push({
      title: 'Runsheet',
      rows: bestMatches(words, paletteLines, (l) => l.text).map((l) => ({ command: l.text, meta: `${l.file}:${l.line}` })),
    });
  }
  return { words, groups };
}

// --- Drawing ---

function palEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The text, with the query's words marked. Built from text nodes, never HTML.
function markWords(text, words) {
  const span = palEl('span');
  const pattern = words.filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!pattern) { span.textContent = text; return span; }
  let last = 0;
  for (const m of text.matchAll(new RegExp(pattern, 'gi'))) {
    if (m.index > last) span.append(text.slice(last, m.index));
    span.append(palEl('mark', '', m[0]));
    last = m.index + m[0].length;
  }
  span.append(text.slice(last));
  return span;
}

function paletteRow(item, content) {
  const row = palEl('div', 'pal-row');
  row.setAttribute('role', 'option');
  row.append(...content);
  const index = paletteItems.push(item) - 1;
  row.addEventListener('mousemove', () => { if (paletteIndex !== index) selectPaletteRow(index); });
  row.addEventListener('click', (e) => activatePaletteItem(item, e.metaKey || e.ctrlKey ? 'airlock' : 'run'));
  item.row = row;
  return row;
}

function renderPaletteList() {
  paletteMode = 'list';
  paletteItems = [];
  const query = paletteInput.value.trim();
  const nodes = []; // functions that each make one node, drawn in order by drawMorePalette
  if (query) {
    const status = asking?.error ? palEl('span', 'pal-error', `Couldn't ask: ${asking.error}.`)
      : asking ? palEl('span', 'pal-meta', 'Asking…') : palEl('span', 'pal-meta', '↵');
    if (asking && !asking.error) status.prepend(palEl('span', 'pal-spinner'));
    nodes.push(() => paletteRow({ kind: 'ask' }, [palEl('span', 'pal-spark', '✦'), palEl('span', 'pal-ask', 'Ask AI'), palEl('span', 'pal-question', `"${query}"`), status]));
  }
  const { words, groups } = paletteGroups(query);
  for (const g of groups) {
    if (!g.rows.length && !g.empty) continue;
    nodes.push(() => {
      const head = palEl('h5', '', `${g.title}${query || !g.rows.length ? '' : ` (${g.rows.length})`}`);
      if (g.note) head.append(palEl('small', '', ` · ${g.note}`));
      return head;
    });
    if (!g.rows.length) nodes.push(() => palEl('div', 'pal-empty', g.empty));
    for (const r of g.rows) {
      nodes.push(() => {
        const parts = [];
        if (r.name) parts.push(markWords(r.name, words));
        const cmd = markWords(r.command, words);
        cmd.className = r.name ? 'pal-cmd dim' : 'pal-cmd';
        parts.push(cmd, palEl('span', 'pal-meta', r.meta));
        return paletteRow({ kind: 'match', command: r.command }, parts);
      });
    }
  }
  if (!nodes.length) nodes.push(() => palEl('div', 'pal-empty', 'Type to search your commands, or describe what you want and press ↵ to ask AI.'));
  paletteBody.replaceChildren();
  paletteBody.scrollTop = 0;
  paletteQueue = nodes;
  drawMorePalette(query ? Infinity : HISTORY_PAGE);
  selectPaletteRow(0);
  setFoot(query ? [['↵', 'ask AI / run'], ['↑↓', 'move'], [AIRLOCK_KEY, 'to airlock'], [CHAT_KEY, 'ask in chat'], ['esc', 'close']]
    : [['↑↓', 'browse history'], ['↵', 'run'], [AIRLOCK_KEY, 'to airlock'], ['esc', 'close']]);
}

// Draws the next rows of a long list: history can run to hundreds of commands.
function drawMorePalette(rows = HISTORY_PAGE) {
  const fresh = [];
  while (rows > 0 && paletteQueue.length) {
    const node = paletteQueue.shift()();
    fresh.push(node);
    if (node.classList.contains('pal-row')) rows--;
  }
  paletteBody.append(...fresh);
}
paletteBody.addEventListener('scroll', () => {
  if (paletteQueue.length && paletteBody.scrollTop + paletteBody.clientHeight > paletteBody.scrollHeight - 120) drawMorePalette();
});

// Up and down stop at the ends rather than wrapping: the bottom of history is a long way down.
function selectPaletteRow(index) {
  if (index >= paletteItems.length - 5 && paletteQueue.length) drawMorePalette();
  if (!paletteItems.length) return;
  paletteIndex = Math.max(0, Math.min(index, paletteItems.length - 1));
  paletteItems.forEach((item, i) => item.row.classList.toggle('on', i === paletteIndex));
  paletteItems[paletteIndex].row.scrollIntoView({ block: 'nearest' });
}

function setFoot(hints) {
  paletteFoot.replaceChildren(...hints.map(([key, what]) => {
    const span = palEl('span');
    span.append(palEl('b', '', key), ` ${what}`);
    return span;
  }));
}

// --- The model's answer ---

async function askAI() {
  const question = paletteInput.value.trim();
  if (!question) return;
  const seq = ++askSeq;
  asking = { question };
  renderPaletteList();
  const result = await window.airlock.aiSuggest({ question, ...terminalContext() });
  if (seq !== askSeq || palette.hidden) return; // closed, or asked something else since
  if (!result || result.error) {
    asking = { question, error: result?.error ?? 'no answer' };
    renderPaletteList();
    return;
  }
  asking = null;
  answer = { ...result, question, options: [{ command: result.command, note: '', risk: result.risk }, ...result.alternatives], chosen: 0 };
  renderAnswer();
}

function renderAnswer() {
  paletteMode = 'answer';
  paletteItems = [];
  const ctx = terminalContext();
  const card = palEl('div', 'pal-ai');
  const head = palEl('div', 'pal-ai-head');
  const riskChip = palEl('span', 'pal-chip');
  head.append(palEl('span', 'pal-spark', '✦'), palEl('span', '', 'Suggested command'), palEl('span', 'spacer'), riskChip, palEl('span', 'pal-chip', `${ctx.shell} · ${ctx.os}`));
  const field = palEl('textarea', 'pal-ai-command');
  field.spellcheck = false;
  field.value = answer.options[answer.chosen].command;
  field.setAttribute('aria-label', 'Suggested command');
  const why = palEl('div', 'pal-ai-why', answer.explanation || '');
  why.hidden = !answer.explanation;
  const warn = palEl('div', 'pal-ai-warn', 'This deletes or overwrites data, so it can\'t run from here: ↵ puts it in the airlock for you to check.');
  const acts = palEl('div', 'pal-ai-acts');
  const runButton = palEl('button', 'primary', 'Run');
  runButton.append(palEl('kbd', '', '↵'));
  const toAirlockButton = palEl('button', '', 'To airlock');
  toAirlockButton.append(palEl('kbd', '', AIRLOCK_KEY));
  const chatButton = palEl('button', '', 'Ask in chat');
  chatButton.append(palEl('kbd', '', CHAT_KEY));
  acts.append(runButton, toAirlockButton, chatButton, palEl('span', 'spacer'), palEl('span', 'pal-chip', `${answer.model} · ${(answer.ms / 1000).toFixed(1)}s`));
  card.append(head, field, why, warn, acts);
  const nodes = [card];

  const alts = [];
  if (answer.options.length > 1) {
    nodes.push(palEl('h5', '', 'Other suggestions'));
    answer.options.forEach((o, i) => {
      const row = palEl('div', 'pal-row');
      row.append(palEl('span', 'pal-cmd', o.command), palEl('span', 'pal-meta', o.note || (i === 0 ? 'first suggestion' : '')));
      row.addEventListener('click', () => useOption(i));
      alts.push(row);
      nodes.push(row);
    });
  }
  paletteBody.replaceChildren(...nodes);

  // The risk follows the field as it's edited, checked by the app, not the model.
  let risk = answer.options[answer.chosen].risk;
  const showRisk = () => {
    riskChip.textContent = RISK_LABELS[risk];
    riskChip.dataset.risk = risk;
    card.classList.toggle('bad', risk === 'deletes');
    warn.hidden = risk !== 'deletes';
    runButton.disabled = risk === 'deletes';
    runButton.classList.toggle('primary', risk !== 'deletes'); // ↵ goes to the airlock instead
    toAirlockButton.classList.toggle('primary', risk === 'deletes');
    alts.forEach((row, i) => row.classList.toggle('on', i === answer.chosen && field.value === answer.options[i].command));
  };
  let riskTimer = null;
  const recheck = () => {
    clearTimeout(riskTimer);
    riskTimer = setTimeout(async () => { risk = await window.airlock.aiRisk(field.value); showRisk(); }, 150);
  };
  const fit = () => { field.rows = Math.min(Math.max(field.value.split('\n').length, 1), 6); };
  const useOption = (i) => {
    answer.chosen = i;
    field.value = answer.options[i].command;
    risk = answer.options[i].risk;
    fit();
    showRisk();
    field.focus();
  };
  const run = () => {
    if (risk === 'deletes') { toast('That deletes or overwrites data, so it goes to the airlock first.', { error: true }); paletteToAirlock(field.value); return; }
    paletteRun(field.value);
  };
  field.addEventListener('input', () => { fit(); recheck(); });
  field.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && mod && !e.altKey) { e.preventDefault(); paletteToAirlock(field.value); }
    else if (e.key === 'Enter' && e.altKey) { e.preventDefault(); askInChat(answer.question); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
    else if (e.key === 'Tab' && answer.options.length > 1) { e.preventDefault(); useOption((answer.chosen + (e.shiftKey ? -1 : 1) + answer.options.length) % answer.options.length); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renderPaletteList(); paletteInput.focus(); }
  });
  toAirlockButton.addEventListener('click', () => paletteToAirlock(field.value));
  runButton.addEventListener('click', run);
  chatButton.addEventListener('click', () => askInChat(answer.question));
  fit();
  showRisk();
  setFoot([['↵', 'run'], [AIRLOCK_KEY, 'to airlock'], ['⇧↵', 'new line'], [CHAT_KEY, 'ask in chat'], ...(answer.options.length > 1 ? [['⇥', 'next suggestion']] : []), ['esc', 'back']]);
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
}

// --- What picking does ---

function paletteToAirlock(command) {
  if (!command.trim()) return;
  fillAirlock(command);
  closePalette({ focus: false });
  airlockText.focus();
  setStatus(`In the airlock: check it, then ${keyHint('mod+enter')} to run`, STATUS_RAN_MS);
}

async function paletteRun(command) {
  if (!command.trim()) return;
  if (await window.airlock.aiRisk(command) === 'deletes') {
    toast('That deletes or overwrites data, so it goes to the airlock first.', { error: true });
    paletteToAirlock(command);
    return;
  }
  closePalette({ focus: false });
  runText(command);
}

async function askInChat(question) {
  closePalette({ focus: false });
  chooseRightTab('claude');
  if (await window.airlock.sendToChat(question)) toast('Your question is in Claude\'s message box: press Enter there to send it.');
  else toast('Copied, but Claude\'s message box wasn\'t found. Paste it in yourself.', { error: true });
}

function activatePaletteItem(item, how) {
  if (!item) return;
  if (item.kind === 'ask') {
    if (how === 'chat') askInChat(paletteInput.value.trim());
    else askAI();
  } else if (how === 'airlock') paletteToAirlock(item.command);
  else paletteRun(item.command);
}

paletteInput.addEventListener('input', () => {
  askSeq++; // a new question replaces any that's still out
  asking = null;
  renderPaletteList();
});
paletteInput.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    selectPaletteRow(paletteIndex + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'PageDown' || e.key === 'PageUp') {
    e.preventDefault();
    selectPaletteRow(paletteIndex + (e.key === 'PageDown' ? 10 : -10));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    activatePaletteItem(paletteItems[paletteIndex], e.altKey ? 'chat' : mod ? 'airlock' : 'run');
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
});
// Inside the palette, its own keys win over the app's (Ctrl+Tab and the like still work).
palette.addEventListener('keydown', (e) => e.stopPropagation());

// --- Settings: the model server ---

const AI_DEFAULT_URL = 'http://localhost:1235/v1';
$('setting-ai-url').value = prefs.aiBaseUrl || AI_DEFAULT_URL;
$('setting-ai-model').value = prefs.aiModel || '';
$('setting-ai-url').addEventListener('change', (e) => {
  const value = e.target.value.trim() || AI_DEFAULT_URL;
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(value)) { toast('The model server needs an http:// or https:// address.', { error: true }); return; }
  e.target.value = value;
  saveSetting('aiBaseUrl', value);
});
$('setting-ai-model').addEventListener('change', (e) => saveSetting('aiModel', e.target.value.trim()));
$('setting-ai-test').addEventListener('click', async () => {
  $('setting-ai-state').textContent = 'Checking…';
  const result = await window.airlock.aiModels();
  if (!result) return;
  if (result.error) { $('setting-ai-state').textContent = `Can't reach it: ${result.error}.`; return; }
  $('setting-ai-models').replaceChildren(...result.models.map((id) => Object.assign(document.createElement('option'), { value: id })));
  $('setting-ai-state').textContent = `Connected. Using ${result.chosen}${prefs.aiModel ? '' : ' (the first chat model)'}; ${result.models.length} available.`;
});
