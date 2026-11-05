const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, shell } = require('electron');
const pty = require('node-pty');

const CHAT_URL = 'https://claude.ai/';
const TITLEBAR_HEIGHT = 35; // keep in sync with --titlebar-height in style.css

let win;
let chat;
let term;
let currentShell;

// --- Shells ---------------------------------------------------------------------------------
// Each shell is launched with the integration script for its kind (ADR 0002). The UI only
// ever sends back an id from this list.

const INTEGRATION_DIR = path.join(__dirname, 'shell-integration');

function listShells() {
  const shells = [];
  if (process.platform === 'win32') {
    const ps1 = path.join(INTEGRATION_DIR, 'airlock.ps1').replace(/'/g, "''");
    const psArgs = ['-NoLogo', '-NoExit', '-Command', `. '${ps1}'`];
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
    for (const p of paths) shells.push({ id: p, label: p, kind: 'unix', file: p });
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
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    title: 'Airlock Terminal',
    backgroundColor: '#181818',
    // VS Code-style: our own title bar; the OS draws only the window buttons over it.
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin' && {
      titleBarOverlay: { color: '#181818', symbolColor: '#cccccc', height: TITLEBAR_HEIGHT },
    }),
    trafficLightPosition: { x: 12, y: 10 },
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.maximize();
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
  const ua = chat.webContents.getUserAgent().replace(/ (Electron|airlock-terminal)\/\S+/g, '');
  chat.webContents.setUserAgent(ua);
  // Links that open new windows go to the system browser.
  chat.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.contentView.addChildView(chat);
  chat.webContents.loadURL(CHAT_URL);
}

// The UI renderer reports where the chat placeholder is; the view follows it.
ipcMain.on('chat:bounds', (_e, r) => chat?.setBounds(r));
// Hidden while a divider is dragged, so the native view doesn't steal the mouse.
ipcMain.on('chat:visible', (_e, visible) => chat?.setVisible(visible));

// Links clicked in the terminal open in the system browser (web URLs only).
ipcMain.on('open-external', (e, url) => {
  if (fromUi(e) && typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

// Copies made in the chat go to the airlock, but only from claude.ai itself.
ipcMain.on('chat:copied', (e, text) => {
  if (e.sender !== chat?.webContents || typeof text !== 'string') return;
  if (new URL(e.senderFrame.url).host !== 'claude.ai') return;
  win.webContents.send('airlock:fill', text);
});

// --- Terminal: node-pty lives here; the UI's xterm.js talks to it over IPC ---------------

const fromUi = (e) => e.sender === win?.webContents;

ipcMain.handle('shells:list', (e) => (fromUi(e) ? shells.map(({ id, label }) => ({ id, label })) : []));

ipcMain.on('pty:start', (e, { cols, rows, shellId }) => {
  if (!fromUi(e)) return;
  term?.kill();
  currentShell = shells.find((s) => s.id === shellId) ?? shells[0];
  const { file, args, env } = launchSpec(currentShell);
  const p = pty.spawn(file, args, {
    name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: { ...process.env, ...env },
  });
  p.onData((data) => win.webContents.send('pty:data', data));
  p.onExit(({ exitCode }) => { if (term === p) win.webContents.send('pty:exit', exitCode); });
  term = p;
});
ipcMain.on('pty:input', (e, data) => { if (fromUi(e)) term?.write(data); });
ipcMain.on('pty:resize', (e, { cols, rows }) => { if (fromUi(e)) term?.resize(cols, rows); });
// --- AWS profiles -------------------------------------------------------------------------

// Profile names from the config file the current shell would use.
function readAwsConfig() {
  try {
    if (currentShell?.kind === 'wsl') {
      return execFileSync('wsl.exe', ['-d', currentShell.distro, '--exec', 'sh', '-c',
        'cat "${AWS_CONFIG_FILE:-$HOME/.aws/config}"'], { encoding: 'utf8', timeout: 10000 });
    }
    return fs.readFileSync(process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config'), 'utf8');
  } catch {
    return '';
  }
}

function awsProfiles() {
  const names = [];
  for (const line of readAwsConfig().split(/\r?\n/)) {
    const m = line.match(/^\s*\[\s*(?:profile\s+)?([^\]]+?)\s*\]/);
    // [sso-session x] and [services x] sections aren't profiles.
    if (m && !/^(sso-session|services)\s/.test(m[1])) names.push(m[1]);
  }
  return [...new Set(names)];
}

const quote = (s) => `'${s.replace(/'/g, currentShell?.kind === 'pwsh' ? "''" : "'\\''")}'`;

ipcMain.handle('aws:profiles', (e) => (fromUi(e) ? awsProfiles() : []));
// The command that selects a profile in the current shell; the UI sends it to the terminal.
ipcMain.handle('aws:command', (e, name) => {
  if (!fromUi(e) || !awsProfiles().includes(name)) return '';
  return currentShell?.kind === 'pwsh' ? `$env:AWS_PROFILE = ${quote(name)}` : `export AWS_PROFILE=${quote(name)}`;
});

// Latest working directory reported by the shell integration, as the shell sees it.
let termCwd = '';
ipcMain.on('pty:cwd', (e, cwd) => { if (fromUi(e) && typeof cwd === 'string') termCwd = cwd; });

// No default menu: its zoom accelerators would zoom the whole window instead of the terminal.
// macOS still needs the app and Edit menus for Cmd+Q / Cmd+C / Cmd+V to work.
Menu.setApplicationMenu(process.platform === 'darwin'
  ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
  : null);

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { term?.kill(); app.quit(); });
