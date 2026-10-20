'use strict';
/* ═══════════════════════════════════════════════════════════
   印刷用の PDF: 図面(拾った印・線の長さ・部材名・重さ・工区)と、
   その次のページにその図面の部材の表。図面1 → 表1 → 図面2 → 表2 …
   図面と表はそれぞれ画像にして PDF に入れる(約200dpi)
═══════════════════════════════════════════════════════════ */
const PrintPdf = (() => {
  let loading = null;
  function load() {
    if (window.PDFLib) return Promise.resolve();
    return loading || (loading = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'pdf-lib.min.js';
      s.onload = res; s.onerror = () => { loading = null; rej(new Error('PDF の部品を読み込めませんでした')); };
      document.head.appendChild(s);
    }));
  }
  const DPI = 150;                                       // iPhone のメモリに収まるように
  const FONT = '-apple-system,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo","Noto Sans CJK JP",sans-serif';
  const MAXPX = 8e6;                                       // 1枚の画像の画素数の上限(iPhone はメモリが少ない)
  const toBytes = c => new Promise((res, rej) => c.toBlob(b => b ? b.arrayBuffer().then(a => res(new Uint8Array(a)), rej) : rej(new Error('PDF の画像を作れませんでした(図面が大きすぎます)')), 'image/jpeg', 0.88));
  const dpiFor = (wPt, hPt) => Math.min(DPI, 72 * Math.sqrt(MAXPX / (wPt * hPt)));

  /* 図面 + 印 */
  async function drawingCanvas(P, pi, src) {
    const pg = P.pages[pi];
    const pxPerPt = dpiFor(src.w / RS, src.h / RS) / 72, k = pxPerPt / RS;   // 1u あたりの px
    const c = document.createElement('canvas');
    c.width = Math.round(src.w * k); c.height = Math.round(src.h * k);
    const ctx = c.getContext('2d'); if (!ctx) throw new Error('メモリが足りず PDF を作れませんでした。アプリを開き直してからもう一度お試しください'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    // 'print' で描く(画面を切り替えても止まらない)。1分たっても終わらなければ止めて知らせる
    let tm; await Promise.race([src.render(ctx, k, 0, 0, src.w, src.h, true),
      new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(pageName(P, pi) + ' の図面を描けませんでした(時間切れ)')), 60000); })]).finally(() => clearTimeout(tm));
    const pt = v => v * pxPerPt;                           // 紙の上の pt → px
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const label = (txt, x, y, col, size, align, box) => {
      ctx.font = `700 ${pt(size)}px ${FONT}`; ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
      if (box) {   // 図面の文字と重なっても読めるように、白い下地と枠を付ける
        const w = ctx.measureText(txt).width, h = pt(size * 1.35), pad = pt(1.5);
        const x0 = (align === 'left' ? x : x - w / 2) - pad, y0 = y - h / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(x0, y0, w + pad * 2, h);
        ctx.lineWidth = pt(0.5); ctx.strokeStyle = col; ctx.strokeRect(x0, y0, w + pad * 2, h);
      } else { ctx.lineWidth = pt(2.2); ctx.strokeStyle = '#fff'; ctx.strokeText(txt, x, y); }
      ctx.fillStyle = col; ctx.fillText(txt, x, y);
    };
    // 伏図の範囲
    secsOf(pg).forEach(sc => {
      ctx.beginPath(); sc.pts.forEach((p, i) => i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)); ctx.closePath();
      ctx.setLineDash([pt(8), pt(4)]); ctx.lineWidth = pt(1.4); ctx.strokeStyle = '#2563ab'; ctx.stroke(); ctx.setLineDash([]);
      const x0 = Math.min(...sc.pts.map(p => p.x)), y0 = Math.min(...sc.pts.map(p => p.y));
      ctx.font = `700 ${pt(13)}px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.lineWidth = pt(3); ctx.strokeStyle = '#fff';
      ctx.strokeText(sc.name, x0 * k + pt(4), y0 * k + pt(4)); ctx.fillStyle = '#2563ab'; ctx.fillText(sc.name, x0 * k + pt(4), y0 * k + pt(4));
    });
    // 工区
    pg.zones.forEach(z => {
      ctx.beginPath(); z.pts.forEach((p, i) => i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)); ctx.closePath();
      ctx.fillStyle = z.color + '14'; ctx.fill();
      ctx.setLineDash([pt(5), pt(3)]); ctx.lineWidth = pt(1.1); ctx.strokeStyle = z.color; ctx.stroke(); ctx.setLineDash([]);
      const cx = z.pts.reduce((s, p) => s + p.x, 0) / z.pts.length, cy = z.pts.reduce((s, p) => s + p.y, 0) / z.pts.length;
      label(z.name, cx * k, cy * k, z.color, 11);
    });
    // 線
    pg.lens.forEach(l => {
      const it = itemOf(P, l.it); const col = it ? it.color : '#888';
      const mm = lenMm(pg, l), kg = lineKg(it, mm), j = it ? judge(P, it, kg) : '';
      ctx.beginPath(); ctx.moveTo(l.x1 * k, l.y1 * k); ctx.lineTo(l.x2 * k, l.y2 * k);
      ctx.lineWidth = pt(1.6); ctx.strokeStyle = col; ctx.setLineDash(j === '手付' ? [pt(4), pt(2.5)] : []); ctx.stroke(); ctx.setLineDash([]);
      const m = markPt(l), d = Math.hypot(l.x2 - l.x1, l.y2 - l.y1) || 1;
      let ox = (l.y2 - l.y1) / d, oy = -(l.x2 - l.x1) / d; if (oy > 0 || (oy === 0 && ox > 0)) { ox = -ox; oy = -oy; }
      const parts = [it ? it.name : '?'];
      if (pg.scale) parts.push(Math.round(mm).toLocaleString('ja-JP'));
      if (kg) parts.push(kg.toFixed(1) + 'kg');
      if (j) parts.push(j);
      if (pg.zones.length) parts.push(needsZone(pg, l) ? '工区?' : (zoneOfMark(pg, l) || '工区外'));
      label(parts.join(' '), m.x * k + ox * pt(7), m.y * k + oy * pt(7), col, 5.5, 'center', true);
    });
    // 個
    pg.dots.forEach(o => {
      const it = itemOf(P, o.it); const col = it ? it.color : '#888';
      ctx.beginPath(); ctx.arc(o.x * k, o.y * k, pt(2.6), 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = pt(0.7); ctx.strokeStyle = '#fff'; ctx.stroke();
      const parts = [it ? it.name : '?']; if (it && it.w) parts.push(it.w + 'kg');
      if (pg.zones.length) parts.push(zoneOfMark(pg, o) || '工区外');
      label(parts.join(' '), o.x * k + pt(4.5), o.y * k, col, 5.5, 'left', true);
    });
    // 見出し(左上)
    label((P.name === pageName(P, pi) ? '' : P.name + '  ') + pageName(P, pi) + (pg.scale ? '  1/' + Math.round(scaleN(pg) * 100) / 100 : '  縮尺未設定'), pt(14), pt(12), '#2b2620', 8, 'left');
    return { c, wPt: src.w / RS, hPt: src.h / RS };
  }

  /* その図面の部材の表(1ページに入らなければ続きのページ) */
  function* tableCanvases(P, pi, A, wPt, hPt) {
    const pg = P.pages[pi], pxPerPt = dpiFor(wPt, hPt) / 72, pt = v => v * pxPerPt;
    const zs = [...new Set(pg.zones.map(z => z.name))].sort(natCmp);
    const rows = [];
    P.items.forEach(it => {
      const c = A.PG[it.id][pi]; if (!c.n) return;
      let zt = '';
      if (zs.length) {
        const per = {};
        A.rows.filter(r => r.pi === pi && r.it === it).forEach(r => { const k = r.cross ? '未定' : (r.zone === '__none' ? '工区外' : r.zone); per[k] = (per[k] || 0) + 1; });
        zt = Object.keys(per).sort(natCmp).map(k => k + ' ' + per[k]).join('  ');
      }
      rows.push({ it, c, zt });
    });
    const cols = [
      { h: '', w: 14 }, { h: '部材名', w: 120, al: 'left' }, { h: '種類', w: 40 }, { h: '数', w: 60, al: 'right' },
      { h: '長さ m', w: 70, al: 'right' }, { h: '吊', w: 40, al: 'right' }, { h: '手付', w: 40, al: 'right' }, { h: '重量 kg', w: 80, al: 'right' },
      ...(zs.length ? [{ h: '工区ごと', w: 0, al: 'left' }] : [])
    ];
    const margin = 36, rowH = 22, top = 70;
    const usable = wPt - margin * 2; const fixed = cols.reduce((s, c) => s + c.w, 0);
    if (zs.length) cols[cols.length - 1].w = Math.max(120, usable - fixed);
    const perPage = Math.max(1, Math.floor((hPt - top - margin - rowH * 2) / rowH));

    const total = { n: 0, mm: 0, sl: 0, hd: 0, kg: 0 };
    rows.forEach(r => { total.kg += r.c.kg; total.sl += r.c.sl; total.hd += r.c.hd; });
    for (let s = 0; s === 0 || s < rows.length; s += perPage) {
      const c = document.createElement('canvas'); c.width = Math.round(pt(wPt)); c.height = Math.round(pt(hPt));
      const ctx = c.getContext('2d'); if (!ctx) throw new Error('メモリが足りず PDF を作れませんでした。アプリを開き直してからもう一度お試しください'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      const text = (t, x, y, size, al, bold, col) => { ctx.font = `${bold ? 700 : 400} ${pt(size)}px ${FONT}`; ctx.textAlign = al || 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = col || '#2b2620'; ctx.fillText(t, pt(x), pt(y)); };
      text(pageName(P, pi) + ' の部材' + (s ? '(つづき)' : ''), margin, 34, 15, 'left', true);
      text(P.name + (pg.scale ? '   縮尺 1/' + Math.round(scaleN(pg) * 100) / 100 : '   縮尺 未設定') + '   ' + new Date().toLocaleDateString('ja-JP'), margin, 54, 9, 'left', false, '#6b6355');
      let x = margin, y = top;
      const hline = (yy, w) => { ctx.beginPath(); ctx.moveTo(pt(margin), pt(yy)); ctx.lineTo(pt(margin + usable), pt(yy)); ctx.lineWidth = pt(w); ctx.strokeStyle = '#2b2620'; ctx.stroke(); };
      hline(y, 1.2);
      cols.forEach(cl => { text(cl.h, cl.al === 'right' ? x + cl.w - 4 : x + 4, y + rowH / 2, 9, cl.al === 'right' ? 'right' : 'left', true, '#6b6355'); x += cl.w; });
      y += rowH; hline(y, 0.6);
      const page = rows.slice(s, s + perPage);
      if (!rows.length) text('この図面では、まだ何も拾っていません', margin + 4, y + rowH / 2, 10, 'left', false, '#6b6355');
      page.forEach(r => {
        const it = r.it, cc = r.c;
        const vals = ['', it.name, KIND[it.kind].lbl,
          it.kind === 'm' ? (cc.mm / 1000).toFixed(2) + ' m' : cc.n + ' ' + KIND[it.kind].unit,
          it.kind !== 'pcs' && cc.mm ? (cc.mm / 1000).toFixed(2) : '',
          it.kind === 'mem' && cc.sl ? String(cc.sl) : '', it.kind === 'mem' && cc.hd ? String(cc.hd) : '',
          cc.kg ? cc.kg.toFixed(1) : '', r.zt];
        x = margin;
        cols.forEach((cl, i) => {
          if (i === 0) { ctx.fillStyle = it.color; ctx.fillRect(pt(x + 2), pt(y + 6), pt(10), pt(10)); }
          else text(vals[i], cl.al === 'right' ? x + cl.w - 4 : x + 4, y + rowH / 2, i === 1 ? 10 : 9.5, cl.al === 'right' ? 'right' : 'left', i === 1);
          x += cl.w;
        });
        y += rowH;
        ctx.beginPath(); ctx.setLineDash([pt(1), pt(2)]); ctx.moveTo(pt(margin), pt(y)); ctx.lineTo(pt(margin + usable), pt(y)); ctx.lineWidth = pt(0.5); ctx.strokeStyle = '#999'; ctx.stroke(); ctx.setLineDash([]);
      });
      if (s + perPage >= rows.length && rows.length) {
        hline(y, 1.2);
        text('この図面の計   吊 ' + total.sl + '本   手付 ' + total.hd + '本   重量 ' + total.kg.toFixed(1) + ' kg', margin + 4, y + rowH / 2 + 2, 10, 'left', true);
      }
      yield c;
      if (!rows.length) break;
    }

  }

  async function blob(P, pageSrc, onStep) {
    await load();
    const A = aggregate(P);
    const doc = await PDFLib.PDFDocument.create();
    doc.setTitle(P.name + ' 拾い図'); doc.setCreator('拾い帳');
    for (let i = 0; i < P.pages.length; i++) {
      if (onStep) onStep(i + 1, P.pages.length);
      const src = await pageSrc(P.pages[i]);
      const d = await drawingCanvas(P, i, src);
      const img = await doc.embedJpg(await toBytes(d.c)); d.c.width = d.c.height = 0;
      doc.addPage([d.wPt, d.hPt]).drawImage(img, { x: 0, y: 0, width: d.wPt, height: d.hPt });
      for (const tc of tableCanvases(P, i, A, d.wPt, d.hPt)) {
        const ti = await doc.embedJpg(await toBytes(tc)); tc.width = tc.height = 0;
        doc.addPage([d.wPt, d.hPt]).drawImage(ti, { x: 0, y: 0, width: d.wPt, height: d.hPt });
      }
    }
    const bytes = await doc.save();
    return new Blob([bytes], { type: 'application/pdf' });
  }
  return { blob };
})();
