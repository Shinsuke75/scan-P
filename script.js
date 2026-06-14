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
const dstCtx = dstCanvas.getContext('2d');

// ---- アプリ状態 ----
const state = {
  bitmap: null,      // EXIF 補正済みの元解像度 ImageBitmap
  nativeW: 0,        // 元画像の幅（px）
  nativeH: 0,        // 元画像の高さ（px）
  viewW: 0,          // 表示キャンバスの幅（px）
  viewH: 0,          // 表示キャンバスの高さ（px）
  scale: 1,          // view / native（表示→元の変換は 1/scale）
  points: [],        // 表示座標系の頂点 [{x,y} x4]（TL,TR,BR,BL の並びを意図）
  warpedColor: null, // 直近の補正結果（カラー）の cv.Mat
  loadToken: 0,      // 画像入れ替え検出用トークン（古い自動検出の適用を防ぐ）
  userAdjusted: false, // ユーザーが頂点を手動調整したか（自動検出の上書き抑止）
  filter: 'color',   // 仕上げフィルタ
  autoDetectTimer: null, // 自動検出の遅延実行タイマー
  autoDetectIdle: null,  // requestIdleCallback の ID
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
  cancelAutoDetect();
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
  if (state.warpedColor) { state.warpedColor.delete(); state.warpedColor = null; }
  dstCtx.clearRect(0, 0, dstCanvas.width, dstCanvas.height);
  dstCanvas.width = 0; dstCanvas.height = 0;
  dstPlaceholder.hidden = false;
  filterGroup.hidden = true;
  downloadGroup.hidden = true;

  renderSource();

  // フォールバック 4 点を即座に表示（B: ユーザーを待たせない）
  state.points = makeFallbackPoints(state.viewW, state.viewH);
  drawOverlay();

  warpBtn.disabled = false;
  setStatus('info',
    `読み込み完了（${state.nativeW}×${state.nativeH}px）— すぐに 4 点を調整できます`);

  // 読み込み直後の手動調整を優先し、短い遅延後に自動検出を開始
  scheduleAutoDetect(state.loadToken);
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

overlayCanvas.addEventListener('pointerdown', (ev) => {
  if (state.points.length !== 4) return;
  const pos = toCanvasPos(ev);
  const idx = hitTest(pos);
  if (idx === -1) return;
  cancelAutoDetect();
  activeIdx = idx;
  state.userAdjusted = true; // 以後、自動検出結果で上書きしない
  overlayCanvas.setPointerCapture(ev.pointerId); // 外へ出ても追従
  overlayCanvas.style.cursor = 'grabbing';
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

/* ============================================================
 * OpenCV.js 遅延ロード（B）
 *  - 複数 CDN へフォールバック。1 つが遅ければ短いタイムアウトで
 *    次の CDN を追加投入し、最初に初期化できたものを採用する。
 *    （docs.opencv.org は CDN ではなく低速・不達になりやすいため）
 *  - 配布形態の違い（クラシック / Promise / MODULARIZE 関数）に対応。
 *  - 「cv.Mat が使えるか」のポーリングを最終的な初期化判定にする。
 * ============================================================ */
const OPENCV_URLS = [
  'https://docs.opencv.org/4.x/opencv.js',
  'https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js',
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.11.0-release.1/dist/opencv.js',
];
const PER_ATTEMPT_MS = 18000;   // この時間で初期化しなければ次の CDN へ
const OVERALL_MS = 90000;       // 全体の最終タイムアウト
let cvLoadPromise = null;

function ensureOpenCV() {
  if (cvLoadPromise) return cvLoadPromise;
  cvLoadPromise = new Promise((resolve, reject) => {
    const READY = () => window.cv && typeof window.cv.Mat === 'function';

    let settled = false;
    let poller = null, overall = null, attemptTimer = null, idx = 0;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poller); clearTimeout(overall); clearTimeout(attemptTimer);
      resolve(window.cv);
    };
    const failAll = (msg) => {
      if (settled) return;
      settled = true;
      clearInterval(poller); clearTimeout(overall); clearTimeout(attemptTimer);
      cvLoadPromise = null; // 失敗はキャッシュせず再試行可能に
      reject(new Error(msg));
    };

    if (READY()) { resolve(window.cv); return; }

    // 初期化検知（全形態・全 CDN 共通の安全網）
    poller = setInterval(() => { if (READY()) finish(); }, 120);
    overall = setTimeout(() => {
      if (!READY()) failAll('OpenCV.js を読み込めませんでした（全 CDN タイムアウト）');
    }, OVERALL_MS);

    // 解決値モジュールを window.cv に反映し、初期化完了を待つ
    const adopt = (mod) => {
      if (mod && typeof mod === 'object') {
        window.cv = mod;
        if (typeof mod.Mat === 'function') { finish(); return; }
        try { mod.onRuntimeInitialized = () => finish(); } catch (_) {}
      }
    };

    const handleLoad = () => {
      try {
        const c = window.cv;
        if (typeof c === 'function') {
          Promise.resolve(c()).then(adopt).catch(() => {}); // MODULARIZE 関数
        } else if (c && typeof c.then === 'function') {
          c.then(adopt).catch(() => {});                    // Promise 形式
        } else if (c && typeof c === 'object') {
          try { c.onRuntimeInitialized = () => finish(); } catch (_) {} // クラシック
        }
      } catch (_) { /* ポーリングに委ねる */ }
    };

    const tryNext = () => {
      if (settled || READY()) return;
      if (idx >= OPENCV_URLS.length) return; // 残りは overall タイムアウトが処理
      const url = OPENCV_URLS[idx++];
      setStatus('work',
        `OpenCV を読み込み中…（${idx}/${OPENCV_URLS.length}・初回は数 MB の DL）`, true);

      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.dataset.opencv = '1';
      s.onload = handleLoad;
      s.onerror = () => { clearTimeout(attemptTimer); tryNext(); }; // 即・次へ
      document.head.appendChild(s);

      clearTimeout(attemptTimer);
      attemptTimer = setTimeout(() => { if (!READY()) tryNext(); }, PER_ATTEMPT_MS);
    };

    tryNext();
  });
  return cvLoadPromise;
}

/* ============================================================
 * 補正実行（4: 座標変換・並べ替え・出力サイズ算出・clamp・warp）
 * ============================================================ */

// 表示座標の頂点を元画像座標へ変換
function pointsToNative(points) {
  const inv = 1 / state.scale;
  return points.map((p) => ({ x: p.x * inv, y: p.y * inv }));
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

// 元解像度の cv.Mat を生成（ImageBitmap → 元サイズ canvas → imread）
function readNativeMat(cv) {
  const tmp = document.createElement('canvas');
  tmp.width = state.nativeW;
  tmp.height = state.nativeH;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(state.bitmap, 0, 0, state.nativeW, state.nativeH);
  const mat = cv.imread(tmp); // RGBA
  return mat;
}

async function runWarp() {
  if (!state.bitmap || state.points.length !== 4) return;
  warpBtn.disabled = true;
  setStatus('work', 'OpenCV を準備中…', true);

  let cv;
  try {
    cv = await ensureOpenCV();
  } catch (e) {
    console.error(e);
    setStatus('error', 'OpenCV.js の読み込みに失敗しました（ネットワークをご確認ください）');
    warpBtn.disabled = false;
    return;
  }

  setStatus('work', '台形補正を実行中…', true);
  // 描画フレームを挟んでスピナーを反映させる
  await new Promise((r) => requestAnimationFrame(() => r()));

  let src = null, dst = null, M = null, srcTri = null, dstTri = null;
  try {
    // A: 表示座標 → 元座標へ変換してから使う
    const native = pointsToNative(state.points);
    const ordered = orderCorners(native);
    const { outW, outH } = computeOutputSize(ordered);

    src = readNativeMat(cv);

    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      ordered[0].x, ordered[0].y,
      ordered[1].x, ordered[1].y,
      ordered[2].x, ordered[2].y,
      ordered[3].x, ordered[3].y,
    ]);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      outW, 0,
      outW, outH,
      0, outH,
    ]);

    M = cv.getPerspectiveTransform(srcTri, dstTri);
    dst = new cv.Mat();
    cv.warpPerspective(
      src, dst, M, new cv.Size(outW, outH),
      cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255)
    );

    // 結果（カラー）を保持し、フィルタ適用して表示
    if (state.warpedColor) { state.warpedColor.delete(); }
    state.warpedColor = dst;
    dst = null; // 所有権を state へ移譲（finally で delete しない）

    renderResult();

    dstPlaceholder.hidden = true;
    filterGroup.hidden = false;
    downloadGroup.hidden = false;
    setStatus('done', `補正完了（${outW}×${outH}px）`);
  } catch (e) {
    console.error(e);
    setStatus('error', '補正処理でエラーが発生しました');
  } finally {
    if (src) src.delete();
    if (M) M.delete();
    if (srcTri) srcTri.delete();
    if (dstTri) dstTri.delete();
    if (dst) dst.delete();
    warpBtn.disabled = false;
  }
}

// 結果 Mat に仕上げフィルタを適用して結果キャンバスへ表示
function renderResult() {
  const cv = window.cv;
  if (!cv || !state.warpedColor) return;
  const base = state.warpedColor;

  if (state.filter === 'color') {
    cv.imshow(dstCanvas, base);
    return;
  }

  let gray = new cv.Mat();
  let bw = null;
  try {
    cv.cvtColor(base, gray, cv.COLOR_RGBA2GRAY);
    if (state.filter === 'gray') {
      cv.imshow(dstCanvas, gray);
      return;
    }
    // 白黒 2 値化（紙のスキャン風）: 適応的しきい値
    bw = new cv.Mat();
    cv.adaptiveThreshold(
      gray, bw, 255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 10
    );
    cv.imshow(dstCanvas, bw);
  } finally {
    gray.delete();
    if (bw) bw.delete();
  }
}

warpBtn.addEventListener('click', () => { runWarp(); });

/* ============================================================
 * 自動輪郭検出（2 / 5）
 *  - OpenCV ロード完了後に、縮小コピー上で検出（モバイル負荷対策）
 *  - 最大の四角形を検出し、元座標→表示座標へ戻して滑らかに移動
 *  - ユーザーが既に頂点を触っていれば尊重して上書きしない
 * ============================================================ */

// 控えめな「自動検出中…」インジケータ
let autoBadge = null;
const AUTO_DETECT_DELAY_MS = 650;

function cancelAutoDetect() {
  if (state.autoDetectTimer !== null) {
    clearTimeout(state.autoDetectTimer);
    state.autoDetectTimer = null;
  }
  if (state.autoDetectIdle !== null && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(state.autoDetectIdle);
    state.autoDetectIdle = null;
  }
}

function scheduleAutoDetect(token) {
  cancelAutoDetect();
  state.autoDetectTimer = setTimeout(() => {
    state.autoDetectTimer = null;
    if (token !== state.loadToken || state.userAdjusted || activeIdx !== -1) return;
    const run = () => {
      if (token !== state.loadToken || state.userAdjusted || activeIdx !== -1) return;
      startAutoDetect(token);
    };
    if (typeof window.requestIdleCallback === 'function') {
      state.autoDetectIdle = window.requestIdleCallback(() => {
        state.autoDetectIdle = null;
        run();
      }, { timeout: 900 });
      return;
    }
    run();
  }, AUTO_DETECT_DELAY_MS);
}

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

// エラー＋「再試行」ボタンをステータスに表示
function showRetryStatus(message) {
  statusEl.hidden = false;
  statusEl.className = 'status error';
  statusEl.innerHTML =
    '<span>' + message + '</span>' +
    '<button id="retryDetectBtn" class="btn btn-ghost" ' +
    'style="margin-left:auto;padding:6px 12px;min-height:34px;">再試行</button>';
  const btn = document.getElementById('retryDetectBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      if (!state.bitmap) return;
      startAutoDetect(state.loadToken);
    });
  }
}

async function startAutoDetect(token) {
  if (token !== state.loadToken || state.userAdjusted || activeIdx !== -1) return;
  showAutoIndicator(true);
  // ステータスにも明示（モバイルはコンソールが見えないため）
  if (!(window.cv && window.cv.Mat)) {
    setStatus('work', 'OpenCV を読み込み中…（初回は数 MB の DL で時間がかかります）', true);
  }

  let cv;
  try {
    cv = await ensureOpenCV();
  } catch (e) {
    console.warn('[scan-P] OpenCV load failed during auto-detect', e);
    showAutoIndicator(false);
    // 失敗を画面に出し、手動操作と再試行へ誘導
    showRetryStatus('自動検出を準備できませんでした（' + e.message + '）');
    return;
  }
  // 画像が入れ替わった／手動操作開始なら中断
  if (token !== state.loadToken || state.userAdjusted || activeIdx !== -1) {
    showAutoIndicator(false);
    if (token === state.loadToken && state.userAdjusted) {
      setStatus('info', '手動で 4 点を調整中です');
    }
    return;
  }
  // 重い処理の前に 1 フレーム譲ってインジケータを描画
  await new Promise((r) => requestAnimationFrame(() => r()));

  let nativePts = null;
  try {
    nativePts = detectDocument(cv);
  } catch (e) {
    console.warn('[scan-P] detectDocument error', e);
  }
  showAutoIndicator(false);

  if (token !== state.loadToken) return;     // 古い結果は破棄
  if (state.userAdjusted || activeIdx !== -1) return; // 手動調整を尊重
  if (!nativePts) {
    setStatus('info', '自動検出できませんでした — 手動で 4 点を合わせてください');
    return;
  }

  const ordered = orderCorners(nativePts);
  const viewPts = ordered.map((p) => ({ x: p.x * state.scale, y: p.y * state.scale }));
  animatePoints(viewPts);
  setStatus('done', '書類の輪郭を自動検出しました — 必要なら微調整してください');
}

// 縮小コピー上で四角形輪郭を検出し、元画像座標の 4 点を返す（なければ null）
function detectDocument(cv) {
  const target = 640; // 検出用の長辺目安（軽量化）
  const longSide = Math.max(state.nativeW, state.nativeH);
  const dscale = Math.min(1, target / longSide);
  const dw = Math.max(1, Math.round(state.nativeW * dscale));
  const dh = Math.max(1, Math.round(state.nativeH * dscale));

  const tmp = document.createElement('canvas');
  tmp.width = dw; tmp.height = dh;
  tmp.getContext('2d').drawImage(state.bitmap, 0, 0, dw, dh);

  let src = cv.imread(tmp);
  let gray = new cv.Mat();
  let blur = new cv.Mat();
  let edges = new cv.Mat();
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  let best = null;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 75, 200);
    // 縁の途切れを閉じる
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, k);
    k.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let maxArea = dw * dh * 0.18; // 画像の 18% 以上の四角形のみ採用
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = Math.abs(cv.contourArea(approx));
        if (area > maxArea) {
          maxArea = area;
          const pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          }
          best = pts;
        }
      }
      approx.delete();
      cnt.delete();
    }
  } finally {
    src.delete(); gray.delete(); blur.delete(); edges.delete();
    contours.delete(); hierarchy.delete();
  }

  if (!best) return null;
  // 縮小コピー座標 → 元画像座標へ
  const inv = 1 / dscale;
  return best.map((p) => ({ x: p.x * inv, y: p.y * inv }));
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
 * 仕上げフィルタ切り替え（5）＋ダウンロード
 * ============================================================ */
filterGroup.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!state.warpedColor) return;
    filterGroup.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.filter = btn.dataset.filter;
    renderResult();
  });
});

function downloadResult(mime, ext, quality) {
  if (!state.warpedColor) return;
  const url = dstCanvas.toDataURL(mime, quality);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `scan-p_${ts}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

downloadPngBtn.addEventListener('click', () => downloadResult('image/png', 'png'));
downloadJpgBtn.addEventListener('click', () => downloadResult('image/jpeg', 'jpg', 0.92));

console.log('[scan-P] ready (stage 6: filters + download)');
