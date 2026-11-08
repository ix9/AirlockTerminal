// --- Remotes: servers to open as terminal tabs (ADR 0008) -----------------------------------
// Loaded after renderer.js and shares its globals (tabs, activeTab, createTab, startShell…).
// The list comes from the main process, which is also the only place that builds the command
// that connects: a tab only ever sends a remote's id.

const TRANSPORT_NAMES = { ssh: 'SSH', winrm: 'PowerShell (WinRM)', 'pwsh-ssh': 'PowerShell over SSH' };
const SOURCE_NOTES = {
  team: 'Everyone using this repo gets this server. Sign-in details never go in the repo.',
  personal: 'Follows you to your other machines. Sign-in details never go in the repo.',
  local: 'Kept on this machine only.',
};
const REMOTES_REFRESH_MS = 5 * 60 * 1000;

let remoteEntries = [];
let remoteErrors = [];
let remotesInfo = { onePasswordAgent: false, onePasswordKeys: false, canSavePasswords: true };
let remotesLoadedAt = 0;
let remotesBusy = false;
let remoteEditing = null; // the entry being edited, or {} for a new one

// "deploy@app-01.example.com · SSH"
function remoteDescription(r) {
  return `${r.user ? `${r.user}@` : ''}${r.address} · ${TRANSPORT_NAMES[r.transport] ?? r.transport}`;
}

const remoteTab = (id) => tabs.find((t) => t.remote?.id === id);

async function loadRemotes() {
  if (remotesBusy) return;
  remotesBusy = true;
  showRemotesState();
  const result = await window.airlock.listRemotes();
  remotesBusy = false;
  remoteEntries = result.entries ?? [];
  remoteErrors = result.errors ?? [];
  remotesInfo = { ...remotesInfo, ...result };
  remotesLoadedAt = Date.now();
  // Open tabs follow edits to their remote, such as a new environment tag.
  for (const tab of tabs) {
    const entry = tab.remote && remoteEntries.find((e) => e.id === tab.remote.id);
    if (entry) { tab.remote = { ...entry.remote, id: entry.id }; updateTabLabel(tab); }
  }
  showRemotesState();
  renderRemotes();
  showRemoteState();
  $('setting-1password-agent-row').hidden = !remotesInfo.onePasswordAgent;
}

function showRemotesState() {
  const el = $('remotes-state');
  el.textContent = remotesBusy ? 'Syncing…'
    : remoteErrors.length ? `Couldn't sync ${remoteErrors.map((e) => e.sourceLabel).join(', ')}` : '';
  el.classList.toggle('error', !remotesBusy && remoteErrors.length > 0);
}

function showRemotesTab() {
  renderRemotes();
  if (Date.now() - remotesLoadedAt > 30000) loadRemotes();
}
setInterval(() => { if (rightTab === 'remotes' && !document.hidden) loadRemotes(); }, REMOTES_REFRESH_MS);

function remoteButton(label, title, onClick, className = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (title) b.title = title;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

function remoteRow(entry) {
  const r = entry.remote;
  const tab = remoteTab(entry.id);
  const li = document.createElement('li');
  li.className = 'remote';
  const dot = document.createElement('span');
  dot.className = `dot ${tab && !tab.exited ? 'on' : tab?.kept ? 'kept' : ''}`;
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', tab && !tab.exited ? 'Connected' : tab?.kept ? 'Session kept on the server' : 'Not connected');
  const text = document.createElement('div');
  text.className = 'text';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = r.name;
  const detail = document.createElement('span');
  detail.className = 'detail mono';
  detail.textContent = entry.problem ? `Can't be used: it ${entry.problem}`
    : entry.source === 'ssh' ? `${entry.detail || r.address} · SSH · ${entry.sourceLabel}`
      : `${remoteDescription(r)} · ${entry.sourceLabel}${entry.by ? ` · ${entry.by}` : ''}`;
  detail.classList.toggle('error', Boolean(entry.problem));
  text.append(name, detail);
  if (r.notes) text.title = r.notes;
  li.append(dot, text);
  if (r.env) {
    const env = document.createElement('span');
    env.className = 'env-badge';
    env.dataset.env = r.env;
    env.textContent = r.env.toUpperCase();
    li.append(env);
  }
  const actions = document.createElement('span');
  actions.className = 'actions';
  if (entry.editable) {
    actions.append(remoteButton('Edit', '', () => openRemoteForm(entry), 'quiet'));
    let armed = null;
    const del = remoteButton('Delete', `Delete from ${entry.sourceLabel}`, async () => {
      if (!armed) {
        del.textContent = 'Delete?';
        del.classList.add('confirm');
        armed = setTimeout(() => { armed = null; del.textContent = 'Delete'; del.classList.remove('confirm'); }, 3000);
        return;
      }
      clearTimeout(armed);
      del.disabled = true;
      const result = await window.airlock.deleteRemote({ source: entry.source, file: entry.file, base: entry.base, name: r.name });
      if (result.error) toast(result.error, { error: true });
      else if (result.conflict) toast(`Someone else changed "${r.name}", so it wasn't deleted. Check their version first.`, { error: true });
      else setStatus(`Deleted "${r.name}" from ${entry.sourceLabel}`, STATUS_RAN_MS);
      loadRemotes();
    }, 'quiet');
    actions.append(del);
  }
  const main = !tab ? 'Connect' : tab.exited ? 'Reconnect' : 'Show tab';
  const go = remoteButton(main, '', () => connectRemote(entry));
  go.disabled = Boolean(entry.problem);
  actions.append(go);
  li.append(actions);
  return li;
}

function renderRemotes() {
  const list = $('remote-list');
  const words = $('remotes-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = remoteEntries.filter((e) => {
    const hay = `${e.remote.name}\n${e.remote.address}\n${e.remote.group}\n${e.remote.user}\n${e.sourceLabel}\n${e.remote.env}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  // Grouped by the group they name; ~/.ssh/config hosts together at the end.
  const groups = new Map();
  for (const e of shown) {
    const key = e.source === 'ssh' ? '￿From ~/.ssh/config' : e.remote.group || '￾Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const rows = [];
  for (const error of remoteErrors) {
    const li = document.createElement('li');
    li.className = 'message error';
    li.textContent = `${error.sourceLabel}: ${error.message}`;
    rows.push(li);
  }
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const head = document.createElement('li');
    head.className = 'group';
    head.textContent = key.replace(/^[￾￿]/, '');
    rows.push(head, ...groups.get(key).sort((a, b) => a.remote.name.localeCompare(b.remote.name)).map(remoteRow));
  }
  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'message';
    li.textContent = !remotesLoadedAt ? 'Loading…' : words.length ? 'No remotes match.'
      : 'No remotes yet. Press Add remote, or add hosts to ~/.ssh/config.';
    rows.push(li);
  }
  list.replaceChildren(...rows);
}

// Opens the remote's tab, reconnecting it if it was closed, or makes a new one.
function connectRemote(entry) {
  const remote = { ...entry.remote, id: entry.id };
  let tab = remoteTab(entry.id);
  if (tab) {
    tab.remote = remote;
    activateTab(tab);
    if (tab.exited) startShell(tab, { keepOutput: true });
  } else {
    tab = createTab(defaultShellId(), remote);
    activateTab(tab);
    startShell(tab);
    outputChanged = true;
  }
  renderRemotes();
  tab.term.focus();
}

// --- The active tab's remote: toolbar, reconnect bar, airlock ---------------------------------

function showRemoteState() {
  const tab = activeTab;
  if (!tab) return;
  const r = tab.remote;
  const connected = r && !tab.exited;
  $('shell').hidden = Boolean(r);
  if (r) $('aws').hidden = true; // AWS profiles are this machine's
  // A remote tab reconnects from the bar shown when it isn't connected; Disconnect takes the space.
  $('restart').hidden = Boolean(r);
  $('remote-chip').hidden = !r;
  $('remote-key').hidden = !(r && r.transport !== 'winrm' && remotesInfo.onePasswordKeys);
  $('remote-disconnect').hidden = !connected;
  const canCopyFiles = connected && !(r.transport === 'winrm' && r.signIn === 'ask');
  $('remote-send').hidden = !canCopyFiles;
  $('remote-get').hidden = !canCopyFiles;
  if (r) {
    $('remote-chip').classList.toggle('on', Boolean(connected));
    $('remote-address').textContent = `${r.user ? `${r.user}@` : ''}${r.address}`;
    $('remote-how').textContent = { ssh: 'SSH', winrm: 'WinRM', 'pwsh-ssh': 'PS over SSH' }[r.transport] + (r.keepSession ? ' · tmux' : '');
    $('remote-chip').title = `${r.name}: ${remoteDescription(r)}${r.env ? ` · ${r.env.toUpperCase()}` : ''}`;
    $('remote-disconnect').title = r.transport === 'winrm' ? `Leave the session running on ${r.name}, to pick up later`
      : r.keepSession ? `Close the connection. tmux keeps the session running on ${r.name}.` : 'Close the connection';
  }
  $('remote-bar').hidden = !(r && tab.exited);
  if (r && tab.exited) {
    $('remote-bar-text').textContent = tab.kept ? `The session is still running on ${r.name}.`
      : r.keepSession ? `Not connected. If the tmux session is still running on ${r.name}, Reconnect picks it up.`
        : `Not connected to ${r.name}.`;
  }
  if (!r || tab.exited) $('remote-get-form').hidden = true;
  // The airlock says where Run goes.
  const target = $('airlock-target');
  target.hidden = !r;
  $('airlock').classList.toggle('prod', r?.env === 'prod');
  if (r) {
    target.textContent = `Runs on ${r.name}${r.env ? ` · ${r.env.toUpperCase()}` : ''}${r.env === 'prod' ? ' · asks before running' : ''}${tab.exited ? ' · not connected' : ''}`;
  }
}

$('remote-disconnect').addEventListener('click', () => {
  const tab = activeTab;
  if (!tab?.remote) return;
  tab.kept = tab.remote.transport === 'winrm';
  window.airlock.ptyDisconnect(tab.id);
});
$('remote-reconnect').addEventListener('click', () => {
  if (!activeTab?.remote) return;
  startShell(activeTab, { keepOutput: true });
  activeTab.term.focus();
});
$('remote-send').addEventListener('click', async () => {
  const tab = activeTab;
  const result = await window.airlock.remoteTransfer({ id: tab.id, direction: 'send' });
  if (result.error) toast(result.error, { error: true });
  else if (result.done) toast(result.done);
});
$('remote-get').addEventListener('click', () => {
  $('remote-get-label').textContent = `Get a file from ${activeTab.remote.name}`;
  $('remote-get-form').hidden = false;
  $('remote-get-path').focus();
});
$('remote-get-cancel').addEventListener('click', () => { $('remote-get-form').hidden = true; activeTab.term.focus(); });
$('remote-get-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const remotePath = $('remote-get-path').value.trim();
  if (!remotePath) return;
  $('remote-get-form').hidden = true;
  const result = await window.airlock.remoteTransfer({ id: activeTab.id, direction: 'get', remotePath });
  if (result.error) toast(result.error, { error: true });
  else if (result.done) toast(result.done);
});
$('remote-get-path').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('remote-get-cancel').click(); });

// --- The form: add or edit a remote --------------------------------------------------------

const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? '';
const setRadio = (name, value) => {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
};

// Shows only what applies to the chosen connection type and sign-in.
function syncRemoteForm() {
  const transport = radio('rf-transport');
  const winrm = transport === 'winrm';
  const signIn = radio('rf-signin');
  for (const card of document.querySelectorAll('.rf-card')) card.classList.toggle('checked', card.querySelector('input').checked);
  $('rf-signin').hidden = !winrm;
  $('rf-ssh-keys').hidden = winrm;
  $('rf-ssh-keys').textContent = remotesInfo.onePasswordKeys
    ? 'Keys come from 1Password\'s SSH agent, which asks you to approve each use. The app never sees them.'
    : 'Keys come from ssh-agent and ~/.ssh, as for any ssh command. The app never reads them.';
  $('rf-1password').hidden = !(winrm && signIn === '1password');
  $('rf-saved').hidden = !(winrm && signIn === 'saved');
  $('rf-https-row').hidden = !winrm;
  $('rf-keep-row').hidden = transport !== 'ssh';
  $('rf-keep-note').hidden = transport !== 'ssh' || !$('rf-keep').checked;
  $('rf-user').placeholder = winrm ? 'CORP\\you, or you@corp.local' : 'Blank: your own, or the one in ~/.ssh/config';
  const source = $('rf-source').selectedOptions[0];
  $('rf-source-note').textContent = SOURCE_NOTES[source?.dataset.kind] ?? '';
  for (const input of document.querySelectorAll('input[name="rf-signin"][value="saved"]')) input.disabled = !remotesInfo.canSavePasswords;
}

function fillSourcePicker(entry) {
  const picker = $('rf-source');
  const option = (value, text, kind) => {
    const o = Object.assign(document.createElement('option'), { value, textContent: text });
    o.dataset.kind = kind;
    return o;
  };
  const repos = snippetRepos();
  const options = [
    ...repos.filter((r) => r.kind === 'team').map((r) => option(r.id, `${r.label} repo (Team)`, 'team')),
    ...repos.filter((r) => r.kind === 'personal').map((r) => option(r.id, `${r.label} repo (Personal)`, 'personal')),
    option('local', 'This machine only', 'local'),
  ];
  picker.replaceChildren(...options);
  const last = prefs.lastRemoteSource;
  picker.value = entry?.source ?? (options.some((o) => o.value === last) ? last : options[0].value);
  // Moving a remote between repos would be a delete and an add; it stays where it is.
  picker.disabled = Boolean(entry?.source);
}

function openRemoteForm(entry = null) {
  remoteEditing = entry ?? {};
  const r = entry?.remote ?? { transport: 'ssh', signIn: '', env: '', port: null };
  $('rf-title').textContent = entry ? `Edit ${r.name}` : 'Add a remote';
  $('rf-name').value = r.name ?? '';
  $('rf-address').value = r.address ?? '';
  $('rf-user').value = r.user ?? '';
  setRadio('rf-transport', r.transport ?? 'ssh');
  setRadio('rf-signin', r.signIn || 'windows');
  $('rf-ref').value = r.passwordRef ?? '';
  $('rf-password').value = '';
  $('rf-password').placeholder = entry?.hasPassword ? 'Leave blank to keep the saved one' : 'The password to save';
  $('rf-env').value = r.env ?? '';
  $('rf-group').value = r.group ?? '';
  $('rf-port').value = r.port ?? '';
  $('rf-start').value = r.startIn ?? '';
  $('rf-https').checked = Boolean(r.https);
  $('rf-keep').checked = Boolean(r.keepSession);
  $('rf-notes').value = r.notes ?? '';
  $('rf-more').open = Boolean(r.port || r.startIn || r.https || r.keepSession || r.notes);
  $('rf-op-list').hidden = true;
  $('rf-problem').textContent = '';
  $('rf-test-result').textContent = '';
  const groups = [...new Set(remoteEntries.map((e) => e.remote.group).filter(Boolean))].sort();
  $('rf-groups').replaceChildren(...groups.map((g) => Object.assign(document.createElement('option'), { value: g })));
  fillSourcePicker(entry);
  syncRemoteForm();
  $('remote-form').hidden = false;
  $('remotes-add').hidden = true;
  $('remote-list').hidden = true;
  $('rf-name').focus();
}

function closeRemoteForm() {
  remoteEditing = null;
  $('remote-form').hidden = true;
  $('remotes-add').hidden = false;
  $('remote-list').hidden = false;
}

// The form as a remote. Checked properly by the main process; this catches the obvious.
function remoteFromForm() {
  const transport = radio('rf-transport');
  const port = $('rf-port').value.trim();
  return {
    name: $('rf-name').value.trim(),
    address: $('rf-address').value.trim(),
    transport,
    user: $('rf-user').value.trim(),
    port: port ? Number(port) : null,
    https: transport === 'winrm' && $('rf-https').checked,
    env: $('rf-env').value,
    group: $('rf-group').value.trim(),
    startIn: $('rf-start').value.trim(),
    keepSession: transport === 'ssh' && $('rf-keep').checked,
    signIn: transport === 'winrm' ? radio('rf-signin') : '',
    passwordRef: transport === 'winrm' && radio('rf-signin') === '1password' ? $('rf-ref').value.trim() : '',
    notes: $('rf-notes').value,
  };
}

function formProblem(r) {
  if (!r.name) return 'Give it a name.';
  if (!/^(?!-)[A-Za-z0-9._:%[\]-]+$/.test(r.address)) return 'The address should be a computer name or an IP address.';
  if (r.port !== null && !(Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535)) return 'The port should be a number from 1 to 65535.';
  if (/['"`$]/.test(r.startIn)) return 'The starting folder can\'t contain quotes or $.';
  if (r.signIn === '1password' && !/^op:\/\//.test(r.passwordRef)) return 'Give the 1Password reference, starting op://, or press Choose from 1Password.';
  if ((r.signIn === '1password' || r.signIn === 'saved') && !r.user) return 'Give the user name to sign in as.';
  if (r.signIn === 'saved' && !$('rf-password').value && !remoteEditing?.hasPassword) return 'Type the password to save.';
  return '';
}

async function saveRemoteForm({ connect }) {
  const remote = remoteFromForm();
  const problem = formProblem(remote);
  $('rf-problem').textContent = problem;
  if (problem) return;
  const editing = remoteEditing;
  $('rf-save').disabled = true;
  $('rf-save-connect').disabled = true;
  const result = await window.airlock.saveRemote({
    source: $('rf-source').value, file: editing.file ?? null, base: editing.base, remote,
    password: remote.signIn === 'saved' ? $('rf-password').value : '',
  });
  $('rf-save').disabled = false;
  $('rf-save-connect').disabled = false;
  if (result.error) { $('rf-problem').textContent = result.error; return; }
  if (result.conflict) {
    if (result.text === null) {
      remoteEditing = { ...editing, file: null, base: null };
      $('rf-problem').textContent = 'Someone else deleted this remote. Save again to add it back.';
    } else {
      remoteEditing = { ...editing, base: result.text };
      $('rf-problem').textContent = 'Someone else changed this remote since you opened it. Save again to replace their version, or Cancel to keep it.';
    }
    return;
  }
  saveSetting('lastRemoteSource', $('rf-source').value);
  closeRemoteForm();
  setStatus(`Saved "${remote.name}"`, STATUS_RAN_MS);
  await loadRemotes();
  const saved = remoteEntries.find((e) => e.id === result.id);
  if (connect && saved) connectRemote(saved);
}

$('remotes-add').addEventListener('click', () => openRemoteForm());
$('remotes-reload').addEventListener('click', loadRemotes);
$('remotes-filter').addEventListener('input', renderRemotes);
$('rf-cancel').addEventListener('click', closeRemoteForm);
$('remote-form').addEventListener('input', syncRemoteForm);
$('remote-form').addEventListener('change', syncRemoteForm);
$('remote-form').addEventListener('submit', (e) => { e.preventDefault(); saveRemoteForm({ connect: true }); });
$('rf-save').addEventListener('click', () => saveRemoteForm({ connect: false }));
$('remote-form').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRemoteForm(); });

$('rf-test').addEventListener('click', async () => {
  const remote = remoteFromForm();
  const problem = formProblem({ ...remote, signIn: remote.signIn === 'saved' ? '' : remote.signIn });
  $('rf-problem').textContent = problem;
  if (problem) return;
  const result = $('rf-test-result');
  result.className = '';
  result.textContent = 'Connecting…';
  $('rf-test').disabled = true;
  const outcome = await window.airlock.testRemote({ remote, id: remoteEditing?.id ?? '', password: $('rf-password').value });
  $('rf-test').disabled = false;
  result.textContent = outcome.message;
  result.className = outcome.ok ? 'ok' : 'error';
});

$('rf-op-choose').addEventListener('click', async () => {
  const button = $('rf-op-choose');
  button.disabled = true;
  button.textContent = 'Asking 1Password…';
  const { items, error } = await window.airlock.onePasswordItems();
  button.disabled = false;
  button.textContent = 'Choose from 1Password…';
  if (error) { $('rf-problem').textContent = error; return; }
  const picker = $('rf-op-list');
  const option = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
  picker.replaceChildren(option('', `${items.length} items: pick one`), ...items.map((i) => option(i.ref, `${i.title} (${i.vault})`)));
  picker.hidden = false;
  picker.focus();
});
$('rf-op-list').addEventListener('change', () => {
  if ($('rf-op-list').value) $('rf-ref').value = $('rf-op-list').value;
});

// --- Settings ------------------------------------------------------------------------------

$('setting-ssh-config-hosts').checked = prefs.showSshConfigHosts !== false;
$('setting-ssh-config-hosts').addEventListener('change', (e) => { saveSetting('showSshConfigHosts', e.target.checked); loadRemotes(); });
$('setting-ssh-accept-new').checked = prefs.sshAcceptNewHostKeys !== false;
$('setting-ssh-accept-new').addEventListener('change', (e) => saveSetting('sshAcceptNewHostKeys', e.target.checked));
$('setting-1password-agent').checked = prefs.use1PasswordAgent !== false;
$('setting-1password-agent').addEventListener('change', (e) => { saveSetting('use1PasswordAgent', e.target.checked); loadRemotes(); });
$('setting-1password-agent-row').hidden = true;

// Once at startup, so tab labels, the toolbar and the Settings row know what's there.
loadRemotes();
if (rightTab === 'remotes') showRemotesTab();
