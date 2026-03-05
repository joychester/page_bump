// background.js — Speed Bump service worker

const MAX_MS        = 10000;  // auto-start: 10 s max + idle detection
const MAX_MS_MANUAL = 20000;  // manual start: 20 s max, no idle auto-stop
const IDLE_MS = 1500;
const KEY_DISABLED = 'pbDisabledTabs'; // persisted array of disabled tab IDs

// Per-tab in-memory state cache and idle timers (rehydrated from storage.session on wake)
const _states     = {};  // tabId → state
const _idleTimers = {};  // tabId → timerId

function alarmName(tabId) { return 'pb_max_' + tabId; }
function stateKey(tabId)  { return 'pbState_' + tabId; }

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    phase: 'idle',      // 'idle' | 'recording' | 'collecting'
    startTime: null,
    isManual: false,    // true = user-initiated (20 s max, no idle stop)
    pageUrl: null,      // URL of the page being recorded
    requests: {},       // { [url]: { url, host, contentType, contentLength, transferredSize } }
    lastRequestTime: null,
    results: null,      // last completed ResultsPayload
  };
}

async function getState(tabId) {
  if (_states[tabId]) return _states[tabId];
  const data = await chrome.storage.session.get(stateKey(tabId));
  _states[tabId] = data[stateKey(tabId)] ?? defaultState();
  return _states[tabId];
}

async function setState(tabId, patch) {
  const current = await getState(tabId);
  _states[tabId] = { ...current, ...patch };
  await chrome.storage.session.set({ [stateKey(tabId)]: _states[tabId] });
}

async function clearTabState(tabId) {
  delete _states[tabId];
  await chrome.storage.session.remove(stateKey(tabId));
}

async function getDisabledTabs() {
  const data = await chrome.storage.session.get(KEY_DISABLED);
  return new Set(data[KEY_DISABLED] ?? []);
}

async function setDisabledTabs(set) {
  await chrome.storage.session.set({ [KEY_DISABLED]: [...set] });
}

// ---------------------------------------------------------------------------
// Recording lifecycle
// ---------------------------------------------------------------------------

async function startRecording(tabId, pageUrl = null, isManual = false) {
  // If no URL was passed (e.g. manual start), read from the tab now
  if (!pageUrl) {
    try { pageUrl = (await chrome.tabs.get(tabId)).url ?? null; } catch { /* tab may not exist */ }
  }
  await setState(tabId, {
    phase: 'recording',
    startTime: Date.now(),
    isManual,
    pageUrl,
    requests: {},
    lastRequestTime: Date.now(),
  });
  await chrome.alarms.clear(alarmName(tabId));
  const maxMs = isManual ? MAX_MS_MANUAL : MAX_MS;
  chrome.alarms.create(alarmName(tabId), { delayInMinutes: maxMs / 60000 });
  // Manual recordings rely solely on the alarm or the Stop button —
  // no idle auto-stop so the user stays in control.
  if (!isManual) resetIdleTimer(tabId);
}

function resetIdleTimer(tabId) {
  if (_states[tabId]?.isManual) return; // manual recordings use only the alarm + Stop button
  if (_idleTimers[tabId]) clearTimeout(_idleTimers[tabId]);
  _idleTimers[tabId] = setTimeout(() => autoStop(tabId, 'idle'), IDLE_MS);
}

async function autoStop(tabId, reason) {
  const state = await getState(tabId);
  if (state.phase !== 'recording') return;
  await stopRecording(tabId, reason);
}

async function stopRecording(tabId, reason) {
  await chrome.alarms.clear(alarmName(tabId));
  if (_idleTimers[tabId]) { clearTimeout(_idleTimers[tabId]); delete _idleTimers[tabId]; }
  await setState(tabId, { phase: 'collecting' });
  broadcast({ type: 'RECORDING_STOPPED', payload: { tabId, reason } });
  await collectPerformanceData(tabId);
}

// ---------------------------------------------------------------------------
// Performance data collection + merge
// ---------------------------------------------------------------------------

async function collectPerformanceData(tabId) {
  const state = await getState(tabId);
  let perfEntries = [];

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => performance.getEntriesByType('resource').map(e => ({
        name: e.name,
        encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize,
        transferSize: e.transferSize,
      })),
    });
    perfEntries = results?.[0]?.result ?? [];
  } catch (err) {
    // Tab navigated away or was closed — proceed with webRequest data only
    console.warn('[SpeedBump] executeScript failed:', err.message);
  }

  // Fetch current tab metadata (title + favicon now available after page load)
  let pageTitle = null;
  let favIconUrl = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    pageTitle  = tab.title   ?? null;
    favIconUrl = tab.favIconUrl ?? null;
  } catch { /* tab may have closed */ }

  const merged = mergeData(state.requests, perfEntries);
  const results = buildResultPayload(merged, { pageUrl: state.pageUrl, pageTitle, favIconUrl });
  await setState(tabId, { phase: 'idle', results });
  broadcast({ type: 'RECORDING_DONE', payload: { tabId } });
}

function mergeData(requests, perfEntries) {
  const perfMap = new Map(perfEntries.map(e => [e.name, e]));
  const merged = [];

  for (const req of Object.values(requests)) {
    const perf = perfMap.get(req.url);
    let transferredSize = req.transferredSize;
    let rawSize = 0;

    if (perf) {
      const corsRestricted = perf.encodedBodySize === 0 && perf.decodedBodySize === 0 && perf.transferSize === 0;
      if (corsRestricted) {
        // CORS-restricted: perf API gives us nothing — fall back to webRequest Content-Length
        rawSize = transferredSize;
      } else {
        if (perf.decodedBodySize > 0) rawSize = perf.decodedBodySize;
        if (perf.transferSize > 0) transferredSize = perf.transferSize;
        // If rawSize still 0 (e.g. only transferSize was available), approximate it
        if (rawSize === 0) rawSize = transferredSize;
      }
    } else {
      // No perf entry: treat raw = transferred (can't determine compression)
      rawSize = transferredSize;
    }

    merged.push({ ...req, transferredSize, rawSize });
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Result payload construction
// ---------------------------------------------------------------------------

function buildResultPayload(merged, pageInfo = {}) {
  const byType = {};
  const byHost = {};
  const byHostPath = {};

  for (const req of merged) {
    const cat = classifyContentType(req.contentType);
    const hostPath = buildHostPath(req.url);
    accumulate(byType, cat, req);
    accumulate(byHost, req.host || 'unknown', req);
    accumulate(byHostPath, hostPath, req);
  }

  return {
    totalTransferred: merged.reduce((s, r) => s + r.transferredSize, 0),
    totalRaw: merged.reduce((s, r) => s + r.rawSize, 0),
    requestCount: merged.length,
    byType,
    byHost,
    byHostPath,
    pageUrl:    pageInfo.pageUrl    ?? null,
    pageTitle:  pageInfo.pageTitle  ?? null,
    favIconUrl: pageInfo.favIconUrl ?? null,
    recordedAt: Date.now(),
  };
}

function classifyContentType(ct) {
  if (!ct) return 'Other';
  const t = ct.toLowerCase().split(';')[0].trim();
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'HTML';
  if (t === 'text/css') return 'CSS';
  if (t === 'application/javascript' || t === 'text/javascript' || t === 'application/x-javascript') return 'JS';
  if (t.startsWith('image/')) return 'Images';
  if (t.includes('font') || t === 'font/woff' || t === 'font/woff2' || t === 'font/ttf') return 'Fonts';
  if (t === 'application/json' || t === 'text/xml' || t === 'application/xml') return 'XHR';
  if (t.startsWith('application/') || t.startsWith('text/')) return 'XHR';
  return 'Other';
}

function buildHostPath(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const first = segments.length > 0 ? '/' + segments[0] : '/';
    return u.hostname + first;
  } catch {
    return 'unknown';
  }
}

function accumulate(map, key, req) {
  if (!map[key]) map[key] = { transferred: 0, raw: 0, count: 0 };
  map[key].transferred += req.transferredSize;
  map[key].raw += req.rawSize;
  map[key].count += 1;
}

// ---------------------------------------------------------------------------
// Message handling (popup <-> background)
// ---------------------------------------------------------------------------

function onMessage(message, sender, sendResponse) {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true; // keep channel open for async response
}

async function handleMessage(message, sender = {}) {
  const senderTabId = sender.tab?.id ?? null;

  switch (message.type) {
    case 'GET_STATE': {
      if (!senderTabId) return { phase: 'idle', startTime: null, isManual: false, requestCount: 0, isDisabled: false };
      const state = await getState(senderTabId);
      const disabled = await getDisabledTabs();
      return {
        phase: state.phase,
        tabId: senderTabId,
        startTime: state.startTime,
        isManual: state.isManual,
        requestCount: Object.keys(state.requests).length,
        isDisabled: disabled.has(senderTabId),
      };
    }

    case 'START_RECORDING': {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab) return { ok: false, error: 'No active tab' };
      await startRecording(tab.id, null, true); // isManual = true
      return { ok: true };
    }

    case 'STOP_RECORDING':
      if (!senderTabId) return { ok: false };
      {
        const state = await getState(senderTabId);
        if (state.phase === 'recording') await stopRecording(senderTabId, 'user');
      }
      return { ok: true };

    case 'GET_RESULTS': {
      if (!senderTabId) return null;
      const state = await getState(senderTabId);
      return state.results ?? null;
    }

    case 'DISABLE_TAB': {
      if (!senderTabId) return { ok: false };
      const disabled = await getDisabledTabs();
      disabled.add(senderTabId);
      await setDisabledTabs(disabled);
      // Stop any active recording on this tab
      const state = await getState(senderTabId);
      if (state.phase === 'recording') {
        await stopRecording(senderTabId, 'disabled');
      }
      return { ok: true };
    }

    case 'ENABLE_TAB': {
      if (!senderTabId) return { ok: false };
      const disabled = await getDisabledTabs();
      disabled.delete(senderTabId);
      await setDisabledTabs(disabled);
      return { ok: true };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup not open — that's fine
  });
}

// ---------------------------------------------------------------------------
// webNavigation: auto-start recording on page navigation
// ---------------------------------------------------------------------------

async function onBeforeNavigate(details) {
  if (details.frameId !== 0) return; // main frame only

  const disabled = await getDisabledTabs();
  if (disabled.has(details.tabId)) return; // recording disabled for this tab

  const state = await getState(details.tabId);

  if (state.phase === 'recording') {
    // New navigation while already recording: reset and restart
    await chrome.alarms.clear(alarmName(details.tabId));
    if (_idleTimers[details.tabId]) { clearTimeout(_idleTimers[details.tabId]); delete _idleTimers[details.tabId]; }
    await startRecording(details.tabId, details.url);
    broadcast({ type: 'RECORDING_STARTED', payload: { tabId: details.tabId, reset: true } });
    return;
  }

  if (state.phase === 'idle') {
    await startRecording(details.tabId, details.url);
    broadcast({ type: 'RECORDING_STARTED', payload: { tabId: details.tabId, reset: false } });
  }
}

// ---------------------------------------------------------------------------
// webRequest: capture each completed request
// ---------------------------------------------------------------------------

async function onRequestCompleted(details) {
  const state = await getState(details.tabId);
  if (state.phase !== 'recording') return;

  const headers = details.responseHeaders ?? [];
  const ctHeader = headers.find(h => h.name.toLowerCase() === 'content-type');
  const clHeader = headers.find(h => h.name.toLowerCase() === 'content-length');

  const contentType = ctHeader?.value ?? '';
  const contentLength = clHeader ? parseInt(clHeader.value, 10) : null;
  const transferredSize = (contentLength && contentLength > 0) ? contentLength : 0;

  let host = 'unknown';
  try { host = new URL(details.url).hostname; } catch { /* ignore */ }

  const requests = { ...state.requests };
  requests[details.url] = { url: details.url, host, contentType, contentLength, transferredSize };

  await setState(details.tabId, { requests, lastRequestTime: Date.now() });
  resetIdleTimer(details.tabId);
}

// ---------------------------------------------------------------------------
// Alarm: 10-second max recording duration (per tab)
// ---------------------------------------------------------------------------

async function onAlarm(alarm) {
  const m = alarm.name.match(/^pb_max_(\d+)$/);
  if (!m) return;
  const tabId = +m[1];
  const state = await getState(tabId);
  if (state.phase === 'recording') await stopRecording(tabId, 'maxTime');
}

// ---------------------------------------------------------------------------
// Tab closed: stop recording cleanly without executeScript
// ---------------------------------------------------------------------------

async function onTabRemoved(tabId) {
  // Clean up disabled list so the ID can be reused by future tabs
  const disabled = await getDisabledTabs();
  if (disabled.has(tabId)) {
    disabled.delete(tabId);
    await setDisabledTabs(disabled);
  }

  // Clear idle timer for this tab
  if (_idleTimers[tabId]) { clearTimeout(_idleTimers[tabId]); delete _idleTimers[tabId]; }
  await chrome.alarms.clear(alarmName(tabId));

  const state = await getState(tabId);
  if (state.phase === 'recording') {
    // Build results from webRequest data only (no Performance API — page is gone)
    const merged = Object.values(state.requests).map(req => ({
      ...req,
      rawSize: req.transferredSize,
    }));
    const results = buildResultPayload(merged, { pageUrl: state.pageUrl });
    await setState(tabId, { phase: 'idle', results });
    broadcast({ type: 'RECORDING_DONE', payload: { tabId } });
  }

  // Always clean up per-tab state when tab closes
  await clearTabState(tabId);
}

// ---------------------------------------------------------------------------
// Top-level listener registration (MUST be at module root for MV3 SW wakeup)
// ---------------------------------------------------------------------------

chrome.webRequest.onCompleted.addListener(
  onRequestCompleted,
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);

chrome.alarms.onAlarm.addListener(onAlarm);

chrome.tabs.onRemoved.addListener(onTabRemoved);

chrome.runtime.onMessage.addListener(onMessage);

chrome.action.onClicked.addListener(tab => {
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' }).catch(() => {});
});
