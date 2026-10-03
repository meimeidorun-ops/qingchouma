// 個股頁「籌碼」頁籤：法人買賣超、大戶、資券（融資融券）、分點。從 app.js 拆出（2026-09-29），共用 app.js 的全域狀態與工具函式。

// ---- 法人買賣超 ----
async function loadInstitutional() {
  const container = $('#chart-inst');
  container.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const rows = await Api.institutional(currentStock.stock_id, instRange);
    if (!rows.length) { container.innerHTML = '<div class="error-msg">查無資料</div>'; return; }
    charts.inst = renderInstitutional(container, rows, instUnit);
    $('#inst-table-label').textContent = instUnit === 1000 ? '近期明細（張）' : '近期明細（股）';

    // build per-date table: 外資/投信/自營商(含避險合計)/合計
    const byDate = new Map();
    for (const r of rows) {
      if (!byDate.has(r.date)) byDate.set(r.date, { foreign: 0, trust: 0, dealer: 0 });
      const net = (r.buy - r.sell) / instUnit;
      const d = byDate.get(r.date);
      if (r.name === 'Foreign_Investor' || r.name === 'Foreign_Dealer_Self') d.foreign += net;
      else if (r.name === 'Investment_Trust') d.trust += net;
      else if (r.name === 'Dealer_self' || r.name === 'Dealer_Hedging' || r.name === 'Dealer') d.dealer += net;
    }
    const dates = Array.from(byDate.keys()).sort().reverse().slice(0, 30);
    const tbody = $('#table-inst tbody');
    tbody.innerHTML = dates.map(d => {
      const v = byDate.get(d);
      const total = v.foreign + v.trust + v.dealer;
      return `<tr>
        <td>${d.slice(5)}</td>
        <td class="${signClass(v.foreign)}">${numFmt(v.foreign)}</td>
        <td class="${signClass(v.trust)}">${numFmt(v.trust)}</td>
        <td class="${signClass(v.dealer)}">${numFmt(v.dealer)}</td>
        <td class="${signClass(total)}">${numFmt(total)}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// ---- 大戶 ----
// TDCC tiers (index 0..14): 1-999 / 1,000-5,000 / ... / 1,000,001+ shares. Boundaries in 張:
// tier index 9 = >100張, 10 = >200張, 11 = >400張, 12 = >600張, 13 = >800張.
const HOLD_BIG_START = { 100: 9, 200: 10, 400: 11, 600: 12, 800: 13 };
const HOLD_RETAIL_END = { 50: 7, 100: 8, 200: 9, 400: 10 };
let holdBig = 400;
let holdRetail = 400;
let holdMode = 'pct';
let holdData = { weeks: [], prices: [] };

function fmtWeek(d) { return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; }

function redrawHolders() {
  const container = $('#chart-holders');
  const weeks = holdData.weeks;
  if (!weeks.length) return;
  const arr = holdMode === 'pct' ? 'pct' : 'ppl';
  const sum = (a, from, to) => { let s = 0; for (let i = from; i <= to; i++) s += a[i]; return s; };
  const rows = weeks.map(w => ({
    date: fmtWeek(w.d),
    big: sum(w[arr], HOLD_BIG_START[holdBig], 14),
    retail: sum(w[arr], 0, HOLD_RETAIL_END[holdRetail]),
  }));

  // weekly price = last daily close on or before the week's date
  const px = holdData.prices;
  let j = 0, lastClose = null;
  const priceSeries = rows.map(r => {
    while (j < px.length && px[j].date <= r.date) { lastClose = px[j].close; j++; }
    return lastClose == null ? null : { time: r.date, value: lastClose };
  }).filter(Boolean);

  const digits = holdMode === 'pct' ? 2 : 0;
  charts.holders = renderHolders(
    container,
    rows.map(r => ({ time: r.date, value: r.big })),
    rows.map(r => ({ time: r.date, value: r.retail })),
    priceSeries,
    digits,
  );

  const isPct = holdMode === 'pct';
  const unit = isPct ? '%' : '';
  $('#table-holders thead').innerHTML = `<tr><th>日期</th><th>大戶持股${unit ? '(%)' : '(人)'}</th><th>大戶增減</th><th>散戶持股${unit ? '(%)' : '(人)'}</th><th>散戶增減</th></tr>`;
  const fmt = (v) => numFmt(v, digits);
  const fmtChg = (v) => `${v > 0 ? '+' : ''}${numFmt(v, digits)}`;
  $('#table-holders tbody').innerHTML = rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const dBig = prev ? r.big - prev.big : null;
    const dRetail = prev ? r.retail - prev.retail : null;
    return `<tr>
      <td>${r.date.slice(5).replace('-', '/')}</td>
      <td>${fmt(r.big)}</td>
      <td class="${dBig == null ? 'flat' : signClass(dBig)}">${dBig == null ? '—' : fmtChg(dBig)}</td>
      <td>${fmt(r.retail)}</td>
      <td class="${dRetail == null ? 'flat' : signClass(dRetail)}">${dRetail == null ? '—' : fmtChg(dRetail)}</td>
    </tr>`;
  }).reverse().join('');
}

async function loadHolders() {
  const container = $('#chart-holders');
  container.innerHTML = '<div class="loading">載入中…（首次查詢約需 10 秒）</div>';
  $('#table-holders thead').innerHTML = '';
  $('#table-holders tbody').innerHTML = '';
  try {
    const [weeks, prices] = await Promise.all([
      Backend.holders(currentStock.stock_id, 26),
      Api.daily(currentStock, 220).catch(() => []),
    ]);
    if (!weeks.length) { container.innerHTML = '<div class="error-msg">查無大戶持股資料（可能是ETF或新上市）</div>'; return; }
    holdData = { weeks, prices };
    redrawHolders();
  } catch (e) {
    container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// ---- 資券（融資融券，FinMind）----
async function loadMargin() {
  const container = $('#chart-margin');
  const stock = currentStock;
  container.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const [rows, px] = await Promise.all([
      Api.margin(stock.stock_id, marginRange),
      Api.daily(stock, marginRange).catch(() => []),
    ]);
    if (stock !== currentStock) return;
    if (!rows.length) { container.innerHTML = '<div class="error-msg">查無融資融券資料（可能不能信用交易）</div>'; $('#table-margin tbody').innerHTML = ''; return; }
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    const dates = new Set(rows.map(r => r.date));
    charts.margin = renderMargin(container,
      rows.map(r => ({ time: r.date, value: r.MarginPurchaseTodayBalance })),
      rows.map(r => ({ time: r.date, value: r.ShortSaleTodayBalance })),
      px.filter(r => dates.has(r.date)).map(r => ({ time: r.date, value: r.close })));
    const chg = (v) => `<td class="${signClass(v)}">${v > 0 ? '+' : ''}${numFmt(v)}</td>`;
    $('#table-margin tbody').innerHTML = rows.slice(-30).reverse().map(r => {
      const m = r.MarginPurchaseTodayBalance, s = r.ShortSaleTodayBalance;
      return `<tr>
        <td>${r.date.slice(5)}</td>
        ${chg(m - r.MarginPurchaseYesterdayBalance)}
        <td>${numFmt(m)}</td>
        ${chg(s - r.ShortSaleYesterdayBalance)}
        <td>${numFmt(s)}</td>
        <td>${m ? (s / m * 100).toFixed(1) + '%' : '—'}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// ---- 分點 ----
const BRANCH_LABEL = { 1: '近1日', 2: '近5日', 3: '近10日', 4: '近20日' };
async function loadBranch() {
  const body = $('#branch-body');
  const sum = $('#branch-summary');
  const stock = currentStock;
  body.innerHTML = '<div class="loading">載入中…</div>';
  sum.innerHTML = '';
  try {
    const d = await Backend.branch(stock.stock_id, branchPeriod);
    if (stock !== currentStock) return;
    if (!d.buy.length && !d.sell.length) { body.innerHTML = '<div class="error-msg">查無分點資料（ETF、興櫃或當日無交易）</div>'; return; }
    const net = (d.sumBuy || 0) - (d.sumSell || 0);
    sum.innerHTML = `
      <span>資料日 <b>${d.date || '—'}</b>（${BRANCH_LABEL[branchPeriod]}）</span>
      <span>前15買超 <b class="up">${numFmt(d.sumBuy)}</b> 張</span>
      <span>前15賣超 <b class="down">${numFmt(d.sumSell)}</b> 張</span>
      <span>主力淨 <b class="${signClass(net)}">${net >= 0 ? '+' : ''}${numFmt(net)}</b> 張</span>
      <span>買超均價 <b>${numFmt(d.avgBuyCost, 2)}</b></span>
      <span>賣超均價 <b>${numFmt(d.avgSellCost, 2)}</b></span>`;
    const max = Math.max(1, ...d.buy.map(r => r.net || 0), ...d.sell.map(r => r.net || 0));
    const table = (rows, dir) => `
      <div class="branch-title ${dir}">${dir === 'up' ? '買超分點' : '賣超分點'}</div>
      <div class="table-wrap" style="padding-bottom:4px">
        <table class="data-table compact branch-table">
          <thead><tr><th>分點</th><th>買進</th><th>賣出</th><th>${dir === 'up' ? '買超' : '賣超'}</th><th>佔成交</th></tr></thead>
          <tbody>${rows.map(r => `<tr>
            <td>${r.bid ? `<span class="br-link" data-bid="${r.bid}" data-bhid="${r.bhid || r.bid}" data-name="${r.name}">${r.name}</span>` : r.name}</td>
            <td>${numFmt(r.buy)}</td>
            <td>${numFmt(r.sell)}</td>
            <td class="barcell ${dir}"><div class="bar ${dir}" style="width:${Math.round((r.net || 0) / max * 100)}%"></div><span>${numFmt(r.net)}</span></td>
            <td>${r.pct != null ? r.pct.toFixed(2) + '%' : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`;
    body.innerHTML = table(d.buy, 'up') + table(d.sell, 'down') +
      '<div class="branch-note" style="padding-top:0">點分點名稱可看它最近 20 個交易日在這檔的進出。</div>';
    body.querySelectorAll('.br-link').forEach(el =>
      el.addEventListener('click', () => openBranchHist(stock, el.dataset.bid, el.dataset.bhid, el.dataset.name)));
  } catch (e) {
    body.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// 單一分點在這檔股票最近約 20 個交易日的每日進出
async function openBranchHist(stock, bid, bhid, name) {
  showModal(`<div class="modal-title">${name}｜${stock.stock_name}</div><div class="loading">載入中…</div>`);
  try {
    const d = await Backend.branchHist(stock.stock_id, bid, bhid);
    if (!$('#modal').classList.contains('active')) return;
    if (!d.rows.length) { $('#modal-card').innerHTML = `<div class="modal-title">${name}</div><div class="error-msg">查無進出紀錄</div>`; return; }
    const max = Math.max(1, ...d.rows.map(r => Math.abs(r.net || 0)));
    const buyDays = d.rows.filter(r => r.net > 0).length;
    $('#modal-card').innerHTML = `
      <div class="modal-title">${name}｜${stock.stock_name}</div>
      <div class="brh-sum">近 ${d.rows.length} 個交易日累計
        <b class="${signClass(d.total)}">${d.total >= 0 ? '+' : ''}${numFmt(d.total)}</b> 張，買超 ${buyDays} 天／賣超 ${d.rows.filter(r => r.net < 0).length} 天</div>
      <div class="table-wrap brh-wrap">
        <table class="data-table compact branch-table">
          <thead><tr><th>日期</th><th>買進</th><th>賣出</th><th>買賣超</th></tr></thead>
          <tbody>${d.rows.map(r => {
            const dir = r.net >= 0 ? 'up' : 'down';
            return `<tr>
              <td>${r.date.slice(5)}</td>
              <td>${numFmt(r.buy)}</td>
              <td>${numFmt(r.sell)}</td>
              <td class="barcell ${dir}"><div class="bar ${dir}" style="width:${Math.round(Math.abs(r.net || 0) / max * 100)}%"></div><span>${r.net > 0 ? '+' : ''}${numFmt(r.net)}</span></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      <button class="modal-btn" id="brh-top" style="text-align:center;margin-top:12px">看「${name}」近期買賣哪些股票 ›</button>
      <button class="modal-btn" id="brh-close" style="text-align:center">關閉</button>`;
    $('#brh-top').addEventListener('click', () => openBranchTop(bid, bhid, name, 1));
    $('#brh-close').addEventListener('click', closeModal);
  } catch (e) {
    $('#modal-card').innerHTML = `<div class="modal-title">${name}</div><div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// 單一分點近期買超／賣超哪些股票（前 15 名），點股票直接打開
async function openBranchTop(bid, bhid, name, period) {
  const head = `<div class="modal-title">${name}｜近期買賣</div>
    <div class="range-bar" style="padding:0 0 8px">
      <button class="range-btn ${period === 1 ? 'active' : ''}" data-p="1">近1日</button>
      <button class="range-btn ${period === 5 ? 'active' : ''}" data-p="5">近5日</button>
    </div>`;
  showModal(head + '<div class="loading">載入中…</div>');
  const wire = () => $$('#modal-card [data-p]').forEach(b => b.addEventListener('click', () => openBranchTop(bid, bhid, name, Number(b.dataset.p))));
  wire();
  try {
    const d = await Backend.branchTop(bid, bhid, period);
    if (!$('#modal').classList.contains('active')) return;
    const watched = new Set(getWatchlist().map(s => s.stock_id));
    const list = (rows, dir) => `
      <div class="branch-title ${dir}">${dir === 'up' ? '買超' : '賣超'}前 15 檔（張）</div>
      <table class="data-table compact branch-table"><tbody>${rows.slice(0, 15).map(r => `
        <tr class="brt-row" data-id="${r.id}" data-name="${r.name}">
          <td><span class="br-link">${r.name || r.id}</span> <span class="dim">${r.id}${watched.has(r.id) ? ' ★' : ''}</span></td>
          <td class="${dir}">${r.net > 0 ? '+' : ''}${numFmt(r.net)}</td>
        </tr>`).join('') || '<tr><td>無資料</td></tr>'}</tbody></table>`;
    const day = d.date ? `資料日 ${d.date.slice(0, 4)}/${d.date.slice(4, 6)}/${d.date.slice(6)}` : '';
    $('#modal-card').innerHTML = head + `<div class="brh-sum">${day}　★ = 在自選清單</div>` +
      `<div class="table-wrap brh-wrap">${list(d.buy, 'up')}${list(d.sell, 'down')}</div>` +
      `<button class="modal-btn" id="brt-close" style="text-align:center;margin-top:12px">關閉</button>`;
    wire();
    $$('#modal-card .brt-row').forEach(tr => tr.addEventListener('click', () => {
      closeModal();
      openStock({ stock_id: tr.dataset.id, stock_name: tr.dataset.name || tr.dataset.id });
    }));
    $('#brt-close').addEventListener('click', closeModal);
  } catch (e) {
    $('#modal-card').innerHTML = head + `<div class="error-msg">載入失敗：${e.message}</div>`;
    wire();
  }
}

