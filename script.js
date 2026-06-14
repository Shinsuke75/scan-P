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

// オーバーレイ（頂点・枠線）の描画
const POINT_RADIUS = 9;          // 見た目の頂点半径（表示座標 px）
function drawOverlay() {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (state.points.length !== 4) return;

  const p = state.points;

  // 半透明の塗り＋枠線
  overlayCtx.beginPath();
  overlayCtx.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < 4; i++) overlayCtx.lineTo(p[i].x, p[i].y);
  overlayCtx.closePath();
  overlayCtx.fillStyle = 'rgba(37,99,235,0.10)';
  overlayCtx.fill();
  overlayCtx.lineWidth = 2;
  overlayCtx.strokeStyle = 'rgba(37,99,235,0.95)';
  overlayCtx.stroke();

  // 頂点
  for (let i = 0; i < 4; i++) {
    const pt = p[i];
    const active = i === activeIdx;
    const r = POINT_RADIUS * (active ? 1.35 : 1);
    overlayCtx.beginPath();
    overlayCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    overlayCtx.fillStyle = active ? '#ea580c' : '#f59e0b';
    overlayCtx.fill();
    overlayCtx.lineWidth = 2.5;
    overlayCtx.strokeStyle = '#fff';
    overlayCtx.stroke();
  }
}

/* ============================================================
 * 頂点ドラッグ（D: Pointer Events に一本化）
 *  - setPointerCapture でキャンバス外へ出ても追従
 *  - touch-action:none + preventDefault でスクロール/ズーム抑止
 *  - 当たり判定は見た目より大きめ（指で押せる半径）
 * ============================================================ */
const HIT_RADIUS = 26;   // 当たり判定半径（CSS px 基準）
let activeIdx = -1;

// クライアント座標 → キャンバス（表示）座標
function toCanvasPos(ev) {
  const rect = overlayCanvas.getBoundingClientRect();
  const sx = overlayCanvas.width / rect.width;
  const sy = overlayCanvas.height / rect.height;
  return {
    x: (ev.clientX - rect.left) * sx,
    y: (ev.clientY - rect.top) * sy,
    sx, sy, rect,
  };
}

// 当たった頂点 index を返す（なければ -1）
function hitTest(pos) {
  const rect = overlayCanvas.getBoundingClientRect();
  const sx = overlayCanvas.width / rect.width; // CSS→canvas 倍率
  const hit = HIT_RADIUS * sx;                 // 当たり判定をキャンバス座標へ
  let best = -1, bestD = hit * hit;
  for (let i = 0; i < state.points.length; i++) {
    const dx = state.points[i].x - pos.x;
    const dy = state.points[i].y - pos.y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

overlayCanvas.addEventListener('pointerdown', (ev) => {
  if (state.points.length !== 4) return;
  const pos = toCanvasPos(ev);
  const idx = hitTest(pos);
  if (idx === -1) return;
  activeIdx = idx;
  overlayCanvas.setPointerCapture(ev.pointerId); // 外へ出ても追従
  overlayCanvas.style.cursor = 'grabbing';
  // つかんだ点をそのままポインタ位置へ
  state.points[idx].x = clamp(pos.x, 0, overlayCanvas.width);
  state.points[idx].y = clamp(pos.y, 0, overlayCanvas.height);
  drawOverlay();
  showLoupe(state.points[idx]);
  ev.preventDefault();
});

overlayCanvas.addEventListener('pointermove', (ev) => {
  if (activeIdx === -1) return;
  ev.preventDefault(); // ドラッグ中のスクロール/ピンチを抑止
  const pos = toCanvasPos(ev);
  state.points[activeIdx].x = clamp(pos.x, 0, overlayCanvas.width);
  state.points[activeIdx].y = clamp(pos.y, 0, overlayCanvas.height);
  drawOverlay();
  showLoupe(state.points[activeIdx]);
});

function endDrag(ev) {
  if (activeIdx === -1) return;
  activeIdx = -1;
  overlayCanvas.style.cursor = 'grab';
  hideLoupe();
  drawOverlay();
  try { overlayCanvas.releasePointerCapture(ev.pointerId); } catch (_) {}
}
overlayCanvas.addEventListener('pointerup', endDrag);
overlayCanvas.addEventListener('pointercancel', endDrag);

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* ---- ルーペ（拡大鏡）---- */
const LOUPE_SIZE = 130;          // CSS 上のサイズ（style.css と一致）
const LOUPE_ZOOM = 2.6;          // 拡大率（ビュー基準）
const loupeCtx = loupe.getContext('2d');

function showLoupe(ptView) {
  if (!state.bitmap) return;
  const dpr = window.devicePixelRatio || 1;
  if (loupe.width !== LOUPE_SIZE * dpr) {
    loupe.width = LOUPE_SIZE * dpr;
    loupe.height = LOUPE_SIZE * dpr;
  }
  loupe.hidden = false;

  const px = loupe.width;        // 内部ピクセル
  // ビュー上で切り出す窓（px）→ 元画像座標へ
  const winView = LOUPE_SIZE / LOUPE_ZOOM;
  const winNative = winView / state.scale;
  const cxNative = ptView.x / state.scale;
  const cyNative = ptView.y / state.scale;
  let sxN = cxNative - winNative / 2;
  let syN = cyNative - winNative / 2;

  loupeCtx.save();
  loupeCtx.clearRect(0, 0, px, px);
  // 円形クリップ
  loupeCtx.beginPath();
  loupeCtx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
  loupeCtx.closePath();
  loupeCtx.clip();
  loupeCtx.fillStyle = '#fff';
  loupeCtx.fillRect(0, 0, px, px);
  // 元解像度から拡大して描く（クリスプ）
  loupeCtx.imageSmoothingEnabled = true;
  loupeCtx.drawImage(state.bitmap, sxN, syN, winNative, winNative, 0, 0, px, px);
  // 十字＋中心リング
  loupeCtx.strokeStyle = 'rgba(234,88,12,0.9)';
  loupeCtx.lineWidth = 2 * dpr;
  loupeCtx.beginPath();
  loupeCtx.moveTo(px / 2, px * 0.3); loupeCtx.lineTo(px / 2, px * 0.7);
  loupeCtx.moveTo(px * 0.3, px / 2); loupeCtx.lineTo(px * 0.7, px / 2);
  loupeCtx.stroke();
  loupeCtx.beginPath();
  loupeCtx.arc(px / 2, px / 2, 7 * dpr, 0, Math.PI * 2);
  loupeCtx.stroke();
  loupeCtx.restore();

  positionLoupe(ptView);
}

// ルーペを指で隠れない位置（基本は上、上端付近なら下）へ
function positionLoupe(ptView) {
  const oRect = overlayCanvas.getBoundingClientRect();
  const wRect = srcWrap.getBoundingClientRect();
  const cssScaleX = oRect.width / overlayCanvas.width;
  const cssScaleY = oRect.height / overlayCanvas.height;
  const cx = (oRect.left - wRect.left) + ptView.x * cssScaleX;
  const cy = (oRect.top - wRect.top) + ptView.y * cssScaleY;

  let left = cx - LOUPE_SIZE / 2;
  let top = cy - LOUPE_SIZE - 24;        // 既定は指の上
  if (top < 4) top = cy + 24;            // 上端付近なら下に出す
  left = clamp(left, 4, srcWrap.clientWidth - LOUPE_SIZE - 4);
  top = clamp(top, 4, srcWrap.clientHeight - LOUPE_SIZE - 4);
  loupe.style.left = left + 'px';
  loupe.style.top = top + 'px';
}

function hideLoupe() { loupe.hidden = true; }

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

console.log('[scan-P] ready (stage 3: vertex drag + loupe)');
