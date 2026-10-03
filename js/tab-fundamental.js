// 個股頁「基本面」頁籤：營收、獲利（含預估 EPS）。從 app.js 拆出（2026-09-29）。

// ---- 營收 ----
async function loadRevenue() {
  const container = $('#chart-revenue');
  container.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const rows = await Api.monthRevenue(currentStock.stock_id, 36);
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
    container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// ---- 獲利 ----
async function loadProfit() {
  const container = $('#chart-profit');
  container.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const rows = await Api.financials(currentStock.stock_id, 3);
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
  try {
    const [backendList, quotes] = await Promise.all([
      Backend.list(),
      Backend.quote([currentStock]).catch(() => ({})),
    ]);
    const entry = backendList.find(s => s.stock_id === currentStock.stock_id);
    const q = quotes[currentStock.stock_id];
    let price = q && q.price != null ? q.price : null;
    if (price == null) {
      const rows = await Api.daily(currentStock, 10).catch(() => []);
      price = rows.length ? rows[rows.length - 1].close : null;
    }

    // 年份跟著後端（定錨換年度後 epsYear 會 +1）；舊後端沒有 epsYear 就當 2026
    const Y = Number((entry && entry.epsYear) || (backendList[0] && backendList[0].epsYear)) || 2026;
    epsYearShown = Y;
    const a = entry ? (entry.epsA !== undefined ? entry.epsA : entry.eps2026) : null;
    const b = entry ? (entry.epsB !== undefined ? entry.epsB : entry.eps2027) : null;
    $('#eps-y1-label').textContent = Y;
    $('#eps-y2-label').textContent = Y + 1;
    $('#eps-2026-input').value = a != null ? a : '';
    $('#eps-2027-input').value = b != null ? b : '';

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
    $('#eps-status').textContent = `讀取預估EPS失敗：${e.message}`;
  }
}

