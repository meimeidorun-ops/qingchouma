// 籌碼總覽（2026-11-21）：個股「即時」頁籤下方，一眼看完法人、融資券、借券、當沖、大戶。
// 全部用手機上已有的全市場檔（mk/inst、margin、dt、tdcc），不用另外等後端。點每一列跳到對應頁籤。
async function paintChipSummary(stock) {
  const box = $('#rt-chips');
  if (!box) return;
  box.innerHTML = '';
  const id = stock.stock_id;
  const [inst, mg, dtd, td] = await Promise.all(['inst', 'margin', 'dt', 'tdcc'].map(n => Mk.load(n).catch(() => null)));
  if (currentStock !== stock) return;
  const sum = (a, n) => { if (!a) return null; let s = 0, k = 0; for (let i = Math.max(0, a.length - n); i < a.length; i++) if (a[i] != null) { s += a[i]; k++; } return k ? s : null; };
  const run = (a) => { if (!a || !a.length) return 0; const sg = Math.sign(a[a.length - 1] || 0); if (!sg) return 0; let n = 0; while (n < a.length && Math.sign(a[a.length - 1 - n] || 0) === sg) n++; return sg * n; };
  const cell = v => v == null ? '<td>—</td>' : `<td class="${signClass(v)}">${v > 0 ? '+' : ''}${numFmt(Math.round(v))}</td>`;
  const I = inst && inst.s[id];
  let instHtml = '';
  if (I) {
    const names = ['外資', '投信', '自營'];
    const tot = I[0].map((_, i) => (I[0][i] || 0) + (I[1][i] || 0) + (I[2][i] || 0));
    const rows = [...I.map((a, k) => [names[k], a]), ['合計', tot]];
    instHtml = `<table class="data-table compact cs-tbl" data-go="inst"><thead><tr><th>法人（張）</th><th>今天</th><th>5 日</th><th>20 日</th><th>連續</th></tr></thead><tbody>
      ${rows.map(([nm, a]) => { const r = run(a); return `<tr><td>${nm}</td>${cell(a[a.length - 1])}${cell(sum(a, 5))}${cell(sum(a, 20))}<td class="${signClass(r)}">${r ? `連${r > 0 ? '買' : '賣'} ${Math.abs(r)}` : '—'}</td></tr>`; }).join('')}
      </tbody></table><div class="cs-date">法人資料日 ${inst.days[inst.days.length - 1].slice(5)}</div>`;
  }
  const pills = [];
  const M = mg && mg.s[id];
  if (M && M[0]) {
    const L = mg.days.length, m0 = M[0][L - 1], m5 = M[0][L - 6], s0 = M[1] && M[1][L - 1];
    if (m0 != null) pills.push(['margin', '融資', `${numFmt(m0)} 張`, m5 ? `5 日 ${m0 - m5 >= 0 ? '+' : ''}${numFmt(m0 - m5)}（${((m0 / m5 - 1) * 100).toFixed(1)}%）` : '', m5 ? m0 - m5 : 0, true]);
    if (s0 != null && m0) pills.push(['margin', '券資比', `${(s0 / m0 * 100).toFixed(1)}%`, `融券 ${numFmt(s0)} 張`, 0]);
  }
  const D = dtd && dtd.s[id];
  if (D) {
    const L = dtd.days.length, r0 = D[0][L - 1], b0 = D[1][L - 1], b5 = D[1][L - 6];
    const otc = typeof marketFor === 'function' && marketFor(id) === 'TWO';
    if (r0 != null) pills.push(['margin', '當沖占比', `${r0}%`, `${otc ? '上櫃' : '上市'}平均 ${(dtd.mkt[otc ? 'otc' : 'tse'][L - 1] ?? '—')}%`, 0]);
    if (b0 != null) pills.push(['margin', '借券餘額', `${numFmt(b0)} 張`, b5 != null ? `5 日 ${b0 - b5 >= 0 ? '+' : ''}${numFmt(b0 - b5)}` : '', b5 != null ? b0 - b5 : 0, true]);
  }
  const T = td && td.s[id];
  if (T) {
    const W = td.weeks.length, b = T[0][W - 1], b1 = T[0][W - 2], p = T[3][W - 1], p1 = T[3][W - 2];
    if (b != null) pills.push(['holders', '大戶 400 張↑', `${b.toFixed(1)}%`, b1 != null ? `週 ${b - b1 >= 0 ? '+' : ''}${(b - b1).toFixed(2)}` : `${td.weeks[W - 1].slice(5)} 週`, b1 != null ? b - b1 : 0]);
    if (p) pills.push(['holders', '股東人數', numFmt(p), p1 ? `週 ${p - p1 >= 0 ? '+' : ''}${numFmt(p - p1)}` : '', p1 ? -(p - p1) : 0]);
  }
  if (!instHtml && !pills.length) return;
  // 融資、借券增加對股價是偏空的訊號 → 顏色反過來（增加綠、減少紅）
  box.innerHTML = `<div class="section-label">籌碼總覽</div>${instHtml}
    <div class="cs-pills">${pills.map(([go, k, v, sub, sg, inv]) => `<div class="cs-pill" data-go="${go}"><span class="dim">${k}</span><b>${v}</b><span class="${sg ? signClass(inv ? -sg : sg) : 'dim'}">${sub}</span></div>`).join('')}</div>
    <p class="hint" style="padding:2px 16px 14px">融資、借券增加通常代表散戶追價或空方加碼（顏色以綠色表示偏空）。點任一格看詳細頁籤。</p>`;
  box.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => {
    const b = document.querySelector(`.tab-btn[data-tab="${el.dataset.go}"]`);
    if (b) { b.click(); window.scrollTo({ top: 0 }); }
  }));
}
