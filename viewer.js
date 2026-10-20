'use strict';
/* ═══════════════════════════════════════════════════════════
   図面の表示: 拡大・縮小・移動(指2本 / ホイール)、タップ、長押しのルーペ
   図面と印は同じ入れ物の中にあるので、倍率を変えても必ず一緒に動く。
   拡大したら、見えている所だけ細かく描き直す(画質を保つ)
═══════════════════════════════════════════════════════════ */
const Viewer = (() => {
  const V = { s: 1, tx: 0, ty: 0, W: 0, H: 0, qb: 1, src: null, h: {} };
  let view, sheet, baseC, detC, svg, loupe, loupeC, bctx;
  const ptrs = new Map();
  let g = null;            // 今の操作
  let detTimer = null, detTask = null, detSeq = 0, renderSeq = 0;
  const DPR = () => Math.min(3, window.devicePixelRatio || 1);

  V.init = (els, handlers) => {
    ({ view, sheet, baseC, detC, svg, loupe, loupeC } = els);
    bctx = baseC.getContext('2d', { willReadFrequently: true });
    V.h = handlers;
    view.addEventListener('pointerdown', down);
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', cancel);
    view.addEventListener('wheel', wheel, { passive: false });
    view.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize', () => { if (V.src) { clamp(); apply(); scheduleDetail(); } });
  };

  /* src: { w, h(u), render(ctx, k, x0, y0, w, h) → Promise } */
  V.clear = () => { V.src = null; };
  V.show = async (src, keepView) => {
    const seq = ++renderSeq;
    V.src = src; V.W = src.w; V.H = src.h;
    V.qb = Math.min(1.25, Math.sqrt(9e6 / (V.W * V.H)));
    const bw = Math.round(V.W * V.qb), bh = Math.round(V.H * V.qb);
    const tmp = document.createElement('canvas'); tmp.width = bw; tmp.height = bh;
    const tctx = tmp.getContext('2d');
    tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, bw, bh);
    await src.render(tctx, V.qb, 0, 0, V.W, V.H);
    if (seq !== renderSeq) return false;
    baseC.width = bw; baseC.height = bh;
    bctx.drawImage(tmp, 0, 0);
    tmp.width = tmp.height = 0;
    for (const el of [baseC, svg]) { el.style.width = V.W + 'px'; el.style.height = V.H + 'px'; }
    sheet.style.width = V.W + 'px'; sheet.style.height = V.H + 'px';
    svg.setAttribute('viewBox', `0 0 ${V.W} ${V.H}`);
    detC.style.display = 'none';
    if (!keepView) V.fit(); else { clamp(); apply(); }
    scheduleDetail();
    return true;
  };
  V.fit = () => {
    const r = view.getBoundingClientRect();
    V.s = Math.min(r.width / V.W, r.height / V.H) * 0.98;
    V.tx = (r.width - V.W * V.s) / 2; V.ty = (r.height - V.H * V.s) / 2;
    apply(); scheduleDetail(); if (V.h.zoomed) V.h.zoomed();
  };
  V.centerOn = (x, y, s) => {
    const r = view.getBoundingClientRect();
    if (s) V.s = s;
    V.tx = r.width / 2 - x * V.s; V.ty = r.height * 0.42 - y * V.s;
    clamp(); apply(); scheduleDetail(); if (V.h.zoomed) V.h.zoomed();
  };
  V.fitS = () => { const r = view.getBoundingClientRect(); return Math.min(r.width / V.W, r.height / V.H) * 0.98; };
  V.toU = (cx, cy) => { const r = view.getBoundingClientRect(); return { x: (cx - r.left - V.tx) / V.s, y: (cy - r.top - V.ty) / V.s }; };
  V.toScreen = (x, y) => { const r = view.getBoundingClientRect(); return { x: r.left + V.tx + x * V.s, y: r.top + V.ty + y * V.s }; };

  function clamp() {
    const r = view.getBoundingClientRect(), fs = V.fitS();
    V.s = Math.max(fs * 0.6, Math.min(16, V.s));
    const m = 60, w = V.W * V.s, h = V.H * V.s;
    V.tx = Math.min(r.width - m, Math.max(m - w, V.tx));
    V.ty = Math.min(r.height - m, Math.max(m - h, V.ty));
  }
  function apply() { sheet.style.transform = `translate(${V.tx}px,${V.ty}px) scale(${V.s})`; }

  /* ── 見えている所を細かく描く ── */
  function scheduleDetail() { clearTimeout(detTimer); detTimer = setTimeout(renderDetail, 180); }
  async function renderDetail() {
    if (!V.src) return;
    const k = V.s * DPR();
    if (k <= V.qb * 1.15) { detC.style.display = 'none'; return; }
    const r = view.getBoundingClientRect();
    let x0 = Math.max(0, -V.tx / V.s), y0 = Math.max(0, -V.ty / V.s);
    let x1 = Math.min(V.W, (r.width - V.tx) / V.s), y1 = Math.min(V.H, (r.height - V.ty) / V.s);
    if (x1 <= x0 || y1 <= y0) return;
    let kk = k; const maxPx = 7e6;
    if ((x1 - x0) * (y1 - y0) * kk * kk > maxPx) kk = Math.sqrt(maxPx / ((x1 - x0) * (y1 - y0)));
    const seq = ++detSeq;
    const c = document.createElement('canvas');
    c.width = Math.ceil((x1 - x0) * kk); c.height = Math.ceil((y1 - y0) * kk);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    try { await V.src.render(ctx, kk, x0, y0, x1 - x0, y1 - y0); } catch (e) { return; }
    if (seq !== detSeq) return;
    detC.width = c.width; detC.height = c.height;
    detC.getContext('2d').drawImage(c, 0, 0); c.width = c.height = 0;
    Object.assign(detC.style, { left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px', display: 'block' });
  }
  V.redetail = scheduleDetail;

  /* ── 吸着: 図面の線(色の変わり目)の中心に寄せる(拾い帳 v5 と同じ方法) ── */
  V.snapEdge = (x, y, radU) => {
    if (!baseC.width) return null;
    const q = V.qb, cx = x * q, cy = y * q;
    const r = Math.max(4, Math.min(40, Math.round(radU * q))), ix = Math.round(cx), iy = Math.round(cy);
    const x0 = Math.max(1, ix - r), y0 = Math.max(1, iy - r), x1 = Math.min(baseC.width - 2, ix + r), y1 = Math.min(baseC.height - 2, iy + r);
    const w = x1 - x0 + 1, h = y1 - y0 + 1; if (w < 3 || h < 3) return null;
    let img; try { img = bctx.getImageData(x0 - 1, y0 - 1, w + 2, h + 2).data; } catch (e) { return null; }
    const W = w + 2, lum = (xx, yy) => { const k = (yy * W + xx) * 4; return img[k] * .299 + img[k + 1] * .587 + img[k + 2] * .114; };
    let best = null, bs = 0;
    for (let yy = 1; yy <= h; yy++) for (let xx = 1; xx <= w; xx++) {
      const edge = Math.abs(lum(xx + 1, yy) - lum(xx - 1, yy)) + Math.abs(lum(xx, yy + 1) - lum(xx, yy - 1));
      if (edge < 28) continue;
      const px = x0 + xx - 1, py = y0 + yy - 1, d = Math.hypot(px - cx, py - cy); if (d > r) continue;
      const sc = edge * (.72 + .55 * (1 - d / (r + 1))); if (sc > bs) { bs = sc; best = { x: px, y: py }; }
    }
    if (!best || bs <= 42) return null;
    let sx = 0, sy = 0, sw = 0;
    for (let yy = Math.max(1, best.y - y0 - 1); yy <= Math.min(h, best.y - y0 + 3); yy++) for (let xx = Math.max(1, best.x - x0 - 1); xx <= Math.min(w, best.x - x0 + 3); xx++) {
      const Lm = lum(xx, yy), edge = Math.abs(lum(xx + 1, yy) - lum(xx - 1, yy)) + Math.abs(lum(xx, yy + 1) - lum(xx, yy - 1));
      const wt = edge + Math.max(0, 190 - Lm) * .35; if (wt > 20) { sx += (x0 + xx - 1) * wt; sy += (y0 + yy - 1) * wt; sw += wt; }
    }
    const p = sw ? { x: sx / sw, y: sy / sw } : best;
    return { x: p.x / q, y: p.y / q };
  };

  /* ── ルーペ(長押し中): 指の下を拡大して見せる ── */
  function showLoupe(cx, cy, pU) {
    const r = view.getBoundingClientRect();
    let lx = cx - r.left - 60, ly = cy - r.top - 150;
    if (ly < 4) ly = cy - r.top + 40;
    lx = Math.max(4, Math.min(r.width - 124, lx));
    loupe.style.left = lx + 'px'; loupe.style.top = ly + 'px'; loupe.style.display = 'block';
    const ctx = loupeC.getContext('2d'), mag = 2.5;            // 画面の 2.5 倍
    const half = 60 / (V.s * mag);                             // ルーペの半径(u)
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 240, 240);
    const useDet = detC.style.display === 'block' && detC.width;
    if (useDet) {
      const dl = parseFloat(detC.style.left), dt = parseFloat(detC.style.top), dk = detC.width / parseFloat(detC.style.width);
      ctx.drawImage(detC, (pU.x - half - dl) * dk, (pU.y - half - dt) * dk, half * 2 * dk, half * 2 * dk, 0, 0, 240, 240);
    } else {
      ctx.drawImage(baseC, (pU.x - half) * V.qb, (pU.y - half) * V.qb, half * 2 * V.qb, half * 2 * V.qb, 0, 0, 240, 240);
    }
    if (V.h.loupeOverlay) V.h.loupeOverlay(ctx, pU, 240 / (half * 2));
  }
  function hideLoupe() { loupe.style.display = 'none'; }

  /* ── 指・マウス ── */
  function down(e) {
    if (e.button === 2) return;
    view.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) {
      g = { type: 'one', sx: e.clientX, sy: e.clientY, t: Date.now(), tx0: V.tx, ty0: V.ty, moved: false, loupe: false, mouse: e.pointerType === 'mouse' };
      if (!g.mouse && V.h.wantsLoupe && V.h.wantsLoupe()) {
        g.timer = setTimeout(() => { if (g && g.type === 'one' && !g.moved) { g.loupe = true; loupeAt(g.sx, g.sy); } }, 380);
      }
    } else if (ptrs.size === 2) {
      if (g && g.timer) clearTimeout(g.timer);
      hideLoupe();
      const [a, b] = [...ptrs.values()];
      g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, s0: V.s, tx0: V.tx, ty0: V.ty };
    }
  }
  function loupeAt(cx, cy) {
    const p = V.h.loupePoint ? V.h.loupePoint(V.toU(cx, cy)) : V.toU(cx, cy);
    g.lp = p; showLoupe(cx, cy, p);
  }
  function move(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!g) return;
    if (g.type === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const r = view.getBoundingClientRect();
      const ns = Math.max(V.fitS() * 0.6, Math.min(16, g.s0 * d / g.d0)), f = ns / g.s0;
      V.s = ns;
      V.tx = (c.x - r.left) - (g.c0.x - r.left - g.tx0) * f;
      V.ty = (c.y - r.top) - (g.c0.y - r.top - g.ty0) * f;
      clamp(); apply();
      return;
    }
    if (g.type === 'one') {
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (g.loupe) { loupeAt(e.clientX, e.clientY); return; }
      if (!g.moved && Math.hypot(dx, dy) > (g.mouse ? 4 : 9)) { g.moved = true; if (g.timer) clearTimeout(g.timer); }
      if (g.moved) { V.tx = g.tx0 + dx; V.ty = g.ty0 + dy; clamp(); apply(); }
    }
  }
  function up(e) {
    ptrs.delete(e.pointerId);
    if (!g) return;
    if (g.type === 'one') {
      if (g.timer) clearTimeout(g.timer);
      if (g.loupe) { hideLoupe(); if (V.h.place) V.h.place(g.lp, e); }
      else if (!g.moved) { if (V.h.tap) V.h.tap(V.toU(e.clientX, e.clientY), e); }
      else { scheduleDetail(); if (V.h.zoomed) V.h.zoomed(); }
      g = null;
    } else if (g.type === 'pinch' && ptrs.size === 0) {
      g = null; scheduleDetail(); if (V.h.zoomed) V.h.zoomed();
    } else if (g.type === 'pinch' && ptrs.size === 1) {
      // 1本残ったら、その指で移動を続ける
      const [p] = [...ptrs.values()];
      g = { type: 'one', sx: p.x, sy: p.y, t: Date.now(), tx0: V.tx, ty0: V.ty, moved: true };
    }
  }
  function cancel(e) { ptrs.delete(e.pointerId); if (g && g.timer) clearTimeout(g.timer); hideLoupe(); g = null; scheduleDetail(); }
  function wheel(e) {
    e.preventDefault();
    const r = view.getBoundingClientRect(), f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
    const ns = Math.max(V.fitS() * 0.6, Math.min(16, V.s * f)), k = ns / V.s;
    V.tx = (e.clientX - r.left) - (e.clientX - r.left - V.tx) * k;
    V.ty = (e.clientY - r.top) - (e.clientY - r.top - V.ty) * k;
    V.s = ns; clamp(); apply(); scheduleDetail();
    clearTimeout(V._wt); V._wt = setTimeout(() => { if (V.h.zoomed) V.h.zoomed(); }, 120);
  }
  return V;
})();
