// popup.js — Page Bump popup controller

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BTN_ICONS = {
  record: `<circle cx="7" cy="7" r="6.25" stroke="currentColor" stroke-width="1.5"/><circle cx="7" cy="7" r="3.5" fill="currentColor"/>`,
  stop:   `<circle cx="7" cy="7" r="6.25" stroke="currentColor" stroke-width="1.5"/><rect x="4.25" y="4.25" width="5.5" height="5.5" rx="1" fill="currentColor"/>`,
};

const TYPE_COLORS = {
  HTML:   '#e94560',
  CSS:    '#0f9b8e',
  JS:     '#f0a500',
  Images: '#7c4dff',
  Fonts:  '#00bcd4',
  XHR:    '#4caf50',
  Other:  '#6e6e8a',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentMode = 'transferred'; // or 'raw'
let currentTheme = 'dark';       // 'dark' | 'light'
let currentResults = null;
let charts = {};      // { type, host, hostPath }
let timerInterval = null;
let pollHandle = null;
let visibleHostCount = 10;
let visiblePathCount = 10;
let isDisabled = false;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  setupControls();
  setupDisableButton();
  setupModeToggle();
  setupMessageListener();
  refreshState();
});

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

async function initTheme() {
  const data = await chrome.storage.local.get('pbTheme');
  currentTheme = data.pbTheme ?? 'dark';
  applyTheme(currentTheme);

  document.getElementById('btnTheme').addEventListener('click', toggleTheme);
}

async function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(currentTheme);
  await chrome.storage.local.set({ pbTheme: currentTheme });
  // Re-render charts with new theme colors if results exist
  if (currentResults) updateCharts(currentResults, currentMode);
}

function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  document.getElementById('btnTheme').textContent = theme === 'dark' ? '🌙' : '☀️';
}

// Returns chart-relevant colors for the active theme
function getChartTheme() {
  const dark = currentTheme === 'dark';
  return {
    tooltipBg:      dark ? '#0f3460'              : '#ffffff',
    tooltipTitle:   dark ? '#eaeaea'              : '#1a1a2e',
    tooltipBody:    dark ? '#eaeaea'              : '#1a1a2e',
    tooltipBorder:  '#e94560',
    doughnutBorder: dark ? '#16213e'              : '#ffffff',
    gridColor:      dark ? 'rgba(15,52,96,0.6)'   : 'rgba(209,209,218,0.7)',
    axisColor:      dark ? '#0f3460'              : '#d1d1da',
    xTickColor:     dark ? '#7a7a9a'              : '#6b6b80',
    yTickColor:     dark ? '#eaeaea'              : '#1a1a2e',
  };
}

// ---------------------------------------------------------------------------
// Refresh state from background
// ---------------------------------------------------------------------------

async function refreshState() {
  let state;
  try {
    state = await sendMessage({ type: 'GET_STATE' });
  } catch {
    showEmpty();
    return;
  }

  isDisabled = state.isDisabled ?? false;
  updateDisabledUI(isDisabled);
  updateStatusUI(state);

  if (state.phase === 'idle') {
    stopTimerDisplay();
    const results = await sendMessage({ type: 'GET_RESULTS' });
    if (results) {
      currentResults = results;
      showResults(results);
    } else {
      showEmpty();
    }

  } else if (state.phase === 'recording') {
    showRecordingState(state.startTime, state.isManual);

  } else if (state.phase === 'collecting') {
    showCollecting();
    startPollingResults();
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function setupControls() {
  document.getElementById('btnToggle').addEventListener('click', async () => {
    const state = await sendMessage({ type: 'GET_STATE' });

    if (state.phase === 'recording') {
      await sendMessage({ type: 'STOP_RECORDING' });
      showCollecting();
      startPollingResults();
    } else if (state.phase === 'idle') {
      await sendMessage({ type: 'START_RECORDING' });
      // Show recording UI immediately with the manual 20 s cap
      showRecordingState(Date.now(), true);
      updateStatusUI({ phase: 'recording' });
    }
    // If collecting, button is disabled — nothing to do
  });
}

// ---------------------------------------------------------------------------
// Disable / enable tab
// ---------------------------------------------------------------------------

function setupDisableButton() {
  document.getElementById('btnDisable').addEventListener('click', async () => {
    if (isDisabled) {
      await sendMessage({ type: 'ENABLE_TAB' });
    } else {
      await sendMessage({ type: 'DISABLE_TAB' });
    }
    await refreshState();
  });
}

function updateDisabledUI(disabled) {
  const btn = document.getElementById('btnDisable');
  const banner = document.getElementById('disabledBanner');
  const btnToggle = document.getElementById('btnToggle');

  if (disabled) {
    show('disabledBanner');
    btn.textContent = 'Enable Recording';
    btn.classList.add('pb-btn--enable');
    btn.classList.remove('pb-btn--disable');
    btnToggle.classList.add('hidden');
  } else {
    hide('disabledBanner');
    btn.textContent = 'Disable Recording';
    btn.classList.add('pb-btn--disable');
    btn.classList.remove('pb-btn--enable');
    btnToggle.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------------

function setupModeToggle() {
  document.querySelectorAll('.pb-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.pb-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentMode = tab.dataset.mode;
      if (currentResults) updateCharts(currentResults, currentMode);
    });
  });
}

// ---------------------------------------------------------------------------
// Message listener (background → popup push events)
// ---------------------------------------------------------------------------

function setupMessageListener() {
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'RECORDING_STOPPED') {
      stopTimerDisplay();
      showCollecting();
      startPollingResults();
    }
    if (message.type === 'RECORDING_STARTED') {
      stopPolling();
      refreshState();
    }
    if (message.type === 'RECORDING_DONE') {
      // Background finished collecting; poll will pick this up
    }
  });
}

// ---------------------------------------------------------------------------
// Poll for results after recording stops
// ---------------------------------------------------------------------------

function startPollingResults() {
  stopPolling();
  let attempts = 0;
  const maxAttempts = 30; // 9 seconds max wait

  pollHandle = setInterval(async () => {
    attempts++;
    try {
      const state = await sendMessage({ type: 'GET_STATE' });
      if (state.phase === 'idle') {
        isDisabled = state.isDisabled ?? false;
        updateDisabledUI(isDisabled);
        const results = await sendMessage({ type: 'GET_RESULTS' });
        if (results) {
          stopPolling();
          currentResults = results;
          showResults(results);
          return;
        }
      }
    } catch { /* background may be busy */ }

    if (attempts >= maxAttempts) {
      stopPolling();
      showEmpty();
    }
  }, 300);
}

function stopPolling() {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
}

// ---------------------------------------------------------------------------
// UI state transitions
// ---------------------------------------------------------------------------

function showRecordingState(startTime, isManual = false) {
  hide('emptyState');
  hide('collectingState');
  hide('pageInfo');
  hide('summary');
  hide('modeToggle');
  hide('charts');
  startTimerDisplay(startTime, isManual ? 20000 : 8000);
  setBtn('Stop Recording', 'stop', false);
}

function showCollecting() {
  hide('emptyState');
  show('collectingState');
  hide('summary');
  hide('modeToggle');
  hide('charts');
  stopTimerDisplay();
  setBtn('Stop Recording', 'stop', true);
  updateStatusUI({ phase: 'collecting' });
}

function showResults(results) {
  hide('emptyState');
  hide('collectingState');
  show('pageInfo');
  show('summary');
  show('modeToggle');
  show('charts');
  stopTimerDisplay();
  visibleHostCount = 10;
  visiblePathCount = 10;
  updatePageInfo(results);
  updateSummary(results);
  updateCharts(results, currentMode);
  updateStatusUI({ phase: 'idle' });
  setBtn('Start Recording', 'primary', false);
}

function showEmpty() {
  show('emptyState');
  hide('collectingState');
  hide('pageInfo');
  hide('summary');
  hide('modeToggle');
  hide('charts');
  stopTimerDisplay();
  updateStatusUI({ phase: 'idle' });
  setBtn('Start Recording', 'primary', false);
}

// ---------------------------------------------------------------------------
// Status UI
// ---------------------------------------------------------------------------

function updateStatusUI(state) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const btn = document.getElementById('btnToggle');

  dot.className = 'pb-status-dot';

  if (state.phase === 'recording') {
    dot.classList.add('recording');
    text.textContent = 'Recording';
    setBtnLabel('Stop Recording', 'stop');
    btn.classList.add('pb-btn--stop');
    btn.classList.remove('pb-btn--primary');
    btn.disabled = false;

  } else if (state.phase === 'collecting') {
    dot.classList.add('collecting');
    text.textContent = 'Collecting…';
    setBtnLabel('Stop Recording', 'stop');
    btn.classList.add('pb-btn--stop');
    btn.classList.remove('pb-btn--primary');
    btn.disabled = true;

  } else {
    text.textContent = 'Idle';
    setBtnLabel('Start Recording', 'record');
    btn.classList.add('pb-btn--primary');
    btn.classList.remove('pb-btn--stop');
    btn.disabled = false;
  }
}

function setBtnLabel(label, iconKey) {
  document.getElementById('btnToggleText').textContent = label;
  document.getElementById('btnToggleIcon').innerHTML = BTN_ICONS[iconKey];
}

function setBtn(label, style, disabled) {
  const btn = document.getElementById('btnToggle');
  setBtnLabel(label, style === 'primary' ? 'record' : 'stop');
  btn.disabled = disabled;
  if (style === 'primary') {
    btn.classList.add('pb-btn--primary');
    btn.classList.remove('pb-btn--stop');
  } else {
    btn.classList.add('pb-btn--stop');
    btn.classList.remove('pb-btn--primary');
  }
}

// ---------------------------------------------------------------------------
// Timer display
// ---------------------------------------------------------------------------

function startTimerDisplay(startTime, maxMs = 8000) {
  stopTimerDisplay();
  const el = document.getElementById('timer');
  const maxSec = (maxMs / 1000).toFixed(0);
  const update = () => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    el.textContent = elapsed + 's / ' + maxSec + 's';
  };
  update();
  timerInterval = setInterval(update, 100);
}

function stopTimerDisplay() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  document.getElementById('timer').textContent = '';
}

// ---------------------------------------------------------------------------
// Page info
// ---------------------------------------------------------------------------

function updatePageInfo(results) {
  const { pageUrl, pageTitle, favIconUrl } = results;

  // Favicon
  const favicon = document.getElementById('pageFavicon');
  if (favIconUrl) {
    favicon.src = favIconUrl;
    favicon.onerror = () => { favicon.src = ''; };
  } else {
    favicon.src = '';
  }

  // Title — fall back to hostname if no title
  const titleEl = document.getElementById('pageTitle');
  if (pageTitle) {
    titleEl.textContent = pageTitle;
  } else if (pageUrl) {
    try { titleEl.textContent = new URL(pageUrl).hostname; } catch { titleEl.textContent = pageUrl; }
  } else {
    titleEl.textContent = 'Unknown page';
  }

  // URL — display cleaned-up form, link opens the URL
  const urlEl = document.getElementById('pageUrl');
  if (pageUrl) {
    let display = pageUrl;
    try {
      const u = new URL(pageUrl);
      display = u.hostname + (u.pathname !== '/' ? u.pathname : '');
    } catch { /* keep raw */ }
    urlEl.textContent = display;
    urlEl.href = pageUrl;
  } else {
    urlEl.textContent = '';
    urlEl.href = '#';
  }
}

// ---------------------------------------------------------------------------
// Summary bar
// ---------------------------------------------------------------------------

function updateSummary(results) {
  document.getElementById('statTransferred').textContent = fmtBytes(results.totalTransferred);
  document.getElementById('statRaw').textContent = fmtBytes(results.totalRaw);
  document.getElementById('statRequests').textContent = results.requestCount;
  const savings = results.totalRaw > 0
    ? Math.round((1 - results.totalTransferred / results.totalRaw) * 100)
    : 0;
  document.getElementById('statCompression').textContent = Math.max(0, savings) + '%';
}

// ---------------------------------------------------------------------------
// Chart rendering
// ---------------------------------------------------------------------------

function updateCharts(results, mode) {
  renderPieByType(results.byType, mode);
  renderPieByHost(results.byHost, mode);
  renderBarByHostPath(results.byHostPath, mode);
}

function renderPieByType(byType, mode) {
  const entries = Object.entries(byType)
    .sort((a, b) => b[1][mode] - a[1][mode]);

  const labels = entries.map(([k]) => k);
  const data   = entries.map(([, v]) => v[mode]);
  const colors = labels.map(l => TYPE_COLORS[l] ?? TYPE_COLORS.Other);

  destroyChart('type');
  const ctx = document.getElementById('chartType').getContext('2d');
  charts.type = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: getChartTheme().doughnutBorder,
        borderWidth: 2,
        hoverBorderWidth: 0,
      }],
    },
    options: doughnutOptions(),
  });
  renderLegend('legendType', labels, data, colors);
}

function renderPieByHost(byHost, mode) {
  const allEntries = Object.entries(byHost).sort((a, b) => b[1][mode] - a[1][mode]);
  const entries = allEntries.slice(0, visibleHostCount);

  const labels = entries.map(([k]) => k);
  const data   = entries.map(([, v]) => v[mode]);
  const colors = genColors(labels.length);

  destroyChart('host');
  const ctx = document.getElementById('chartHost').getContext('2d');
  charts.host = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: getChartTheme().doughnutBorder,
        borderWidth: 2,
        hoverBorderWidth: 0,
      }],
    },
    options: doughnutOptions(),
  });
  renderLegend('legendHost', labels, data, colors);

  updateLoadMore('hostLoadMore', allEntries.length, visibleHostCount, () => {
    visibleHostCount = Math.min(visibleHostCount + 10, allEntries.length);
    renderPieByHost(byHost, mode);
  });
}

function renderBarByHostPath(byHostPath, mode) {
  const allEntries = Object.entries(byHostPath).sort((a, b) => b[1][mode] - a[1][mode]);
  const entries = allEntries.slice(0, visiblePathCount);

  const labels = entries.map(([k]) => k);
  const data   = entries.map(([, v]) => v[mode]);

  // Dynamic canvas height: 24px per bar + 50px for axes
  const chartHeight = Math.max(100, entries.length * 24 + 50);
  const wrap = document.getElementById('chartHostPathWrap');
  wrap.style.height = chartHeight + 'px';

  destroyChart('hostPath');
  const ctx = document.getElementById('chartHostPath').getContext('2d');
  charts.hostPath = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: 'rgba(233, 69, 96, 0.75)',
        borderColor: '#e94560',
        borderWidth: 1,
        borderRadius: 3,
        borderSkipped: false,
      }],
    },
    options: barOptions(),
  });

  updateLoadMore('pathLoadMore', allEntries.length, visiblePathCount, () => {
    visiblePathCount = Math.min(visiblePathCount + 10, allEntries.length);
    renderBarByHostPath(byHostPath, mode);
  });
}

function updateLoadMore(containerId, total, visible, onMore) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = '';
  if (visible >= total) return;

  const remaining = total - visible;
  const nextBatch = Math.min(10, remaining);
  const btn = document.createElement('button');
  btn.className = 'pb-load-more-btn';
  btn.textContent = `Show ${nextBatch} more  (${remaining} remaining)`;
  btn.addEventListener('click', onMore);
  wrap.appendChild(btn);
}

function doughnutOptions() {
  const t = getChartTheme();
  return {
    responsive: true,
    maintainAspectRatio: true,
    cutout: '60%',
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: { label: ctx => '  ' + ctx.label + ': ' + fmtBytes(ctx.raw) },
        backgroundColor: t.tooltipBg,
        titleColor:      t.tooltipTitle,
        bodyColor:       t.tooltipBody,
        borderColor:     t.tooltipBorder,
        borderWidth: 1,
      },
    },
  };
}

function barOptions() {
  const t = getChartTheme();
  return {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: { label: ctx => '  ' + fmtBytes(ctx.raw) },
        backgroundColor: t.tooltipBg,
        titleColor:      t.tooltipTitle,
        bodyColor:       t.tooltipBody,
        borderColor:     t.tooltipBorder,
        borderWidth: 1,
      },
    },
    scales: {
      x: {
        ticks: { color: t.xTickColor, font: { size: 10 }, callback: v => fmtBytes(v) },
        grid:  { color: t.gridColor },
        border: { color: t.axisColor },
      },
      y: {
        ticks: { color: t.yTickColor, font: { size: 10 }, autoSkip: false },
        grid:  { display: false },
        border: { color: t.axisColor },
      },
    },
  };
}

function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    charts[key] = null;
  }
}

// ---------------------------------------------------------------------------
// Legend rendering
// ---------------------------------------------------------------------------

function renderLegend(containerId, labels, data, colors) {
  const total = data.reduce((a, b) => a + b, 0);
  const el = document.getElementById(containerId);
  el.innerHTML = labels.map((label, i) => {
    const pct = total > 0 ? ((data[i] / total) * 100).toFixed(1) : '0.0';
    return `
      <div class="pb-legend-item">
        <span class="pb-legend-dot" style="background:${colors[i]}"></span>
        <span class="pb-legend-label" title="${label}">${label}</span>
        <span class="pb-legend-size">${fmtBytes(data[i])}</span>
        <span class="pb-legend-pct">${pct}%</span>
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function genColors(n) {
  // Evenly spaced hues, avoiding red (already used for accent)
  return Array.from({ length: n }, (_, i) => {
    const hue = (200 + Math.round((i / Math.max(n, 1)) * 280)) % 360;
    return `hsl(${hue}, 65%, 55%)`;
  });
}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}
