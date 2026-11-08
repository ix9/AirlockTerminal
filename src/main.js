const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, WebContentsView, Menu, clipboard, dialog, ipcMain, nativeTheme, safeStorage, screen, session, shell } = require('electron');
const pty = require('node-pty');
const remotes = require('./remotes');

const CHAT_URL = 'https://claude.ai/';
const TITLEBAR_HEIGHT = 35; // keep in sync with --titlebar-height in style.css
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

let win;
let chat;

// One entry per terminal tab, keyed by the id the UI gave it: { pty, shell, cwd, exited }.
const terminals = new Map();
let activeId = null;
const activeTerminal = () => terminals.get(activeId);
const toUi = (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); };

// --- Data files and settings ----------------------------------------------------------------

const dataFile = (name) => path.join(app.getPath('userData'), name);

// Replaced in one step, so a crash can't leave half a file.
function writeFileAtomic(file, text, options) {
  fs.writeFileSync(`${file}.tmp`, text, options);
  fs.renameSync(`${file}.tmp`, file);
}

const THEMES = {
  dark: { background: '#181818', symbols: '#cccccc' },
  light: { background: '#f8f8f8', symbols: '#3b3b3b' },
  contrast: { background: '#000000', symbols: '#ffffff' },
  monokai: { background: '#1e1f1c', symbols: '#f8f8f2' },
  oceanic: { background: '#1b2b34', symbols: '#d8dee9' },
};

// Snippet repos (ADR 0006). An address is any git address, but never one starting with '-', which git
// would read as an option. The SSH key path goes through a shell, so it can't hold quotes or $.
const validRepoId = (id) => typeof id === 'string' && /^[a-z0-9]{1,16}$/.test(id);
const REPO_URL = /^(https:\/\/|ssh:\/\/|git@|file:\/\/)\S+$/;
const optionalLine = (v, max, bad = /[\r\n]/) => v === undefined || v === '' || (typeof v === 'string' && v.length <= max && !bad.test(v));
const validRepo = (r) => Boolean(r) && validRepoId(r.id)
  && typeof r.label === 'string' && Boolean(r.label.trim()) && r.label.length <= 40 && !/[\r\n]/.test(r.label)
  && typeof r.url === 'string' && r.url.length <= 500 && REPO_URL.test(r.url)
  && (r.kind === 'team' || r.kind === 'personal')
  && optionalLine(r.name, 100) && optionalLine(r.email, 200) && optionalLine(r.sshKey, 500, /[\r\n"$`]/);

const isPercent = (v) => Number.isFinite(v) && v > 0 && v < 100;
// What the UI may change. The window, folders, files and web settings are set only by this process.
const SETTING_RULES = {
  theme: (v) => v === 'system' || Object.hasOwn(THEMES, v),
  fontSize: (v) => Number.isFinite(v) && v >= 8 && v <= 32,
  airlockFontSize: (v) => Number.isFinite(v) && v >= 8 && v <= 32,
  runsheetFontSize: (v) => Number.isFinite(v) && v >= 8 && v <= 32,
  lastShell: (v) => typeof v === 'string',
  leftWidth: isPercent,
  airlockHeight: isPercent,
  scratchLeft: isPercent,
  saveScrollback: (v) => typeof v === 'boolean',
  rightTab: (v) => ['claude', 'web', 'runsheet', 'team', 'personal', 'remotes'].includes(v),
  doubleCopyRun: (v) => typeof v === 'boolean',
  showOtherFolderSnippets: (v) => typeof v === 'boolean',
  snippetRepos: (v) => Array.isArray(v) && v.length <= 10 && v.every(validRepo) && new Set(v.map((r) => r.id)).size === v.length,
  lastSnippetRepo: (v) => validRepoId(v),
  // Remote sessions (ADR 0008).
  use1PasswordAgent: (v) => typeof v === 'boolean',
  showSshConfigHosts: (v) => typeof v === 'boolean',
  sshAcceptNewHostKeys: (v) => typeof v === 'boolean',
  lastRemoteSource: (v) => v === 'local' || validRepoId(v),
};

let settings = { theme: 'dark' };
let settingsTimer = null;

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile('settings.json'), 'utf8'));
    // Repos saved before there were Team and Personal tabs go in Team.
    if (Array.isArray(raw.snippetRepos)) raw.snippetRepos = raw.snippetRepos.map((r) => (r && !r.kind ? { ...r, kind: 'team' } : r));
    for (const [key, valid] of Object.entries(SETTING_RULES)) if (valid(raw[key])) settings[key] = raw[key];
    if (!settings.snippetRepos && typeof raw.teamRepoUrl === 'string' && REPO_URL.test(raw.teamRepoUrl)) {
      settings.snippetRepos = [{ id: 'team', label: 'Team', url: raw.teamRepoUrl, kind: 'team' }];
    }
    if (typeof raw.snippetsDir === 'string') settings.snippetsDir = raw.snippetsDir;
    if (typeof raw.runsheetPath === 'string') settings.runsheetPath = raw.runsheetPath;
    if (typeof raw.runsheetFolder === 'string') settings.runsheetFolder = raw.runsheetFolder;
    if (typeof raw.webUrl === 'string' && /^https?:\/\//i.test(raw.webUrl)) settings.webUrl = raw.webUrl;
    if (Array.isArray(raw.webAutoRunSites)) settings.webAutoRunSites = raw.webAutoRunSites.filter((s) => typeof s === 'string' && s.startsWith('https://'));
    const w = raw.window;
    if (w && [w.x, w.y, w.width, w.height].every(Number.isFinite)) settings.window = { ...w, maximized: w.maximized === true };
  } catch {} // no file yet, or unreadable: defaults
}

function flushSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = null;
  // Private because it holds the last web address, which may include a token.
  try { writeFileAtomic(dataFile('settings.json'), `${JSON.stringify(settings, null, 2)}\n`, PRIVATE_FILE); } catch {}
}
function saveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(flushSettings, 300);
}

// A saved position is only used if it's still on a connected screen.
function initialBounds() {
  const w = settings.window;
  if (!w) return { width: 1600, height: 900 };
  const size = { width: w.width, height: w.height };
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    w.x < a.x + a.width && w.x + w.width > a.x && w.y < a.y + a.height && w.y + w.height > a.y);
  return visible ? { x: w.x, y: w.y, ...size } : size;
}

function rememberWindow() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  settings.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  saveSettings();
}

// --- Themes: the renderer styles itself; this covers what only this process can reach --------

const resolvedTheme = () => (settings.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : settings.theme);

// Also what claude.ai sees as prefers-color-scheme, so the chat follows the app.
function applyThemeSource() {
  nativeTheme.themeSource = settings.theme === 'system' ? 'system' : settings.theme === 'light' ? 'light' : 'dark';
}

function pushTheme() {
  if (!win || win.isDestroyed()) return;
  const theme = resolvedTheme();
  const { background, symbols } = THEMES[theme];
  win.setBackgroundColor(background);
  if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: background, symbolColor: symbols, height: TITLEBAR_HEIGHT });
  toUi('theme:changed', theme);
}
nativeTheme.on('updated', pushTheme);

// --- Shells ---------------------------------------------------------------------------------
// Each shell is launched with the integration script for its kind (ADR 0002). The UI only
// ever sends back an id from this list.

// Shells can't read inside the asar archive, so packaged builds keep these scripts beside it.
const INTEGRATION_DIR = path.join(__dirname, 'shell-integration').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

const PWSH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/local/microsoft/powershell/7', '/usr/bin', '/snap/bin', '/opt/microsoft/powershell/7'];
const isPwsh = (shellPath) => shellPath.split('/').pop() === 'pwsh';

function listShells() {
  const shells = [];
  const ps1 = path.join(INTEGRATION_DIR, 'airlock.ps1').replace(/'/g, "''");
  const psArgs = ['-NoLogo', '-NoExit', '-Command', `. '${ps1}'`];
  if (process.platform === 'win32') {
    try {
      execFileSync('where.exe', ['pwsh'], { stdio: 'ignore' });
      shells.push({ id: 'pwsh', label: 'PowerShell 7', kind: 'pwsh', file: 'pwsh.exe', args: psArgs });
    } catch {}
    shells.push({ id: 'powershell', label: 'Windows PowerShell', kind: 'pwsh', file: 'powershell.exe', args: psArgs });
    try {
      // `wsl -l -q` prints UTF-16LE. Docker's internal distros aren't for interactive use.
      const out = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'utf16le', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const name of out.split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim())) {
        if (name && !name.startsWith('docker-desktop'))
          shells.push({ id: `wsl:${name}`, label: `WSL: ${name}`, kind: 'wsl', distro: name });
      }
    } catch {}
  } else {
    const paths = new Set([process.env.SHELL || '/bin/bash']);
    try {
      for (const line of fs.readFileSync('/etc/shells', 'utf8').split('\n'))
        if (line.startsWith('/') && fs.existsSync(line.trim())) paths.add(line.trim());
    } catch {}
    // PowerShell's installers don't add it to /etc/shells. An app opened from the Finder gets a
    // short PATH that leaves out Homebrew, so look in the usual places too.
    if (![...paths].some(isPwsh)) {
      const pwsh = [...(process.env.PATH ?? '').split(':').filter(Boolean), ...PWSH_DIRS].map((dir) => `${dir}/pwsh`).find((p) => fs.existsSync(p));
      if (pwsh) paths.add(pwsh);
    }
    for (const p of paths) {
      // -Login has to come first. It gives pwsh the PATH a login shell would have.
      shells.push(isPwsh(p) ? { id: p, label: p, kind: 'pwsh', file: p, args: ['-Login', ...psArgs] } : { id: p, label: p, kind: 'unix', file: p });
    }
  }
  return shells;
}
const shells = listShells();

// Arguments/env that start a bash or zsh with integration; other shells start plain.
function unixLaunch(shellPath, integrationDir) {
  const name = shellPath.split('/').pop();
  if (name === 'bash') return { args: ['--init-file', `${integrationDir}/airlock.bash`, '-i'], env: {} };
  if (name === 'zsh') return { args: ['-l'], env: { ZDOTDIR: `${integrationDir}/zsh`, AIRLOCK_USER_ZDOTDIR: process.env.ZDOTDIR || '' } };
  return { args: ['-l'], env: {} };
}

// Resolve a shell entry to the actual command line.
function launchSpec(s) {
  if (s.kind === 'pwsh') return { file: s.file, args: s.args, env: {} };
  if (s.kind === 'unix') return { file: s.file, ...unixLaunch(s.file, INTEGRATION_DIR) };
  // WSL: ask the distro for the user's login shell and where our scripts appear inside it.
  let shellPath = '';
  let dir = '';
  try {
    // --exec passes argv straight through (`--` would re-parse it with the user's shell).
    [shellPath, dir] = execFileSync('wsl.exe', ['-d', s.distro, '--exec', 'sh', '-c',
      'getent passwd "$(id -un)" | cut -d: -f7; wslpath -a "$0"', INTEGRATION_DIR.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 15000 }).trim().split('\n').map((l) => l.trim());
  } catch {}
  const base = ['-d', s.distro, '--cd', '~'];
  if (!shellPath || !dir) return { file: 'wsl.exe', args: base, env: {} };
  const { args, env } = unixLaunch(shellPath, dir);
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return { file: 'wsl.exe', args: [...base, '--exec', 'env', ...envArgs, shellPath, ...args], env: {} };
}

function createWindow() {
  const { background, symbols } = THEMES[resolvedTheme()];
  win = new BrowserWindow({
    ...initialBounds(),
    title: 'Airlock Terminal',
    icon: APP_ICON,
    backgroundColor: background,
    // VS Code-style: our own title bar; the OS draws only the window buttons over it.
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin' && {
      titleBarOverlay: { color: background, symbolColor: symbols, height: TITLEBAR_HEIGHT },
    }),
    trafficLightPosition: { x: 12, y: 10 },
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (!settings.window || settings.window.maximized) win.maximize();
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, rememberWindow);
  // The UI never navigates away from itself, whatever a link in a runsheet says.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  uiGesture = trackCopyGestures(win.webContents);
  win.on('close', () => { rememberWindow(); flushSettings(); });
  // The renderer holds the window open while the Runsheet has unsaved edits. Unload events can't
  // wait, so this dialog has to be the blocking kind.
  win.webContents.on('will-prevent-unload', (e) => {
    if (dialog.showMessageBoxSync(win, DISCARD_EDITS) === 0) e.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Chat pane: an external site in its own persistent session, laid over the UI's placeholder.
  chat = new WebContentsView({
    webPreferences: {
      partition: 'persist:chat',
      preload: path.join(__dirname, 'chat-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Present as plain Chrome; some sign-in flows refuse user agents that mention Electron.
  // Set on the session so the usage fetch below looks identical to the page.
  const ua = chat.webContents.getUserAgent().replace(/ (Electron|airlock-terminal)\/\S+/g, '');
  chat.webContents.session.setUserAgent(ua);
  chat.webContents.setUserAgent(ua);
  // Links that open new windows go to the system browser.
  chat.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  chatGesture = trackCopyGestures(chat.webContents);
  win.contentView.addChildView(chat);
  chat.webContents.loadURL(CHAT_URL);

  // Usage stats: after the chat loads (a login may have just happened), every few minutes,
  // and when the window regains focus.
  chat.webContents.on('did-finish-load', () => refreshUsage(true));
  win.on('focus', () => refreshUsage());
  setInterval(() => refreshUsage(true), USAGE_POLL_MS);
}

// The UI renderer reports where the chat placeholder is; the view follows it.
ipcMain.on('chat:bounds', (_e, r) => chat?.setBounds(r));
// Hidden while a divider is dragged, so the native view doesn't steal the mouse.
ipcMain.on('chat:visible', (_e, visible) => chat?.setVisible(visible));

// "Send to Claude": puts terminal output in claude.ai's message box, through the clipboard and a
// paste, as the person would. Long text then becomes an attachment, as it does when pasted by hand.
// Nothing is sent until they press Enter in the chat.
ipcMain.handle('chat:send', async (e, text) => {
  if (!fromUi(e) || typeof text !== 'string' || !chat) return false;
  clipboard.writeText(text);
  const contents = chat.webContents;
  if (new URL(contents.getURL()).host !== 'claude.ai') return false;
  // The message box is a ProseMirror editor. Put the caret at its end, after anything typed.
  const found = await contents.executeJavaScript(`(() => {
    const box = document.querySelector('div.ProseMirror[contenteditable="true"]');
    if (!box) return false;
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return true;
  })()`).catch(() => false);
  if (!found) return false;
  contents.focus();
  contents.paste();
  return true;
});

// Links clicked in the terminal open in the system browser (web URLs only).
ipcMain.on('open-external', (e, url) => {
  if (fromUi(e) && typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

// Double-copy runs a command (ADR 0005), so a copy only counts if a real click or key press caused
// it. Pages can call the clipboard whenever they like, but these events come from outside them.
// Each press has its own id: a held key adds none, and one click that writes twice has one id.
const COPY_GESTURE_MS = 1000;
let chatGesture = () => null;
let uiGesture = () => null;

function trackCopyGestures(contents) {
  let id = 0;
  let at = 0;
  const copyKey = process.platform === 'darwin' ? 'meta' : 'control';
  contents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && !input.isAutoRepeat && input.key.toLowerCase() === 'c'
      && input[copyKey] && !input.alt && !input.shift) { id++; at = Date.now(); }
  });
  contents.on('before-mouse-event', (_e, mouse) => {
    if (mouse.type === 'mouseDown') { id++; at = Date.now(); }
  });
  return () => (Date.now() - at <= COPY_GESTURE_MS ? id : null);
}

// Copies made in the chat go to the airlock, but only from claude.ai itself. Only its top frame
// can count towards a double-copy. Web tab pages are handled separately because they can be anything.
ipcMain.on('chat:copied', (e, text) => {
  if (typeof text !== 'string') return;
  if (e.sender === web?.webContents) { receiveWebCopy(e, text); return; }
  if (e.sender !== chat?.webContents) return;
  if (new URL(e.senderFrame.url).host !== 'claude.ai') return;
  const gesture = e.senderFrame === chat.webContents.mainFrame ? chatGesture() : null;
  win.webContents.send('airlock:fill', { text, gesture: gesture === null ? null : `chat:${gesture}` });
});
ipcMain.on('copy:gesture', (e) => {
  const gesture = fromUi(e) ? uiGesture() : null;
  e.returnValue = gesture === null ? null : `ui:${gesture}`;
});

// --- Terminal: node-pty lives here; the UI's xterm.js talks to it over IPC ---------------

const fromUi = (e) => e.sender === win?.webContents;

ipcMain.handle('shells:list', (e) => (fromUi(e) ? shells.map(({ id, label }) => ({ id, label })) : []));

ipcMain.on('pty:start', async (e, { id, cols, rows, shellId, remoteId }) => {
  if (!fromUi(e) || !Number.isInteger(id)) return;
  terminals.get(id)?.pty.kill();
  terminals.delete(id);
  let shellEntry;
  let spec;
  let remote = null;
  if (remoteId != null) {
    // Remote tabs (ADR 0008): the UI names a remote; what runs comes from this process's own list.
    const found = typeof remoteId === 'string' ? await findRemote(remoteId) : null;
    try {
      if (!found) throw new Error('That remote isn\'t in the list any more.');
      if (found.problem) throw new Error(`This remote ${found.problem}. Edit it to fix that.`);
      remote = found;
      spec = remoteLaunch(found);
      shellEntry = { kind: 'remote', file: spec.file };
    } catch (err) {
      toUi('pty:data', id, `\x1b[31m${err.message}\x1b[0m\r\n`);
      toUi('pty:exit', id, -1);
      return;
    }
  } else {
    shellEntry = shells.find((s) => s.id === shellId) ?? shells[0];
    spec = launchSpec(shellEntry);
  }
  const { file, args, env } = spec;
  let p;
  try {
    p = pty.spawn(file, args, {
      name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: { ...process.env, ...env },
    });
  } catch (err) {
    toUi('pty:data', id, `\x1b[31mCouldn't start ${file}: ${err.message}\x1b[0m\r\n`);
    toUi('pty:exit', id, -1);
    return;
  }
  const entry = { pty: p, shell: shellEntry, remote, keepFile: env.AIRLOCK_KEEP_FILE, cwd: '', exited: false };
  terminals.set(id, entry);
  // A restarted tab's old shell may still be finishing; only the current one reaches the UI.
  p.onData((data) => { if (terminals.get(id) === entry) toUi('pty:data', id, data); });
  p.onExit(({ exitCode }) => {
    entry.exited = true;
    if (entry.keepFile) fs.rm(entry.keepFile, { force: true }, () => {});
    if (terminals.get(id) === entry) toUi('pty:exit', id, exitCode);
  });
});
ipcMain.on('pty:input', (e, id, data) => {
  const t = terminals.get(id);
  if (fromUi(e) && t && !t.exited) t.pty.write(data);
});
ipcMain.on('pty:resize', (e, id, { cols, rows }) => {
  const t = terminals.get(id);
  if (fromUi(e) && t && !t.exited) t.pty.resize(cols, rows);
});
// Downloads, saves and AWS commands follow this tab.
ipcMain.on('pty:activate', (e, id) => { if (fromUi(e)) activeId = id; });
ipcMain.on('pty:close', (e, id) => {
  if (!fromUi(e)) return;
  terminals.get(id)?.pty.kill();
  terminals.delete(id);
});

// What's running in the terminal besides its shell. Windows and WSL can't tell us, so there the
// answer is always "something might be".
function foregroundProcess(t) {
  if (t.exited) return null;
  if (t.remote) return `It's connected to ${t.remote.name}.`;
  if (process.platform === 'win32') return 'A command may still be running.';
  const name = (t.pty.process || '').split('/').pop().replace(/^-/, '');
  return name && name !== t.shell.file.split('/').pop() ? `"${name}" is still running.` : null;
}
ipcMain.handle('pty:confirm-close', async (e, id) => {
  const t = terminals.get(id);
  if (!fromUi(e) || !t) return true;
  const detail = foregroundProcess(t);
  if (!detail) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', message: 'Close this terminal?', detail, buttons: ['Close Terminal', 'Cancel'], defaultId: 1, cancelId: 1,
  });
  return response === 0;
});

// --- AWS profiles -------------------------------------------------------------------------

// Profile names from the config file this tab's shell would use.
function readAwsConfig(shellEntry) {
  try {
    if (shellEntry?.kind === 'wsl') {
      return execFileSync('wsl.exe', ['-d', shellEntry.distro, '--exec', 'sh', '-c',
        'cat "${AWS_CONFIG_FILE:-$HOME/.aws/config}"'], { encoding: 'utf8', timeout: 10000 });
    }
    return fs.readFileSync(process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config'), 'utf8');
  } catch {
    return '';
  }
}

function awsProfiles(shellEntry) {
  const names = [];
  for (const line of readAwsConfig(shellEntry).split(/\r?\n/)) {
    const m = line.match(/^\s*\[\s*(?:profile\s+)?([^\]]+?)\s*\]/);
    // [sso-session x] and [services x] sections aren't profiles.
    if (m && !/^(sso-session|services)\s/.test(m[1])) names.push(m[1]);
  }
  return [...new Set(names)];
}

const quote = (s, kind) => `'${s.replace(/'/g, kind === 'pwsh' ? "''" : "'\\''")}'`;

ipcMain.handle('aws:profiles', (e, id) => (fromUi(e) ? awsProfiles(terminals.get(id)?.shell) : []));
// The command that selects a profile in that tab's shell; the UI sends it to the terminal.
ipcMain.handle('aws:command', (e, id, name) => {
  const shellEntry = terminals.get(id)?.shell;
  if (!fromUi(e) || !awsProfiles(shellEntry).includes(name)) return '';
  return shellEntry?.kind === 'pwsh' ? `$env:AWS_PROFILE = ${quote(name, 'pwsh')}` : `export AWS_PROFILE=${quote(name)}`;
});

// Latest working directory reported by each tab's shell integration, as the shell sees it.
ipcMain.on('pty:cwd', (e, id, cwd) => {
  const t = terminals.get(id);
  if (fromUi(e) && t && typeof cwd === 'string') t.cwd = cwd;
});

// The README of the git repository a terminal is in. Its code blocks are offered as snippets;
// the UI only ever loads them into the airlock.
const README_MAX_BYTES = 512 * 1024;
async function repoReadme(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) {
      const name = (await fs.promises.readdir(d)).find((f) => /^readme\.md$/i.test(f));
      if (!name) return null;
      const file = path.join(d, name);
      if ((await fs.promises.stat(file)).size > README_MAX_BYTES) return null;
      return { repo: path.basename(d), text: await fs.promises.readFile(file, 'utf8') };
    }
    if (path.dirname(d) === d) return null;
  }
}
ipcMain.handle('readme:snippets', async (e, id) => {
  const t = terminals.get(id);
  if (!fromUi(e) || !t?.cwd) return null;
  try { return await repoReadme(hostCwd(t)); } catch { return null; }
});

// --- Claude usage (unofficial: the endpoint claude.ai's Usage page uses, ADR 0003) --------

const USAGE_POLL_MS = 5 * 60 * 1000;
let lastUsageFetch = 0;

async function fetchUsage() {
  const ses = session.fromPartition('persist:chat');
  const get = async (p) => {
    const res = await ses.fetch(`https://claude.ai${p}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${p}: ${res.status}`);
    return res.json();
  };
  // The organisation the user last had open in claude.ai.
  const [cookie] = await ses.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' });
  const orgId = cookie?.value ?? (await get('/api/organizations'))[0]?.uuid;
  if (!orgId || !/^[\w-]+$/.test(orgId)) return null;
  const u = await get(`/api/organizations/${orgId}/usage`);
  const pick = (w) => (w && typeof w.utilization === 'number'
    ? { percent: w.utilization, resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null } : null);
  const usage = { session: pick(u.five_hour), weekly: pick(u.seven_day) };
  return usage.session || usage.weekly ? usage : null;
}

async function refreshUsage(force = false) {
  if (!win || (!force && Date.now() - lastUsageFetch < 60 * 1000)) return;
  lastUsageFetch = Date.now();
  let usage = null;
  try { usage = await fetchUsage(); } catch {}
  win?.webContents.send('usage:update', usage); // null hides the display
}
ipcMain.on('usage:refresh', (e) => { if (fromUi(e)) refreshUsage(true); });

// --- Settings, as seen by the UI -------------------------------------------------------------

// Synchronous so the first paint already has the right theme and layout.
ipcMain.on('settings:initial', (e) => {
  const { window: _ignored, ...rest } = settings;
  e.returnValue = fromUi(e) ? { settings: rest, theme: resolvedTheme(), dataDir: app.getPath('userData') } : null;
});
ipcMain.on('settings:set', (e, patch) => {
  if (!fromUi(e) || !patch) return;
  for (const [key, valid] of Object.entries(SETTING_RULES)) {
    if (Object.hasOwn(patch, key) && valid(patch[key])) settings[key] = patch[key];
  }
  if (patch.theme) { applyThemeSource(); pushTheme(); }
  if (Object.hasOwn(patch, 'snippetRepos')) removeStaleClones();
  if (patch.saveScrollback === false) fs.rm(dataFile('scrollback.json'), { force: true }, () => {});
  saveSettings();
});
ipcMain.on('data:open', (e) => { if (fromUi(e)) shell.openPath(app.getPath('userData')); });

// --- Snippets (a plain file, in a folder the user can choose so it can be synced) ------------

const snippetsFile = () => path.join(settings.snippetsDir || app.getPath('userData'), 'snippets.json');

// Throws if the file exists but can't be used, so a sync conflict is reported and never saved over.
function readSnippets() {
  if (settings.snippetsDir && !fs.statSync(settings.snippetsDir).isDirectory()) throw new Error('not a folder');
  let raw;
  try {
    raw = fs.readFileSync(snippetsFile(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error('not a list of snippets');
  return list.filter((s) => typeof s?.name === 'string' && typeof s?.command === 'string');
}
function writeSnippets(list) {
  writeFileAtomic(snippetsFile(), `${JSON.stringify(list, null, 2)}\n`);
}
const snippetsError = (err) => `Can't use ${snippetsFile()}: ${err.message}`;

ipcMain.handle('snippets:list', (e) => {
  if (!fromUi(e)) return { list: [] };
  try {
    return { list: readSnippets() };
  } catch (err) {
    return { list: [], error: snippetsError(err) };
  }
});
ipcMain.handle('snippets:save', (e, list) => {
  if (!fromUi(e) || !Array.isArray(list)) return { error: 'bad request' };
  const clean = list
    .filter((s) => typeof s?.name === 'string' && typeof s?.command === 'string')
    // `cwd`: the folder the snippet belongs to, as the shell reported it. Absent for regular snippets.
    .map(({ name, command, cwd }) => (typeof cwd === 'string' && cwd ? { name, command, cwd } : { name, command }));
  try {
    readSnippets();
    writeSnippets(clean);
    return {};
  } catch (err) {
    return { error: snippetsError(err) };
  }
});
// A folder that already has snippets is used as it is; an empty one gets a copy of the current list.
ipcMain.handle('snippets:choose-folder', async (e) => {
  if (!fromUi(e)) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Snippets folder', properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  let current = [];
  try { current = readSnippets(); } catch {}
  settings.snippetsDir = filePaths[0];
  saveSettings();
  try {
    if (!fs.existsSync(snippetsFile())) writeSnippets(current);
  } catch (err) {
    return { dir: filePaths[0], error: snippetsError(err) };
  }
  return { dir: filePaths[0] };
});
ipcMain.handle('snippets:reset-folder', (e) => {
  if (fromUi(e)) { delete settings.snippetsDir; saveSettings(); }
});

// --- Snippet repos: shared git repos, one Markdown file per snippet (ADR 0006) --------------
// Each repo in Settings has its own clone, its own commit name and email, and optionally its own
// SSH key, so a work and a personal account can sit side by side.

const reposDir = () => dataFile('team-snippets');
const repoDir = (repo) => path.join(reposDir(), repo.id);
const TEAM_FILE = /^[a-z0-9][a-z0-9-]{0,79}\.md$/;
const TEAM_NAME_MAX = 200;
const TEAM_COMMAND_MAX = 64 * 1024;
const findRepo = (id) => settings.snippetRepos?.find((r) => r.id === id);

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      // Fail instead of waiting for a password nobody can type. Credential Manager and SSH still work.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const message = (stderr || err.message).trim();
      if (err.code === 'ENOENT') reject(new Error('Git isn\'t installed, or isn\'t on the PATH.'));
      else if (/tell me who you are|author identity unknown/i.test(message)) {
        reject(new Error('Git needs a name: set a commit name and email for this repo in Settings.'));
      } else reject(Object.assign(new Error(message.split('\n').filter((l) => !l.startsWith('hint:')).join('\n')), { code: err.code }));
    });
  });
}

// Sets a value in this clone's own git config, or removes it so the global one applies.
async function setLocalConfig(dir, key, value) {
  if (value) return git(['config', '--local', key, value], dir);
  try { await git(['config', '--local', '--unset', key], dir); } catch {} // wasn't set
}

// The repo's identity, kept in its clone only. The global git config is never touched.
async function applyIdentity(repo) {
  const dir = repoDir(repo);
  await setLocalConfig(dir, 'user.name', repo.name);
  await setLocalConfig(dir, 'user.email', repo.email);
  // Forward slashes and quotes, because git runs this through a shell.
  const key = repo.sshKey?.replace(/\\/g, '/');
  await setLocalConfig(dir, 'core.sshCommand', key ? `ssh -i "${key}" -o IdentitiesOnly=yes` : '');
}

// Git makes its object files read-only, and on Windows that stops them being deleted.
async function removeTree(dir) {
  const writable = async (p) => {
    let entries;
    try { entries = await fs.promises.readdir(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) await writable(f);
      else await fs.promises.chmod(f, 0o666).catch(() => {});
    }
  };
  await writable(dir);
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

// The clone, made again if the repo's address changed.
async function repoClone(repo) {
  const dir = repoDir(repo);
  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      if ((await git(['remote', 'get-url', 'origin'], dir)).trim() === repo.url) return;
    } catch {} // a broken clone: start again
  }
  await removeTree(dir);
  await fs.promises.mkdir(reposDir(), { recursive: true });
  // The SSH key has to apply to the clone itself, before the clone's own config exists.
  const key = repo.sshKey?.replace(/\\/g, '/');
  const sshArgs = key ? ['-c', `core.sshCommand=ssh -i "${key}" -o IdentitiesOnly=yes`] : [];
  await git([...sshArgs, 'clone', '--quiet', '--', repo.url, dir], reposDir());
}

// Brings the clone to exactly what the server has, and returns the branch. Safe because the clone
// only ever holds commits that were pushed straight away.
async function repoSync(repo, fresh = false) {
  const dir = repoDir(repo);
  await repoClone(repo);
  await applyIdentity(repo);
  await git(['fetch', '--quiet', '--prune', 'origin'], dir);
  let branch = (await git(['symbolic-ref', '--short', 'HEAD'], dir)).trim();
  let onServer = true;
  try { await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], dir); } catch { onServer = false; }
  if (onServer) {
    await git(['reset', '--quiet', '--hard', `origin/${branch}`], dir);
  } else if (!(await git(['branch', '--remotes'], dir)).trim()) {
    // A new, empty repo: start it on main, whatever this machine's git defaults to.
    branch = 'main';
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
    await git(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '.'], dir);
  } else if (!fresh) {
    // Cloned while the repo was empty, and someone else has pushed first since: clone again.
    await removeTree(dir);
    return repoSync(repo, true);
  }
  await git(['clean', '-fdq'], dir);
  return branch;
}

// Who last changed each file in a folder, and when, from one `git log`.
async function repoEdits(repo, folder = 'snippets') {
  const edits = new Map();
  let log = '';
  try {
    log = await git(['log', '--format=%x1e%an%x1f%aI', '--name-only', '--', folder], repoDir(repo));
  } catch { return edits; } // no commits yet
  for (const entry of log.split('\x1e').slice(1)) {
    const [head, ...files] = entry.split('\n');
    const [by, at] = head.split('\x1f');
    for (const f of files) {
      const file = path.posix.basename(f.trim());
      if (file && !edits.has(file)) edits.set(file, { by, at: at?.trim() });
    }
  }
  return edits;
}

const snippetPath = (repo, file, folder = 'snippets') => path.join(repoDir(repo), folder, file);
// Line endings depend on git's settings, so they never count as a change.
async function readSnippetFile(repo, file, folder = 'snippets') {
  try {
    return (await fs.promises.readFile(snippetPath(repo, file, folder), 'utf8')).replace(/\r\n/g, '\n');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function repoList(repo) {
  await repoSync(repo);
  let files = [];
  try { files = (await fs.promises.readdir(path.join(repoDir(repo), 'snippets'))).filter((f) => TEAM_FILE.test(f)); } catch {}
  const edits = await repoEdits(repo);
  const list = await Promise.all(files.map(async (file) => ({ file, text: await readSnippetFile(repo, file), ...edits.get(file) })));
  return list.filter((s) => s.text !== null);
}

// The first heading is the name and the first code block is the command. The fence is longer
// than any run of backticks in the command, so the command can't end it early.
function snippetMarkdown(name, command) {
  const longest = Math.max(2, ...(command.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `# ${name}\n\n${fence}\n${command}\n${fence}\n`;
}

function newSnippetFile(repo, name, folder = 'snippets') {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || folder.replace(/s$/, '');
  for (let n = 1; ; n++) {
    const file = n === 1 ? `${slug}.md` : `${slug}-${n}.md`;
    if (!fs.existsSync(snippetPath(repo, file, folder))) return file;
  }
}

// Sync, check the file is still what the user opened, change it, commit and push. A push that
// loses a race starts again from the server's version.
async function repoChange(repo, { file, base, label, apply, folder = 'snippets' }) {
  const dir = repoDir(repo);
  for (let attempt = 1; ; attempt++) {
    const branch = await repoSync(repo);
    if (file) {
      const current = await readSnippetFile(repo, file, folder);
      if (current !== base) return { conflict: true, text: current };
    }
    const changed = await apply();
    try {
      await git(['diff', '--cached', '--quiet'], dir);
      return { file: changed }; // nothing to commit
    } catch {}
    await git(['commit', '--quiet', '-m', label], dir);
    try {
      await git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], dir);
      return { file: changed };
    } catch (err) {
      if (attempt >= 3 || !/rejected|fetch first|non-fast-forward/i.test(err.message)) throw err;
    }
  }
}

function repoSave(repo, { file, base, name, command }) {
  return repoChange(repo, {
    file, base, label: `${file ? 'Update' : 'Add'} snippet: ${name}`,
    apply: async () => {
      const target = file ?? newSnippetFile(repo, name);
      await fs.promises.mkdir(path.join(repoDir(repo), 'snippets'), { recursive: true });
      await fs.promises.writeFile(snippetPath(repo, target), snippetMarkdown(name, command));
      await git(['add', '--', `snippets/${target}`], repoDir(repo));
      return target;
    },
  });
}

function repoDelete(repo, { file, base, name }) {
  return repoChange(repo, {
    file, base, label: `Delete snippet: ${name}`,
    apply: async () => {
      await git(['rm', '--quiet', '--', `snippets/${file}`], repoDir(repo));
      return file;
    },
  });
}

// One git operation at a time in each repo, so a sync never runs in the middle of a save. Repos
// don't wait for each other.
const repoQueues = new Map();
function repoQueued(id, fn) {
  const repo = findRepo(id);
  if (!repo) return Promise.resolve({ error: 'That repo isn\'t in Settings any more.' });
  const run = (repoQueues.get(id) ?? Promise.resolve()).then(() => fn(repo));
  repoQueues.set(id, run.catch(() => {}));
  return run.catch((err) => ({ error: err.message }));
}

// Removes clones of repos that are no longer in Settings. The single clone from before there could
// be several sat directly in the folder, so that goes too.
async function removeStaleClones() {
  const keep = new Set((settings.snippetRepos ?? []).map((r) => r.id));
  let entries = [];
  try { entries = await fs.promises.readdir(reposDir()); } catch { return; }
  const old = entries.includes('.git');
  for (const name of entries) {
    if (old || !keep.has(name)) {
      try { await removeTree(path.join(reposDir(), name)); } catch {} // in use: next time
    }
  }
}

const validTeamFile = (f) => typeof f === 'string' && TEAM_FILE.test(f);
const validTeamName = (n) => typeof n === 'string' && Boolean(n.trim()) && n.length <= TEAM_NAME_MAX && !/[\r\n]/.test(n);
const validTeamCommand = (c) => typeof c === 'string' && Boolean(c.trim()) && c.length <= TEAM_COMMAND_MAX;

ipcMain.handle('team:list', (e, id) => {
  if (!fromUi(e) || !validRepoId(id)) return { error: 'bad request' };
  return repoQueued(id, async (repo) => ({ list: await repoList(repo) }));
});
ipcMain.handle('team:save', (e, s) => {
  if (!fromUi(e) || !validRepoId(s?.repo)) return { error: 'bad request' };
  if (!validTeamName(s.name) || !validTeamCommand(s.command)) return { error: 'A snippet needs a one-line name and a command.' };
  if (s.file != null && (!validTeamFile(s.file) || typeof s.base !== 'string')) return { error: 'bad request' };
  const command = s.command.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return repoQueued(s.repo, (repo) => repoSave(repo, { file: s.file ?? null, base: s.base, name: s.name.trim(), command }));
});
ipcMain.handle('team:delete', (e, s) => {
  if (!fromUi(e) || !validRepoId(s?.repo) || !validTeamFile(s.file) || typeof s.base !== 'string' || typeof s.name !== 'string') return { error: 'bad request' };
  return repoQueued(s.repo, (repo) => repoDelete(repo, { file: s.file, base: s.base, name: s.name.slice(0, TEAM_NAME_MAX) }));
});

// --- Remotes: servers to open as terminal tabs (ADR 0008) --------------------------------------
// From three places: a remotes/ folder in each snippet repo (one Markdown file per server), a file
// on this machine, and the hosts in ~/.ssh/config, read only. Sign-in secrets are never in any of
// them: passwords stay in 1Password or are saved encrypted on this machine, keys stay with ssh.

const REMOTES_FOLDER = 'remotes';
const localRemotesFile = () => dataFile('remotes.json');
const remotePasswordsFile = () => dataFile('remote-passwords.json');
let remoteCache = new Map(); // id → entry, from the last full list

function readLocalRemotes() {
  try {
    const list = JSON.parse(fs.readFileSync(localRemotesFile(), 'utf8'));
    return Array.isArray(list) ? list.filter((r) => typeof r?.key === 'string' && /^[a-z0-9-]{1,80}$/.test(r.key)) : [];
  } catch {
    return [];
  }
}
function writeLocalRemotes(list) {
  writeFileAtomic(localRemotesFile(), `${JSON.stringify(list, null, 2)}\n`, PRIVATE_FILE);
}

// One list entry: the remote, where it's from, and whether it can be used as it is.
function remoteEntry(id, remote, extra) {
  const clean = remotes.cleanRemote(remote);
  return { id, ...extra, remote: clean, problem: remotes.remoteProblem(clean), hasPassword: savedPasswordIds().has(id) };
}

async function repoRemotes(repo) {
  await repoSync(repo);
  let files = [];
  try { files = (await fs.promises.readdir(path.join(repoDir(repo), REMOTES_FOLDER))).filter((f) => TEAM_FILE.test(f)); } catch {}
  const edits = await repoEdits(repo, REMOTES_FOLDER);
  const list = [];
  for (const file of files) {
    const text = await readSnippetFile(repo, file, REMOTES_FOLDER);
    if (text === null) continue;
    list.push(remoteEntry(`repo:${repo.id}:${file}`, remotes.parseRemoteMarkdown(text), {
      source: repo.id, sourceLabel: `${repo.label} repo`, kind: repo.kind, file, base: text, editable: true, ...edits.get(file),
    }));
  }
  return list;
}

async function listRemotes() {
  const entries = [];
  const errors = [];
  for (const repo of settings.snippetRepos ?? []) {
    const result = await repoQueued(repo.id, (r) => repoRemotes(r).then((list) => ({ list })));
    if (result.error) errors.push({ source: repo.id, sourceLabel: `${repo.label} repo`, message: result.error });
    else entries.push(...result.list);
  }
  for (const { key, ...remote } of readLocalRemotes()) {
    entries.push(remoteEntry(`local:${key}`, remote, { source: 'local', sourceLabel: 'This machine', kind: 'local', file: key, editable: true }));
  }
  if (settings.showSshConfigHosts !== false) {
    for (const h of remotes.sshConfigHosts()) {
      entries.push(remoteEntry(`ssh:${h.alias}`, { name: h.alias, address: h.alias, transport: 'ssh' }, {
        source: 'ssh', sourceLabel: 'From ~/.ssh/config', kind: 'ssh', editable: false,
        detail: [h.user, h.hostName].filter(Boolean).join('@'),
      }));
    }
  }
  remoteCache = new Map(entries.map((e) => [e.id, e]));
  return { entries, errors };
}

// A remote by id, from the last list or, for a tab restored at startup, a fresh one.
async function findRemote(id) {
  if (!remoteCache.has(id)) await listRemotes();
  const entry = remoteCache.get(id);
  return entry && { ...entry.remote, id, problem: entry.problem };
}

// Passwords for remotes that sign in with "Saved on each machine", encrypted with the OS keychain's
// key (Electron safeStorage). Only this process ever decrypts them, just before connecting.
function readSavedPasswords() {
  try { return JSON.parse(fs.readFileSync(remotePasswordsFile(), 'utf8')) ?? {}; } catch { return {}; }
}
const savedPasswordIds = () => new Set(Object.keys(readSavedPasswords()));
function savePassword(id, password) {
  const all = readSavedPasswords();
  if (password) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This system can\'t encrypt saved passwords. Use 1Password or Ask each time.');
    all[id] = safeStorage.encryptString(password).toString('base64');
  } else {
    delete all[id];
  }
  writeFileAtomic(remotePasswordsFile(), JSON.stringify(all), PRIVATE_FILE);
}
function savedPassword(id) {
  const stored = readSavedPasswords()[id];
  try { return stored ? safeStorage.decryptString(Buffer.from(stored, 'base64')) : ''; } catch { return ''; }
}

// SSH tabs use 1Password's agent when it's running and turned on, unless ~/.ssh/config already does.
function sshEnv() {
  const sock = settings.use1PasswordAgent !== false ? remotes.onePasswordAgentSocket() : null;
  return sock ? { SSH_AUTH_SOCK: sock } : {};
}
// Save a new server's key the first time (on unless turned off in Settings). Without it, Test,
// file copies and other background ssh can't connect to a server ssh hasn't seen, since they can't ask.
const acceptNew = () => settings.sshAcceptNewHostKeys !== false;
const usesOnePasswordKeys = () => Boolean(Object.keys(sshEnv()).length) || remotes.sshConfigUsesOnePassword();

// The local PowerShell that WinRM and PowerShell-over-SSH tabs run in: PowerShell 7 if there is one.
const remotePowerShell = () => shells.find((s) => s.kind === 'pwsh' && /pwsh(\.exe)?$/i.test(s.file)) ?? shells.find((s) => s.kind === 'pwsh');

// The command line that connects a tab to a remote.
function remoteLaunch(r) {
  if (r.transport === 'ssh') return { ...remotes.sshLaunch(r, INTEGRATION_DIR, { acceptNew: acceptNew() }), env: sshEnv() };
  const ps = remotePowerShell();
  if (!ps) throw new Error('Connecting to this remote needs PowerShell on this machine, and none was found.');
  // The tab's own integration first, as for any PowerShell tab, then the connection.
  const args = [...ps.args];
  args[args.length - 1] = `${args[args.length - 1]}; ${remotes.psBootstrap(r, INTEGRATION_DIR, { acceptNew: acceptNew() })}`;
  const env = r.transport === 'pwsh-ssh' ? sshEnv() : {};
  if (r.signIn === 'saved') env.AIRLOCK_REMOTE_SECRET = savedPassword(r.id);
  // Where Disconnect leaves word for the tab's local prompt to keep the session (see psBootstrap).
  env.AIRLOCK_KEEP_FILE = path.join(os.tmpdir(), `airlock-keep-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return { file: ps.file, args, env };
}

// Runs a command to completion, with a time limit. Resolves with its output; rejects with its
// error output.
function run(file, args, { env = {}, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      if (err.code === 'ENOENT') return reject(new Error(`${file} isn't installed, or isn't on the PATH.`));
      reject(new Error((stderr || err.message).trim().split('\n').filter((l) => !/^\s*$/.test(l)).slice(-3).join('\n')));
    });
  });
}

// PowerShell run in the background (tests, file copies), signed in the same way as the tab.
function runPowerShell(r, script, { password = '' } = {}) {
  const ps = remotePowerShell();
  if (!ps) return Promise.reject(new Error('This needs PowerShell on this machine, and none was found.'));
  if (r.signIn === 'ask') return Promise.reject(new Error('This remote asks for a password each time, so it can\'t be used in the background.'));
  const env = r.transport === 'pwsh-ssh' ? sshEnv() : {};
  if (r.signIn === 'saved') env.AIRLOCK_REMOTE_SECRET = password || savedPassword(r.id);
  const full = `$ErrorActionPreference = 'Stop'\n${remotes.psCredential(r)}\n$p = ${remotes.psConnectParams(r, { name: false })}\nif ($c) { $p.Credential = $c }\n${remotes.psSshOptions(r, acceptNew())}\n${script}`;
  // -EncodedCommand: no quoting to get wrong on any platform.
  return run(ps.file, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')], { env, timeout: 120000 });
}

// "Test connection" in the form: signs in without opening a tab.
async function testRemote(r, password) {
  if (r.transport === 'ssh' || r.transport === 'pwsh-ssh') {
    const { args, dest } = remotes.sshTarget(r, { acceptNew: acceptNew() });
    // A PowerShell check needs no quoting in any remote shell when it's encoded.
    const check = r.transport === 'ssh' ? 'echo "$(id -un)@$(hostname)"'
      : `pwsh -NoProfile -NonInteractive -EncodedCommand ${Buffer.from("[Environment]::UserName + '@' + [Environment]::MachineName + ' · PowerShell ' + $PSVersionTable.PSVersion", 'utf16le').toString('base64')}`;
    try {
      const out = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...args, '--', dest, check], { env: sshEnv(), timeout: 30000 });
      return { ok: true, message: `Connected as ${out.split('\n').pop()}` };
    } catch (err) {
      if (/host key verification failed|remote host identification has changed/i.test(err.message)) {
        return { ok: false, message: acceptNew()
          ? `${r.address}'s key doesn't match the one ~/.ssh/known_hosts has for it, so ssh refused to connect. If the server was rebuilt, remove the old key with: ssh-keygen -R ${r.address}`
          : `${r.address} isn't in ~/.ssh/known_hosts yet. Turn on "Trust a server's key the first time" in Settings, or press Save and connect and accept it in the tab.` };
      }
      if (/permission denied|passphrase|keyboard-interactive/i.test(err.message)) {
        return { ok: false, message: 'The server wants a password or a key it can\'t get without asking. Save and connect to sign in.' };
      }
      return { ok: false, message: err.message };
    }
  }
  try {
    // "Ask each time" can only check the server answers; the others sign in too.
    const out = await runPowerShell(r.signIn === 'ask' ? { ...r, signIn: '' } : r, r.signIn === 'ask'
      ? '$t = Test-WSMan @p\n"the server answers (sign-in not checked)"'
      : '$t = Test-WSMan @p -Authentication Default\nif ($c) { "signed in as $($c.UserName)" } else { "signed in with your Windows sign-in" }', { password });
    return { ok: true, message: `Connected: ${out.split('\n').pop()}` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// Copies a file to or from the folder the remote tab is in.
async function transferFile(t, direction, localPath, remotePath) {
  const r = t.remote;
  if (r.transport === 'ssh') {
    const { args, dest } = remotes.sshTarget(r, { scp: true, acceptNew: acceptNew() });
    const remote = `${dest}:${remotePath}`;
    const [from, to] = direction === 'send' ? [localPath, remote] : [remote, localPath];
    return run('scp', ['-o', 'BatchMode=yes', ...args, from, to], { env: sshEnv(), timeout: 600000 });
  }
  const [from, to, way] = direction === 'send' ? [localPath, remotePath, 'ToSession'] : [remotePath, localPath, 'FromSession'];
  return runPowerShell(r, `$s = New-PSSession @p\ntry { Copy-Item -LiteralPath ${remotes.psQuote(from)} -Destination ${remotes.psQuote(to)} -${way} $s } finally { Remove-PSSession $s }`);
}

// A path typed for the server, relative to the folder the tab is in.
function remotePathFor(t, typed) {
  const windows = t.remote.transport === 'winrm' || /^[A-Za-z]:[\\/]/.test(t.cwd);
  const absolute = windows ? /^([A-Za-z]:[\\/]|\\\\)/.test(typed) : /^[/~]/.test(typed);
  if (absolute || !t.cwd) return typed;
  return windows ? `${t.cwd.replace(/[\\/]+$/, '')}\\${typed}` : `${t.cwd.replace(/\/+$/, '')}/${typed}`;
}

// Uploads a file the app saved locally (a download, a scratchpad save) to the remote tab's
// folder. The local copy is removed once it's there.
async function uploadToRemote(t, localPath) {
  const name = path.basename(localPath);
  if (!t.cwd) throw new Error(`${t.remote.name}'s current folder isn't known`);
  const target = remotePathFor(t, name);
  await transferFile(t, 'send', localPath, target);
  fs.rm(path.dirname(localPath), { recursive: true, force: true }, () => {});
  return `${t.remote.name}:${target}`;
}

const validSource = (s) => s === 'local' || validRepoId(s);

ipcMain.handle('remotes:list', async (e) => {
  if (!fromUi(e)) return { entries: [], errors: [] };
  const { entries, errors } = await listRemotes();
  return {
    entries, errors,
    onePasswordAgent: Boolean(remotes.onePasswordAgentSocket()),
    onePasswordKeys: usesOnePasswordKeys(),
    canSavePasswords: safeStorage.isEncryptionAvailable(),
  };
});

ipcMain.handle('remotes:save', async (e, req) => {
  if (!fromUi(e) || !validSource(req?.source)) return { error: 'bad request' };
  const remote = remotes.cleanRemote(req.remote);
  const problem = remotes.remoteProblem(remote);
  if (problem) return { error: `This remote ${problem}.` };
  const password = typeof req.password === 'string' ? req.password : null;
  try {
    let id;
    if (req.source === 'local') {
      const list = readLocalRemotes();
      const key = req.file && list.some((r) => r.key === req.file) ? req.file
        : `${remotes.slug(remote.name)}-${Date.now().toString(36)}`;
      const next = list.filter((r) => r.key !== key);
      next.push({ key, ...remote });
      writeLocalRemotes(next);
      id = `local:${key}`;
    } else {
      if (req.file != null && (!validTeamFile(req.file) || typeof req.base !== 'string')) return { error: 'bad request' };
      const result = await repoQueued(req.source, (repo) => repoChange(repo, {
        file: req.file ?? null, base: req.base, folder: REMOTES_FOLDER,
        label: `${req.file ? 'Update' : 'Add'} remote: ${remote.name}`,
        apply: async () => {
          const target = req.file ?? newSnippetFile(repo, remote.name, REMOTES_FOLDER);
          await fs.promises.mkdir(path.join(repoDir(repo), REMOTES_FOLDER), { recursive: true });
          await fs.promises.writeFile(snippetPath(repo, target, REMOTES_FOLDER), remotes.remoteMarkdown(remote));
          await git(['add', '--', `${REMOTES_FOLDER}/${target}`], repoDir(repo));
          return target;
        },
      }));
      if (result.error || result.conflict) return result;
      id = `repo:${req.source}:${result.file}`;
    }
    // A password is only kept for "Saved on each machine", and only here.
    if (remote.signIn === 'saved' && password) savePassword(id, password);
    else if (remote.signIn !== 'saved') savePassword(id, '');
    settings.lastRemoteSource = req.source;
    saveSettings();
    return { id };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('remotes:delete', async (e, req) => {
  if (!fromUi(e) || !validSource(req?.source) || typeof req.file !== 'string') return { error: 'bad request' };
  try {
    if (req.source === 'local') {
      writeLocalRemotes(readLocalRemotes().filter((r) => r.key !== req.file));
      savePassword(`local:${req.file}`, '');
      return {};
    }
    if (!validTeamFile(req.file) || typeof req.base !== 'string') return { error: 'bad request' };
    const name = typeof req.name === 'string' ? req.name.slice(0, 80) : req.file;
    const result = await repoQueued(req.source, (repo) => repoChange(repo, {
      file: req.file, base: req.base, folder: REMOTES_FOLDER, label: `Delete remote: ${name}`,
      apply: async () => {
        await git(['rm', '--quiet', '--', `${REMOTES_FOLDER}/${req.file}`], repoDir(repo));
        return req.file;
      },
    }));
    if (!result.error && !result.conflict) savePassword(`repo:${req.source}:${req.file}`, '');
    return result;
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('remotes:test', async (e, req) => {
  if (!fromUi(e)) return { ok: false, message: 'bad request' };
  const remote = remotes.cleanRemote(req?.remote);
  const problem = remotes.remoteProblem(remote);
  if (problem) return { ok: false, message: `This remote ${problem}.` };
  // An unchanged saved password isn't sent back to the UI, so a test of a saved remote uses it here.
  const id = typeof req.id === 'string' ? req.id : '';
  return testRemote({ ...remote, id }, typeof req.password === 'string' ? req.password : '');
});

// Logins in 1Password, as references for the form. Titles and vaults only: nothing secret.
ipcMain.handle('remotes:op-items', async (e) => {
  if (!fromUi(e)) return { items: [] };
  try {
    const items = JSON.parse(await run('op', ['item', 'list', '--categories', 'Login,Password,Server', '--format', 'json'], { timeout: 60000 }));
    const plain = (s) => /^[\w .-]+$/.test(s);
    return {
      items: items.map((i) => ({
        title: i.title, vault: i.vault?.name ?? '',
        // Names read better; ids work whatever the names contain.
        ref: plain(i.title) && plain(i.vault?.name ?? '') ? `op://${i.vault.name}/${i.title}/password` : `op://${i.vault?.id}/${i.id}/password`,
      })).sort((a, b) => a.title.localeCompare(b.title)),
    };
  } catch (err) {
    return { items: [], error: /isn't installed/.test(err.message)
      ? 'The 1Password CLI (op) isn\'t installed. Install it and turn on "Integrate with 1Password CLI" in 1Password\'s settings.'
      : err.message };
  }
});

// Leaves a WinRM session running on the server, so it can be picked up later. The tab's shell is
// inside the session, so it leaves that first.
ipcMain.on('pty:disconnect', (e, id) => {
  const t = terminals.get(id);
  if (!fromUi(e) || !t?.remote || t.exited) return;
  if (t.remote.transport === 'winrm' && t.keepFile) {
    fs.writeFileSync(t.keepFile, '');
    t.pty.write('exit\r');
  } else {
    t.pty.kill();
  }
});

ipcMain.handle('remote:transfer', async (e, { id, direction, remotePath }) => {
  const t = terminals.get(id);
  if (!fromUi(e) || !t?.remote || t.exited || !['send', 'get'].includes(direction)) return { error: 'bad request' };
  try {
    if (direction === 'send') {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: `Send a file to ${t.remote.name}`, properties: ['openFile'] });
      if (canceled || !filePaths[0]) return {};
      if (!t.cwd) return { error: `${t.remote.name}'s current folder isn't known yet.` };
      const target = remotePathFor(t, path.basename(filePaths[0]));
      await transferFile(t, 'send', filePaths[0], target);
      return { done: `Sent to ${t.remote.name}:${target}` };
    }
    if (typeof remotePath !== 'string' || !remotePath.trim() || /[\x00-\x1f]/.test(remotePath)) return { error: 'bad request' };
    const source = remotePathFor(t, remotePath.trim());
    const name = source.split(/[\\/]/).pop() || 'file';
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: `Save ${name} from ${t.remote.name}`, defaultPath: path.join(app.getPath('downloads'), name),
    });
    if (canceled || !filePath) return {};
    await transferFile(t, 'get', filePath, source);
    return { done: `Saved ${name} to ${filePath}` };
  } catch (err) {
    return { error: err.message };
  }
});

// Running in a PROD tab asks first (ADR 0008).
ipcMain.handle('remote:confirm-run', async (e, { name, command }) => {
  if (!fromUi(e) || typeof name !== 'string' || typeof command !== 'string') return false;
  const lines = command.split('\n');
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', message: `Run on ${name}? It's tagged PROD.`,
    detail: lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n… and ${lines.length - 8} more lines` : ''),
    buttons: ['Run', 'Cancel'], defaultId: 1, cancelId: 1,
  });
  return response === 0;
});

// --- Airlock history: local only, private, and trimmed each time the app starts --------------

const HISTORY_LIMIT = 500;
const PRIVATE_FILE = { mode: 0o600 };

function maintainHistory() {
  const file = dataFile('history.jsonl');
  try {
    fs.chmodSync(file, 0o600); // files from older versions were readable by other users
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > HISTORY_LIMIT) writeFileAtomic(file, `${lines.slice(-HISTORY_LIMIT).join('\n')}\n`, PRIVATE_FILE);
  } catch {} // no history yet
}

ipcMain.handle('history:list', (e) => {
  if (!fromUi(e)) return [];
  try {
    return fs.readFileSync(dataFile('history.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-HISTORY_LIMIT)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
});
ipcMain.on('history:add', (e, command) => {
  if (!fromUi(e) || typeof command !== 'string' || !command.trim()) return;
  const entry = { ts: new Date().toISOString(), shell: activeTerminal()?.shell.id ?? '', command };
  fs.appendFile(dataFile('history.jsonl'), `${JSON.stringify(entry)}\n`, PRIVATE_FILE, () => {});
});

// --- Runsheet: a script to read or edit in the right pane -------------------------------------
// The UI only ever names a file from the listing of the folder the user chose.

const DISCARD_EDITS = {
  type: 'warning', message: 'Discard your changes to this file?', buttons: ['Discard', 'Keep Editing'], defaultId: 1, cancelId: 1,
};
const confirmDiscardEdits = async () => (await dialog.showMessageBox(win, DISCARD_EDITS)).response === 0;
const RUNSHEET_MAX_BYTES = 2 * 1024 * 1024;
const RUNSHEET_MAX_FILES = 1000;
const RUNSHEET_MAX_DEPTH = 4;
const RUNSHEET_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.ksh', '.command', '.ps1', '.psm1', '.psd1', '.py', '.rb',
  '.js', '.mjs', '.ts', '.json', '.yml', '.yaml', '.sql', '.md', '.markdown', '.txt', '.ini', '.toml']);

// Paths relative to the folder, using / on every OS, sorted. Hidden folders and node_modules are skipped.
async function listRunsheets(folder) {
  const found = [];
  const walk = async (dir, prefix, depth) => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (found.length >= RUNSHEET_MAX_FILES || entry.name.startsWith('.')) continue;
      if (entry.isFile() && RUNSHEET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(`${prefix}${entry.name}`);
      else if (entry.isDirectory() && entry.name !== 'node_modules' && depth < RUNSHEET_MAX_DEPTH) {
        try { await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1); } catch {} // unreadable subfolder
      }
    }
  };
  await walk(folder, '', 1);
  return found.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}

// PowerShell scripts are often UTF-16, so go by the byte order mark before assuming UTF-8.
function textEncoding(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}
const decodeText = (bytes) => new TextDecoder(textEncoding(bytes)).decode(bytes);

// Bytes that don't decode (a Windows-1252 file, say) would be lost by saving the decoded text.
function decodesCleanly(bytes) {
  try {
    new TextDecoder(textEncoding(bytes), { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// The new text in the same encoding, byte order mark and line endings as the file it replaces.
function encodeLike(originalBytes, text) {
  const original = decodeText(originalBytes);
  const crlf = original.match(/\r\n/g)?.length ?? 0;
  const lf = (original.match(/\n/g)?.length ?? 0) - crlf;
  const body = crlf > lf ? text.replace(/\n/g, '\r\n') : text;
  const encoding = textEncoding(originalBytes);
  if (encoding === 'utf-8') {
    const hasBom = originalBytes[0] === 0xef && originalBytes[1] === 0xbb && originalBytes[2] === 0xbf;
    return Buffer.from(`${hasBom ? '\ufeff' : ''}${body}`, 'utf8');
  }
  const encoded = Buffer.from(`\ufeff${body}`, 'utf16le');
  return encoding === 'utf-16be' ? encoded.swap16() : encoded;
}

function readRunsheet(file) {
  const name = path.basename(file);
  try {
    if (fs.statSync(file).size > RUNSHEET_MAX_BYTES) return { path: file, name, error: 'it is larger than 2 MB' };
    const bytes = fs.readFileSync(file);
    const text = decodeText(bytes);
    if (text.includes('\0')) return { path: file, name, error: "it doesn't look like a text file" };
    return { path: file, name, text, editable: decodesCleanly(bytes), baseUrl: pathToFileURL(path.dirname(file) + path.sep).href };
  } catch (err) {
    return { path: file, name, error: err.code === 'ENOENT' ? 'the file no longer exists' : err.message };
  }
}

const relativeToFolder = (file) => path.relative(settings.runsheetFolder ?? '', file).split(path.sep).join('/');
const withRelativePath = (sheet) => ({ ...sheet, relative: relativeToFolder(sheet.path) });

ipcMain.handle('runsheet:read', (e) => (fromUi(e) && settings.runsheetPath ? withRelativePath(readRunsheet(settings.runsheetPath)) : null));
ipcMain.handle('runsheet:list', async (e) => {
  const folder = settings.runsheetFolder;
  if (!fromUi(e) || !folder) return { folder: '', files: [] };
  try {
    const files = await listRunsheets(folder);
    return { folder, files, truncated: files.length >= RUNSHEET_MAX_FILES };
  } catch (err) {
    return { folder, files: [], error: err.code === 'ENOENT' ? 'this folder no longer exists' : err.message };
  }
});
ipcMain.handle('runsheet:choose-folder', async (e) => {
  if (!fromUi(e)) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Runsheet folder', properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  settings.runsheetFolder = filePaths[0];
  delete settings.runsheetPath;
  saveSettings();
  return { folder: filePaths[0] };
});
ipcMain.handle('runsheet:open', async (e, relative) => {
  const folder = settings.runsheetFolder;
  if (!fromUi(e) || !folder) return null;
  let files = [];
  try { files = await listRunsheets(folder); } catch {}
  if (!files.includes(relative)) return { name: String(relative), error: 'it is no longer in the folder' };
  const sheet = readRunsheet(path.join(folder, ...relative.split('/')));
  if (!sheet.error) { settings.runsheetPath = sheet.path; saveSettings(); }
  return { ...sheet, relative };
});
// `expected` is the text the edit started from, so a change made elsewhere since isn't overwritten
// without asking. Returns the file as saved, an error, or null if the user chose not to overwrite.
ipcMain.handle('runsheet:save', async (e, relative, text, expected) => {
  const folder = settings.runsheetFolder;
  if (!fromUi(e) || !folder || typeof text !== 'string') return null;
  const name = String(relative);
  let files = [];
  try { files = await listRunsheets(folder); } catch {}
  if (!files.includes(relative)) return { name, error: 'it is no longer in the folder' };
  const file = path.join(folder, ...relative.split('/'));
  try {
    const current = await fs.promises.readFile(file);
    if (!decodesCleanly(current)) return { name, error: "it isn't valid UTF-8 or UTF-16, so saving could damage it" };
    if (decodeText(current).replace(/\r\n?/g, '\n') !== expected) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', message: `${path.basename(file)} has changed on disk.`, detail: 'Saving replaces those changes with yours.',
        buttons: ['Overwrite', 'Cancel'], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) return null;
    }
    const encoded = encodeLike(current, text);
    if (encoded.length > RUNSHEET_MAX_BYTES) return { name, error: 'it would be larger than 2 MB' };
    await fs.promises.writeFile(file, encoded); // in place, which keeps its permissions and any links to it
  } catch (err) {
    return { name, error: err.code === 'ENOENT' ? 'the file no longer exists' : err.message };
  }
  return { ...readRunsheet(file), relative };
});
ipcMain.handle('runsheet:confirm-discard', async (e) => {
  if (!fromUi(e)) return false;
  return confirmDiscardEdits();
});

// --- Web tab: an ordinary browser for any site, so nothing it does is trusted (ADR 0005) -------

let web = null;
let webGesture = () => null;
let webVisible = false;
let webBounds = null;
const isWebUrl = (url) => /^https?:\/\//i.test(url);

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}
const autoRunSites = () => settings.webAutoRunSites ?? [];
const isAutoRunSite = (url) => autoRunSites().includes(originOf(url));

// Anything that isn't a web address is a search, so file: and javascript: can't be typed in.
function webTarget(input) {
  const text = input.trim();
  if (!text) return null;
  if (isWebUrl(text)) {
    try { return new URL(text).href; } catch {}
  }
  if (/^localhost(:\d+)?([/?#]|$)/i.test(text)) return `http://${text}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

function pushWebState() {
  if (!web) return;
  const { webContents: c } = web;
  const url = c.getURL();
  toUi('web:state', {
    url,
    title: c.getTitle(),
    canGoBack: c.navigationHistory.canGoBack(),
    canGoForward: c.navigationHistory.canGoForward(),
    loading: c.isLoading(),
    canAutoRun: url.startsWith('https://'),
    autoRun: isAutoRunSite(url),
  });
}

function ensureWeb() {
  if (web) return web;
  web = new WebContentsView({
    webPreferences: {
      partition: 'persist:web',
      preload: path.join(__dirname, 'chat-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const { webContents: c } = web;
  const ua = c.getUserAgent().replace(/ (Electron|airlock-terminal)\/\S+/g, '');
  c.session.setUserAgent(ua);
  c.setUserAgent(ua);
  // Only what copying and video need: no camera, microphone, location or notifications.
  const allowed = (permission) => permission === 'clipboard-sanitized-write' || permission === 'fullscreen';
  c.session.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
  c.session.setPermissionCheckHandler((_wc, permission) => allowed(permission));
  // Unlike chat downloads, these never land in the terminal's directory: any site can start one.
  c.session.on('will-download', (_e, item) => {
    const savePath = uniquePath(app.getPath('downloads'), item.getFilename());
    item.setSavePath(savePath);
    item.once('done', (_ev, state) => toUi('download:done', { state, savePath, displayPath: savePath }));
  });
  // One page at a time: links that open new windows stay in this tab.
  c.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) c.loadURL(url);
    return { action: 'deny' };
  });
  const webOnly = (e, url) => { if (!isWebUrl(url)) e.preventDefault(); };
  c.on('will-navigate', (e) => webOnly(e, e.url));
  c.on('will-redirect', (e) => webOnly(e, e.url));
  const remember = () => {
    const url = c.getURL();
    if (isWebUrl(url) && url !== settings.webUrl) { settings.webUrl = url; saveSettings(); }
    pushWebState();
  };
  c.on('did-navigate', remember);
  c.on('did-navigate-in-page', remember);
  for (const event of ['did-start-loading', 'did-stop-loading', 'page-title-updated']) c.on(event, pushWebState);
  c.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) toUi('web:error', `${url}: ${description}`); // -3 is a cancelled load
  });
  c.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'l' && (process.platform === 'darwin' ? input.meta : input.control) && !input.alt && !input.shift) {
      e.preventDefault();
      win.webContents.focus();
      toUi('web:focus-address');
    }
  });
  webGesture = trackCopyGestures(c);
  win.contentView.addChildView(web);
  if (webBounds) web.setBounds(webBounds);
  web.setVisible(webVisible);
  return web;
}

// Any site can reach the airlock, but only from a real press in its visible top frame: otherwise a
// page could quietly replace a command waiting there. Running needs the site turned on as well.
function receiveWebCopy(e, text) {
  const gesture = webGesture();
  if (gesture === null || !webVisible || e.senderFrame !== web.webContents.mainFrame) return;
  const autoRun = isAutoRunSite(e.senderFrame.url);
  win.webContents.send('airlock:fill', { text, gesture: autoRun ? `web:${gesture}` : null, autoRunOff: !autoRun });
}

ipcMain.on('web:bounds', (e, bounds) => {
  if (!fromUi(e)) return;
  webBounds = bounds;
  web?.setBounds(bounds);
});
ipcMain.on('web:visible', (e, visible) => {
  if (!fromUi(e)) return;
  webVisible = visible === true;
  // Nothing is loaded until the tab is first used.
  if (webVisible && !web && settings.webUrl) ensureWeb().webContents.loadURL(settings.webUrl);
  web?.setVisible(webVisible);
  pushWebState();
});
ipcMain.on('web:go', (e, input) => {
  const target = fromUi(e) && typeof input === 'string' ? webTarget(input) : null;
  if (target) ensureWeb().webContents.loadURL(target);
});
ipcMain.on('web:back', (e) => { if (fromUi(e)) web?.webContents.navigationHistory.goBack(); });
ipcMain.on('web:forward', (e) => { if (fromUi(e)) web?.webContents.navigationHistory.goForward(); });
ipcMain.on('web:reload', (e) => {
  if (!fromUi(e) || !web) return;
  if (web.webContents.isLoading()) web.webContents.stop();
  else web.webContents.reload();
});
ipcMain.on('web:external', (e) => {
  const url = web?.webContents.getURL();
  if (fromUi(e) && url && isWebUrl(url)) shell.openExternal(url);
});
// Applies to whichever https site is really showing; the UI doesn't get to name one.
ipcMain.handle('web:set-auto-run', (e, enabled) => {
  const url = web?.webContents.getURL();
  if (!fromUi(e) || !url?.startsWith('https://')) return autoRunSites();
  const origin = originOf(url);
  settings.webAutoRunSites = autoRunSites().filter((s) => s !== origin);
  if (enabled === true) settings.webAutoRunSites.push(origin);
  saveSettings();
  pushWebState();
  return settings.webAutoRunSites;
});
ipcMain.handle('web:remove-auto-run', (e, origin) => {
  if (!fromUi(e)) return autoRunSites();
  settings.webAutoRunSites = autoRunSites().filter((s) => s !== origin);
  saveSettings();
  pushWebState();
  return settings.webAutoRunSites;
});

// --- Saved terminal output: opt-in, because anything printed on screen ends up on disk -------

ipcMain.handle('scrollback:load', (e) => {
  if (!fromUi(e) || !settings.saveScrollback) return [];
  try {
    const { tabs } = JSON.parse(fs.readFileSync(dataFile('scrollback.json'), 'utf8'));
    return tabs.filter((t) => typeof t?.shellId === 'string' && typeof t?.data === 'string');
  } catch {
    return [];
  }
});
// Synchronous so the last save finishes during quit.
ipcMain.on('scrollback:save', (e, tabs) => {
  if (!fromUi(e) || !settings.saveScrollback || !Array.isArray(tabs)) return;
  try { writeFileAtomic(dataFile('scrollback.json'), JSON.stringify({ tabs }), PRIVATE_FILE); } catch {}
});

// --- Downloads from the chat land in the terminal's current directory -------------------

// A terminal's cwd as a path this (host) process can write to.
function hostCwd({ cwd, shell: shellEntry }) {
  if (shellEntry.kind === 'remote') return ''; // on another machine
  if (!cwd || shellEntry.kind !== 'wsl') return cwd;
  const mnt = cwd.match(/^\/mnt\/([a-z])(\/.*)?$/i);
  if (mnt) return `${mnt[1].toUpperCase()}:${(mnt[2] || '/').replace(/\//g, '\\')}`;
  return `\\\\wsl.localhost\\${shellEntry.distro}${cwd.replace(/\//g, '\\')}`;
}

function uniquePath(dir, filename) {
  const { name, ext } = path.parse(filename);
  let candidate = path.join(dir, filename);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${name} (${i})${ext}`);
  return candidate;
}

// Where a new file goes: the active terminal's cwd if it's known and exists, else Downloads.
// Captured up front so a slow download still reports the right path after a tab switch. For a
// remote tab, a temporary folder here, and the file is then copied to the tab's folder on the
// server (ADR 0008).
function saveTarget() {
  const t = activeTerminal();
  if (t?.remote && !t.exited && t.cwd) {
    return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'airlock-')), shown: (p) => p, remote: t };
  }
  let dir = t ? hostCwd(t) : '';
  try { if (!dir || !fs.statSync(dir).isDirectory()) dir = ''; } catch { dir = ''; }
  return {
    dir: dir || app.getPath('downloads'),
    // A saved path as the shell would write it, when it's inside the cwd.
    shown: (savePath) => (dir ? savePath.replace(dir, () => t.cwd).replace(/\\/g, t.shell.kind === 'wsl' ? '/' : '\\') : savePath),
  };
}

function handleDownloads() {
  session.fromPartition('persist:chat').on('will-download', (_e, item) => {
    const target = saveTarget();
    const savePath = uniquePath(target.dir, item.getFilename());
    item.setSavePath(savePath);
    item.once('done', async (_ev, state) => {
      // Windows' "downloaded from the internet" marker is an NTFS stream; on a WSL filesystem
      // it shows up as a stray "<file>:Zone.Identifier" file instead, so drop it there.
      if (savePath.startsWith('\\\\wsl')) fs.rm(`${savePath}:Zone.Identifier`, { force: true }, () => {});
      if (state === 'completed' && target.remote) {
        toUi('download:done', await finishRemoteSave(target.remote, savePath));
        return;
      }
      toUi('download:done', { state, savePath, displayPath: target.shown(savePath) });
    });
  });
}

// A file saved for a remote tab goes on to the server; if that fails it's kept in Downloads.
async function finishRemoteSave(t, savePath) {
  try {
    return { state: 'completed', savePath, displayPath: await uploadToRemote(t, savePath) };
  } catch (err) {
    const kept = uniquePath(app.getPath('downloads'), path.basename(savePath));
    try { fs.renameSync(savePath, kept); } catch { fs.copyFileSync(savePath, kept); }
    return { state: `copied to Downloads, not ${t.remote.name} (${err.message})`, savePath: kept, displayPath: kept };
  }
}

// --- Scratchpad: panes kept between sessions ----------------------------------------------

ipcMain.handle('scratch:load', (e) => {
  const empty = { a: '', b: '', split: false };
  if (!fromUi(e)) return empty;
  try {
    const { a, b, split } = JSON.parse(fs.readFileSync(dataFile('scratchpad.json'), 'utf8'));
    return { a: typeof a === 'string' ? a : '', b: typeof b === 'string' ? b : '', split: split === true };
  } catch {
    return empty;
  }
});
// Synchronous so the last save finishes during quit. Readable only by this user because pasted
// text may include secrets.
ipcMain.on('scratch:state', (e, { a, b, split }) => {
  if (!fromUi(e) || typeof a !== 'string' || typeof b !== 'string') return;
  try {
    writeFileAtomic(dataFile('scratchpad.json'), JSON.stringify({ a, b, split: split === true }), PRIVATE_FILE);
  } catch {}
});

// --- Scratchpad: save as a text file, in the same place downloads go ---------------------

ipcMain.handle('scratch:save', async (e, file) => {
  if (!fromUi(e) || typeof file?.name !== 'string' || typeof file?.text !== 'string') return { error: 'bad request' };
  let name = file.name.trim();
  // A file name, not a path: nothing here can write outside the directory.
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(name)) {
    return { error: `"${name}" isn't a valid file name` };
  }
  if (!path.extname(name)) name += '.txt';
  const target = saveTarget();
  const savePath = uniquePath(target.dir, name);
  try {
    await fs.promises.writeFile(savePath, file.text, { flag: 'wx' }); // never overwrite
  } catch (err) {
    return { error: err.message };
  }
  if (target.remote) {
    const done = await finishRemoteSave(target.remote, savePath);
    return done.state === 'completed' ? { displayPath: done.displayPath } : { error: `Saved to ${done.displayPath}: ${done.state}` };
  }
  return { displayPath: target.shown(savePath) };
});

// No default menu: its zoom accelerators would zoom the whole window instead of the terminal.
// macOS still needs the app and Edit menus for Cmd+Q / Cmd+C / Cmd+V to work. The Window menu
// leaves out Close because Cmd+W closes the terminal tab.
Menu.setApplicationMenu(process.platform === 'darwin'
  ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, {
    label: 'Window', role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
  }])
  : null);

// One copy at a time: a second copy can't use the chat profile the first one has locked, so the
// chat breaks. Launching again brings the open window forward instead.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  // Packaged builds get their icon from the app bundle.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(APP_ICON);
  loadSettings();
  removeStaleClones();
  applyThemeSource();
  maintainHistory();
  handleDownloads();
  createWindow();
});
app.on('window-all-closed', () => {
  for (const t of terminals.values()) t.pty.kill();
  app.quit();
});
