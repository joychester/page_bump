// content-perf-buffer.js — Speed Bump early content script
// Runs at document_start (before any resources load) to expand the
// resource timing buffer from the default 150 to 1000 entries.
// This prevents Performance API entries from being silently dropped
// on large pages (e.g. SPAs with hundreds of assets).
performance.setResourceTimingBufferSize(1000);
