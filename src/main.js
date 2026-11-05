const path = require('node:path');
const { app, BrowserWindow, WebContentsView, ipcMain, shell } = require('electron');

const CHAT_URL = 'https://claude.ai/';

let win;
let chat;

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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
