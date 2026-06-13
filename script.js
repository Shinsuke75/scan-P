'use strict';

/* ============================================================
 * scan-P — ドキュメントスキャナ（台形補正）
 * Stage 1: 骨格 / DOM 取得 / ステータス表示ユーティリティ
 * ============================================================ */

// ---- DOM 参照 ----
const fileInput = document.getElementById('fileInput');
const warpBtn = document.getElementById('warpBtn');
const srcCanvas = document.getElementById('srcCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const dstCanvas = document.getElementById('dstCanvas');
const loupe = document.getElementById('loupe');
const srcPlaceholder = document.getElementById('srcPlaceholder');
const dstPlaceholder = document.getElementById('dstPlaceholder');
const statusEl = document.getElementById('status');
const filterGroup = document.getElementById('filterGroup');
const downloadGroup = document.getElementById('downloadGroup');
const downloadPngBtn = document.getElementById('downloadPngBtn');
const downloadJpgBtn = document.getElementById('downloadJpgBtn');

// ---- ステータス表示ユーティリティ ----
// kind: 'info' | 'work' | 'done' | 'error'
function setStatus(kind, message, withSpinner = false) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.innerHTML = '';
    return;
  }
  statusEl.hidden = false;
  statusEl.className = 'status ' + kind;
  statusEl.innerHTML =
    (withSpinner ? '<span class="spinner"></span>' : '') +
    '<span>' + message + '</span>';
}

console.log('[scan-P] ready (stage 1 skeleton)');
