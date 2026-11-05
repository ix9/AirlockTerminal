// Bridge between the local UI renderer and the main process. Only these calls are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airlock', {
  setChatBounds: (rect) => ipcRenderer.send('chat:bounds', rect),
  setChatVisible: (visible) => ipcRenderer.send('chat:visible', visible),
});
