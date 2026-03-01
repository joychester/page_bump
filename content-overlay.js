// content-overlay.js — Page Bump floating overlay injector
// Runs as a content script on http/https pages.
// Creates a draggable iframe overlay hosting popup.html.

const POPUP_URL   = chrome.runtime.getURL('popup.html');
const KEY_POS     = 'pbPos';
const KEY_VISIBLE = 'pbVisible';
const KEY_COLLAPSED = 'pbCollapsed';
const KEY_THEME   = 'pbTheme';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const data = await chrome.storage.local.get([KEY_VISIBLE, KEY_COLLAPSED, KEY_THEME]);
  const visible   = data[KEY_VISIBLE]   ?? true;   // show by default
  const collapsed = data[KEY_COLLAPSED] ?? false;
  const theme     = data[KEY_THEME]     ?? 'dark';

  if (visible) createOverlay(collapsed, theme);

  // Extension icon click → toggle overlay
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type !== 'TOGGLE_OVERLAY') return;
    const existing = getRoot();
    if (existing) {
      removeOverlay();
      chrome.storage.local.set({ [KEY_VISIBLE]: false });
    } else {
      chrome.storage.local.get([KEY_COLLAPSED, KEY_THEME]).then(d => {
        createOverlay(d[KEY_COLLAPSED] ?? false, d[KEY_THEME] ?? 'dark');
        chrome.storage.local.set({ [KEY_VISIBLE]: true });
      });
    }
  });

  // Sync drag-bar theme when user toggles inside the iframe
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY_THEME]) return;
    const root = getRoot();
    if (root) applyTheme(root, changes[KEY_THEME].newValue);
  });
}

// ---------------------------------------------------------------------------
// Create / remove overlay
// ---------------------------------------------------------------------------

function createOverlay(collapsed, theme) {
  if (getRoot()) return; // already exists

  // ---- Root container ----
  const root = document.createElement('div');
  root.id = 'pb-overlay-root';
  applyTheme(root, theme);

  // ---- Drag bar ----
  const bar = document.createElement('div');
  bar.className = 'pb-drag-bar';
  bar.innerHTML = `
    <span class="pb-drag-title">⚡ Page Bump</span>
    <div class="pb-drag-btns">
      <button class="pb-drag-btn" id="pb-btn-collapse" title="Collapse panel">▼</button>
      <button class="pb-drag-btn" id="pb-btn-hide"     title="Hide panel">✕</button>
    </div>`;

  // ---- iframe wrapper ----
  const frameWrap = document.createElement('div');
  frameWrap.className = 'pb-frame-wrap' + (collapsed ? ' pb-collapsed' : '');

  const iframe = document.createElement('iframe');
  iframe.src   = POPUP_URL;
  iframe.title = 'Page Bump panel';
  frameWrap.appendChild(iframe);

  root.appendChild(bar);
  root.appendChild(frameWrap);

  // Attach to page — use documentElement so it survives body replacements
  (document.body || document.documentElement).appendChild(root);

  // Restore saved position (async — visually instant after load)
  restorePosition(root);

  // Wire up drag
  makeDraggable(root, bar);

  // Collapse button
  root.querySelector('#pb-btn-collapse').addEventListener('click', e => {
    e.stopPropagation();
    toggleCollapse(root, frameWrap, e.currentTarget);
  });

  // Hide button
  root.querySelector('#pb-btn-hide').addEventListener('click', e => {
    e.stopPropagation();
    removeOverlay();
    chrome.storage.local.set({ [KEY_VISIBLE]: false });
  });

  // Set correct collapse button label
  updateCollapseBtn(root.querySelector('#pb-btn-collapse'), collapsed);
}

function removeOverlay() {
  getRoot()?.remove();
}

function getRoot() {
  return document.getElementById('pb-overlay-root');
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme(root, theme) {
  root.classList.toggle('pb-light', theme === 'light');
}

// ---------------------------------------------------------------------------
// Collapse / expand
// ---------------------------------------------------------------------------

function toggleCollapse(root, frameWrap, btn) {
  const nowCollapsed = frameWrap.classList.toggle('pb-collapsed');
  updateCollapseBtn(btn, nowCollapsed);
  chrome.storage.local.set({ [KEY_COLLAPSED]: nowCollapsed });
}

function updateCollapseBtn(btn, collapsed) {
  btn.textContent = collapsed ? '▲' : '▼';
  btn.title = collapsed ? 'Expand panel' : 'Collapse panel';
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

function makeDraggable(root, handle) {
  let startMouseX, startMouseY, startLeft, startTop;

  handle.addEventListener('mousedown', e => {
    // Ignore clicks on the buttons inside the bar
    if (e.target.closest('.pb-drag-btn')) return;
    e.preventDefault();

    const rect = root.getBoundingClientRect();
    startMouseX = e.clientX;
    startMouseY = e.clientY;
    startLeft   = rect.left;
    startTop    = rect.top;

    // Switch from CSS right:16px default to explicit left/top.
    // Must use setProperty('important') to override overlay.css !important rules.
    root.style.setProperty('left',  startLeft + 'px', 'important');
    root.style.setProperty('top',   startTop  + 'px', 'important');
    root.style.setProperty('right', 'auto',            'important');

    root.classList.add('pb-dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  function onMove(e) {
    const dx = e.clientX - startMouseX;
    const dy = e.clientY - startMouseY;

    let newLeft = startLeft + dx;
    let newTop  = startTop  + dy;

    // Clamp: keep at least the drag bar visible
    const minVisible = handle.offsetHeight || 36;
    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth  - root.offsetWidth));
    newTop  = Math.max(0, Math.min(newTop,  window.innerHeight - minVisible));

    root.style.setProperty('left', newLeft + 'px', 'important');
    root.style.setProperty('top',  newTop  + 'px', 'important');
  }

  function onUp() {
    root.classList.remove('pb-dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);

    // Persist final position
    chrome.storage.local.set({
      [KEY_POS]: {
        left: parseInt(root.style.left, 10),
        top:  parseInt(root.style.top,  10),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Position persistence
// ---------------------------------------------------------------------------

function restorePosition(root) {
  chrome.storage.local.get(KEY_POS).then(data => {
    const pos = data[KEY_POS];
    if (!pos) return; // use CSS default (top: 16px, right: 16px)

    // Clamp saved position to current viewport in case window was resized
    const maxLeft = window.innerWidth  - root.offsetWidth - 8;
    const maxTop  = window.innerHeight - (root.querySelector('.pb-drag-bar')?.offsetHeight || 36) - 8;
    const left = Math.min(Math.max(0, pos.left), Math.max(0, maxLeft));
    const top  = Math.min(Math.max(0, pos.top),  Math.max(0, maxTop));

    root.style.setProperty('left',  left + 'px', 'important');
    root.style.setProperty('top',   top  + 'px', 'important');
    root.style.setProperty('right', 'auto',       'important');
  });
}

// ---------------------------------------------------------------------------
// Re-clamp on window resize so the panel never goes fully off-screen
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => {
  const root = getRoot();
  if (!root || root.style.left === '') return; // still using CSS default

  const maxLeft = window.innerWidth  - root.offsetWidth - 8;
  const maxTop  = window.innerHeight - (root.querySelector('.pb-drag-bar')?.offsetHeight || 36) - 8;
  const curLeft = parseInt(root.style.left, 10);
  const curTop  = parseInt(root.style.top,  10);

  if (curLeft > maxLeft) root.style.setProperty('left', Math.max(0, maxLeft) + 'px', 'important');
  if (curTop  > maxTop)  root.style.setProperty('top',  Math.max(0, maxTop)  + 'px', 'important');
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

boot();
