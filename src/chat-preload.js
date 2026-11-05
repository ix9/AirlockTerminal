// Preload for the chat pane. Forwards anything copied in the page to the airlock.
// The page's own copy still happens; we only observe it (see ADR 0001).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__airlockCopied', (text) => ipcRenderer.send('chat:copied', String(text)));

// Runs in the page's world, synchronously, before any page script.
contextBridge.executeInMainWorld({
  func: () => {
    const send = (t) => { if (typeof t === 'string' && t.trim()) window.__airlockCopied(t); };
    const cb = navigator.clipboard;
    if (cb?.writeText) {
      const orig = cb.writeText.bind(cb);
      cb.writeText = (t) => { send(String(t)); return orig(t); };
    }
    if (cb?.write) {
      const orig = cb.write.bind(cb);
      cb.write = async (items) => {
        try {
          for (const item of items)
            if (item.types.includes('text/plain')) send(await (await item.getType('text/plain')).text());
        } catch {}
        return orig(items);
      };
    }
    // Ctrl+C / Cmd+C on a selection (including inside text fields).
    document.addEventListener('copy', () => {
      let t = '';
      const el = document.activeElement;
      try {
        // Text fields keep their selection separately (some types, e.g. email, don't expose it).
        if (el && typeof el.value === 'string' && el.selectionStart != null)
          t = el.value.substring(el.selectionStart, el.selectionEnd);
      } catch {}
      send(t || String(document.getSelection()));
    }, true);
  },
});
