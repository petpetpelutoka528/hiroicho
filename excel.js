'use strict';
/* ═══════════════════════════════════════════════════════════
   Excel に書き出す(Excel 版と同じ表)
   部材 / 集計 / 吊材積算・手付積算 / 工区毎P算出(吊)・工区毎_手付・工区毎_長さm
═══════════════════════════════════════════════════════════ */
const Excel = (() => {
  let loading = null;
  function load() {
    if (window.ExcelJS) return Promise.resolve();
    return loading || (loading = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'exceljs.min.js';
      s.onload = res; s.onerror = () => { loading = null; rej(new Error('Excel の部品を読み込めませんでした')); };
      document.head.appendChild(s);
    }));
  }
  const FONT = '游ゴシック';
  const THICK = { style: 'medium', color: { argb: 'FF000000' } };
  const DOT = { style: 'dotted', color: { argb: 'FF000000' } };
  const GRAY = 'FF7F7F7F', BLUE = 'FF1F4E9F';
  const NUM = '#,##0.##;-#,##0.##;;@';
  const f9 = (o) => Object.assign({ name: FONT, size: 9 }, o || {});
  function title(ws, row, c0, c1, text) {
    for (let c = c0; c <= c1; c++) { const x = ws.getCell(row, c); x.border = Object.assign({}, x.border, { top: THICK }); }
    const x = ws.getCell(row, c0); x.value = text; x.font = f9({ color: { argb: GRAY } });
  }
  function rowsDotted(ws, r0, r1, c0, c1) {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const x = ws.getCell(r, c); x.border = Object.assign({}, x.border, { bottom: r === r1 ? THICK : DOT });
    }
  }
  const argb = c => { let h = String(c || '').replace('#', ''); if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, x => x + x); return 'FF' + (/^[0-9a-f]{6}$/i.test(h) ? h.toUpperCase() : '888888'); };

  async function build(P) {
    await load();
    const A = aggregate(P), t = totals(P, A);
    const wb = new ExcelJS.Workbook(); wb.creator = '拾い帳';

    /* ── 部材 ── */
    {
      const ws = wb.addWorksheet('部材', { views: [{ state: 'frozen', ySplit: 5, showGridLines: false }] });
      [4, 4, 14, 6, 7, 6, 6, 9, 8, 4, 8, 6, 6, 9].forEach((w, i) => ws.getColumn(i + 1).width = w);
      title(ws, 1, 1, 14, '部材');
      [['個', t.pcs], ['吊', t.sl], ['手付', t.hd], ['t', Math.round(t.kg / 10) / 100]].forEach(([l, v], i) => {
        const a = ws.getCell(2, 3 + i * 2); a.value = l; a.font = f9({ color: { argb: GRAY } }); a.alignment = { horizontal: 'right' };
        const b = ws.getCell(2, 4 + i * 2); b.value = v; b.font = f9({ size: 12, bold: true });
      });
      ws.getCell(3, 3).value = '吊/手付の境目'; ws.getCell(3, 3).font = f9({ color: { argb: GRAY } });
      ws.getCell(3, 4).value = P.threshold; ws.getCell(3, 4).font = f9({ bold: true, color: { argb: BLUE } });
      ws.getCell(3, 5).value = 'kg 以上を「吊」'; ws.getCell(3, 5).font = f9({ color: { argb: GRAY } });
      const hd = ['No', '色', '部材名', '種類', '単重', '', 'ボルト', '柱/G/B/他', '数', '', '長さm', '吊', '手付', '重量kg'];
      hd.forEach((h, i) => { const x = ws.getCell(5, i + 1); x.value = h; x.font = f9(); x.border = { bottom: DOT }; x.alignment = { horizontal: i === 2 ? 'left' : 'center' }; });
      let r = 6;
      P.items.forEach((it, i) => {
        const T = A.T[it.id];
        const v = [i + 1, '', it.name, KIND[it.kind].lbl, it.w || null, KIND[it.kind].wLbl, it.bolt || null, catOf(it),
          it.kind === 'm' ? (T.mm ? Math.round(T.mm / 10) / 100 : null) : (T.n || null), KIND[it.kind].unit,
          it.kind === 'mem' && T.mm ? Math.round(T.mm / 10) / 100 : null,
          it.kind === 'mem' && T.sl ? T.sl : null, it.kind === 'mem' && T.hd ? T.hd : null, T.kg ? Math.round(T.kg * 10) / 10 : null];
        v.forEach((val, c) => { const x = ws.getCell(r, c + 1); x.value = val; x.font = f9(c === 2 ? { color: { argb: BLUE } } : {});
          if (c >= 8 && c !== 9) x.numFmt = NUM; });
        ws.getCell(r, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(it.color) } };
        r++;
      });
      rowsDotted(ws, 6, Math.max(6, r - 1), 1, 14);
    }

    /* ── 集計(部材 × 工区) + 図面ごとの数 ── */
    {
      const ws = wb.addWorksheet('集計', { views: [{ showGridLines: false }] });
      const zs = A.cols.filter(c => c !== '__none'), hasZ = zs.length > 0;
      const cols = hasZ ? [...zs, '__none'] : [];
      const head = ['部材', ...zs, ...(hasZ ? ['未割当'] : []), '計', '長さm', '重量kg'];
      title(ws, 1, 1, head.length, '集計');
      const top = 3;
      head.forEach((h, i) => { const x = ws.getCell(top, i + 1); x.value = h; x.font = f9(); x.alignment = { horizontal: i ? 'right' : 'left' }; });
      let r = top + 1;
      P.items.forEach(it => {
        const T = A.T[it.id];
        ws.getCell(r, 1).value = it.name;
        cols.forEach((c, j) => { const q = qtyTxt(it, A.M[it.id][c]); if (q) ws.getCell(r, 2 + j).value = +q; });
        const base = 2 + cols.length;
        if (T.n) ws.getCell(r, base).value = +qtyTxt(it, T);
        if (it.kind === 'mem' && T.mm) ws.getCell(r, base + 1).value = Math.round(T.mm / 10) / 100;
        if (T.kg) ws.getCell(r, base + 2).value = Math.round(T.kg);
        r++;
      });
      ws.getCell(r, 1).value = '吊/手付(本)'; ws.getCell(r + 1, 1).value = '重量(t)';
      cols.forEach((c, j) => { let sl = 0, hdn = 0, kg = 0; P.items.forEach(it => { const x = A.M[it.id][c]; sl += x.sl; hdn += x.hd; kg += x.kg; });
        if (sl + hdn) ws.getCell(r, 2 + j).value = sl + '/' + hdn; if (kg) ws.getCell(r + 1, 2 + j).value = Math.round(kg / 10) / 100; });
      ws.getCell(r, 2 + cols.length).value = t.sl + '/' + t.hd; ws.getCell(r + 1, 2 + cols.length).value = Math.round(t.kg / 10) / 100;
      for (let rr = top; rr <= r + 1; rr++) for (let c = 1; c <= head.length; c++) {
        const x = ws.getCell(rr, c); x.font = f9({ bold: rr >= r || c === 2 + cols.length });
        x.alignment = { horizontal: c === 1 ? 'left' : 'right' }; if (c > 1) x.numFmt = NUM;
        x.border = { top: rr === top ? DOT : undefined, bottom: rr === r + 1 ? THICK : DOT };
      }
      ws.getColumn(1).width = 14; for (let c = 2; c <= head.length; c++) ws.getColumn(c).width = 8;
      // 気になる点
      let n = r + 4;
      ws.getCell(n, 1).value = '気になる点'; ws.getCell(n, 1).font = f9({ color: { argb: GRAY } }); n++;
      const iss = issues(P, A);
      (iss.length ? iss.map(s => '・' + s) : ['気になる点はありません']).forEach(s => { ws.getCell(n, 1).value = s; ws.getCell(n, 1).font = f9(); n++; });
      // 図面ごとの数(右)
      const c0 = head.length + 2, np = P.pages.length;
      ws.getCell(top - 1, c0).value = '図面ごとの数'; ws.getCell(top - 1, c0).font = f9({ color: { argb: GRAY } });
      ws.getCell(top, c0).value = '部材';
      P.pages.forEach((pg, i) => ws.getCell(top, c0 + 1 + i).value = pageName(P, i));
      ws.getCell(top, c0 + 1 + np).value = '計';
      P.items.forEach((it, k) => {
        const rr = top + 1 + k; ws.getCell(rr, c0).value = it.name;
        P.pages.forEach((pg, i) => { const q = qtyTxt(it, A.PG[it.id][i]); if (q) ws.getCell(rr, c0 + 1 + i).value = +q; });
        const q = qtyTxt(it, A.T[it.id]); if (q) ws.getCell(rr, c0 + 1 + np).value = +q;
      });
      const lastR = top + P.items.length;
      for (let rr = top; rr <= lastR; rr++) for (let c = c0; c <= c0 + 1 + np; c++) {
        const x = ws.getCell(rr, c); x.font = f9({ bold: c === c0 + 1 + np }); x.alignment = { horizontal: c === c0 ? 'left' : 'right' };
        if (c > c0) x.numFmt = NUM; x.border = { top: rr === top ? DOT : undefined, bottom: rr === lastR ? THICK : DOT };
      }
      ws.getColumn(c0).width = 14;
    }

    /* ── 吊材積算・手付積算(左右に並べる) ── */
    {
      const ws = wb.addWorksheet('吊材積算・手付積算', { views: [{ showGridLines: false }] });
      const P0 = 4, NROW = Math.max(40, P.items.length);
      [[1, '吊材積算', 'sl'], [10, '手付積算', 'hd']].forEach(([c0, ttl, key]) => {
        [10, 6, 6, 6, 6, 6, 7, 9].forEach((w, i) => ws.getColumn(c0 + i).width = w);
        title(ws, 1, c0, c0 + 7, ttl);
        ['部材名', '2F', '3F', '4F', '5F', 'ボルト', '合計数', 'ボルト数量'].forEach((h, i) => {
          const x = ws.getCell(3, c0 + i); x.value = h; x.font = f9(); x.alignment = { horizontal: i ? 'right' : 'left' }; x.border = { bottom: DOT }; });
        const L = k => ws.getColumn(c0 + k).letter;
        let r = P0;
        P.items.forEach(it => { if (it.kind !== 'mem') return; const n = A.T[it.id][key]; if (!n) return;
          ws.getCell(r, c0).value = it.name; ws.getCell(r, c0 + 1).value = n; if (it.bolt) ws.getCell(r, c0 + 5).value = it.bolt; r++; });
        for (let rr = P0; rr < P0 + NROW; rr++) {
          ws.getCell(rr, c0 + 6).value = { formula: `IF(${L(0)}${rr}="","",SUM(${L(1)}${rr}:${L(4)}${rr}))` };
          ws.getCell(rr, c0 + 7).value = { formula: `IF(${L(0)}${rr}="","",${L(6)}${rr}*N(${L(5)}${rr}))` };
          for (let k = 0; k < 8; k++) { const x = ws.getCell(rr, c0 + k); x.font = f9(k <= 1 ? { color: { argb: BLUE } } : {});
            x.alignment = { horizontal: k ? 'right' : 'left' }; if (k) x.numFmt = NUM; }
        }
        rowsDotted(ws, P0, P0 + NROW - 1, c0, c0 + 7);
      });
      ws.getColumn(9).width = 6;
    }

    /* ── 工区毎P算出(伏図の数だけ: 柱 G B 他 軸 軸 軸 小計)。吊・手付・長さの3枚 ── */
    [['sl', '工区毎P算出', '工区毎P算出(吊)'], ['hd', '工区毎_手付', '工区毎(手付の本数)'], ['len', '工区毎_長さm', '工区毎(部材の長さ m)']].forEach(([mode, sheet, head]) => {
      const ws = wb.addWorksheet(sheet, { views: [{ showGridLines: false }] });
      const cats = ['柱', 'G', 'B', '他', '軸', '軸', '軸', '小計'];
      const Z = zoneTable(P, A, mode), nb = Math.max(1, Z.blocks.length), lastC = 1 + nb * 8 + 1;
      const FMT = mode === 'len' ? '0.0;-0.0;;@' : '0;-0;;@';
      title(ws, 1, 1, lastC, head);
      const nShow = Math.max(15, Z.zones.length);
      ws.getCell(4, 1).value = '工区名';
      for (let j = 0; j < nb; j++) {
        const x = ws.getCell(3, 1 + (j + 1) * 8); x.value = Z.blocks[j] || ''; x.alignment = { horizontal: 'right' };
        cats.forEach((c, k) => ws.getCell(4, 2 + j * 8 + k).value = c);
      }
      ws.getCell(4, lastC).value = '合計';
      Z.zones.forEach((z, i) => {
        ws.getCell(5 + i, 1).value = z === '' ? '(工区外)' : z;
        for (let j = 0; j < Z.blocks.length; j++) for (let k = 0; k < 4; k++) {
          const v = Z.get(Z.blocks[j], z, cats[k]); if (v) ws.getCell(5 + i, 2 + j * 8 + k).value = mode === 'len' ? Math.round(v * 10) / 10 : v; }
      });
      // 小計(伏図ごと)と 合計(全部の伏図)。軸の列は手で入れる用(入れれば小計に入る)
      const CL = c => ws.getColumn(c).letter;
      for (let i = 0; i <= nShow; i++) { const r = 5 + i, subs = [], foot = i === nShow;
        for (let j = 0; j < nb; j++) { const c0 = 2 + j * 8; subs.push(CL(c0 + 7) + r);
          if (foot) for (let k = 0; k < 8; k++) { const x = ws.getCell(r, c0 + k); x.value = { formula: `SUM(${CL(c0 + k)}5:${CL(c0 + k)}${r - 1})` }; x.numFmt = FMT; }
          else { const x = ws.getCell(r, c0 + 7); x.value = { formula: `SUM(${CL(c0)}${r}:${CL(c0 + 6)}${r})` }; x.numFmt = FMT; }
          for (let k = 0; k < 7; k++) ws.getCell(r, c0 + k).numFmt = FMT; }
        const t = ws.getCell(r, lastC); t.value = { formula: 'SUM(' + subs.join(',') + ')' }; t.numFmt = FMT; }
      ws.getCell(5 + nShow, 1).value = '計';
      const thin = { style: 'thin', color: { argb: 'FFC8C8C8' } };
      for (let r = 3; r <= 5 + nShow; r++) for (let c = 1; c <= lastC; c++) {
        const x = ws.getCell(r, c); x.font = f9(r === 5 + nShow || (c > 1 && (c - 1) % 8 === 0) || c === lastC ? { bold: true } : {}); if (c > 1 && r !== 3) x.alignment = { horizontal: 'right' };
        const b = {};
        if (r >= 5) { b.bottom = r >= 4 + nShow ? THICK : thin; if (r === 5) b.top = thin; }
        if (c >= 2 && (c - 2) % 8 === 0) b.left = thin;
        if (c === lastC) b.left = thin;
        x.border = b;
      }
      ws.getColumn(1).width = 10;
      for (let c = 2; c < lastC; c++) ws.getColumn(c).width = (c - 1) % 8 === 0 ? 6 : (mode === 'len' ? 6 : 4.2);
      ws.getColumn(lastC).width = 8;
    });
    return wb;
  }
  async function blob(P) {
    const wb = await build(P);
    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  return { blob, load };
})();
