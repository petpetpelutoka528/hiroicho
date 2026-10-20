'use strict';
/* ═══════════════════════════════════════════════════════════
   拾い帳 — 計算(拾い帳 v5 と同じ考え方)
   長さ・重量・吊/手付は保存しない。毎回、印と縮尺・単重・境目から計算する
   → 縮尺や単重を後から直しても、全部の数字が追従する
   座標の単位 u = PDF の 1pt × RS(拾い帳 v5 と同じ)
═══════════════════════════════════════════════════════════ */
const RS = 2.5;
const MM_PER_U = 25.4 / 72 / RS;            // 用紙上の 1u の長さ(mm)
const KIND = {
  pcs: { lbl: '個', unit: '個', wLbl: 'kg/個' },
  m:   { lbl: 'm',  unit: 'm',  wLbl: 'kg/m' },
  mem: { lbl: '部材', unit: '本', wLbl: 'kg/m' }
};
const KIND_BY_LBL = { '個': 'pcs', 'm': 'm', 'M': 'm', '部材': 'mem' };
const CATS = ['柱', 'G', 'B', '他'];

function hsl2hex(h, s, l) {
  s /= 100; l /= 100; const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}
function genColor(n) { return hsl2hex((n * 137.508) % 360, 62 + ((n * 7) % 18), 38 + ((n * 11) % 14)); }
function natCmp(a, b) { return String(a).localeCompare(String(b), 'ja', { numeric: true }); }

/* ── 案件 ── */
function newProject(name) {
  const now = Date.now();
  return { id: 'p' + now.toString(36) + Math.random().toString(36).slice(2, 6), name: name || '新しい案件',
    createdAt: now, updatedAt: now, ver: 1, threshold: 35, nid: 1, items: [], files: [], pages: [], cur: 0, activeItem: 0 };
}
function nextId(P) { return P.nid++; }
function itemOf(P, id) { return P.items.find(i => i.id === id); }
function catOf(it) {
  if (it.cat) return it.cat;
  const c = String(it.name || '').toUpperCase();
  return c.includes('G') ? 'G' : c.includes('B') ? 'B' : '他';
}
function scaleN(pg) { return pg && pg.scale ? pg.scale / MM_PER_U : 0; }          // 縮尺 1/N の N
function setScaleN(pg, n) { pg.scale = n > 0 ? n * MM_PER_U : 0; }
function lenMm(pg, l) { return Math.hypot(l.x2 - l.x1, l.y2 - l.y1) * (pg.scale || 0); }
function lineKg(it, mm) { return it && it.w ? mm / 1000 * it.w : 0; }
function judge(P, it, kg) { return it.kind !== 'mem' || !it.w ? '' : (kg >= P.threshold ? '吊' : '手付'); }

/* ── 工区 ── */
function pip(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (((a.y > y) !== (b.y > y)) && (x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x)) c = !c;
  }
  return c;
}
function zoneAt(pg, x, y) { for (let i = pg.zones.length - 1; i >= 0; i--) if (pip(pg.zones[i].pts, x, y)) return pg.zones[i]; return null; }
function markPt(o) { return o.x1 !== undefined ? { x: (o.x1 + o.x2) / 2, y: (o.y1 + o.y2) / 2 } : { x: o.x, y: o.y }; }
/* 印の工区: 自分で選んだ工区(o.zn)があればそれ。なければ印(線は真ん中)の場所の工区 */
function zoneOfMark(pg, o) {
  if (o.zn !== undefined) { if (o.zn === '__none') return null; if (pg.zones.some(z => z.name === o.zn)) return o.zn; }
  const p = markPt(o), z = zoneAt(pg, p.x, p.y); return z ? z.name : null;
}
/* 線がかかっている工区(名前)と、工区の外にもはみ出しているか */
function zonesTouched(pg, l) {
  const names = [], pts = [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }, markPt(l)];
  let out = false;
  pts.forEach(p => { if (!zoneAt(pg, p.x, p.y)) out = true; });
  pg.zones.forEach(z => {
    let hit = pts.some(p => pip(z.pts, p.x, p.y));
    if (!hit) for (let i = 0; i < z.pts.length && !hit; i++) { const a = z.pts[i], b = z.pts[(i + 1) % z.pts.length]; if (segX(l.x1, l.y1, l.x2, l.y2, a.x, a.y, b.x, b.y)) hit = true; }
    if (hit && !names.includes(z.name)) names.push(z.name);
  });
  return { names: names.sort(natCmp), out };
}
/* 工区をまたいでいて、まだ自分で振り分けていない線 */
function needsZone(pg, l) { return l.x1 !== undefined && pg.zones.length > 0 && l.zn === undefined && crosses(pg, l); }
function segX(ax, ay, bx, by, cx, cy, dx, dy) {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx); if (!d) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d, u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t > 0.02 && t < 0.98 && u >= 0 && u <= 1;
}
function crosses(pg, l) {
  return pg.zones.some(z => { const p = z.pts; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length];
    if (segX(l.x1, l.y1, l.x2, l.y2, a.x, a.y, b.x, b.y)) return true; } return false; });
}
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
  let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
/* ── 伏図の範囲(1枚の図面に 2F・3F… と並んでいるとき) ── */
function secsOf(pg) { return (pg && pg.secs) || []; }
function secAt(pg, x, y) { const ss = secsOf(pg); for (let i = ss.length - 1; i >= 0; i--) if (pip(ss[i].pts, x, y)) return ss[i]; return null; }
function polyC(pts) { return pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 }); }
/* 印の「かたまり」(工区毎P算出の 数量1・数量2… の単位)
   工区毎P算出に入れる図面(pg.zp)だけ。図面1枚で1つ。伏図の範囲を囲んだ図面だけは、その範囲ごと(範囲の外は入れない) */
function blockOf(P, pi, o) {
  const pg = P.pages[pi]; if (!pg.zp) return null;
  if (!secsOf(pg).length) return pageName(P, pi);
  const p = markPt(o), s = secAt(pg, p.x, p.y); return s ? s.name : null;
}
function zoneNames(P) {
  const seen = new Map();
  P.pages.forEach(p => p.zones.forEach(z => { if (!seen.has(z.name)) seen.set(z.name, z.color); }));
  return [...seen.keys()].sort(natCmp);
}
function pageName(P, i) {
  const pg = P.pages[i]; if (!pg) return '';
  if (pg.name) return pg.name;
  const f = P.files.find(f => f.id === pg.file);
  const base = f ? f.name.replace(/\.[^.]+$/, '') : '図面';
  const n = P.pages.filter(q => q.file === pg.file).length;
  return n > 1 ? base + ' P' + pg.p : base;
}

/* ── 集計(全部ここから) ── */
function blank() { return { n: 0, q: 0, mm: 0, kg: 0, sl: 0, hd: 0, rv: 0, cat: {} }; }
function addTo(c, it, mm, kg, j, rv) {
  c.n++; c.mm += mm; c.kg += kg; if (rv) c.rv++;
  c.q = it.kind === 'm' ? c.mm / 1000 : c.n;
  if (j === '吊') c.sl++; else if (j === '手付') c.hd++;
}
function aggregate(P) {
  const cols = [...zoneNames(P), '__none'];
  const M = {}, T = {}, PG = {}, rows = [];
  P.items.forEach(it => { M[it.id] = {}; cols.forEach(c => M[it.id][c] = blank()); T[it.id] = blank(); PG[it.id] = P.pages.map(() => blank()); });
  P.pages.forEach((pg, pi) => {
    pg.dots.forEach(d => { const it = itemOf(P, d.it); if (!it) return;
      const z = zoneOfMark(pg, d) || '__none', kg = it.w || 0;
      addTo(M[it.id][z], it, 0, kg, '', d.rv); addTo(T[it.id], it, 0, kg, '', d.rv); addTo(PG[it.id][pi], it, 0, kg, '', d.rv);
      rows.push({ pi, o: d, it, zone: z, blk: blockOf(P, pi, d), mm: 0, kg, j: '', cross: false }); });
    pg.lens.forEach(l => { const it = itemOf(P, l.it); if (!it) return;
      const z = zoneOfMark(pg, l) || '__none', mm = lenMm(pg, l), kg = lineKg(it, mm), j = judge(P, it, kg);
      addTo(M[it.id][z], it, mm, kg, j, l.rv); addTo(T[it.id], it, mm, kg, j, l.rv); addTo(PG[it.id][pi], it, mm, kg, j, l.rv);
      rows.push({ pi, o: l, it, zone: z, blk: blockOf(P, pi, l), mm, kg, j, cross: needsZone(pg, l) }); });
  });
  const orphan = P.pages.reduce((s, pg) => s + pg.dots.filter(d => !itemOf(P, d.it)).length + pg.lens.filter(l => !itemOf(P, l.it)).length, 0);
  return { cols, M, T, PG, rows, orphan };
}
/* 工区毎P算出: 伏図(かたまり) × 工区 × 柱/G/B/他。mode = 'sl'(吊の本数) / 'hd'(手付の本数) / 'len'(部材の長さ m) */
const ZCATS = ['柱', 'G', 'B', '他'];
const ZMODE = { sl: '吊(本)', hd: '手付(本)', len: '長さ(m)' };
function zoneTable(P, A, mode) {
  const blocks = [];
  P.pages.forEach((pg, pi) => {
    if (!pg.zp) return;
    const ss = secsOf(pg);
    if (!ss.length) { const n = pageName(P, pi); if (!blocks.includes(n)) blocks.push(n); }
    else ss.map(s => s.name).sort(natCmp).forEach(n => { if (!blocks.includes(n)) blocks.push(n); });
  });
  const V = {}, use = rw => rw.it.kind === 'mem' && (mode === 'len' ? true : rw.j === (mode === 'hd' ? '手付' : '吊'));
  let outside = false;
  A.rows.forEach(rw => { if (!rw.blk || !use(rw)) return;
    const z = rw.zone === '__none' ? '' : rw.zone; if (!z) outside = true;
    const k = rw.blk + '|' + z + '|' + catOf(rw.it); V[k] = (V[k] || 0) + (mode === 'len' ? rw.mm / 1000 : 1); });
  const zones = [...zoneNames(P), ...(outside ? [''] : [])];
  const get = (b, z, c) => V[b + '|' + z + '|' + c] || 0;
  return { blocks, zones, get };
}
function qtyTxt(it, c) { if (!c || !c.n) return ''; return it.kind === 'm' ? (c.mm / 1000).toFixed(2) : String(c.n); }
function totals(P, A) {
  let pcs = 0, sl = 0, hd = 0, mem = 0, len = 0, kg = 0, n = 0, rv = 0;
  P.items.forEach(it => { const t = A.T[it.id]; kg += t.kg; n += t.n; rv += t.rv;
    if (it.kind === 'pcs') pcs += t.n; else if (it.kind === 'm') len += t.mm; else { mem += t.n; sl += t.sl; hd += t.hd; } });
  return { pcs, sl, hd, mem, len, kg, n, rv };
}
/* 気になる点 */
function issues(P, A) {
  const out = [];
  const hasZones = P.pages.some(p => p.zones.length);
  const cross = A.rows.filter(r => r.cross);
  if (cross.length) out.push('工区をまたいでいて、どちらに入れるか決めていない線  ' + cross.length + '件(見直しの「工区をまたぐ線」で選べます)');
  if (hasZones) { const un = A.rows.filter(r => r.zone === '__none'); if (un.length) out.push('どの工区にも入っていない拾い  ' + un.length + '件'); }
  P.items.filter(it => it.kind === 'mem' && !it.w && A.T[it.id].n).forEach(it => out.push('「' + it.name + '」の単重が未設定(重量・吊/手付が出ません)'));
  P.pages.forEach((pg, pi) => { if (!pg.scale && pg.lens.length) out.push(pageName(P, pi) + ' は縮尺が未設定なのに線があります(長さ0)'); });
  if (A.orphan) out.push('部材の一覧にない部材の拾い  ' + A.orphan + '件(部材を消した場合など)');
  const dup = dupMarks(P); if (dup.length) out.push('同じ部材がほぼ同じ場所に2回拾われている  ' + dup.length + '件(見直しで確認)');
  const outSec = A.rows.filter(r => !r.blk && P.pages[r.pi].zp && secsOf(P.pages[r.pi]).length && r.it.kind === 'mem').length;
  if (outSec) out.push('工区毎P算出に入れる図面で、伏図の範囲の外にある部材  ' + outSec + '件(工区毎P算出には入りません)');
  if (P.dropped) out.push('書き出しでは、伏図の範囲の外の拾い ' + P.dropped + '件を入れていません');
  if (P.skipped) out.push('書き出しに入れていない図面 ' + P.skipped + '枚');
  const t = totals(P, A); if (t.n && t.rv < t.n) out.push('見直しがまだの印  ' + (t.n - t.rv) + '件 / ' + t.n + '件');
  return out;
}
/* 二重に拾っていそうな印(同じ部材・ほぼ同じ場所) */
function dupMarks(P) {
  const out = [];
  P.pages.forEach((pg, pi) => {
    for (let i = 0; i < pg.dots.length; i++) for (let j = i + 1; j < pg.dots.length; j++) {
      const a = pg.dots[i], b = pg.dots[j];
      if (a.it === b.it && Math.hypot(a.x - b.x, a.y - b.y) < 6) out.push({ pi, o: b });
    }
    for (let i = 0; i < pg.lens.length; i++) for (let j = i + 1; j < pg.lens.length; j++) {
      const a = pg.lens[i], b = pg.lens[j]; if (a.it !== b.it) continue;
      const same = (Math.hypot(a.x1 - b.x1, a.y1 - b.y1) < 6 && Math.hypot(a.x2 - b.x2, a.y2 - b.y2) < 6) ||
                   (Math.hypot(a.x1 - b.x2, a.y1 - b.y2) < 6 && Math.hypot(a.x2 - b.x1, a.y2 - b.y1) < 6);
      if (same) out.push({ pi, o: b });
    }
  });
  return out;
}
/* 見直しの順番: 図面の順 → 部材の並び順 → 上から下・左から右 */
function reviewList(P, filter, itemId) {
  const order = new Map(P.items.map((it, i) => [it.id, i]));
  const out = [];
  P.pages.forEach((pg, pi) => {
    const ms = [...pg.dots, ...pg.lens].filter(o => itemOf(P, o.it));
    ms.forEach(o => { if (filter === 'todo' && o.rv) return; if (filter === 'item' && o.it !== itemId) return; if (filter === 'cross' && !needsZone(pg, o)) return;
      const p = markPt(o); out.push({ pi, o, k: [pi, order.get(o.it), Math.round(p.y / 80), p.x] }); });
  });
  out.sort((a, b) => { for (let i = 0; i < 4; i++) if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i]; return 0; });
  return out;
}
