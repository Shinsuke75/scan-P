'use strict';

/* ============================================================
 * scan-P — ドキュメントスキャナ（台形補正）
 *
 * 設計の要:
 *  A. 表示解像度と処理解像度を分離（表示は縮小ビュー、warp は元解像度）
 *  B. OpenCV.js は遅延ロード（UI を固めない）
 *  C. EXIF 向きは createImageBitmap で補正
 *  D. 入力は Pointer Events に統一
 * ============================================================ */

// ---- DOM 参照 ----
const fileInput = document.getElementById('fileInput');
const warpBtn = document.getElementById('warpBtn');
const srcCanvas = document.getElementById('srcCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const dstCanvas = document.getElementById('dstCanvas');
const loupe = document.getElementById('loupe');
const srcWrap = document.getElementById('srcWrap');
const srcPlaceholder = document.getElementById('srcPlaceholder');
const dstPlaceholder = document.getElementById('dstPlaceholder');
const statusEl = document.getElementById('status');
const filterGroup = document.getElementById('filterGroup');
const downloadGroup = document.getElementById('downloadGroup');
const downloadPngBtn = document.getElementById('downloadPngBtn');
const downloadJpgBtn = document.getElementById('downloadJpgBtn');

const srcCtx = srcCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');

// ---- アプリ状態 ----
const state = {
  bitmap: null,      // EXIF 補正済みの元解像度 ImageBitmap
  nativeW: 0,        // 元画像の幅（px）
  nativeH: 0,        // 元画像の高さ（px）
  viewW: 0,          // 表示キャンバスの幅（px）
  viewH: 0,          // 表示キャンバスの高さ（px）
  scale: 1,          // view / native（表示→元の変換は 1/scale）
  points: [],        // 表示座標系の頂点 [{x,y} x4]（TL,TR,BR,BL の並びを意図）
};

// ---- ステータス表示ユーティリティ ----
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

/* ============================================================
 * 表示サイズの計算（A: 表示解像度と処理解像度の分離）
 *  - 元解像度はそのまま保持
 *  - コンテナ幅と最大高さに収まる「ビュー」サイズを算出
 * ============================================================ */
function computeViewSize(nativeW, nativeH) {
  // コンテナの利用可能幅（パディング考慮で実測）
  const available = srcWrap.clientWidth || 320;
  const maxW = Math.max(240, available);
  // 縦に長い書類でも画面に収まるよう高さ上限も設ける
  const maxH = Math.max(260, Math.round(window.innerHeight * 0.7));

  let scale = Math.min(maxW / nativeW, maxH / nativeH);
  // 元画像が小さければ拡大しすぎない（等倍を上限）
  if (scale > 1) scale = 1;

  const viewW = Math.max(1, Math.round(nativeW * scale));
  const viewH = Math.max(1, Math.round(nativeH * scale));
  return { viewW, viewH, scale: viewW / nativeW };
}

// フォールバックの 4 点（画像の内側 20%）を表示座標で生成
function makeFallbackPoints(viewW, viewH) {
  const mx = viewW * 0.2;
  const my = viewH * 0.2;
  return [
    { x: mx, y: my },                 // 左上
    { x: viewW - mx, y: my },         // 右上
    { x: viewW - mx, y: viewH - my }, // 右下
    { x: mx, y: viewH - my },         // 左下
  ];
}

/* ============================================================
 * 画像の読み込みと表示（C: EXIF 向き補正）
 * ============================================================ */
async function loadImageFile(file) {
  setStatus('work', '画像を読み込み中…', true);

  let bitmap;
  try {
    // EXIF の向きを反映して読み込む（横倒し防止）
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    // 一部ブラウザで imageOrientation 未対応の場合のフォールバック
    console.warn('[scan-P] createImageBitmap orientation fallback', e);
    bitmap = await createImageBitmap(file);
  }

  // 既存ビットマップを解放
  if (state.bitmap && state.bitmap.close) {
    try { state.bitmap.close(); } catch (_) {}
  }

  state.bitmap = bitmap;
  state.nativeW = bitmap.width;
  state.nativeH = bitmap.height;

  renderSource();

  // フォールバック 4 点を即座に表示（B: ユーザーを待たせない）
  state.points = makeFallbackPoints(state.viewW, state.viewH);
  drawOverlay();

  warpBtn.disabled = false;
  setStatus('info',
    `読み込み完了（${state.nativeW}×${state.nativeH}px）— 4 点を角に合わせてください`);

  // Stage 5 でここから OpenCV 遅延ロード＆自動検出を起動する
}

// 元画像を「ビュー」サイズに縮小して表示キャンバスへ描画
function renderSource() {
  const { viewW, viewH, scale } = computeViewSize(state.nativeW, state.nativeH);
  state.viewW = viewW;
  state.viewH = viewH;
  state.scale = scale;

  srcCanvas.width = viewW;
  srcCanvas.height = viewH;
  overlayCanvas.width = viewW;
  overlayCanvas.height = viewH;

  srcCtx.clearRect(0, 0, viewW, viewH);
  srcCtx.drawImage(state.bitmap, 0, 0, viewW, viewH);

  srcPlaceholder.hidden = true;
}

// オーバーレイ（頂点・枠線）の描画 — Stage 3 で本実装
function drawOverlay() {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (state.points.length !== 4) return;

  const p = state.points;
  // 枠線
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeStyle = 'rgba(37,99,235,0.9)';
  overlayCtx.beginPath();
  overlayCtx.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < 4; i++) overlayCtx.lineTo(p[i].x, p[i].y);
  overlayCtx.closePath();
  overlayCtx.stroke();

  // 頂点
  for (const pt of p) {
    overlayCtx.beginPath();
    overlayCtx.arc(pt.x, pt.y, 9, 0, Math.PI * 2);
    overlayCtx.fillStyle = '#f59e0b';
    overlayCtx.fill();
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeStyle = '#fff';
    overlayCtx.stroke();
  }
}

// ---- イベント ----
fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  loadImageFile(file).catch((err) => {
    console.error(err);
    setStatus('error', '画像の読み込みに失敗しました');
  });
});

// 画面リサイズ時はビューを再計算（頂点も相対位置を保って追従）
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!state.bitmap) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const prevW = state.viewW, prevH = state.viewH;
    const ratios = state.points.map((pt) => ({ rx: pt.x / prevW, ry: pt.y / prevH }));
    renderSource();
    state.points = ratios.map((r) => ({ x: r.rx * state.viewW, y: r.ry * state.viewH }));
    drawOverlay();
  }, 150);
});

console.log('[scan-P] ready (stage 2: upload & display)');
