const $ = (id) => document.getElementById(id);
const root = document.documentElement.style;

// --- Chat view follows its placeholder -------------------------------------------------

const chatSlot = $('chat');
function syncChatBounds() {
  const r = chatSlot.getBoundingClientRect();
  window.airlock.setChatBounds({
    x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
  });
}
new ResizeObserver(syncChatBounds).observe(chatSlot);

// --- Dividers ---------------------------------------------------------------------------

function makeSplitter(el, onMove) {
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    window.airlock.setChatVisible(false);
    const move = (ev) => onMove(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.classList.remove('dragging');
      window.airlock.setChatVisible(true);
      syncChatBounds();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
  });
}

makeSplitter($('vsplit'), (e) => {
  const min = 200;
  const x = Math.min(Math.max(e.clientX, min), window.innerWidth - min);
  root.setProperty('--left-width', `${x}px`);
});

makeSplitter($('hsplit'), (e) => {
  const h = Math.min(Math.max(window.innerHeight - e.clientY, 80), window.innerHeight - 100);
  root.setProperty('--airlock-height', `${h}px`);
});
