// Bridge between the local UI renderer and the main process. Only these calls are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airlock', {
  platform: process.platform,
  setChatBounds: (rect) => ipcRenderer.send('chat:bounds', rect),
  setChatVisible: (visible) => ipcRenderer.send('chat:visible', visible),
  onFill: (cb) => ipcRenderer.on('airlock:fill', (_e, text) => cb(text)),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  listShells: () => ipcRenderer.invoke('shells:list'),
  ptyStart: (opts) => ipcRenderer.send('pty:start', opts),
  ptyInput: (data) => ipcRenderer.send('pty:input', data),
  ptyResize: (size) => ipcRenderer.send('pty:resize', size),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, data) => cb(data)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, code) => cb(code)),
  reportCwd: (cwd) => ipcRenderer.send('pty:cwd', cwd),
  onDownloadDone: (cb) => ipcRenderer.on('download:done', (_e, info) => cb(info)),
  listSnippets: () => ipcRenderer.invoke('snippets:list'),
  saveSnippets: (list) => ipcRenderer.invoke('snippets:save', list),
  listHistory: () => ipcRenderer.invoke('history:list'),
  addHistory: (command) => ipcRenderer.send('history:add', command),
  awsProfiles: () => ipcRenderer.invoke('aws:profiles'),
  awsCommand: (name) => ipcRenderer.invoke('aws:command', name),
});
