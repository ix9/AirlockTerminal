const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, WebContentsView, ipcMain, shell } = require('electron');
const pty = require('node-pty');

const CHAT_URL = 'https://claude.ai/';

let win;
let chat;
let term;

function defaultShell() {
  if (process.platform !== 'win32') return { file: process.env.SHELL || '/bin/bash', args: [] };
  try {
    execFileSync('where.exe', ['pwsh'], { stdio: 'ignore' });
    return { file: 'pwsh.exe', args: ['-NoLogo'] };
  } catch {
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
}

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

ipcMain.on('pty:start', (e, { cols, rows }) => {
  if (!fromUi(e)) return;
  term?.kill();
  const { file, args } = defaultShell();
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
