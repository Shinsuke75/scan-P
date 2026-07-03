'use strict';

/* ============================================================
 * scan-P — ドキュメントスキャナ（台形補正）
 *
 * 設計の要:
 *  A. 表示解像度と処理解像度を分離（表示は縮小ビュー、warp は元解像度）
 *  B. 射影変換は WebGL（外部ライブラリ不要）。不可時は純 JS フォールバック
 *  C. EXIF 向きは createImageBitmap で補正
 *  D. 入力は Pointer Events に統一（ハンドル操作中のみスクロール抑止）
 *  E. 画像は全てブラウザ内で処理（外部送信なし）
 * ============================================================ */

// ---- DOM 参照 ----
const fileInput = document.getElementById('fileInput');
const warpBtn = document.getElementById('warpBtn');
const autoBtn = document.getElementById('autoBtn');
const srcCanvas = document.getElementById('srcCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const dstCanvas = document.getElementById('dstCanvas');
const loupe = document.getElementById('loupe');
const srcWrap = document.getElementById('srcWrap');
const srcPlaceholder = document.getElementById('srcPlaceholder');
const dstPlaceholder = document.getElementById('dstPlaceholder');
const statusEl = document.getElementById('status');
const resultTools = document.getElementById('resultTools');
const filterSeg = document.getElementById('filterSeg');
const bwRow = document.getElementById('bwRow');
const bwThresh = document.getElementById('bwThresh');
const rotL = document.getElementById('rotL');
const rotR = document.getElementById('rotR');
const savePhotoBtn = document.getElementById('savePhotoBtn');
const saveHint = document.getElementById('saveHint');
const downloadPngBtn = document.getElementById('downloadPngBtn');
const downloadJpgBtn = document.getElementById('downloadJpgBtn');
const pasteBtn = document.getElementById('pasteBtn');
const copyBtn = document.getElementById('copyBtn');

// 端末/ブラウザの対応状況
const CAN_SHARE_FILES = (() => {
  try {
    return !!(navigator.canShare &&
      navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] }));
  } catch (_) { return false; }
})();
const CAN_COPY_IMG = !!(navigator.clipboard && window.ClipboardItem && navigator.clipboard.write);
const CAN_PASTE_IMG = !!(navigator.clipboard && navigator.clipboard.read);

// 非対応のボタンは隠す
if (!CAN_SHARE_FILES) savePhotoBtn.hidden = true;
if (!CAN_COPY_IMG && copyBtn) copyBtn.hidden = true;
if (!CAN_PASTE_IMG && pasteBtn) pasteBtn.hidden = true;

// 保存の説明文を対応状況に合わせて生成
if (saveHint) {
  const parts = [];
  if (CAN_COPY_IMG) parts.push('<b>コピー</b>＝クリップボードへ');
  if (CAN_SHARE_FILES) parts.push('<b>写真に保存</b>＝スマホのアルバムへ');
  parts.push('<b>PNG/JPEG</b>＝ダウンロード（PNG=高画質・文字くっきり / JPEG=軽量・写真向き）');
  saveHint.innerHTML = parts.join('／');
}

const srcCtx = srcCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');
const dstCtx = dstCanvas.getContext('2d');

// ビルド表示（キャッシュ確認用）。変更のたびに更新する。
const BUILD = 'v1.42 (2026-06-16)';
const buildStampEl = document.getElementById('buildStamp');
if (buildStampEl) buildStampEl.textContent = 'build ' + BUILD;

// ---- アプリ状態 ----
const state = {
  bitmap: null,      // EXIF 補正済みの元解像度 ImageBitmap
  nativeW: 0,        // 元画像の幅（px）
  nativeH: 0,        // 元画像の高さ（px）
  viewW: 0,          // 表示キャンバスの幅（px）
  viewH: 0,          // 表示キャンバスの高さ（px）
  scale: 1,          // view / native（表示→元の変換は 1/scale）
  padX: 0, padY: 0,  // 画像の周囲に設ける余白（画像外の仮想点用）
  points: [],        // 表示座標系の頂点 [{x,y} x4]（TL,TR,BR,BL の並びを意図）
  warpedCanvas: null, // 直近の補正結果（カラー）の 2D キャンバス
  baseImageData: null, // フィルタ再計算用のカラー ImageData キャッシュ
  loadToken: 0,      // 画像入れ替え検出用トークン（古い自動検出の適用を防ぐ）
  userAdjusted: false, // ユーザーが頂点を手動調整したか（自動検出の上書き抑止）
  filter: 'color',   // 仕上げフィルタ
  bwC: 10,           // 白黒2値化のしきい値オフセット（大=薄, 小=濃）
  rotBase: 0,        // 90°単位の回転
  filteredCanvas: null, // フィルタ適用後（回転前）のキャッシュ
  filteredKey: '',   // キャッシュ鍵（warpId + filter + bwC）
  warpId: 0,         // 補正実行ごとに増える
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

// 端末側の例外を画面に表示（モバイルはコンソールが見えないため）
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
window.addEventListener('error', (e) => {
  const msg = e && (e.message || (e.error && e.error.message)) || '不明なエラー';
  setStatus('error', '⚠ ' + escapeHtml(msg));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  const msg = (r && (r.message || r)) || '不明なエラー';
  setStatus('error', '⚠ ' + escapeHtml(msg));
});

// 画像の周囲に設ける余白の割合（画像外の角＝仮想点を置けるように）
const PAD_FRAC = 0.16;

// フォールバックの 4 点（画像の内側 20%）を表示座標（余白込み）で生成
function makeFallbackPoints() {
  const { padX, padY, viewW, viewH } = state;
  const mx = viewW * 0.2, my = viewH * 0.2;
  return [
    { x: padX + mx, y: padY + my },                 // 左上
    { x: padX + viewW - mx, y: padY + my },         // 右上
    { x: padX + viewW - mx, y: padY + viewH - my }, // 右下
    { x: padX + mx, y: padY + viewH - my },         // 左下
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
  state.loadToken++;
  state.userAdjusted = false;

  // 前回の結果を解放し、結果パネルをリセット
  state.warpedCanvas = null;
  state.baseImageData = null;
  state.filteredCanvas = null;
  dstCtx.clearRect(0, 0, dstCanvas.width, dstCanvas.height);
  dstCanvas.width = 0; dstCanvas.height = 0;
  dstPlaceholder.hidden = false;
  resultTools.hidden = true;

  renderSource();

  // フォールバック 4 点を即座に表示（B: ユーザーを待たせない）
  state.points = makeFallbackPoints();
  drawOverlay();

  warpBtn.disabled = false;
  if (autoBtn) autoBtn.hidden = false;
  setStatus('info',
    `読み込み完了（${state.nativeW}×${state.nativeH}px）— 4 点を角に合わせて「補正実行」`);

  // 自動検出は「✨自動で枠検出」ボタンを押したときだけ実行する
  // （読込直後の手動調整を邪魔しないため）。
}

// 元画像を「ビュー」サイズに縮小し、周囲に余白を付けて表示キャンバスへ描画
function renderSource() {
  const available = srcWrap.clientWidth || 320;
  const maxCanvasW = Math.max(240, available);
  const maxCanvasH = Math.max(260, Math.round(window.innerHeight * 0.7));
  const f = 1 + 2 * PAD_FRAC; // キャンバス全体は画像の f 倍

  let scale = Math.min((maxCanvasW / f) / state.nativeW, (maxCanvasH / f) / state.nativeH);
  if (scale > 1) scale = 1; // 拡大しすぎない

  const viewW = Math.max(1, Math.round(state.nativeW * scale));
  const viewH = Math.max(1, Math.round(state.nativeH * scale));
  const padX = Math.round(viewW * PAD_FRAC);
  const padY = Math.round(viewH * PAD_FRAC);

  state.viewW = viewW; state.viewH = viewH;
  state.scale = viewW / state.nativeW;
  state.padX = padX; state.padY = padY;

  const cw = viewW + 2 * padX, ch = viewH + 2 * padY;
  srcCanvas.width = cw; srcCanvas.height = ch;
  overlayCanvas.width = cw; overlayCanvas.height = ch;

  srcCtx.clearRect(0, 0, cw, ch);
  // 画像領域の外（余白）が分かるよう、画像の枠を薄く描く
  srcCtx.drawImage(state.bitmap, padX, padY, viewW, viewH);
  srcCtx.strokeStyle = 'rgba(100,116,139,0.5)';
  srcCtx.lineWidth = 1;
  srcCtx.strokeRect(padX + 0.5, padY + 0.5, viewW - 1, viewH - 1);

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

  // 辺の中央ハンドル（ドラッグで辺を平行移動）
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const active = i === activeEdge;
    const s = active ? 9 : 7;
    overlayCtx.save();
    overlayCtx.translate(mx, my);
    overlayCtx.rotate(Math.PI / 4); // ひし形
    overlayCtx.beginPath();
    overlayCtx.rect(-s, -s, s * 2, s * 2);
    overlayCtx.fillStyle = active ? '#2563eb' : 'rgba(37,99,235,0.85)';
    overlayCtx.fill();
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeStyle = '#fff';
    overlayCtx.stroke();
    overlayCtx.restore();
  }

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
let activeIdx = -1;      // ドラッグ中の頂点 index（-1=なし）
let activeEdge = -1;     // ドラッグ中の辺 index（-1=なし）
let lastPos = null;      // 辺ドラッグ用の前回ポインタ位置
let edgeDirA = null;     // 辺ドラッグ時、端点 A が沿う隣辺の方向（固定）
let edgeDirB = null;     // 辺ドラッグ時、端点 B が沿う隣辺の方向（固定）

// 単位ベクトル（長さ0近傍は null）
function unitVec(x, y) {
  const L = Math.hypot(x, y);
  if (L < 1e-6) return null;
  return { x: x / L, y: y / L };
}

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
  const sx = overlayCanvas.width / rect.width;
  const sy = overlayCanvas.height / rect.height;
  let best = -1, bestD = HIT_RADIUS * HIT_RADIUS;
  for (let i = 0; i < state.points.length; i++) {
    const dx = (state.points[i].x - pos.x) / sx;
    const dy = (state.points[i].y - pos.y) / sy;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

// 点 pos と辺の中央ハンドルの当たり判定（辺 index か -1）
function hitTestEdge(pos) {
  const rect = overlayCanvas.getBoundingClientRect();
  const sx = overlayCanvas.width / rect.width;
  const sy = overlayCanvas.height / rect.height;
  let best = -1, bestD = (HIT_RADIUS * HIT_RADIUS);
  for (let i = 0; i < 4; i++) {
    const a = state.points[i], b = state.points[(i + 1) % 4];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = (mx - pos.x) / sx, dy = (my - pos.y) / sy;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

overlayCanvas.addEventListener('pointerdown', (ev) => {
  if (state.points.length !== 4) return;
  const pos = toCanvasPos(ev);
  // まず頂点、なければ辺の中央ハンドル
  const idx = hitTest(pos);
  if (idx !== -1) {
    activeIdx = idx;
  } else {
    const e = hitTestEdge(pos);
    if (e === -1) return;
    activeEdge = e;
    lastPos = { x: pos.x, y: pos.y };
    // 隣接2辺の向きを固定（端点はこの線上をスライド＝隣辺の形状を保つ）
    const pA = state.points[e], farA = state.points[(e + 3) % 4];
    const pB = state.points[(e + 1) % 4], farB = state.points[(e + 2) % 4];
    edgeDirA = unitVec(pA.x - farA.x, pA.y - farA.y);
    edgeDirB = unitVec(pB.x - farB.x, pB.y - farB.y);
  }
  state.userAdjusted = true; // 以後、自動検出結果で上書きしない
  overlayCanvas.setPointerCapture(ev.pointerId); // 外へ出ても追従
  overlayCanvas.style.cursor = 'grabbing';
  drawOverlay();
  if (activeIdx !== -1) showLoupe(state.points[activeIdx]);
  ev.preventDefault();
});

overlayCanvas.addEventListener('pointermove', (ev) => {
  if (activeIdx === -1 && activeEdge === -1) return;
  ev.preventDefault(); // ドラッグ中のスクロール/ピンチを抑止
  const pos = toCanvasPos(ev);
  if (activeIdx !== -1) {
    // 頂点ドラッグ（余白内なら画像外＝仮想点も置ける）
    state.points[activeIdx].x = clamp(pos.x, 0, overlayCanvas.width);
    state.points[activeIdx].y = clamp(pos.y, 0, overlayCanvas.height);
    drawOverlay();
    showLoupe(state.points[activeIdx]);
  } else {
    // 辺ドラッグ：両端を「隣の辺の線上」だけスライドさせる。
    // これで隣接2辺は向き（直線）を保ち、向かい側の辺は完全固定。
    const dx = pos.x - lastPos.x, dy = pos.y - lastPos.y;
    const a = state.points[activeEdge], b = state.points[(activeEdge + 1) % 4];
    slideAlong(a, edgeDirA, dx, dy);
    slideAlong(b, edgeDirB, dx, dy);
    lastPos = { x: pos.x, y: pos.y };
    drawOverlay();
    showLoupe({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
});

// 点 pt を方向 dir に沿って、ドラッグ量(dx,dy)の射影分だけ動かす
// dir が null（隣辺が退化）の場合はそのまま平行移動にフォールバック
function slideAlong(pt, dir, dx, dy) {
  if (!dir) {
    pt.x = clamp(pt.x + dx, 0, overlayCanvas.width);
    pt.y = clamp(pt.y + dy, 0, overlayCanvas.height);
    return;
  }
  const t = dx * dir.x + dy * dir.y; // 隣辺方向への射影
  pt.x = clamp(pt.x + dir.x * t, 0, overlayCanvas.width);
  pt.y = clamp(pt.y + dir.y * t, 0, overlayCanvas.height);
}

function endDrag(ev) {
  if (activeIdx === -1 && activeEdge === -1) return;
  activeIdx = -1;
  activeEdge = -1;
  lastPos = null;
  edgeDirA = edgeDirB = null;
  overlayCanvas.style.cursor = 'grab';
  hideLoupe();
  drawOverlay();
  try { overlayCanvas.releasePointerCapture(ev.pointerId); } catch (_) {}
}
overlayCanvas.addEventListener('pointerup', endDrag);
overlayCanvas.addEventListener('pointercancel', endDrag);

// タッチ：頂点/辺をドラッグ中だけスクロールを抑止する（preventDefault が
// 確実）。それ以外（画像をなぞるだけ）はページを縦スクロールできる。
overlayCanvas.addEventListener('touchmove', (ev) => {
  if (activeIdx !== -1 || activeEdge !== -1) ev.preventDefault();
}, { passive: false });

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* ---- ルーペ（拡大鏡）---- */
const LOUPE_SIZE = 130;          // CSS 上のサイズ（style.css と一致）
const LOUPE_ZOOM = 2.6;          // 拡大率（ビュー基準）
const loupeCtx = loupe.getContext('2d');

// 「画像の外（余白）」を表す市松パターン（キャンバスの余白と同じ見た目）
let checkerPattern = null;
function getCheckerPattern() {
  if (checkerPattern) return checkerPattern;
  const c = document.createElement('canvas');
  c.width = c.height = 20;
  const x = c.getContext('2d');
  x.fillStyle = '#eef2f7'; x.fillRect(0, 0, 20, 20);
  x.fillStyle = '#dde3ec'; x.fillRect(0, 0, 10, 10); x.fillRect(10, 10, 10, 10);
  checkerPattern = loupeCtx.createPattern(c, 'repeat');
  return checkerPattern;
}

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
  // 表示座標（余白込み）→ 元画像座標（窓は点を中心に固定＝点の本当の位置）
  const cxNative = (ptView.x - state.padX) / state.scale;
  const cyNative = (ptView.y - state.padY) / state.scale;
  const sxN = cxNative - winNative / 2;
  const syN = cyNative - winNative / 2;
  const sc = px / winNative;     // ルーペpx / 元画像px

  loupeCtx.save();
  loupeCtx.clearRect(0, 0, px, px);
  // 円形クリップ
  loupeCtx.beginPath();
  loupeCtx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
  loupeCtx.closePath();
  loupeCtx.clip();
  // 背景＝市松模様（＝画像の外。余白に出ているのが一目で分かる）
  loupeCtx.fillStyle = getCheckerPattern();
  loupeCtx.fillRect(0, 0, px, px);
  // 写真部分をクリスプに重ね描き。
  // ※ iOS Safari は元範囲が画像外へ少しでもはみ出すと drawImage 全体を
  //   描画しないため、画像と窓の「重なり部分だけ」を切り出して描く。
  loupeCtx.imageSmoothingEnabled = true;
  const ix0 = Math.max(0, sxN), iy0 = Math.max(0, syN);
  const ix1 = Math.min(state.nativeW, sxN + winNative);
  const iy1 = Math.min(state.nativeH, syN + winNative);
  if (ix1 > ix0 && iy1 > iy0) {
    const sW = ix1 - ix0, sH = iy1 - iy0;
    loupeCtx.drawImage(
      state.bitmap, ix0, iy0, sW, sH,
      (ix0 - sxN) * sc, (iy0 - syN) * sc, sW * sc, sH * sc
    );
  }
  // 写真の縁（境界線）＝「ここが写真の端」
  const bx = (0 - sxN) * sc, by = (0 - syN) * sc;
  loupeCtx.strokeStyle = 'rgba(37,99,235,0.9)';
  loupeCtx.lineWidth = 2 * dpr;
  loupeCtx.strokeRect(bx, by, state.nativeW * sc, state.nativeH * sc);
  // 十字＋リング（中心＝点の本当の位置）
  loupeCtx.strokeStyle = 'rgba(234,88,12,0.95)';
  loupeCtx.lineWidth = 2 * dpr;
  loupeCtx.beginPath();
  loupeCtx.moveTo(px / 2, px * 0.28); loupeCtx.lineTo(px / 2, px * 0.72);
  loupeCtx.moveTo(px * 0.28, px / 2); loupeCtx.lineTo(px * 0.72, px / 2);
  loupeCtx.stroke();
  loupeCtx.beginPath();
  loupeCtx.arc(px / 2, px / 2, 7 * dpr, 0, Math.PI * 2);
  loupeCtx.stroke();
  loupeCtx.restore();

  positionLoupe(ptView);
}

// ルーペは「点と反対側のすみ」に表示し、作業中の角を隠さないようにする
function positionLoupe(ptView) {
  const oRect = overlayCanvas.getBoundingClientRect();
  const wRect = srcWrap.getBoundingClientRect();
  const cssScaleX = oRect.width / overlayCanvas.width;
  const cssScaleY = oRect.height / overlayCanvas.height;
  const cx = (oRect.left - wRect.left) + ptView.x * cssScaleX;
  const cy = (oRect.top - wRect.top) + ptView.y * cssScaleY;
  const W = srcWrap.clientWidth, H = srcWrap.clientHeight;

  // 点が右側なら左へ、左側なら右へ／上側なら下へ、下側なら上へ（対角のすみ）
  const left = (cx > W / 2) ? 8 : (W - LOUPE_SIZE - 8);
  const top = (cy > H / 2) ? 8 : (H - LOUPE_SIZE - 8);
  loupe.style.left = left + 'px';
  loupe.style.top = top + 'px';
}

function hideLoupe() { loupe.hidden = true; }

// ---- イベント ----
fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  // 同じファイルを選び直しても change が発火するよう毎回リセット
  e.target.value = '';
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
    // 元画像座標に直してから新しいビューへ再マップ（余白も追従）
    const nativePts = pointsToNative(state.points);
    renderSource();
    state.points = nativePts.map((p) => ({
      x: p.x * state.scale + state.padX,
      y: p.y * state.scale + state.padY,
    }));
    drawOverlay();
  }, 150);
});

/* ============================================================
 * 補正実行（座標変換 → 四隅の並べ替え → 出力サイズ算出 → warp）
 * ============================================================ */

// 表示座標（余白込み）の頂点を元画像座標へ変換
function pointsToNative(points) {
  const inv = 1 / state.scale;
  return points.map((p) => ({
    x: (p.x - state.padX) * inv,
    y: (p.y - state.padY) * inv,
  }));
}

// 4 点を 左上→右上→右下→左下 に正規化（任意順でも破綻しない）
function orderCorners(pts) {
  let tl = pts[0], tr = pts[0], br = pts[0], bl = pts[0];
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (const p of pts) {
    const sum = p.x + p.y;   // 最小=左上, 最大=右下
    const diff = p.y - p.x;  // 最小=右上, 最大=左下
    if (sum < minSum) { minSum = sum; tl = p; }
    if (sum > maxSum) { maxSum = sum; br = p; }
    if (diff < minDiff) { minDiff = diff; tr = p; }
    if (diff > maxDiff) { maxDiff = diff; bl = p; }
  }
  return [tl, tr, br, bl];
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 出力サイズの上限（iOS Safari の Canvas 上限を考慮）
const MAX_OUT_DIM = 4096;
const MAX_OUT_PIXELS = 16 * 1024 * 1024; // 約 16M ピクセル

// 並べ替え済みの 4 点（元座標）から出力サイズを算出し、上限に収める
function computeOutputSize(ordered) {
  const [tl, tr, br, bl] = ordered;
  const wTop = dist(tl, tr);
  const wBottom = dist(bl, br);
  const hLeft = dist(tl, bl);
  const hRight = dist(tr, br);
  let outW = Math.max(wTop, wBottom);
  let outH = Math.max(hLeft, hRight);

  // 出力上限クランプ（アスペクト比保持）
  let sc = 1;
  sc = Math.min(sc, MAX_OUT_DIM / outW, MAX_OUT_DIM / outH);
  if (outW * sc * outH * sc > MAX_OUT_PIXELS) {
    sc = Math.min(sc, Math.sqrt(MAX_OUT_PIXELS / (outW * outH)));
  }
  outW = Math.max(1, Math.round(outW * sc));
  outH = Math.max(1, Math.round(outH * sc));
  return { outW, outH };
}

/* ============================================================
 * 射影変換は WebGL で行う（OpenCV 非依存・追加 DL ゼロ・GPU 高速）
 *  - 元解像度のビットマップをテクスチャに載せ、出力矩形へ
 *    ホモグラフィでサンプリングする（A: 元解像度で変換）。
 * ============================================================ */
let glState = null; // { canvas, gl, prog, uH, aPos, uTex, buf }

function initGL() {
  if (glState) return glState;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', {
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,   // drawImage で確実に取り出すため
  }) || canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
  if (!gl) return null;

  const vsSrc =
    'attribute vec2 aPos; varying vec2 vOut;' +
    'void main(){ vOut = aPos;' +
    ' gl_Position = vec4(aPos.x*2.0-1.0, 1.0-aPos.y*2.0, 0.0, 1.0); }';
  const fsSrc =
    'precision highp float; varying vec2 vOut;' +
    'uniform mat3 uH; uniform sampler2D uTex;' +
    'void main(){ vec3 p = uH * vec3(vOut, 1.0); vec2 tc = p.xy / p.z;' +
    ' if (tc.x < 0.0 || tc.x > 1.0 || tc.y < 0.0 || tc.y > 1.0) {' +
    '   gl_FragColor = vec4(1.0,1.0,1.0,1.0);' +
    ' } else { gl_FragColor = texture2D(uTex, tc); } }';

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('[scan-P] shader error', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[scan-P] program link error', gl.getProgramInfoLog(prog));
    return null;
  }

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  // 出力正規化座標の 4 隅（TL,TR,BR,BL）を TRIANGLE_FAN で
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);

  glState = {
    canvas, gl, prog,
    uH: gl.getUniformLocation(prog, 'uH'),
    uTex: gl.getUniformLocation(prog, 'uTex'),
    aPos: gl.getAttribLocation(prog, 'aPos'),
    buf,
  };
  return glState;
}

// 8x8 連立一次方程式を部分ピボット付きガウス消去で解く
function gaussSolve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat(b[i]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

// from[4]→to[4] のホモグラフィを GLSL mat3（列優先 9 要素）で返す
function solveHomography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = gaussSolve(A, b);
  if (!h) return null;
  const [a, bb, c, d, e, f, g, hh] = h;
  // 行優先 [[a,bb,c],[d,e,f],[g,hh,1]] → GLSL 列優先
  return [a, d, g, bb, e, hh, c, f, 1];
}

// WebGL で射影変換し、結果を 2D キャンバスに描いて返す（失敗時 null）
function warpWithWebGL(orderedNative, outW, outH) {
  const S = initGL();
  if (!S) return null;
  const { gl, prog, buf } = S;

  S.canvas.width = outW;
  S.canvas.height = outH;
  gl.viewport(0, 0, outW, outH);

  // 元解像度テクスチャ（上下反転なし: texcoord(0,0)=画像左上）
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // iOS Safari は ImageBitmap の直接アップロードで空テクスチャになることが
  // あるため、必ず 2D キャンバスに描いてからアップロードする。
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
  const longSide = Math.max(state.nativeW, state.nativeH);
  let tw = state.nativeW, th = state.nativeH;
  if (longSide > maxTex) {
    const s = maxTex / longSide;
    tw = Math.max(1, Math.round(state.nativeW * s));
    th = Math.max(1, Math.round(state.nativeH * s));
  }
  const tc = document.createElement('canvas');
  tc.width = tw; tc.height = th;
  tc.getContext('2d').drawImage(state.bitmap, 0, 0, tw, th);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tc);

  // 出力正規化(0..1) → 元テクスチャ座標(0..1) のホモグラフィ
  const from = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const to = orderedNative.map((p) => [p.x / state.nativeW, p.y / state.nativeH]);
  const H = solveHomography(from, to);
  if (!H) { gl.deleteTexture(tex); return null; }

  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(S.aPos);
  gl.vertexAttribPointer(S.aPos, 2, gl.FLOAT, false, 0, 0);
  gl.uniformMatrix3fv(S.uH, false, new Float32Array(H));
  gl.uniform1i(S.uTex, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);

  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  gl.deleteTexture(tex);

  // WebGL キャンバスを 2D キャンバスへ複製（以降の処理・保存用）
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  out.getContext('2d').drawImage(S.canvas, 0, 0);
  return out;
}

// WebGL が使えない場合の純 JS フォールバック（逆写像＋バイリニア）
function warpWithJS(orderedNative, outW, outH) {
  // 元画像のピクセルを取得
  const sc = document.createElement('canvas');
  sc.width = state.nativeW; sc.height = state.nativeH;
  const sctx = sc.getContext('2d');
  sctx.drawImage(state.bitmap, 0, 0);
  const sImg = sctx.getImageData(0, 0, state.nativeW, state.nativeH);
  const sData = sImg.data, sw = state.nativeW, sh = state.nativeH;

  // 出力正規化 → 元座標(px) のホモグラフィ
  const from = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const to = orderedNative.map((p) => [p.x, p.y]);
  const h = (() => {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i], [u, v] = to[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    return gaussSolve(A, b);
  })();
  if (!h) return null;
  const [a, bb, c, d, e, f, g, hh] = h;

  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d');
  const oImg = octx.createImageData(outW, outH);
  const oData = oImg.data;

  for (let oy = 0; oy < outH; oy++) {
    const ny = (oy + 0.5) / outH;
    for (let ox = 0; ox < outW; ox++) {
      const nx = (ox + 0.5) / outW;
      const w = g * nx + hh * ny + 1;
      const sx = (a * nx + bb * ny + c) / w;
      const sy = (d * nx + e * ny + f) / w;
      const di = (oy * outW + ox) * 4;
      if (sx < 0 || sx > sw - 1 || sy < 0 || sy > sh - 1) {
        oData[di] = oData[di + 1] = oData[di + 2] = 255; oData[di + 3] = 255;
        continue;
      }
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let k = 0; k < 3; k++) {
        const top = sData[i00 + k] * (1 - fx) + sData[i10 + k] * fx;
        const bot = sData[i01 + k] * (1 - fx) + sData[i11 + k] * fx;
        oData[di + k] = (top * (1 - fy) + bot * fy) | 0;
      }
      oData[di + 3] = 255;
    }
  }
  octx.putImageData(oImg, 0, 0);
  return out;
}

// 結果がほぼ真っ白か（WebGL 失敗検出用）。数点をサンプリング。
function isMostlyBlank(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const pts = [[w >> 1, h >> 1], [w >> 2, h >> 2], [(w * 3) >> 2, (h * 3) >> 2],
                 [w >> 2, (h * 3) >> 2], [(w * 3) >> 2, h >> 2]];
    let white = 0;
    for (const [x, y] of pts) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      if (d[0] > 250 && d[1] > 250 && d[2] > 250) white++;
    }
    return white === pts.length;
  } catch (_) { return false; }
}

async function runWarp() {
  if (!state.bitmap || state.points.length !== 4) return;
  warpBtn.disabled = true;
  setStatus('work', '台形補正を実行中…', true);
  await new Promise((r) => requestAnimationFrame(() => r()));

  try {
    // A: 表示座標 → 元座標へ変換し、TL,TR,BR,BL に正規化
    const native = pointsToNative(state.points);
    const ordered = orderCorners(native);
    const { outW, outH } = computeOutputSize(ordered);

    let result = warpWithWebGL(ordered, outW, outH);
    // WebGL が空（真っ白）を返した場合も CPU フォールバックへ
    if (!result || isMostlyBlank(result)) {
      setStatus('work', '台形補正を実行中…（CPU フォールバック）', true);
      await new Promise((r) => requestAnimationFrame(() => r()));
      // 純 JS は重いので、フォールバック時は解像度を抑える（フリーズ防止）
      const JS_MAX = 1800;
      let jw = outW, jh = outH;
      const lng = Math.max(jw, jh);
      if (lng > JS_MAX) { const s = JS_MAX / lng; jw = Math.round(jw * s); jh = Math.round(jh * s); }
      result = warpWithJS(ordered, jw, jh);
    }
    if (!result) { setStatus('error', '補正に失敗しました（頂点の配置をご確認ください）'); return; }

    state.warpedCanvas = result;
    state.baseImageData = null;     // フィルタ用キャッシュを無効化
    state.filteredCanvas = null;
    state.warpId++;
    state.rotBase = 0; // 回転をリセット
    renderResult();

    dstPlaceholder.hidden = true;
    resultTools.hidden = false;
    updateBwRow();
    setStatus('done', `補正完了（${result.width}×${result.height}px）`);
    // モバイルでは結果が画面外（下）に出るため、結果ツールへスクロールして見せる
    try { dstCanvas.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
  } catch (e) {
    console.error(e);
    setStatus('error', '補正処理でエラーが発生しました');
  } finally {
    warpBtn.disabled = false;
  }
}

/* ============================================================
 * 仕上げフィルタ（純 JS）: カラー / グレー / 白黒2値化
 *  - 2値化は積分画像による適応的しきい値（紙のスキャン風）
 * ============================================================ */
function getBaseImageData() {
  if (state.baseImageData) return state.baseImageData;
  const c = state.warpedCanvas;
  const ctx = c.getContext('2d');
  state.baseImageData = ctx.getImageData(0, 0, c.width, c.height);
  return state.baseImageData;
}

// フィルタ適用後（回転前）のキャンバスを返す（キャッシュ付き）
function buildFilteredCanvas() {
  const key = state.warpId + ':' + state.filter + ':' + state.bwC;
  if (state.filteredCanvas && state.filteredKey === key) return state.filteredCanvas;

  const srcC = state.warpedCanvas;
  const w = srcC.width, h = srcC.height;

  if (state.filter === 'color') {
    state.filteredCanvas = srcC;       // そのまま
    state.filteredKey = key;
    return srcC;
  }

  const base = getBaseImageData();
  const src = base.data;
  const n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    gray[i] = 0.299 * src[j] + 0.587 * src[j + 1] + 0.114 * src[j + 2];
  }

  const out = new ImageData(w, h);
  const o = out.data;

  if (state.filter === 'gray') {
    for (let i = 0; i < n; i++) {
      const v = gray[i] | 0, j = i * 4;
      o[j] = o[j + 1] = o[j + 2] = v; o[j + 3] = 255;
    }
  } else {
    // 白黒2値化: 積分画像で各画素の周辺平均としきい値比較（適応的）
    const integ = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    const rad = Math.max(8, Math.round(Math.min(w, h) * 0.02));
    const C = state.bwC; // 大=薄（白多め） / 小=濃（黒多め）
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - rad), y1 = Math.min(h - 1, y + rad);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - rad), x1 = Math.min(w - 1, x + rad);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum =
          integ[(y1 + 1) * (w + 1) + (x1 + 1)] -
          integ[(y0) * (w + 1) + (x1 + 1)] -
          integ[(y1 + 1) * (w + 1) + (x0)] +
          integ[(y0) * (w + 1) + (x0)];
        const mean = sum / area;
        const i = y * w + x, j = i * 4;
        const v = gray[i] > (mean - C) ? 255 : 0;
        o[j] = o[j + 1] = o[j + 2] = v; o[j + 3] = 255;
      }
    }
  }

  const fc = document.createElement('canvas');
  fc.width = w; fc.height = h;
  fc.getContext('2d').putImageData(out, 0, 0);
  state.filteredCanvas = fc;
  state.filteredKey = key;
  return fc;
}

// 任意角度で回転（白背景・はみ出しを含む外接矩形サイズ）
function rotateCanvas(srcC, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return srcC;
  const rad = d * Math.PI / 180;
  const s = Math.abs(Math.sin(rad)), c = Math.abs(Math.cos(rad));
  const w = srcC.width, h = srcC.height;
  const nw = Math.round(w * c + h * s), nh = Math.round(w * s + h * c);
  const out = document.createElement('canvas');
  out.width = nw; out.height = nh;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, nw, nh);
  ctx.translate(nw / 2, nh / 2);
  ctx.rotate(rad);
  ctx.drawImage(srcC, -w / 2, -h / 2);
  return out;
}

function renderResult() {
  if (!state.warpedCanvas) return;
  const filtered = buildFilteredCanvas();
  const final = rotateCanvas(filtered, state.rotBase);
  dstCanvas.width = final.width;
  dstCanvas.height = final.height;
  dstCtx.drawImage(final, 0, 0);
}

warpBtn.addEventListener('click', () => { runWarp(); });

// 自動検出は明示的なタップ時のみ実行
if (autoBtn) {
  autoBtn.addEventListener('click', () => {
    if (!state.bitmap) return;
    state.userAdjusted = false; // 自動結果で頂点を更新可能に
    startAutoDetect(state.loadToken);
  });
}

/* ============================================================
 * 自動輪郭検出（純 JS）
 *  - 縮小コピー上で大津の二値化 → 最大の明領域（紙）の四隅を推定
 *  - 元座標→表示座標へ戻して滑らかに移動
 *  - ユーザーが既に頂点を触っていれば尊重して上書きしない
 * ============================================================ */

// 控えめな「自動検出中…」インジケータ
let autoBadge = null;

function showAutoIndicator(on) {
  if (on) {
    if (!autoBadge) {
      autoBadge = document.createElement('div');
      autoBadge.className = 'auto-badge';
      autoBadge.innerHTML = '<span class="spinner"></span><span>自動検出中…</span>';
      srcWrap.appendChild(autoBadge);
    }
    autoBadge.hidden = false;
  } else if (autoBadge) {
    autoBadge.hidden = true;
  }
}

// 自動検出（純 JS・OpenCV 不要）。固まらない軽量実装。
function startAutoDetect(token) {
  if (token !== state.loadToken) return;
  showAutoIndicator(true);
  setStatus('work', '枠を自動検出中…', true);
  // 1〜2 フレーム譲ってインジケータを描画してから計算
  requestAnimationFrame(() => requestAnimationFrame(() => {
    let nativePts = null;
    try { nativePts = detectDocumentJS(); }
    catch (e) { console.warn('[scan-P] detectDocumentJS error', e); }
    showAutoIndicator(false);
    if (token !== state.loadToken) return;
    if (!nativePts) {
      setStatus('info', '枠を自動検出できませんでした — 手動で 4 点を合わせてください');
      return;
    }
    const ordered = orderCorners(nativePts);
    const viewPts = ordered.map((p) => ({
      x: p.x * state.scale + state.padX,
      y: p.y * state.scale + state.padY,
    }));
    state.userAdjusted = false;
    animatePoints(viewPts);
    setStatus('done', '枠を自動検出しました — 必要なら微調整してください');
  }));
}

// 大津の二値化で最も明るい連結領域（紙）を求め、その四隅を返す（純 JS）
function detectDocumentJS() {
  const target = 480; // 検出用の縮小（軽量）
  const longSide = Math.max(state.nativeW, state.nativeH);
  const s = Math.min(1, target / longSide);
  const dw = Math.max(1, Math.round(state.nativeW * s));
  const dh = Math.max(1, Math.round(state.nativeH * s));

  const c = document.createElement('canvas');
  c.width = dw; c.height = dh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(state.bitmap, 0, 0, dw, dh);
  const data = ctx.getImageData(0, 0, dw, dh).data;
  const n = dw * dh;

  // グレースケール＋ヒストグラム
  const gray = new Uint8Array(n);
  const hist = new Int32Array(256);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const g = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) | 0;
    gray[i] = g; hist[g]++;
  }

  // 大津の閾値
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    const wF = n - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; thr = t; }
  }

  // 明るい画素（紙候補）の最大連結成分を BFS で抽出
  const bright = new Uint8Array(n);
  for (let i = 0; i < n; i++) bright[i] = gray[i] > thr ? 1 : 0;
  const label = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let bestLabel = -1, bestSize = 0, cur = 0;
  for (let start = 0; start < n; start++) {
    if (!bright[start] || label[start] !== -1) continue;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = start; label[start] = cur;
    while (head < tail) {
      const p = queue[head++]; size++;
      const x = p % dw, y = (p / dw) | 0;
      if (x > 0) { const q = p - 1; if (bright[q] && label[q] === -1) { label[q] = cur; queue[tail++] = q; } }
      if (x < dw - 1) { const q = p + 1; if (bright[q] && label[q] === -1) { label[q] = cur; queue[tail++] = q; } }
      if (y > 0) { const q = p - dw; if (bright[q] && label[q] === -1) { label[q] = cur; queue[tail++] = q; } }
      if (y < dh - 1) { const q = p + dw; if (bright[q] && label[q] === -1) { label[q] = cur; queue[tail++] = q; } }
    }
    if (size > bestSize) { bestSize = size; bestLabel = cur; }
    cur++;
  }

  // 紙が小さすぎる／見つからない場合は失敗
  if (bestLabel === -1 || bestSize < n * 0.05) return null;

  // 最大成分の四隅（凸四角形の極値）を求める
  let tl = null, tr = null, br = null, bl = null;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (let i = 0; i < n; i++) {
    if (label[i] !== bestLabel) continue;
    const x = i % dw, y = (i / dw) | 0;
    const su = x + y, di = x - y;
    if (su < minSum) { minSum = su; tl = { x, y }; }
    if (su > maxSum) { maxSum = su; br = { x, y }; }
    if (di > maxDiff) { maxDiff = di; tr = { x, y }; }
    if (di < minDiff) { minDiff = di; bl = { x, y }; }
  }
  if (!tl || !tr || !br || !bl) return null;

  // 縮小座標 → 元画像座標
  const inv = 1 / s;
  return [tl, tr, br, bl].map((p) => ({ x: p.x * inv, y: p.y * inv }));
}

// 現在の頂点から目標位置へ滑らかに移動
function animatePoints(target) {
  const start = state.points.map((p) => ({ x: p.x, y: p.y }));
  const dur = 300;
  const t0 = performance.now();
  function step(now) {
    if (state.userAdjusted) { return; } // 途中で触られたら中断
    const k = Math.min(1, (now - t0) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOut
    state.points = target.map((tp, i) => ({
      x: start[i].x + (tp.x - start[i].x) * e,
      y: start[i].y + (tp.y - start[i].y) * e,
    }));
    drawOverlay();
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ============================================================
 * 仕上げフィルタ / 回転 / 保存（結果パネル内ツール）
 * ============================================================ */
// 濃さ行の有効/無効を仕上げに合わせて切替（白黒のみ操作可）
function updateBwRow() {
  const on = state.filter === 'bw';
  bwThresh.disabled = !on;
  bwRow.classList.toggle('is-disabled', !on);
}

filterSeg.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!state.warpedCanvas) return;
    filterSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.filter = btn.dataset.filter;
    updateBwRow();
    renderResult();
  });
});

// 白黒のしきい値（濃さ）。スライダー右=濃、左=薄。C = 10 - value
bwThresh.addEventListener('input', () => {
  if (!state.warpedCanvas) return;
  state.bwC = 10 - (parseFloat(bwThresh.value) || 0);
  renderResult();
});

// 回転（90°単位）
rotL.addEventListener('click', () => { if (!state.warpedCanvas) return; state.rotBase -= 90; renderResult(); });
rotR.addEventListener('click', () => { if (!state.warpedCanvas) return; state.rotBase += 90; renderResult(); });

// 結果を Blob 化
function resultBlob(mime, quality) {
  return new Promise((resolve) => dstCanvas.toBlob((b) => resolve(b), mime, quality));
}

function tsName(ext) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `scan-p_${ts}.${ext}`;
}

function downloadResult(mime, ext, quality) {
  if (!state.warpedCanvas) return;
  // toBlob + ObjectURL（toDataURL は高解像度で巨大文字列になりメモリを食うため）
  dstCanvas.toBlob((blob) => {
    if (!blob) { setStatus('error', '保存用データの生成に失敗しました'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = tsName(ext);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, mime, quality);
}

downloadPngBtn.addEventListener('click', () => downloadResult('image/png', 'png'));
downloadJpgBtn.addEventListener('click', () => downloadResult('image/jpeg', 'jpg', 0.92));

// 写真アプリへ保存（iOS は共有シート → 画像を保存）。非対応時は DL にフォールバック
savePhotoBtn.addEventListener('click', async () => {
  if (!state.warpedCanvas) return;
  try {
    const blob = await resultBlob('image/jpeg', 0.95);
    if (!blob) throw new Error('blob 生成に失敗');
    const file = new File([blob], tsName('jpg'), { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'scan-P' });
      setStatus('done', '共有メニューから「画像を保存」で写真に保存できます');
    } else {
      // 共有不可（PC など）→ ダウンロード
      downloadResult('image/jpeg', 'jpg', 0.95);
      setStatus('info', 'この環境では共有に未対応のため、ダウンロードしました');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // ユーザーがキャンセル
    console.warn('[scan-P] share failed', e);
    downloadResult('image/jpeg', 'jpg', 0.95);
    setStatus('info', '共有できなかったため、ダウンロードしました');
  }
});

/* ============================================================
 * クリップボード（貼り付け / コピー）
 * ============================================================ */
// 補正画像をクリップボードへコピー（PNG）
// 補正画像をクリップボードへコピー（PNG）。
// ※ WebKit(iOS Safari/Chrome) は「ユーザー操作と同じ実行フロー内」で
//   clipboard.write を呼ぶ必要がある。await でBlobを作ってから呼ぶと失敗するため、
//   ClipboardItem に Blob の Promise を渡し、await せず即 write する。
function copyResultToClipboard() {
  if (!state.warpedCanvas) return;
  if (!(navigator.clipboard && window.ClipboardItem && navigator.clipboard.write)) {
    setStatus('error', 'この環境はコピーに対応していません');
    return;
  }
  try {
    const blobPromise = new Promise((resolve, reject) => {
      try {
        dstCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('blob 生成に失敗'))), 'image/png');
      } catch (e) { reject(e); }
    });
    const item = new ClipboardItem({ 'image/png': blobPromise });
    // ここで await しない（ユーザー操作のフローを維持）
    navigator.clipboard.write([item]).then(
      () => setStatus('done', '補正画像をクリップボードにコピーしました'),
      (e) => {
        console.warn('[scan-P] copy failed', e);
        const n = (e && e.name) ? '：' + e.name : '';
        setStatus('error', 'コピーできませんでした' + n);
      }
    );
  } catch (e) {
    console.warn('[scan-P] copy failed', e);
    setStatus('error', 'コピーできませんでした（対応していない環境かもしれません）');
  }
}

// クリップボードの画像を貼り付けて読み込む（ボタン用：非同期 Clipboard API）
async function pasteFromClipboard() {
  setStatus('work', 'クリップボードを読み取り中…', true);
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) {
        const blob = await item.getType(type);
        await loadImageFile(blob);
        return;
      }
    }
    setStatus('info', 'クリップボードに画像が見つかりませんでした');
  } catch (e) {
    console.warn('[scan-P] paste failed', e);
    setStatus('error', 'クリップボードを読めませんでした（許可が必要かもしれません）');
  }
}

if (copyBtn) copyBtn.addEventListener('click', copyResultToClipboard);
if (pasteBtn) pasteBtn.addEventListener('click', pasteFromClipboard);

// Ctrl/Cmd+V でも貼り付け（主に PC）
window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const blob = it.getAsFile();
      if (blob) {
        e.preventDefault();
        loadImageFile(blob).catch((err) => {
          console.error(err);
          setStatus('error', '貼り付けた画像を読み込めませんでした');
        });
        return;
      }
    }
  }
});

// 読み取り専用デバッグフック（テスト用・副作用なし）
window.__dbgPoints = () => state.points.map((p) => ({ x: p.x, y: p.y }));

console.log('[scan-P] ready (' + BUILD + ')');
