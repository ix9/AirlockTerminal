const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, WebContentsView, ipcMain, shell } = require('electron');
const pty = require('node-pty');

const CHAT_URL = 'https://claude.ai/';

let win;
let chat;
let term;

// Shells offered in the toolbar. The UI only ever sends back an id from this list.
function listShells() {
  const shells = [];
  if (process.platform === 'win32') {
    try {
      execFileSync('where.exe', ['pwsh'], { stdio: 'ignore' });
      shells.push({ id: 'pwsh', label: 'PowerShell 7', file: 'pwsh.exe', args: ['-NoLogo'] });
    } catch {}
    shells.push({ id: 'powershell', label: 'Windows PowerShell', file: 'powershell.exe', args: ['-NoLogo'] });
    try {
      // `wsl -l -q` prints UTF-16LE. Docker's internal distros aren't for interactive use.
      const out = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'utf16le', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const name of out.split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim())) {
        if (name && !name.startsWith('docker-desktop'))
          shells.push({ id: `wsl:${name}`, label: `WSL: ${name}`, file: 'wsl.exe', args: ['-d', name, '--cd', '~'] });
      }
    } catch {}
  } else {
    const fs = require('node:fs');
    const paths = new Set([process.env.SHELL || '/bin/bash']);
    try {
      for (const line of fs.readFileSync('/etc/shells', 'utf8').split('\n'))
        if (line.startsWith('/') && fs.existsSync(line.trim())) paths.add(line.trim());
    } catch {}
    for (const p of paths) shells.push({ id: p, label: p, file: p, args: ['-l'] });
  }
  return shells;
}
const shells = listShells();

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    title: 'Airlock Terminal',
    backgroundColor: '#0c0c0c',
    autoHideMenuBar: true,
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
  const { file, args } = shells.find((s) => s.id === shellId) ?? shells[0];
  const p = pty.spawn(file, args, {
    name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: process.env,
  });
  p.onData((data) => win.webContents.send('pty:data', data));
  p.onExit(({ exitCode }) => { if (term === p) win.webContents.send('pty:exit', exitCode); });
  term = p;
});
ipcMain.on('pty:input', (e, data) => { if (fromUi(e)) term?.write(data); });
ipcMain.on('pty:resize', (e, { cols, rows }) => { if (fromUi(e)) term?.resize(cols, rows); });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { term?.kill(); app.quit(); });
