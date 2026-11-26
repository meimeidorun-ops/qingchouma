// 同業比較（2026-11-26，仿籌碼K線「同業」）：同產業（mk/ind.json）成交值前 12 大＋本檔，
// 比較漲跌、20 日漲跌、本益比、殖利率、月營收年增、評分。點一列開那檔（上一檔／下一檔跟著同業順序）。
async function paintPeers(stock) {
  const box = $('#peer-box');
  if (!box) return;
  box.innerHTML = '';
  if (/^00/.test(stock.stock_id)) return;
  try {
    const [I, V, S, day] = await Promise.all([Mk.load('ind'), Mk.load('val').catch(() => null), Mk.load('scores').catch(() => null), Mk.dayMap()]);
    if (currentStock !== stock) return;
    const code = I.s[stock.stock_id];
    if (!code) return;
    const ids = Object.keys(I.s).filter(id => I.s[id] === code && day.has(id));
    if (ids.length < 2) return;
    ids.sort((a, b) => (day.get(b).money || 0) - (day.get(a).money || 0));
    let pick = ids.slice(0, 12);
    if (!pick.includes(stock.stock_id)) pick = pick.slice(0, 11).concat(stock.stock_id);
    const sg = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
    const rows = pick.map(id => {
      const d = day.get(id), v = V && V.s[id], s = S && S.items[id];
      return { id, name: d.name, pct: d.pct, pct20: d.pct20, pe: v ? v[0] : null, yld: v ? v[1] : null, yoy: v ? v[5] : null, score: s ? s[0] : null };
    });
    // 產業平均（中位數比較不受極端值影響）
    const med = key => { const a = rows.map(r => r[key]).filter(x => x != null && isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
    const m = { pct20: med('pct20'), pe: med('pe'), yld: med('yld'), yoy: med('yoy') };
    const me = rows.find(r => r.id === stock.stock_id);
    const cmp = [];
    if (me) {
      if (me.pe != null && m.pe != null) cmp.push(`本益比 ${me.pe} 倍，同業中位數 ${m.pe} 倍（${me.pe < m.pe ? '比同業便宜' : '比同業貴'}）`);
      if (me.yoy != null && m.yoy != null) cmp.push(`月營收年增 ${sg(me.yoy)}，同業中位數 ${sg(m.yoy)}`);
      if (me.pct20 != null && m.pct20 != null) cmp.push(`近 20 日 ${sg(me.pct20)}，同業中位數 ${sg(m.pct20)}`);
    }
    box.innerHTML = `<div class="section-label">同業比較（${I.names[code]}，共 ${ids.length} 檔，取成交值前 12）</div>
      ${cmp.length ? `<div class="peer-sum">${cmp.map(x => `<div>• ${x}</div>`).join('')}</div>` : ''}
      <div class="table-wrap"><table class="data-table compact peer-tbl"><thead><tr><th>股票</th><th>漲跌</th><th>20日</th><th>本益比</th><th>殖利率</th><th>營收<br>年增</th><th>評分</th></tr></thead><tbody>
      ${rows.map(r => `<tr data-id="${r.id}" class="${r.id === stock.stock_id ? 'me' : ''}"><td><b>${mkEsc(r.name)}</b><br><span class="dim">${r.id}</span></td>
        <td class="${signClass(r.pct)}">${r.pct == null ? '—' : pctFmt(r.pct)}</td><td class="${signClass(r.pct20)}">${sg(r.pct20)}</td>
        <td>${r.pe ?? '—'}</td><td>${r.yld == null ? '—' : r.yld + '%'}</td><td class="${signClass(r.yoy)}">${sg(r.yoy)}</td><td>${r.score ?? '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="hint" style="padding:2px 16px 14px">產業分類：證交所／櫃買公布的產業別。漲跌為最近收盤；評分只有成交金額前 350 大才有。點一列看那檔。</p>`;
    box.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => {
      if (tr.dataset.id === stock.stock_id) return;
      navStocks = rows.map(r => ({ stock_id: r.id, stock_name: r.name }));
      const cur = ($('.tab-btn.active') || {}).dataset;
      openStock({ stock_id: tr.dataset.id, stock_name: day.get(tr.dataset.id).name }, { keepTab: cur && cur.tab });
    }));
  } catch (e) { /* 沒資料不顯示 */ }
}
