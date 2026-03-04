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
  setupExport();
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
  const total  = data.reduce((a, b) => a + b, 0);

  // Dynamic canvas height: 24px per bar + 50px for axes
  const chartHeight = Math.max(100, entries.length * 24 + 50);
  const wrap = document.getElementById('chartHostPathWrap');
  wrap.style.height = chartHeight + 'px';

  const pctPlugin = {
    id: 'barPctLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = currentTheme === 'dark' ? '#8888a8' : '#6b6b80';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      data.forEach((val, i) => {
        const pct = total > 0 ? (val / total) * 100 : 0;
        const label = pct < 1 ? '<1%' : Math.round(pct) + '%';
        const bar = meta.data[i];
        ctx.fillText(label, bar.x + 4, bar.y);
      });
      ctx.restore();
    },
  };

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
    plugins: [pctPlugin],
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
    layout: { padding: { right: 36 } },
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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function setupExport() {
  document.getElementById('btnExport').addEventListener('click', () => {
    if (currentResults) exportReport(currentResults);
  });
}

async function exportReport(results) {
  const chartJsUrl = chrome.runtime.getURL('lib/chart.min.js');
  const [chartJs, faviconDataUrl] = await Promise.all([
    fetch(chartJsUrl).then(r => r.text()),
    fetchAsDataUrl(results.favIconUrl),
  ]);
  const html = generateReportHTML(results, chartJs, faviconDataUrl);
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  let filename = 'page-bump';
  if (results.pageUrl) {
    try { filename += '-' + new URL(results.pageUrl).hostname; } catch { /* ignore */ }
  }
  if (results.recordedAt) {
    filename += '-' + new Date(results.recordedAt).toISOString().slice(0, 10);
  }
  a.download = filename + '.html';
  a.click();
  URL.revokeObjectURL(url);
}

async function fetchAsDataUrl(url) {
  if (!url) return '';
  try {
    const res  = await fetch(url);
    const blob = await res.blob();
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  } catch { return ''; }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateReportHTML(results, chartJs, faviconDataUrl) {
  const isDark = currentTheme === 'dark';

  const C = {
    border:    isDark ? '#16213e'             : '#ffffff',
    dim:       isDark ? '#8888a8'             : '#6b6b80',
    text:      isDark ? '#eaeaea'             : '#1a1a2e',
    grid:      isDark ? 'rgba(15,52,96,0.6)'  : 'rgba(209,209,218,0.7)',
    axis:      isDark ? '#0f3460'             : '#d1d1da',
    tooltipBg: isDark ? '#0f3460'             : '#ffffff',
  };

  const recordedAt  = results.recordedAt ? new Date(results.recordedAt).toLocaleString() : '';
  const pageTitle   = escapeHtml(results.pageTitle || (results.pageUrl ? (() => { try { return new URL(results.pageUrl).hostname; } catch { return results.pageUrl; } })() : 'Unknown Page'));
  const pageUrl     = escapeHtml(results.pageUrl || '');
  const faviconHtml = faviconDataUrl ? `<img src="${faviconDataUrl}" width="20" height="20" alt="" class="favicon">` : '';
  const savings     = results.totalRaw > 0 ? Math.max(0, Math.round((1 - results.totalTransferred / results.totalRaw) * 100)) : 0;
  const chartJsSafe = chartJs.replace(/<\/script>/gi, '<\\/script>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Page Bump — ${pageTitle}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;background:var(--bg);color:var(--text);line-height:1.5}
body.dark{--bg:#1a1a2e;--surface:#16213e;--border:#0f3460;--text:#eaeaea;--dim:#8888a8;--accent:#e94560}
body.light{--bg:#f4f4f8;--surface:#ffffff;--border:#d1d1da;--text:#1a1a2e;--dim:#6b6b80;--accent:#e94560}
.wrap{max-width:920px;margin:0 auto;padding:32px 24px;display:flex;flex-direction:column;gap:20px}
.rpt-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.page-info{display:flex;align-items:center;gap:10px;min-width:0}
.favicon{flex-shrink:0;border-radius:3px;object-fit:contain}
.page-meta{min-width:0}
.page-title{font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.page-url{font-size:12px;color:var(--dim);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.page-url:hover{color:var(--accent)}
.rpt-meta{font-size:11px;color:var(--dim);white-space:nowrap;flex-shrink:0;text-align:right;line-height:1.8}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.stat{background:var(--surface);padding:14px 12px;text-align:center}
.stat-label{font-size:10px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.stat-value{font-size:18px;font-weight:700}
.mode-toggle{display:flex;gap:3px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:3px;align-self:flex-start}
.mode-tab{padding:6px 20px;border:none;border-radius:6px;background:transparent;color:var(--dim);font-size:13px;font-weight:500;cursor:pointer;transition:all .15s}
.mode-tab.active{background:var(--accent);color:#fff;font-weight:600}
.mode-tab:not(.active):hover{color:var(--text);background:rgba(233,69,96,.1)}
.pies{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.chart-box{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px}
.chart-title{font-size:10px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.6px;margin-bottom:14px}
.pie-row{display:flex;align-items:center;gap:16px}
.pie-row canvas{flex-shrink:0;width:180px !important;height:180px !important}
.bar-wrap{position:relative;width:100%}
.bar-wrap canvas{width:100% !important}
.legend{flex:1;display:flex;flex-direction:column;gap:6px;min-width:0}
.legend-item{display:flex;align-items:center;gap:6px;font-size:12px}
.legend-dot{width:9px;height:9px;border-radius:2px;flex-shrink:0}
.legend-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.legend-size{color:var(--dim);font-size:11px;flex-shrink:0;font-variant-numeric:tabular-nums}
.legend-pct{color:var(--dim);flex-shrink:0;font-variant-numeric:tabular-nums;min-width:36px;text-align:right}
.rpt-footer{text-align:center;font-size:11px;color:var(--dim);padding-top:16px;border-top:1px solid var(--border)}
.rpt-footer a{color:var(--accent);text-decoration:none}
.rpt-footer a:hover{text-decoration:underline}
</style>
</head>
<body class="${isDark ? 'dark' : 'light'}">
<div class="wrap">

  <header class="rpt-header">
    <div class="page-info">
      ${faviconHtml}
      <div class="page-meta">
        <div class="page-title">${pageTitle}</div>
        ${pageUrl ? `<a class="page-url" href="${pageUrl}" target="_blank" rel="noopener">${pageUrl}</a>` : ''}
      </div>
    </div>
    <div class="rpt-meta">
      Recorded ${escapeHtml(recordedAt)}<br>
      Generated by Page Bump
    </div>
  </header>

  <section class="summary">
    <div class="stat"><div class="stat-label">Transferred</div><div class="stat-value">${fmtBytes(results.totalTransferred)}</div></div>
    <div class="stat"><div class="stat-label">Raw Size</div><div class="stat-value">${fmtBytes(results.totalRaw)}</div></div>
    <div class="stat"><div class="stat-label">Requests</div><div class="stat-value">${results.requestCount}</div></div>
    <div class="stat"><div class="stat-label">Savings</div><div class="stat-value">${savings}%</div></div>
  </section>

  <div class="mode-toggle">
    <button class="mode-tab active" data-mode="transferred">Transferred</button>
    <button class="mode-tab" data-mode="raw">Raw</button>
  </div>

  <div class="pies">
    <div class="chart-box">
      <div class="chart-title">By Content Type</div>
      <div class="pie-row">
        <canvas id="chartType" width="180" height="180"></canvas>
        <div id="legendType" class="legend"></div>
      </div>
    </div>
    <div class="chart-box">
      <div class="chart-title">By Host</div>
      <div class="pie-row">
        <canvas id="chartHost" width="180" height="180"></canvas>
        <div id="legendHost" class="legend"></div>
      </div>
    </div>
  </div>

  <div class="chart-box">
    <div class="chart-title">By Host + Path</div>
    <div id="barWrap" class="bar-wrap"><canvas id="chartHostPath"></canvas></div>
  </div>

  <footer class="rpt-footer">Generated by <a href="https://github.com/nicholasgasior/page-bump" target="_blank">Page Bump</a></footer>

</div>
<script>${chartJsSafe}</script>
<script>
var DATA = ${JSON.stringify(results)};
var TYPE_COLORS = ${JSON.stringify(TYPE_COLORS)};
var currentMode = 'transferred';
var BORDER = '${C.border}';
var DIM    = '${C.dim}';
var TEXT   = '${C.text}';
var GRID   = '${C.grid}';
var AXIS   = '${C.axis}';
var TOOLTIP_BG = '${C.tooltipBg}';

var chartType = null, chartHost = null, chartHostPath = null;

function fmtBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function genColors(n) {
  return Array.from({length: n}, function(_, i) {
    return 'hsl(' + ((200 + Math.round(i / Math.max(n, 1) * 280)) % 360) + ',65%,55%)';
  });
}

function renderLegend(id, labels, data, colors) {
  var total = data.reduce(function(a, b) { return a + b; }, 0);
  document.getElementById(id).innerHTML = labels.map(function(label, i) {
    var pct = total > 0 ? ((data[i] / total) * 100).toFixed(1) : '0.0';
    return '<div class="legend-item">' +
      '<span class="legend-dot" style="background:' + colors[i] + '"></span>' +
      '<span class="legend-label" title="' + label + '">' + label + '</span>' +
      '<span class="legend-size">' + fmtBytes(data[i]) + '</span>' +
      '<span class="legend-pct">' + pct + '%</span>' +
    '</div>';
  }).join('');
}

var tooltipDefaults = {
  backgroundColor: TOOLTIP_BG, titleColor: TEXT, bodyColor: TEXT,
  borderColor: '#e94560', borderWidth: 1,
};

function renderByType(mode) {
  if (chartType) chartType.destroy();
  var entries = Object.entries(DATA.byType).sort(function(a, b) { return b[1][mode] - a[1][mode]; });
  var labels  = entries.map(function(e) { return e[0]; });
  var data    = entries.map(function(e) { return e[1][mode]; });
  var colors  = labels.map(function(l) { return TYPE_COLORS[l] || '#6e6e8a'; });
  chartType = new Chart(document.getElementById('chartType'), {
    type: 'doughnut',
    data: { labels: labels, datasets: [{ data: data, backgroundColor: colors, borderColor: BORDER, borderWidth: 2, hoverBorderWidth: 0 }] },
    options: { cutout: '60%', plugins: { legend: { display: false }, tooltip: Object.assign({}, tooltipDefaults, { callbacks: { label: function(c) { return '  ' + c.label + ': ' + fmtBytes(c.raw); } } }) } }
  });
  renderLegend('legendType', labels, data, colors);
}

function renderByHost(mode) {
  if (chartHost) chartHost.destroy();
  var entries = Object.entries(DATA.byHost).sort(function(a, b) { return b[1][mode] - a[1][mode]; });
  var labels  = entries.map(function(e) { return e[0]; });
  var data    = entries.map(function(e) { return e[1][mode]; });
  var colors  = genColors(labels.length);
  chartHost = new Chart(document.getElementById('chartHost'), {
    type: 'doughnut',
    data: { labels: labels, datasets: [{ data: data, backgroundColor: colors, borderColor: BORDER, borderWidth: 2, hoverBorderWidth: 0 }] },
    options: { cutout: '60%', plugins: { legend: { display: false }, tooltip: Object.assign({}, tooltipDefaults, { callbacks: { label: function(c) { return '  ' + c.label + ': ' + fmtBytes(c.raw); } } }) } }
  });
  renderLegend('legendHost', labels, data, colors);
}

function renderByPath(mode) {
  if (chartHostPath) chartHostPath.destroy();
  var entries = Object.entries(DATA.byHostPath).sort(function(a, b) { return b[1][mode] - a[1][mode]; });
  var labels  = entries.map(function(e) { return e[0]; });
  var data    = entries.map(function(e) { return e[1][mode]; });
  var total   = data.reduce(function(a, b) { return a + b; }, 0);
  document.getElementById('barWrap').style.height = Math.max(200, entries.length * 24 + 50) + 'px';
  var pctPlugin = {
    id: 'pct',
    afterDatasetsDraw: function(chart) {
      var ctx = chart.ctx, meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = '11px system-ui,sans-serif';
      ctx.fillStyle = DIM;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      data.forEach(function(val, i) {
        var pct = total > 0 ? (val / total) * 100 : 0;
        var bar = meta.data[i];
        ctx.fillText(pct < 1 ? '<1%' : Math.round(pct) + '%', bar.x + 4, bar.y);
      });
      ctx.restore();
    }
  };
  chartHostPath = new Chart(document.getElementById('chartHostPath'), {
    type: 'bar',
    data: { labels: labels, datasets: [{ data: data, backgroundColor: 'rgba(233,69,96,0.75)', borderColor: '#e94560', borderWidth: 1, borderRadius: 3, borderSkipped: false }] },
    options: {
      indexAxis: 'y', maintainAspectRatio: false, layout: { padding: { right: 42 } },
      plugins: { legend: { display: false }, tooltip: Object.assign({}, tooltipDefaults, { callbacks: { label: function(c) { return '  ' + fmtBytes(c.raw); } } }) },
      scales: {
        x: { ticks: { color: DIM, font: { size: 10 }, callback: function(v) { return fmtBytes(v); } }, grid: { color: GRID }, border: { color: AXIS } },
        y: { ticks: { color: TEXT, font: { size: 10 }, autoSkip: false }, grid: { display: false }, border: { color: AXIS } }
      }
    },
    plugins: [pctPlugin]
  });
}

function renderAll(mode) {
  renderByType(mode);
  renderByHost(mode);
  renderByPath(mode);
}

document.querySelectorAll('.mode-tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    document.querySelectorAll('.mode-tab').forEach(function(t) { t.classList.remove('active'); });
    tab.classList.add('active');
    currentMode = tab.dataset.mode;
    renderAll(currentMode);
  });
});

renderAll(currentMode);
</script>
</body>
</html>`;
}
