// Bridge between the local UI renderer and the main process. Only these calls are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airlock', {
  setChatBounds: (rect) => ipcRenderer.send('chat:bounds', rect),
  setChatVisible: (visible) => ipcRenderer.send('chat:visible', visible),
  onFill: (cb) => ipcRenderer.on('airlock:fill', (_e, text) => cb(text)),

  ptyStart: (size) => ipcRenderer.send('pty:start', size),
  ptyInput: (data) => ipcRenderer.send('pty:input', data),
  ptyResize: (size) => ipcRenderer.send('pty:resize', size),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, data) => cb(data)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, code) => cb(code)),
});
