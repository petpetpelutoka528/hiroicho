'use strict';
/* ═══════════════════════════════════════════════════════════
   拾い帳(スマホ・PC 共通) — 画面と操作
═══════════════════════════════════════════════════════════ */
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = v => Math.round(v).toLocaleString('ja-JP');
const TAP_R = 16;                       // タップで印を選ぶ範囲(画面の px)
const SNAP_R = 14;                      // 線の端・図面の線に吸い付く範囲(画面の px)

let P = null;                           // 開いている案件
const S = { mode: 'pick', pend: null, zonePts: [], scalePts: [], ortho: false, rev: { list: [], i: 0, filter: 'todo' } };
const docs = {};                        // file id → pdf.js の文書 / 画像
let A = null;                           // 集計(変わったら作り直す)

/* ── 小物 ── */
function toast(m, ms) { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), ms || 2200); }
function hint(m, ms) { const h = $('hint'); if (!m) { h.classList.remove('show'); return; } h.textContent = m; h.classList.add('show'); clearTimeout(h._t); h._t = setTimeout(() => h.classList.remove('show'), ms || 3500); }
function show(id) { ['home', 'draw', 'ledger', 'items'].forEach(s => $(s).classList.toggle('hidden', s !== id)); }
function busy(on, txt) { const b = $('busy'); b.textContent = txt || '読み込み中…'; b.classList.toggle('show', !!on); }
function curPage() { return P && P.pages[P.cur]; }
function activeIt() { return P && itemOf(P, P.activeItem); }
function stale() { A = null; }
function agg() { return A || (A = aggregate(P)); }

/* 入力の窓 */
function dialog(title, html, buttons) {
  return new Promise(res => {
    $('dlgTitle').textContent = title; $('dlgBody').innerHTML = html;
    const bb = $('dlgBtns'); bb.innerHTML = '';
    buttons.forEach(b => { const e = document.createElement('button'); e.textContent = b.label; if (b.cls) e.className = b.cls;
      e.onclick = () => { const v = b.value !== undefined ? b.value : true; const out = b.read ? b.read() : v; if (out === false) return; $('dlgBg').classList.add('hidden'); res(out); };
      bb.appendChild(e); });
    $('dlgBg').classList.remove('hidden');
    const f = $('dlgBody').querySelector('input,textarea'); if (f) setTimeout(() => { f.focus(); if (f.select) f.select(); }, 60);
  });
}
const confirmDlg = (t, msg, ok, cls) => dialog(t, '<p>' + esc(msg).replace(/\n/g, '<br>') + '</p>', [{ label: 'やめる', value: false }, { label: ok || 'OK', cls: cls || 'pri', value: true }]);
async function askText(t, label, val, type) {
  return dialog(t, `<label>${esc(label)}</label><input id="dIn" type="${type || 'text'}" ${type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(val ?? '')}">`,
    [{ label: 'やめる', value: null }, { label: 'OK', cls: 'pri', read: () => $('dIn').value }]);
}
async function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (e) {
      if (e && e.name === 'AbortError') return false;
      // 作るのに時間がかかると、iPhone は続けて共有させてくれない → ボタンをもう一度押してもらう
      return new Promise(res => {
        $('dlgTitle').textContent = '書き出しの準備ができました';
        $('dlgBody').innerHTML = '<p>「' + esc(name) + '」</p><p>「共有・保存」を押して、保存先(ファイルに保存・AirDrop・メールなど)を選んでください。</p>';
        const bb = $('dlgBtns'); bb.innerHTML = '';
        const c = document.createElement('button'); c.textContent = '閉じる'; c.onclick = () => { $('dlgBg').classList.add('hidden'); res(false); };
        const s = document.createElement('button'); s.textContent = '共有・保存'; s.className = 'pri';
        s.onclick = () => { $('dlgBg').classList.add('hidden'); navigator.share({ files: [file] }).then(() => res(true), () => res(false)); };
        bb.append(c, s); $('dlgBg').classList.remove('hidden');
      });
    }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); return true;
}
/* ── 保存・元に戻す ── */
let saveT = null;
const hist = [];
function snap() { return JSON.stringify({ items: P.items, pages: P.pages, threshold: P.threshold, nid: P.nid, files: P.files }); }
function push() { hist.push(snap()); if (hist.length > 60) hist.shift(); }
function changed() { stale(); P.updatedAt = Date.now(); clearTimeout(saveT); saveT = setTimeout(saveNow, 400); }
async function saveNow() { clearTimeout(saveT); saveT = null; if (P) try { await Store.putProj(P); } catch (e) { toast('保存できませんでした: ' + e.message, 4000); } }
function undo() {
  const h = hist.pop(); if (!h) { toast('戻せるものがありません'); return; }
  const o = JSON.parse(h); Object.assign(P, o); if (P.cur >= P.pages.length) P.cur = 0;
  S.pend = null; S.zonePts = []; S.scalePts = [];
  changed(); redraw(); renderItemBar(); toast('元に戻しました');
}
document.addEventListener('visibilitychange', () => { if (document.hidden && saveT) saveNow(); });
window.addEventListener('pagehide', () => { if (saveT) saveNow(); });

/* ═════════ 案件の一覧 ═════════ */
async function renderHome() {
  show('home');
  const list = (await Store.listProj()).sort((a, b) => b.updatedAt - a.updatedAt);
  const box = $('projList');
  if (!list.length) { box.innerHTML = '<div class="empty">まだ案件がありません。<br>「新しい案件」で図面(PDF・画像)を選んでください。</div>'; }
  else box.innerHTML = list.map(p => {
    const A2 = aggregate(p), t = totals(p, A2), pct = t.n ? Math.round(t.rv / t.n * 100) : 0;
    const d = new Date(p.updatedAt);
    return `<div class="proj" data-id="${p.id}"><div class="grow"><div class="nm">${esc(p.name)}</div>
      <div class="meta">図面 ${p.pages.length}枚 ・ 印 ${t.n} ・ 見直し ${pct}% ・ ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</div>
      <div class="bar2"><i style="width:${pct}%"></i></div></div><button class="more" data-more="${p.id}">⋯</button></div>`;
  }).join('');
  box.querySelectorAll('.proj').forEach(el => el.onclick = e => { if (e.target.dataset.more) return; openProject(el.dataset.id); });
  box.querySelectorAll('[data-more]').forEach(el => el.onclick = () => projMenu(list.find(p => p.id === el.dataset.more)));
  const est = await Store.estimate();
  $('storeNote').textContent = '案件はこの端末の中だけに保存されます。iPhone と PC の間は「案件ファイル」で受け渡します。' +
    (est && est.usage ? `(使っている容量 ${Math.round(est.usage / 1048576)}MB)` : '');
}
async function projMenu(p) {
  const r = await dialog(p.name, '', [{ label: '名前を変える', value: 'ren' }, { label: '案件ファイルに書き出す', value: 'exp' }, { label: '消す', cls: 'warn', value: 'del' }, { label: '閉じる', value: null }]);
  if (r === 'ren') { const v = await askText('名前を変える', '案件の名前', p.name); if (v && v.trim()) { p.name = v.trim(); await Store.putProj(p); renderHome(); } }
  if (r === 'exp') { busy(true, '書き出し中…'); try { await shareFile(await Store.exportProj(p), p.name + '.hiroicho'); } finally { busy(false); } }
  if (r === 'del') { if (await confirmDlg('案件を消す', '「' + p.name + '」を消します。図面と拾った印もすべて消えます(元に戻せません)。', '消す', 'warn')) { await Store.delProj(p); renderHome(); } }
}

/* 図面を選ぶ → 新しい案件 / 図面を追加 */
let filesFor = 'new';
$('btnNewProj').onclick = () => { filesFor = 'new'; $('fFiles').value = ''; $('fFiles').click(); };
$('fFiles').onchange = async e => {
  const fs = [...e.target.files]; if (!fs.length) return;
  if (filesFor === 'new') {
    const n = await askText('縮尺', '縮尺 1/○ の ○(全部の図面に使う。あとで図面ごとに直せます)', '100', 'number');
    if (n === null) return;
    P = newProject(fs[0].name.replace(/\.[^.]+$/, ''));
    hist.length = 0;
    await addFiles(fs, +n || 0);
    await Store.putProj(P);
    await openProject(P.id);
  } else {
    push();
    const first = P.pages.length;
    await addFiles(fs, scaleN(curPage()) || 0);
    changed(); await saveNow();
    gotoPage(first);
  }
};
async function addFiles(fs, n) {
  busy(true);
  try {
    for (const f of fs) {
      const isPdf = /pdf/i.test(f.type) || /\.pdf$/i.test(f.name);
      const isImg = /^image\/(jpeg|png)/i.test(f.type) || /\.(jpe?g|png)$/i.test(f.name);
      if (!isPdf && !isImg) { toast(f.name + ' は PDF・画像ではありません', 3000); continue; }
      const buf = await f.arrayBuffer();
      const fid = 'f' + nextId(P);
      const type = isPdf ? 'pdf' : (f.type || 'image/jpeg');
      await Store.putFile(P.id, fid, { type, data: buf });
      P.files.push({ id: fid, name: f.name, type, size: f.size });
      if (isPdf) {
        const doc = await openDoc(fid);
        for (let i = 1; i <= doc.numPages; i++) {
          const pg = { id: nextId(P), file: fid, p: i, name: '', scale: 0, w: 0, h: 0, dots: [], lens: [], zones: [] };
          if (n) setScaleN(pg, n); P.pages.push(pg);
        }
      } else {
        const img = await openDoc(fid);
        const paper = await askPaper(f.name, img.naturalWidth, img.naturalHeight);
        const pg = { id: nextId(P), file: fid, p: 0, name: '', scale: 0, w: 0, h: 0, paper, dots: [], lens: [], zones: [] };
        if (n) setScaleN(pg, n); P.pages.push(pg);
      }
    }
  } catch (e) { console.error(e); toast('読み込めませんでした: ' + e.message, 4000); }
  finally { busy(false); }
}
async function askPaper(name, w, h) {
  const land = w >= h;
  const r = await dialog('用紙の大きさ', `<p>「${esc(name)}」は画像なので、元の用紙の大きさを選んでください(長さの計算に使います)。</p>`,
    [{ label: 'A1', value: land ? 841 : 594 }, { label: 'A2', value: land ? 594 : 420 }, { label: 'A3', cls: 'pri', value: land ? 420 : 297 }, { label: 'A4', value: land ? 297 : 210 }]);
  return r;   // 図面の幅(mm)
}
async function openDoc(fid) {
  if (docs[fid]) return docs[fid];
  const v = await Store.getFile(P.id, fid); if (!v) throw new Error('図面のデータがありません');
  if (v.type === 'pdf') {
    docs[fid] = await pdfjsLib.getDocument({ data: new Uint8Array(v.data.slice(0)), CMapReaderFactory: InlineCMapReader, cMapUrl: 'inline/', cMapPacked: true, isEvalSupported: false }).promise;
  } else {
    const url = URL.createObjectURL(new Blob([v.data], { type: v.type }));
    const img = new Image(); img.src = url; await img.decode(); docs[fid] = img;
  }
  return docs[fid];
}

/* 案件ファイルを読み込む */
$('btnImport').onclick = () => { $('fImport').value = ''; $('fImport').click(); };
$('fImport').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  busy(true);
  try {
    const o = await Store.parseImport(f);
    const old = await Store.getProj(o.project.id);
    let asNew = false;
    if (old) {
      const newer = (old.updatedAt || 0) > (o.project.updatedAt || 0);
      busy(false);
      const r = await dialog('同じ案件があります', `<p>「${esc(old.name)}」はこの端末にもあります。${newer ? '<br><b>この端末のほうが新しい</b>です。' : ''}</p>`,
        [{ label: 'やめる', value: null }, { label: '別の案件として入れる', value: 'new' }, { label: '置き換える', cls: newer ? 'warn' : 'pri', value: 'rep' }]);
      if (!r) return;
      asNew = r === 'new';
      busy(true);
    }
    const p = await Store.saveImported(o, asNew);
    toast('「' + p.name + '」を読み込みました');
    renderHome();
  } catch (err) { toast(err.message, 4000); }
  finally { busy(false); }
};
$('btnHomeMenu').onclick = () => dialog('拾い帳について', `
  <p>図面(PDF・画像)の上で鉄骨を拾い、台帳・集計を作ります。</p>
  <p>・拾う: 下の「拾い」で、個はタップ1回、m・部材は始点と終点をタップ。<br>
  ・細かく合わせたいときは、長押しすると指の下が拡大され、離した所に置けます。<br>
  ・拡大・縮小は指2本、移動は指1本でなぞる。<br>
  ・印をタップすると「消す」などが出ます。<br>
  ・見直し: 印を1つずつ順に見て OK を付けます。全部 OK になれば見落としなし。</p>
  <p>データはこの端末の中だけに保存されます。控えと PC への受け渡しは「案件ファイル」で。</p>`, [{ label: '閉じる', cls: 'pri' }]);

/* ═════════ 図面 ═════════ */
async function openProject(id) {
  busy(true);
  try {
    P = await Store.getProj(id); if (!P) throw new Error('案件が見つかりません');
    hist.length = 0; stale();
    for (const k in docs) delete docs[k];
    S.pend = null; S.zonePts = []; S.scalePts = [];
    show('draw'); setMode('pick');
    if (!activeIt() && P.items.length) P.activeItem = P.items[0].id;
    renderItemBar();
    if (P.pages.length) await gotoPage(Math.min(P.cur || 0, P.pages.length - 1), true);
    Store.persist();
    if (!P.items.length) setTimeout(() => hint('まず「部材を選ぶ」から部材を追加してください(Excel からまとめて貼り付けもできます)', 6000), 400);
  } catch (e) { console.error(e); toast(e.message, 4000); renderHome(); }
  finally { busy(false); }
}
async function pageSrc(pg) {
  const d = await openDoc(pg.file);
  if (pg.p) {
    const page = await d.getPage(pg.p), vp = page.getViewport({ scale: RS });
    pg.w = vp.width; pg.h = vp.height;
    return { w: pg.w, h: pg.h, render: (ctx, k, x0, y0) => page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: RS * k }), transform: [1, 0, 0, 1, -x0 * k, -y0 * k] }).promise };
  }
  const W = pg.paper / MM_PER_U, H = W * d.naturalHeight / d.naturalWidth; pg.w = W; pg.h = H;
  return { w: W, h: H, render: async (ctx, k, x0, y0, w, h) => {
    const fx = d.naturalWidth / W; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(d, x0 * fx, y0 * fx, w * fx, h * fx, 0, 0, w * k, h * k); } };
}
async function gotoPage(i, fit) {
  if (!P.pages[i]) return;
  const same = P.cur === i && !fit;
  P.cur = i; S.pend = null; S.zonePts = []; S.scalePts = [];
  busy(true);
  try { const src = await pageSrc(P.pages[i]); await Viewer.show(src, same); }
  catch (e) { console.error(e); toast('図面を表示できませんでした', 3000); }
  finally { busy(false); }
  $('pageLbl').textContent = pageName(P, i) + (P.pages.length > 1 ? `(${i + 1}/${P.pages.length})` : '');
  renderScaleLbl(); redraw(); renderItemBar(); changed();
}
function renderScaleLbl() {
  const n = scaleN(curPage()); $('scaleLbl').textContent = n ? '1/' + (Math.round(n * 100) / 100) : '縮尺 未設定';
  $('btnScale').classList.toggle('unset', !n);
}

/* ── 印を描く ── */
const NS = 'http://www.w3.org/2000/svg';
function el(t, a, parent) { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (parent) parent.appendChild(e); return e; }
function redraw() {
  const svg = $('ovl'); svg.innerHTML = ''; const pg = curPage(); if (!pg) return;
  const k = 1 / Viewer.s;                       // 画面 1px の長さ(u)
  const act = P.activeItem, it0 = activeIt();
  const revCur = S.mode === 'review' ? S.rev.list[S.rev.i] : null;
  // 工区
  pg.zones.forEach(z => {
    el('polygon', { points: z.pts.map(p => p.x + ',' + p.y).join(' '), fill: z.color + '18', stroke: z.color, 'stroke-width': 2 * k, 'stroke-dasharray': `${8 * k} ${5 * k}` }, svg);
    const c = z.pts.reduce((a, p) => ({ x: a.x + p.x / z.pts.length, y: a.y + p.y / z.pts.length }), { x: 0, y: 0 });
    const t = el('text', { x: c.x, y: c.y, 'font-size': 15 * k, 'font-weight': 700, fill: z.color, 'text-anchor': 'middle', 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3 * k }, svg);
    t.textContent = z.name;
  });
  const faded = o => S.mode !== 'review' && it0 && o.it !== act;
  // 線
  pg.lens.forEach(l => {
    const it = itemOf(P, l.it); const col = it ? it.color : '#888';
    const mm = lenMm(pg, l), kg = lineKg(it, mm), j = it ? judge(P, it, kg) : '';
    const g = el('g', { opacity: faded(l) ? 0.3 : 1 }, svg);
    el('line', { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, stroke: col, 'stroke-width': 3 * k, 'stroke-linecap': 'round', 'stroke-dasharray': j === '手付' ? `${7 * k} ${4 * k}` : 'none' }, g);
    if (S.mode === 'review' && l.rv) el('line', { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, stroke: '#2f7a4a', 'stroke-width': 1.2 * k }, g);
    if (needsZone(pg, l)) { const m = markPt(l); const q = el('text', { x: m.x, y: m.y + 16 * k, 'font-size': 11 * k, 'font-weight': 700, fill: '#b0451c', 'text-anchor': 'middle', 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3 * k }, g); q.textContent = '工区?'; }
    if (!faded(l) && pg.scale && Viewer.s > Viewer.fitS() * 1.4) {
      const m = markPt(l), d = Math.hypot(l.x2 - l.x1, l.y2 - l.y1) || 1;
      let ox = (l.y2 - l.y1) / d * 9 * k, oy = -(l.x2 - l.x1) / d * 9 * k; if (oy > 0 || (oy === 0 && ox > 0)) { ox = -ox; oy = -oy; }
      const t = el('text', { x: m.x + ox, y: m.y + oy, 'font-size': 11 * k, 'font-weight': 700, fill: col, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3 * k }, g);
      t.textContent = n0(mm);
    }
  });
  // 個
  pg.dots.forEach(d => {
    const it = itemOf(P, d.it); const col = it ? it.color : '#888';
    const g = el('g', { opacity: faded(d) ? 0.3 : 1 }, svg);
    el('circle', { cx: d.x, cy: d.y, r: 6 * k, fill: col, stroke: '#fff', 'stroke-width': 1.5 * k }, g);
    if (S.mode === 'review' && d.rv) el('circle', { cx: d.x, cy: d.y, r: 8.5 * k, fill: 'none', stroke: '#2f7a4a', 'stroke-width': 1.5 * k }, g);
  });
  // 見直し中の印
  if (revCur && revCur.pi === P.cur) {
    const p = markPt(revCur.o), o = revCur.o;
    if (o.x1 !== undefined) el('line', { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, stroke: '#ffd400', 'stroke-width': 9 * k, 'stroke-linecap': 'round', opacity: 0.5 }, svg);
    el('circle', { cx: p.x, cy: p.y, r: 22 * k, fill: 'none', stroke: '#c94f2c', 'stroke-width': 3 * k }, svg);
  }
  // 描きかけ
  if (S.pend) el('circle', { cx: S.pend.x, cy: S.pend.y, r: 6 * k, fill: 'none', stroke: it0 ? it0.color : '#c94f2c', 'stroke-width': 3 * k }, svg);
  if (S.zonePts.length) {
    el('polyline', { points: S.zonePts.map(p => p.x + ',' + p.y).join(' '), fill: 'none', stroke: '#c94f2c', 'stroke-width': 2 * k, 'stroke-dasharray': `${6 * k} ${4 * k}` }, svg);
    S.zonePts.forEach((p, i) => el('circle', { cx: p.x, cy: p.y, r: (i ? 4 : 8) * k, fill: i ? '#c94f2c' : 'none', stroke: '#c94f2c', 'stroke-width': 2 * k }, svg));
  }
  S.scalePts.forEach(p => el('circle', { cx: p.x, cy: p.y, r: 6 * k, fill: 'none', stroke: '#2563ab', 'stroke-width': 3 * k }, svg));
}

/* ── 吸着 ── */
function endpoints(pg, except) {
  const out = [];
  pg.lens.forEach(l => { if (l !== except) { out.push({ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }); } });
  return out;
}
function snapPt(p, kind) {
  const pg = curPage(), r = SNAP_R / Viewer.s;
  if (kind === 'zone') {
    let best = null, bd = r;
    pg.zones.forEach(z => z.pts.forEach(q => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = q; } }));
    if (best) return { x: best.x, y: best.y };
    return Viewer.snapEdge(p.x, p.y, r) || p;
  }
  if (kind === 'pcs') return p;
  let best = null, bd = r;
  endpoints(pg).forEach(q => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = q; } });
  if (best) return { x: best.x, y: best.y };
  return Viewer.snapEdge(p.x, p.y, r) || p;
}
function orthoTo(p0, p) { return Math.abs(p.x - p0.x) >= Math.abs(p.y - p0.y) ? { x: p.x, y: p0.y } : { x: p0.x, y: p.y }; }
function nearEndpoint(p) { const r = SNAP_R / Viewer.s; return endpoints(curPage()).some(q => Math.hypot(q.x - p.x, q.y - p.y) < r); }

/* ── 印を探す ── */
function hitMark(p) {
  const pg = curPage(), r = TAP_R / Viewer.s; let best = null, bd = r;
  pg.dots.forEach(d => { const dd = Math.hypot(d.x - p.x, d.y - p.y); if (dd < bd) { bd = dd; best = d; } });
  pg.lens.forEach(l => { const dd = distSeg(p.x, p.y, l.x1, l.y1, l.x2, l.y2); if (dd < bd) { bd = dd; best = l; } });
  return best;
}
function removeMark(o) {
  const pg = P.pages.find(q => q.dots.includes(o) || q.lens.includes(o)); if (!pg) return;
  if (o.x1 !== undefined) pg.lens.splice(pg.lens.indexOf(o), 1); else pg.dots.splice(pg.dots.indexOf(o), 1);
}
function markText(o, pg) {
  const it = itemOf(P, o.it); if (!it) return '(部材の一覧にない)';
  if (o.x1 === undefined) return it.name + '  ' + KIND[it.kind].lbl;
  const mm = lenMm(pg, o), kg = lineKg(it, mm), j = judge(P, it, kg);
  const zt = pg.zones.length ? (needsZone(pg, o) ? '  工区:未定' : '  ' + (zoneOfMark(pg, o) || '工区外')) : '';
  return it.name + '  ' + (pg.scale ? n0(mm) + 'mm' : '縮尺未設定') + (kg ? '  ' + kg.toFixed(1) + 'kg' : '') + (j ? '  ' + j : '') + zt;
}

/* ── タップ ── */
function onTap(p, e) {
  hidePop();
  if (!curPage()) return;
  if (S.mode === 'pick') return pickTap(p, e, false);
  if (S.mode === 'zone') return zoneTap(p, e, false);
  if (S.mode === 'scale') return scaleTap(snapPt(p, 'line'));
  if (S.mode === 'review') { const o = hitMark(p); if (o) { const k = S.rev.list.findIndex(x => x.o === o); if (k >= 0) { S.rev.i = k; showRev(false); } else markPop(o, e); } return; }
  if (S.mode === 'view') { const o = hitMark(p); if (o) markPop(o, e); }
}
function onPlace(p, e) {           // 長押しのあと離した所(ルーペで合わせた所)
  if (S.mode === 'pick') return pickTap(p, e, true);
  if (S.mode === 'zone') return zoneTap(p, e, true);
  if (S.mode === 'scale') return scaleTap(p);
}
function loupePoint(p) {
  if (S.mode === 'zone') return snapPt(p, 'zone');
  if (S.mode === 'scale') return snapPt(p, 'line');
  const it = activeIt(); if (!it) return p;
  let q = snapPt(p, it.kind === 'pcs' ? 'pcs' : 'line');
  if (S.pend && S.ortho) q = orthoTo(S.pend, q);
  return q;
}
function pickTap(p, e, placed) {
  const it = activeIt();
  if (!it) { openItemSheet(); return; }
  const pg = curPage();
  if (S.pend) {                                   // 線の終点
    let q = placed ? p : snapPt(p, 'line');
    if (S.ortho) q = orthoTo(S.pend, q);
    if (Math.hypot(q.x - S.pend.x, q.y - S.pend.y) * Viewer.s < 4) return;
    push();
    const l = { id: nextId(P), it: it.id, x1: S.pend.x, y1: S.pend.y, x2: q.x, y2: q.y };
    pg.lens.push(l); S.pend = null; changed(); redraw(); renderItemBar();
    hint(markText(l, pg), 2500);
    if (needsZone(pg, l)) chooseZone(l, pg);
    return;
  }
  if (!placed) {
    const o = hitMark(p);
    // 線を拾うとき、線の端の近くなら続けて描く(印のメニューは出さない)
    const chain = it.kind !== 'pcs' && nearEndpoint(p);
    if (o && !chain) { markPop(o, e); return; }
  }
  if (it.kind === 'pcs') {
    push(); pg.dots.push({ id: nextId(P), it: it.id, x: p.x, y: p.y }); changed(); redraw(); renderItemBar();
  } else {
    S.pend = placed ? p : snapPt(p, 'line'); redraw(); hint(it.name + ': 終点をタップ(やめるときは もう一度「拾い」)', 2500);
  }
}
function zoneTap(p, e, placed) {
  const pg = curPage();
  const q = placed ? p : snapPt(p, 'zone');
  if (S.zonePts.length >= 3 && Math.hypot(q.x - S.zonePts[0].x, q.y - S.zonePts[0].y) * Viewer.s < 22) { closeZone(); return; }
  if (!S.zonePts.length && !placed) {
    const z = zoneAt(pg, p.x, p.y), nearV = pg.zones.some(zz => zz.pts.some(v => Math.hypot(v.x - p.x, v.y - p.y) * Viewer.s < SNAP_R));
    if (z && !nearV) { zonePop(z, e, q); return; }
  }
  S.zonePts.push(q); redraw();
  hint(S.zonePts.length < 3 ? '工区: 角を順にタップ' : '工区: 最初の点をタップで閉じる', 2500);
}
async function closeZone(firstPt) {
  const pts = S.zonePts.slice(); S.zonePts = []; redraw();
  const names = zoneNames(P);
  let def = '1工区'; for (let i = 1; i < 200; i++) if (!names.includes(i + '工区')) { def = i + '工区'; break; }
  const nm = await askText('工区の名前', '同じ名前なら別の範囲・別の図面でも合わせて数えます', def);
  if (!nm || !nm.trim()) { redraw(); return; }
  push();
  const exist = P.pages.flatMap(q => q.zones).find(z => z.name === nm.trim());
  curPage().zones.push({ id: nextId(P), name: nm.trim(), color: exist ? exist.color : genColor(names.length + 3), pts });
  changed(); redraw(); toast('工区「' + nm.trim() + '」を追加しました');
}
async function scaleTap(p) {
  S.scalePts.push(p); redraw();
  if (S.scalePts.length < 2) { hint('縮尺: 2点目をタップ', 3000); return; }
  const [a, b] = S.scalePts; S.scalePts = []; redraw();
  const d = Math.hypot(b.x - a.x, b.y - a.y); if (d < 3) return;
  const v = await askText('縮尺を合わせる', 'この2点の間の実際の寸法(mm)', '', 'number');
  const mm = parseFloat(String(v || '').replace(/,/g, '')); if (!(mm > 0)) return;
  const n = Math.round(mm / d / MM_PER_U * 100) / 100;
  await applyScale(n);
  setMode('pick');
}
async function applyScale(n) {
  let all = false;
  if (P.pages.length > 1) all = await dialog('縮尺 1/' + n, '<p>どの図面に使いますか?</p>', [{ label: 'この図面だけ', value: false }, { label: '全部の図面', cls: 'pri', value: true }]);
  push();
  (all ? P.pages : [curPage()]).forEach(pg => setScaleN(pg, n));
  changed(); renderScaleLbl(); redraw(); renderItemBar(); toast('縮尺 1/' + n + ' にしました(拾った長さも計算し直し)');
}

/* ── 工区をまたぐ線: どの工区に入れるか自分で選ぶ ── */
async function chooseZone(l, pg) {
  const t = zonesTouched(pg, l);
  const btns = t.names.map(n => ({ label: n, cls: l.zn === n ? 'pri' : '', value: n }));
  if (t.out) btns.push({ label: '工区外', cls: l.zn === '__none' ? 'pri' : '', value: '__none' });
  btns.push({ label: 'あとで決める', value: null });
  const r = await dialog('どの工区に入れますか', '<p>' + esc(markText(l, pg)) + '</p><p>この線は工区の境界をまたいでいます。</p>', btns);
  if (r === null || r === undefined || r === true) return false;
  push(); l.zn = r; changed(); redraw(); toast((r === '__none' ? '工区外' : r) + ' に入れました');
  return true;
}

/* ── 印・工区のメニュー ── */
function hidePop() { $('pop').classList.add('hidden'); }
function popAt(e, html, actions) {
  const pp = $('pop'); pp.innerHTML = html; pp.classList.remove('hidden');
  const w = pp.offsetWidth, h = pp.offsetHeight;
  let x = (e && e.clientX) || innerWidth / 2, y = (e && e.clientY) || innerHeight / 2;
  pp.style.left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)) + 'px';
  pp.style.top = Math.max(8, Math.min(innerHeight - h - 8, y + 18)) + 'px';
  pp.querySelectorAll('button').forEach(b => b.onclick = () => { hidePop(); actions[b.dataset.a](); });
}
function markPop(o, e) {
  const pg = curPage(), it = itemOf(P, o.it);
  popAt(e, `<div class="pt">${esc(markText(o, pg))}${o.rv ? '  ✓見直し済み' : ''}</div>
    <button data-a="sel">この部材を選ぶ</button>${o.rv ? '' : '<button data-a="ok">見直し OK にする</button>'}${o.x1 !== undefined && pg.zones.length ? '<button data-a="zn">入れる工区を選ぶ</button>' : ''}<button data-a="del" class="warn">この印を消す</button><button data-a="x">閉じる</button>`, {
    zn: () => chooseZone(o, pg),
    sel: () => { if (it) { P.activeItem = it.id; changed(); renderItemBar(); redraw(); } },
    ok: () => { push(); o.rv = true; changed(); redraw(); },
    del: () => { push(); removeMark(o); changed(); redraw(); renderItemBar(); toast('消しました'); },
    x: () => {}
  });
}
function zonePop(z, e, q) {
  popAt(e, `<div class="pt">工区「${esc(z.name)}」</div><button data-a="draw">ここから新しい工区を描く</button><button data-a="ren">名前を変える</button><button data-a="del" class="warn">この範囲を消す</button><button data-a="x">閉じる</button>`, {
    draw: () => { S.zonePts = [q]; redraw(); },
    ren: async () => { const v = await askText('工区の名前', '新しい名前', z.name); if (v && v.trim()) { push(); const pg = curPage(), old = z.name; z.name = v.trim();
      if (!pg.zones.some(q => q.name === old)) pg.lens.forEach(l => { if (l.zn === old) l.zn = z.name; });   // 選んであった工区も新しい名前に
      changed(); redraw(); } },
    del: async () => { if (await confirmDlg('工区を消す', '工区「' + z.name + '」のこの範囲を消します(拾った印は残ります)。', '消す', 'warn')) { push(); const pg = curPage(); pg.zones.splice(pg.zones.indexOf(z), 1); changed(); redraw(); } },
    x: () => {}
  });
}

/* ── モード ── */
const MODE_HINT = {
  pick: '拾い: 個はタップ、m・部材は始点と終点をタップ。長押しで拡大して合わせる',
  zone: '工区: 角を順にタップ。最初の点をタップで閉じる',
  scale: '縮尺: 寸法の分かっている2点をタップ(通り芯など)',
  review: '見直し: 印を1つずつ見て「OK」。全部 OK になれば見落としなし',
  view: '移動: 図面を見るだけ(タップしても拾わない)'
};
function setMode(m) {
  if (S.mode === m && m === 'pick' && S.pend) { S.pend = null; redraw(); hint('描きかけをやめました', 1500); return; }
  S.mode = m; S.pend = null; S.zonePts = []; S.scalePts = [];
  document.querySelectorAll('#modes button[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('revBar').classList.toggle('hidden', m !== 'review');
  $('itemBar').classList.toggle('hidden', m === 'review');
  if (m === 'review') startReview(); else redraw();
  hint(MODE_HINT[m]);
}
document.querySelectorAll('#modes button[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$('btnModeItems').onclick = () => openItems('draw');
$('btnOrtho').onclick = () => { S.ortho = !S.ortho; $('btnOrtho').classList.toggle('on', S.ortho); toast('直角 ' + (S.ortho ? 'ON(水平・垂直だけ)' : 'OFF')); };

/* ── 見直し ── */
function startReview() {
  S.rev.filter = $('revFilter').value;
  S.rev.list = reviewList(P, S.rev.filter, P.activeItem); S.rev.i = 0;
  // 今の図面の印から始める
  const k = S.rev.list.findIndex(x => x.pi === P.cur); if (k > 0) S.rev.i = k;
  showRev(true);
}
async function showRev(zoom) {
  const L = S.rev.list, t = totals(P, agg());
  if (!L.length) {
    $('revPos').textContent = '0 / 0';
    $('revInfo').textContent = S.rev.filter === 'todo' ? (t.n ? '全部の印を見直しました ✓' : '印がありません') : S.rev.filter === 'cross' ? '工区をまたいで未定の線はありません ✓' : '印がありません';
    $('revZone').classList.add('hidden');
    redraw(); return;
  }
  S.rev.i = Math.max(0, Math.min(L.length - 1, S.rev.i));
  const cur = L[S.rev.i];
  if (cur.pi !== P.cur) await gotoPage(cur.pi, true);
  const pg = curPage(), p = markPt(cur.o);
  const s = Math.max(Viewer.s, Viewer.fitS() * 3);
  if (zoom || true) Viewer.centerOn(p.x, p.y, s);
  $('revPos').textContent = (S.rev.i + 1) + ' / ' + L.length;
  $('revInfo').textContent = markText(cur.o, pg) + '  ・ ' + pageName(P, cur.pi) + '  ・ 見直し済み ' + t.rv + '/' + t.n;
  $('revZone').classList.toggle('hidden', !(cur.o.x1 !== undefined && pg.zones.length));
  redraw();
}
$('revFilter').onchange = () => startReview();
$('revZone').onclick = async () => {
  const cur = S.rev.list[S.rev.i]; if (!cur) return;
  if (await chooseZone(cur.o, curPage()) && S.rev.filter === 'cross') { S.rev.list.splice(S.rev.i, 1); }
  showRev();
};
$('revPrev').onclick = () => { S.rev.i--; showRev(); };
$('revNext').onclick = () => { S.rev.i++; showRev(); };
$('revOk').onclick = () => {
  const cur = S.rev.list[S.rev.i]; if (!cur) return;
  push(); cur.o.rv = true; changed();
  if (S.rev.filter === 'todo') S.rev.list.splice(S.rev.i, 1); else S.rev.i++;
  if (S.rev.i >= S.rev.list.length && S.rev.list.length) { S.rev.i = S.rev.list.length - 1; toast('最後の印です'); }
  showRev();
};
$('revDel').onclick = async () => {
  const cur = S.rev.list[S.rev.i]; if (!cur) return;
  push(); removeMark(cur.o); changed(); S.rev.list.splice(S.rev.i, 1); toast('消しました'); renderItemBar(); showRev();
};

/* ── 部材の切り替え ── */
function renderItemBar() {
  const it = activeIt();
  $('itDot').style.background = it ? it.color : 'var(--rule2)';
  $('itName').textContent = it ? it.name : '部材を選ぶ';
  if (it) {
    const a = agg(), T = a.T[it.id], PGc = a.PG[it.id][P.cur];
    const q = c => it.kind === 'm' ? (c.mm / 1000).toFixed(1) + 'm' : c.n + KIND[it.kind].unit;
    $('itCnt').textContent = KIND[it.kind].lbl + '  この図面 ' + q(PGc) + ' / 全部 ' + q(T);
  } else $('itCnt').textContent = '';
}
function stepItem(d) {
  if (!P.items.length) return openItemSheet();
  let i = P.items.findIndex(x => x.id === P.activeItem); i = i < 0 ? 0 : (i + d + P.items.length) % P.items.length;
  P.activeItem = P.items[i].id; S.pend = null; changed(); renderItemBar(); redraw();
}
$('itPrev').onclick = () => stepItem(-1);
$('itNext').onclick = () => stepItem(1);
$('itCur').onclick = () => openItemSheet();

/* 下から出る一覧 */
function openSheet(title, render, searchable) {
  $('bsTitle').textContent = title; $('bsSearch').value = '';
  $('bsSearch').classList.toggle('hidden', !searchable);
  $('sheetBg').classList.remove('hidden'); $('bsheet').classList.remove('hidden');
  const go = () => render($('bsSearch').value.trim());
  $('bsSearch').oninput = go; go();
}
function closeSheet() { $('sheetBg').classList.add('hidden'); $('bsheet').classList.add('hidden'); }
$('sheetBg').onclick = closeSheet; $('bsClose').onclick = closeSheet;

function openItemSheet() {
  openSheet('部材を選ぶ', q => {
    const a = agg(), ql = q.toLowerCase();
    const rows = P.items.filter(it => !q || it.name.toLowerCase().includes(ql)).map(it => {
      const T = a.T[it.id], c = a.PG[it.id][P.cur];
      const qq = x => it.kind === 'm' ? (x.mm / 1000).toFixed(1) : String(x.n);
      return `<div class="row${it.id === P.activeItem ? ' cur' : ''}" data-id="${it.id}"><i class="sw" style="background:${it.color}"></i>
        <span class="nm">${esc(it.name)}</span><span class="k">${KIND[it.kind].lbl}</span>
        <span class="v">${qq(c)} <small>全部 ${qq(T)}${KIND[it.kind].unit}</small></span></div>`;
    }).join('');
    $('bsBody').innerHTML = `<div class="list">${rows || '<div class="empty">' + (P.items.length ? '見つかりません' : 'まだ部材がありません') + '</div>'}</div>
      <div class="add"><button id="bsAdd">＋ 部材を追加</button><button id="bsEdit">部材の編集・貼り付け</button></div>`;
    $('bsBody').querySelectorAll('.row').forEach(r => r.onclick = () => { P.activeItem = +r.dataset.id; S.pend = null; changed(); renderItemBar(); redraw(); closeSheet(); if (S.mode !== 'pick') setMode('pick'); });
    $('bsAdd').onclick = async () => { closeSheet(); const it = await editItem(null); if (it) { P.activeItem = it.id; renderItemBar(); redraw(); } };
    $('bsEdit').onclick = () => { closeSheet(); openItems('draw'); };
  }, true);
}
function openPageSheet() {
  openSheet('図面', () => {
    const a = agg();
    const rows = P.pages.map((pg, i) => {
      const n = pg.dots.length + pg.lens.length, rv = [...pg.dots, ...pg.lens].filter(o => o.rv).length, sn = scaleN(pg);
      return `<div class="row${i === P.cur ? ' cur' : ''}" data-i="${i}"><span class="nm">${esc(pageName(P, i))}</span>
        <span class="v">印 ${n} ・ 見直し ${rv}/${n}<small>${sn ? '1/' + Math.round(sn * 100) / 100 : '縮尺 未設定'}</small></span></div>`;
    }).join('');
    $('bsBody').innerHTML = `<div class="list">${rows}</div><div class="add"><button id="bsAddPdf">＋ 図面を追加</button><button id="bsRen">この図面の名前を変える</button></div>
      <div class="add"><button id="bsDelPg" style="color:var(--warn)">この図面を消す</button></div>`;
    $('bsDelPg').onclick = async () => {
      closeSheet(); const pg = curPage(), n = pg.dots.length + pg.lens.length;
      if (!(await confirmDlg('図面を消す', '「' + pageName(P, P.cur) + '」を案件から消します。' + (n ? 'この図面で拾った印 ' + n + '件も消えます。' : ''), '消す', 'warn'))) return;
      P.pages.splice(P.cur, 1);
      if (!P.pages.some(q => q.file === pg.file)) { P.files = P.files.filter(f => f.id !== pg.file); Store.delFile(P.id, pg.file); delete docs[pg.file]; }
      hist.length = 0; changed(); await saveNow();
      if (!P.pages.length) { P = null; renderHome(); return; }
      gotoPage(Math.min(P.cur, P.pages.length - 1), true);
    };
    $('bsBody').querySelectorAll('.row').forEach(r => r.onclick = () => { closeSheet(); gotoPage(+r.dataset.i, true); });
    $('bsAddPdf').onclick = () => { closeSheet(); filesFor = 'add'; $('fFiles').value = ''; $('fFiles').click(); };
    $('bsRen').onclick = async () => { closeSheet(); const v = await askText('図面の名前', '工区毎P算出などの見出しに使います', pageName(P, P.cur)); if (v && v.trim()) { push(); curPage().name = v.trim(); changed(); $('pageLbl').textContent = pageName(P, P.cur); } };
  }, false);
}
$('btnPage').onclick = openPageSheet;
$('btnScale').onclick = async () => {
  const n = scaleN(curPage());
  const r = await dialog('縮尺', `<label>縮尺 1/○ の ○</label><input id="dIn" type="number" inputmode="decimal" value="${n ? Math.round(n * 100) / 100 : ''}" placeholder="100">
    <p style="margin-top:10px;color:var(--ink2);font-size:13px">分からないときは「2点で合わせる」で、寸法の分かっている2点(通り芯など)をタップします。</p>`,
    [{ label: '2点で合わせる', value: 'two' }, { label: 'やめる', value: null }, { label: 'OK', cls: 'pri', read: () => $('dIn').value }]);
  if (r === 'two') { setMode('scale'); return; }
  const v = parseFloat(String(r || '').replace(/,/g, '')); if (v > 0) await applyScale(v);
};
$('btnUndo').onclick = undo;
$('btnBack').onclick = async () => { await saveNow(); P = null; renderHome(); };

/* ═════════ 台帳 ═════════ */
let ledTab = 'items';
$('btnLedger').onclick = () => { show('ledger'); renderLedger(); };
$('btnLedgerBack').onclick = () => { show('draw'); renderItemBar(); redraw(); };
document.querySelectorAll('#ledSeg button').forEach(b => b.onclick = () => { ledTab = b.dataset.tab; renderLedger(); });
function renderLedger() {
  document.querySelectorAll('#ledSeg button').forEach(b => b.classList.toggle('on', b.dataset.tab === ledTab));
  const a = agg(), t = totals(P, a), body = $('ledBody');
  const kpi = `<div class="kpis"><div class="kpi"><small>個</small><b>${t.pcs}</b></div><div class="kpi sl"><small>吊</small><b>${t.sl}</b></div>
    <div class="kpi hd"><small>手付</small><b>${t.hd}</b></div><div class="kpi"><small>t</small><b>${(t.kg / 1000).toFixed(2)}</b></div>
    <div class="kpi"><small>見直し</small><b>${t.n ? Math.round(t.rv / t.n * 100) : 0}%</b></div></div>`;
  if (ledTab === 'items') {
    body.innerHTML = kpi + '<div class="list">' + (P.items.map(it => {
      const T = a.T[it.id];
      const q = it.kind === 'm' ? (T.mm / 1000).toFixed(2) + ' m' : T.n + ' ' + KIND[it.kind].unit;
      const sub = it.kind === 'mem' ? `${(T.mm / 1000).toFixed(2)}m ・ 吊${T.sl} 手付${T.hd} ・ ${n0(T.kg)}kg` : (T.kg ? n0(T.kg) + 'kg' : '');
      return `<div class="row" data-id="${it.id}"><i class="sw" style="background:${it.color}"></i><span class="nm">${esc(it.name)}</span><span class="k">${KIND[it.kind].lbl}</span>
        <span class="v">${q}<small>${sub}</small><small class="ck${T.n && T.rv < T.n ? ' todo' : ''}">${T.n ? '見直し ' + T.rv + '/' + T.n : '拾いなし'}</small></span></div>`;
    }).join('') || '<div class="empty">部材がありません。右上の「部材の編集」から追加してください。</div>') + '</div>';
    body.querySelectorAll('.row').forEach(r => r.onclick = () => { P.activeItem = +r.dataset.id; changed(); show('draw'); setMode('pick'); renderItemBar(); });
  } else if (ledTab === 'zones') {
    const zs = a.cols.filter(c => c !== '__none'), cols = zs.length ? [...zs, '__none'] : [];
    let h = '<div class="tblWrap"><table class="mx"><tr><th>部材</th>' + zs.map(z => `<th>${esc(z)}</th>`).join('') + (zs.length ? '<th>未割当</th>' : '') + '<th>計</th><th>長さm</th><th>kg</th></tr>';
    P.items.forEach(it => { const T = a.T[it.id];
      h += `<tr><td>${esc(it.name)}</td>` + cols.map(c => `<td>${qtyTxt(it, a.M[it.id][c])}</td>`).join('') +
        `<td><b>${qtyTxt(it, T)}</b></td><td>${it.kind === 'mem' && T.mm ? (T.mm / 1000).toFixed(2) : ''}</td><td>${T.kg ? n0(T.kg) : ''}</td></tr>`; });
    h += '<tr class="foot"><td>吊/手付</td>' + cols.map(c => { let s = 0, d = 0; P.items.forEach(it => { s += a.M[it.id][c].sl; d += a.M[it.id][c].hd; }); return `<td>${s + d ? s + '/' + d : ''}</td>`; }).join('') + `<td>${t.sl}/${t.hd}</td><td></td><td>${n0(t.kg)}</td></tr></table></div>`;
    h += '<div class="sec"><h3>図面ごとの数</h3></div><div class="tblWrap"><table class="mx"><tr><th>部材</th>' + P.pages.map((pg, i) => `<th>${esc(pageName(P, i))}</th>`).join('') + '<th>計</th></tr>';
    P.items.forEach(it => { h += `<tr><td>${esc(it.name)}</td>` + P.pages.map((pg, i) => `<td>${qtyTxt(it, a.PG[it.id][i])}</td>`).join('') + `<td><b>${qtyTxt(it, a.T[it.id])}</b></td></tr>`; });
    body.innerHTML = kpi + h + '</table></div>';
  } else if (ledTab === 'check') {
    const iss = issues(P, a);
    let h = kpi + '<div class="issues"><h3>気になる点</h3><ul>' + (iss.length ? iss.map(s => `<li>${esc(s)}</li>`).join('') : '<li>気になる点はありません</li>') + '</ul>';
    h += '<h3>図面ごとの見直し</h3><ul>' + P.pages.map((pg, i) => { const ms = [...pg.dots, ...pg.lens], rv = ms.filter(o => o.rv).length;
      return `<li>${esc(pageName(P, i))} … 印 ${ms.length} ・ 見直し済み ${rv}${ms.length && rv === ms.length ? ' ✓' : ''}</li>`; }).join('') + '</ul></div>';
    h += '<div class="sec"><button class="big" id="goRev">見直しをする</button><button class="big ghost" id="resetRev">見直しを最初からやり直す</button></div>';
    body.innerHTML = h;
    $('goRev').onclick = () => { show('draw'); setMode('review'); };
    $('resetRev').onclick = async () => { if (await confirmDlg('見直しをやり直す', '全部の印の「見直し OK」を外します。', '外す', 'warn')) { push(); P.pages.forEach(pg => [...pg.dots, ...pg.lens].forEach(o => delete o.rv)); changed(); renderLedger(); } };
  } else {
    body.innerHTML = kpi + `<div class="sec"><h3>Excel に書き出す</h3><p>部材・集計・吊材積算・手付積算・工区毎P算出の表を、Excel ファイル(.xlsx)にします。</p>
      <button class="big" id="expX">Excel に書き出す</button>
      <h3>印刷用の PDF</h3><p>拾った印を描いた図面(線の長さ・部材名・重さ・工区つき)と、その次のページにその図面の部材の表を入れた PDF です。</p>
      <button class="big ghost" id="expPdf">印刷用の PDF に書き出す</button>
      <h3>案件ファイル(控え・PC との受け渡し)</h3><p>図面と拾った印をまとめた1つのファイルです。PC や別の iPhone の拾い帳で「案件ファイルを読み込む」から開けます。控えとしても保存しておいてください。</p>
      <button class="big ghost" id="expP">案件ファイルに書き出す</button></div>`;
    $('expX').onclick = async () => { busy(true, 'Excel を作っています…'); try { await saveNow(); await shareFile(await Excel.blob(P), P.name + '_拾い帳.xlsx'); } catch (e) { toast(e.message, 4000); } finally { busy(false); } };
    $('expPdf').onclick = async () => { busy(true, 'PDF を作っています…'); try { await saveNow();
        const b = await PrintPdf.blob(P, pageSrc, (i, n) => busy(true, 'PDF を作っています… ' + i + ' / ' + n));
        busy(false); await shareFile(b, P.name + '_拾い図.pdf'); } catch (e) { console.error(e); toast(e.message, 4000); } finally { busy(false); } };
    $('expP').onclick = async () => { busy(true, '書き出し中…'); try { await saveNow(); await shareFile(await Store.exportProj(P), P.name + '.hiroicho'); } catch (e) { toast(e.message, 4000); } finally { busy(false); } };
  }
}

/* ═════════ 部材の編集 ═════════ */
let itemsBack = 'draw';
function openItems(back) { itemsBack = back || 'draw'; show('items'); $('thIn').value = P.threshold; renderItems(); }
$('btnItems').onclick = () => openItems('ledger');
$('btnItemsBack').onclick = () => { show(itemsBack); if (itemsBack === 'ledger') renderLedger(); else { renderItemBar(); redraw(); } };
$('thIn').onchange = () => { const v = parseFloat($('thIn').value); if (v >= 0) { push(); P.threshold = v; changed(); } };
function renderItems() {
  const a = agg();
  $('itemsBody').innerHTML = '<div class="list">' + (P.items.map((it, i) => {
    const T = a.T[it.id];
    return `<div class="row" data-id="${it.id}"><span class="k" style="width:22px">${i + 1}</span><i class="sw" style="background:${it.color}"></i><span class="nm">${esc(it.name)}</span>
      <span class="k">${KIND[it.kind].lbl}</span><span class="v">${it.w ? it.w + ' ' + KIND[it.kind].wLbl : (it.kind === 'mem' ? '<span style="color:var(--warn)">単重なし</span>' : '')}
      <small>${it.bolt ? 'ボルト ' + it.bolt + ' ・ ' : ''}${catOf(it)}${T.n ? ' ・ 拾い ' + T.n : ''}</small></span></div>`;
  }).join('') || '<div class="empty">部材がありません。右上の「＋」で1つずつ、「貼り付け」で Excel からまとめて追加できます。</div>') + '</div>';
  $('itemsBody').querySelectorAll('.row').forEach(r => r.onclick = () => editItem(itemOf(P, +r.dataset.id)).then(renderItems));
}
async function editItem(it) {
  const isNew = !it, v = it || { name: '', kind: 'mem', w: '', bolt: '', cat: '', color: genColor(P.items.length + 1) };
  const r = await dialog(isNew ? '部材を追加' : '部材を直す', `
    <label>部材名</label><input id="eNm" value="${esc(v.name)}">
    <div class="row2"><div><label>種類</label><select id="eKd">${['pcs', 'm', 'mem'].map(k => `<option value="${k}"${v.kind === k ? ' selected' : ''}>${KIND[k].lbl}</option>`).join('')}</select></div>
    <div><label>単重(kg/m・kg/個)</label><input id="eW" type="number" inputmode="decimal" value="${esc(v.w)}"></div></div>
    <div class="row2"><div><label>ボルト</label><input id="eB" type="number" inputmode="decimal" value="${esc(v.bolt)}"></div>
    <div><label>柱/G/B/他</label><select id="eC"><option value="">名前から(G→G、B→B)</option>${CATS.map(c => `<option${v.cat === c ? ' selected' : ''}>${c}</option>`).join('')}</select></div></div>
    <label>色</label><input id="eCol" type="color" value="${v.color}" style="height:44px;padding:2px">
    <p style="font-size:12.5px;color:var(--ink2);margin-top:8px">個: タップ1回で数える / m: 2点で長さ / 部材: 2点で長さ→重量→吊・手付</p>`,
    [...(isNew ? [] : [{ label: '消す', cls: 'warn', value: 'del' }]), { label: 'やめる', value: null },
     { label: 'OK', cls: 'pri', read: () => { const nm = $('eNm').value.trim(); if (!nm) { toast('部材名を入れてください'); return false; }
        return { name: nm, kind: $('eKd').value, w: parseFloat($('eW').value) || 0, bolt: parseFloat($('eB').value) || 0, cat: $('eC').value, color: $('eCol').value }; } }]);
  if (!r) return null;
  if (r === 'del') {
    const n = P.pages.reduce((s, pg) => s + pg.dots.filter(d => d.it === it.id).length + pg.lens.filter(l => l.it === it.id).length, 0);
    if (n && !(await confirmDlg('部材を消す', '「' + it.name + '」で拾った印 ' + n + '件も一緒に消えます。', '消す', 'warn'))) return null;
    push();
    P.items.splice(P.items.indexOf(it), 1);
    P.pages.forEach(pg => { pg.dots = pg.dots.filter(d => d.it !== it.id); pg.lens = pg.lens.filter(l => l.it !== it.id); });
    if (P.activeItem === it.id) P.activeItem = P.items[0] ? P.items[0].id : 0;
    changed(); return null;
  }
  push();
  if (isNew) { const ni = Object.assign({ id: nextId(P) }, r); P.items.push(ni); changed(); return ni; }
  Object.assign(it, r); changed(); return it;
}
$('btnAddItem').onclick = () => editItem(null).then(renderItems);
$('btnPaste').onclick = async () => {
  const txt = await dialog('Excel から貼り付け', `<p>Excel で「部材名・種類・単重・ボルト・柱/G/B/他」の順の列をコピーして、下に貼り付けてください(種類・単重などは無くてもかまいません)。</p>
    <textarea id="eTx" placeholder="G1&#9;部材&#9;60&#9;4&#10;B1&#9;部材&#9;30&#10;EV&#9;個&#9;50"></textarea>`,
    [{ label: 'やめる', value: null }, { label: '追加する', cls: 'pri', read: () => $('eTx').value }]);
  if (!txt) return;
  const lines = txt.split(/\r?\n/).map(l => l.split(/\t|,/).map(s => s.trim())).filter(c => c[0]);
  if (lines.length && /部材名|名前/.test(lines[0][0])) lines.shift();
  if (!lines.length) return;
  push();
  let n = 0;
  lines.forEach(c => {
    const kind = KIND_BY_LBL[c[1]] || 'mem';
    P.items.push({ id: nextId(P), name: c[0], kind, w: parseFloat(c[2]) || 0, bolt: parseFloat(c[3]) || 0, cat: CATS.includes(c[4]) ? c[4] : '', color: genColor(P.items.length + 1) });
    n++;
  });
  if (!P.activeItem && P.items.length) P.activeItem = P.items[0].id;
  changed(); renderItems(); toast(n + '件の部材を追加しました');
};

/* ═════════ 図面の操作をつなぐ ═════════ */
Viewer.init({ view: $('view'), sheet: $('sheet'), baseC: $('baseC'), detC: $('detC'), svg: $('ovl'), loupe: $('loupe'), loupeC: $('loupeC') }, {
  tap: onTap, place: onPlace,
  wantsLoupe: () => ['pick', 'zone', 'scale'].includes(S.mode),
  loupePoint, zoomed: () => redraw()
});
document.addEventListener('keydown', e => {
  if (!P || $('draw').classList.contains('hidden')) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.key === 'Escape') { S.pend = null; S.zonePts = []; S.scalePts = []; hidePop(); redraw(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.key === 'ArrowRight' && S.mode !== 'review') stepItem(1);
  else if (e.key === 'ArrowLeft' && S.mode !== 'review') stepItem(-1);
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
renderHome();
