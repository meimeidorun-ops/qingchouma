// 個股頁「基本面」頁籤：營收、獲利（含預估 EPS）。從 app.js 拆出（2026-09-29）。

// ---- 營收 ----
async function loadRevenue() {
  const container = $('#chart-revenue');
  const stock = currentStock, tk = tabTicket('revenue');
  container.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const rows = await Api.monthRevenue(stock.stock_id, 36);
    if (!tabLive('revenue', tk, stock)) return;
    if (!rows.length) { container.innerHTML = '<div class="error-msg">查無資料</div>'; return; }
    charts.revenue = renderRevenue(container, rows);

    const sorted = [...rows].sort((a, b) => (b.revenue_year * 100 + b.revenue_month) - (a.revenue_year * 100 + a.revenue_month));
    const byKey = new Map(rows.map(r => [`${r.revenue_year}-${r.revenue_month}`, r.revenue]));
    const tbody = $('#table-revenue tbody');
    tbody.innerHTML = sorted.slice(0, 24).map(r => {
      const prev = byKey.get(`${r.revenue_year - 1}-${r.revenue_month}`);
      const yoy = prev ? ((r.revenue - prev) / prev) * 100 : null;
      const prevM = r.revenue_month === 1
        ? byKey.get(`${r.revenue_year - 1}-12`)
        : byKey.get(`${r.revenue_year}-${r.revenue_month - 1}`);
      const mom = prevM ? ((r.revenue - prevM) / prevM) * 100 : null;
      return `<tr>
        <td>${r.revenue_year}/${String(r.revenue_month).padStart(2, '0')}</td>
        <td>${numFmt(r.revenue / 1000)}</td>
        <td class="${mom != null ? signClass(mom) : 'flat'}">${mom != null ? pctFmt(mom) : '—'}</td>
        <td class="${yoy != null ? signClass(yoy) : 'flat'}">${yoy != null ? pctFmt(yoy) : '—'}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    if (tabLive('revenue', tk, stock)) container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// ---- 獲利 ----
// 歷年股利（2026-11-21）：FinMind TaiwanStockDividend（手機快取 7 天），獲利頁籤與 ETF 頁籤下方都有
async function loadDividends(stock, boxSel, tabKey, tk) {
  const box = $(boxSel);
  if (!box) return;
  box.innerHTML = '<div class="section-label">歷年股利</div><div class="loading" style="padding:10px">載入中…</div>';
  try {
    const start = `${new Date().getFullYear() - 8}-01-01`;
    let rows;
    try {
      rows = await finmindGet('TaiwanStockDividend', { data_id: stock.stock_id, start_date: start }, { ttlMs: 7 * 86400e3 });
    } catch (fmErr) {
      // FinMind 失敗（額度、授權碼）→ 改用電腦做好的除權息紀錄（mk/f，只有權息合計，當作現金股利顯示）
      const x = typeof mkShard === 'function' ? await mkShard(stock.stock_id) : null;
      if (!x || !x.d || !x.d.length) throw fmErr;
      rows = x.d.map(([date, v]) => ({ year: date.slice(0, 4), CashEarningsDistribution: v, CashExDividendTradingDate: date }));
    }
    if (!tabLive(tabKey, tk, stock)) return;
    const num = v => Number(v) || 0;
    const list = (rows || []).map(r => ({
      period: String(r.year || '').trim(),
      cash: num(r.CashEarningsDistribution) + num(r.CashStatutorySurplus),
      stock: num(r.StockEarningsDistribution) + num(r.StockStatutorySurplus),
      exDate: r.CashExDividendTradingDate || r.StockExDividendTradingDate || '',
      payDate: r.CashDividendPaymentDate || '',
    })).filter(r => r.cash || r.stock).sort((a, b) => (a.exDate || a.period) < (b.exDate || b.period) ? 1 : -1);
    if (!list.length) { box.innerHTML = '<div class="section-label">歷年股利</div><div class="empty-hint" style="padding:12px">查無配息紀錄</div>'; return; }
    // 依年度（除息日的年份）加總，算「近一年配息」與用目前股價的殖利率
    const byYear = new Map();
    for (const r of list) { const y = (r.exDate || '').slice(0, 4) || r.period; const v = byYear.get(y) || { cash: 0, stock: 0, n: 0 }; v.cash += r.cash; v.stock += r.stock; v.n++; byYear.set(y, v); }
    const priceTxt = ($('#dq-price') || {}).textContent || '';
    const price = parseFloat(priceTxt.replace(/,/g, ''));
    const lastYear = new Date(Date.now() - 365 * 86400e3).toISOString().slice(0, 10);
    const ttm = list.filter(r => r.exDate && r.exDate >= lastYear).reduce((a, r) => a + r.cash, 0);
    const years = [...byYear.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, 8);
    box.innerHTML = `<div class="section-label">歷年股利</div>
      <div class="branch-summary"><span>近一年現金股利 <b>${numFmt(ttm, 2)}</b> 元</span>${price > 0 && ttm ? `<span>以目前股價殖利率 <b>${(ttm / price * 100).toFixed(2)}%</b></span>` : ''}
        <span>連續配息 <b>${(() => { let n = 0; const ys = [...byYear.keys()].filter(y => /^\d{4}$/.test(y)).sort().reverse(); for (let i = 0; i < ys.length; i++) { if (byYear.get(ys[i]).cash > 0 && (i === 0 || Number(ys[i - 1]) - Number(ys[i]) === 1)) n++; else break; } return n; })()}</b> 年</span></div>
      <div class="table-wrap"><table class="data-table compact"><thead><tr><th>年度（除息年）</th><th>現金股利</th><th>股票股利</th><th>次數</th></tr></thead><tbody>
        ${years.map(([y, v]) => `<tr><td>${y}</td><td>${numFmt(v.cash, 2)}</td><td>${v.stock ? numFmt(v.stock, 2) : '—'}</td><td>${v.n}</td></tr>`).join('')}
      </tbody></table></div>
      <details class="mh-more"><summary>每次配息明細</summary><div class="table-wrap"><table class="data-table compact"><thead><tr><th>期別</th><th>除息日</th><th>現金</th><th>股票</th><th>發放日</th></tr></thead><tbody>
        ${list.slice(0, 24).map(r => `<tr><td>${r.period}</td><td>${r.exDate ? r.exDate.slice(2) : '—'}</td><td>${r.cash ? numFmt(r.cash, 3) : '—'}</td><td>${r.stock ? numFmt(r.stock, 2) : '—'}</td><td>${r.payDate ? r.payDate.slice(2) : '—'}</td></tr>`).join('')}
      </tbody></table></div></details>
      <p class="hint" style="padding:2px 16px 14px">資料：FinMind（公開資訊觀測站）。股票股利單位為元（每股面額 10 元，1 元＝配 100 股／張）。</p>`;
  } catch (e) {
    if (tabLive(tabKey, tk, stock)) box.innerHTML = `<div class="section-label">歷年股利</div><div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

async function loadProfit() {
  const container = $('#chart-profit');
  const stock = currentStock, tk = tabTicket('profit');
  loadDividends(stock, '#div-profit', 'profit', tk);
  container.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const rows = await Api.financials(stock.stock_id, 3);
    if (!tabLive('profit', tk, stock)) return;
    if (!rows.length) { container.innerHTML = '<div class="error-msg">查無資料</div>'; return; }

    const byDate = new Map();
    for (const r of rows) {
      if (!byDate.has(r.date)) byDate.set(r.date, {});
      byDate.get(r.date)[r.type] = r.value;
    }
    const dates = Array.from(byDate.keys()).sort();
    const quarters = dates.map(d => ({ date: d, eps: byDate.get(d).EPS || 0 })).filter(q => q.eps !== undefined);
    charts.profit = renderEPS(container, quarters);

    // 累計EPS：同一年度從 Q1 累加到該季（FinMind 的 EPS 是單季值）
    const cumEps = new Map();
    // 資料最早那一年若不是從 Q1(03-31) 開始，累計值不完整，顯示「—」
    let runYear = null, runSum = 0, runOk = false;
    for (const d of dates) {
      const y = d.slice(0, 4);
      if (y !== runYear) { runYear = y; runSum = 0; runOk = d.slice(5, 7) === '03'; }
      const e = byDate.get(d).EPS;
      if (e != null && isFinite(e)) runSum += e;
      cumEps.set(d, runOk ? Math.round(runSum * 100) / 100 : null);
    }

    const tbody = $('#table-profit tbody');
    tbody.innerHTML = dates.slice().reverse().slice(0, 12).map(d => {
      const v = byDate.get(d);
      const cum = cumEps.get(d);
      const margin = v.Revenue ? (v.GrossProfit / v.Revenue) * 100 : null;
      return `<tr>
        <td>${d.slice(0, 7)}</td>
        <td>${fmtYi(v.Revenue)}</td>
        <td>${fmtYi(v.GrossProfit)}</td>
        <td>${margin != null ? margin.toFixed(1) + '%' : '—'}</td>
        <td class="${signClass(v.IncomeAfterTaxes || 0)}">${fmtYi(v.IncomeAfterTaxes)}</td>
        <td class="${signClass(v.EPS || 0)}">${numFmt(v.EPS, 2)}</td>
        <td class="${signClass(cum || 0)}">${numFmt(cum, 2)}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    if (!tabLive('profit', tk, stock)) return;
    container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }

  loadEpsEstimate();
}

let epsYearShown = 2026;  // 個股頁 EPS 欄位目前顯示的第一年（儲存時帶給後端核對）

function peColorClass(pe) {
  if (pe == null || !isFinite(pe) || pe <= 0) return null;
  if (pe < 15) return 'pe-green';
  if (pe < 25) return 'pe-yellow';
  if (pe < 40) return 'pe-orange';
  return 'pe-red';
}

async function loadEpsEstimate() {
  $('#eps-status').textContent = '';
  $('#eps-pe-row').innerHTML = '';
  // 先清掉上一檔的數字（讀取期間按儲存才不會把上一檔的 EPS 存到這一檔）
  $('#eps-2026-input').value = '';
  $('#eps-2027-input').value = '';
  $('#btn-save-eps').disabled = true;  // 讀到這一檔的數字前不能按（空白＝清除，會誤刪）
  const stock = currentStock, tk = tabTicket('eps');
  try {
    const [backendList, quotes] = await Promise.all([
      Backend.list(),
      Backend.quote([stock]).catch(() => ({})),
    ]);
    const entry = backendList.find(s => s.stock_id === stock.stock_id);
    const q = quotes[stock.stock_id];
    let price = q && q.price != null ? q.price : null;
    if (price == null) {
      const rows = await Api.daily(stock, 10).catch(() => []);
      price = rows.length ? rows[rows.length - 1].close : null;
    }
    // 換了股票：別把上一檔的 EPS 填進這一檔的欄位（之後按儲存會存錯股票）
    if (!tabLive('eps', tk, stock)) return;

    // 年份跟著後端（定錨換年度後 epsYear 會 +1）；舊後端沒有 epsYear 就當 2026
    const Y = Number((entry && entry.epsYear) || (backendList[0] && backendList[0].epsYear)) || 2026;
    epsYearShown = Y;
    const a = entry ? (entry.epsA !== undefined ? entry.epsA : entry.eps2026) : null;
    const b = entry ? (entry.epsB !== undefined ? entry.epsB : entry.eps2027) : null;
    $('#eps-y1-label').textContent = Y;
    $('#eps-y2-label').textContent = Y + 1;
    $('#eps-2026-input').value = a != null ? a : '';
    $('#eps-2027-input').value = b != null ? b : '';
    $('#btn-save-eps').disabled = false;  // 讀取失敗時維持不能按（避免空白欄位把原本的 EPS 清掉）

    const chips = [];
    if (price && entry) {
      for (const [year, eps] of [[String(Y), a], [String(Y + 1), b]]) {
        if (eps == null || eps <= 0) continue;
        const pe = price / eps;
        const cls = peColorClass(pe);
        chips.push(`<span class="pe-chip ${cls}">${year} 本益比 ${pe.toFixed(1)}</span>`);
      }
    }
    $('#eps-pe-row').innerHTML = chips.join('');
    if (!isOwner()) $('#eps-status').textContent = '訪客模式：預估 EPS 是擁有者功能（到 ⚙ 設定填寫入密碼）';
  } catch (e) {
    if (tabLive('eps', tk, stock)) $('#eps-status').textContent = `讀取預估EPS失敗：${e.message}`;
  }
}

