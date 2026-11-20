// 個股頁「籌碼」頁籤：法人買賣超、大戶、資券（融資融券）、分點。從 app.js 拆出（2026-09-29），共用 app.js 的全域狀態與工具函式。

// ---- 法人買賣超 ----
// 2026-11-21：圖可以切 合計／外資／投信／自營商（表格照舊四欄都列）
let instWho = 'all';
const INST_NAMES = { f: ['Foreign_Investor', 'Foreign_Dealer_Self'], t: ['Investment_Trust'], d: ['Dealer_self', 'Dealer_Hedging', 'Dealer'] };
async function loadInstitutional() {
  const container = $('#chart-inst');
  const stock = currentStock, tk = tabTicket('inst');
  container.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const rows = await Api.institutional(stock.stock_id, instRange);
    if (!tabLive('inst', tk, stock)) return;
    if (!rows.length) { container.innerHTML = '<div class="error-msg">查無資料</div>'; return; }
    const pick = instWho === 'all' ? rows : rows.filter(r => INST_NAMES[instWho].includes(r.name));
    charts.inst = renderInstitutional(container, pick.length ? pick : rows, instUnit);
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
    if (tabLive('inst', tk, stock)) container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
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
  const stock = currentStock, tk = tabTicket('holders');
  container.innerHTML = '<div class="loading">載入中…（首次查詢約需 10 秒）</div>';
  $('#table-holders thead').innerHTML = '';
  $('#table-holders tbody').innerHTML = '';
  try {
    const [weeks, prices] = await Promise.all([
      Backend.holders(stock.stock_id, 26),
      Api.daily(stock, 220).catch(() => []),
    ]);
    if (!tabLive('holders', tk, stock)) return;
    if (!weeks.length) { container.innerHTML = '<div class="error-msg">查無大戶持股資料（可能是ETF或新上市）</div>'; return; }
    holdData = { weeks, prices };
    redrawHolders();
  } catch (e) {
    if (tabLive('holders', tk, stock)) container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// ---- 資券（融資融券，FinMind）----
async function loadMargin() {
  const container = $('#chart-margin');
  const stock = currentStock, tk = tabTicket('margin');
  container.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const [rows, px] = await Promise.all([
      Api.margin(stock.stock_id, marginRange),
      Api.daily(stock, marginRange).catch(() => []),
    ]);
    if (!tabLive('margin', tk, stock)) return;
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
    if (tabLive('margin', tk, stock)) container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
  loadDtSbl(stock, tk);
}

// 當沖占比、借券賣出（2026-11-21）：mk/dt.json（Agent chip_extra.py，近 20 個交易日）
async function loadDtSbl(stock, tk) {
  const box = $('#dt-sbl');
  if (!box) return;
  box.innerHTML = '';
  try {
    const d = await Mk.load('dt');
    if (!tabLive('margin', tk, stock)) return;
    const s = d.s[stock.stock_id];
    if (!s) { box.innerHTML = '<div class="section-label">當沖・借券</div><div class="empty-hint" style="padding:12px">這檔沒有當沖或借券資料</div>'; return; }
    const [ratio, bal, sell] = s, L = d.days.length;
    const last = i => { for (let k = L - 1; k >= 0; k--) if (i[k] != null) return [i[k], k]; return [null, -1]; };
    const [r0] = last(ratio), [b0, bi] = last(bal);
    const b5 = bi >= 5 ? bal[bi - 5] : null;
    const mk = d.mkt[(typeof marketFor === 'function' && marketFor(stock.stock_id) === 'TWO') ? 'otc' : 'tse'] || [];
    const avg = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const r20 = avg(ratio);
    box.innerHTML = `<div class="section-label">當沖・借券（近 ${L} 個交易日）</div>
      <div class="branch-summary">
        <span>當沖占比 <b class="${r0 >= 50 ? 'up' : ''}">${r0 == null ? '—' : r0 + '%'}</b>（20 日平均 ${r20 == null ? '—' : r20.toFixed(1) + '%'}，大盤 ${mk[mk.length - 1] ?? '—'}%）</span>
        <span>借券賣出餘額 <b>${b0 == null ? '—' : numFmt(b0)}</b> 張${b5 != null && b0 != null ? `（5 日 <b class="${signClass(b0 - b5)}">${b0 - b5 >= 0 ? '+' : ''}${numFmt(b0 - b5)}</b>）` : ''}</span>
      </div>
      <div class="chart-container" id="chart-dtsbl" style="height:200px"></div>
      <div class="legend-row"><span><span class="dot" style="background:#f59e0b"></span>當沖占比 %（左軸）</span><span><span class="dot" style="background:#7aa2f7"></span>借券賣出餘額 張（右軸）</span></div>
      <div class="table-wrap"><table class="data-table compact"><thead><tr><th>日期</th><th>當沖占比</th><th>借券賣出</th><th>借券餘額</th><th>餘額增減</th></tr></thead><tbody>
      ${d.days.map((day, i) => i).reverse().map(i => `<tr><td>${d.days[i].slice(5)}</td><td>${ratio[i] == null ? '—' : ratio[i] + '%'}</td><td>${sell[i] == null ? '—' : numFmt(sell[i])}</td>
        <td>${bal[i] == null ? '—' : numFmt(bal[i])}</td>${i > 0 && bal[i] != null && bal[i - 1] != null ? `<td class="${signClass(bal[i] - bal[i - 1])}">${bal[i] - bal[i - 1] >= 0 ? '+' : ''}${numFmt(bal[i] - bal[i - 1])}</td>` : '<td>—</td>'}</tr>`).join('')}
      </tbody></table></div>
      <p class="hint" style="padding:4px 16px 16px">當沖占比＝當天當沖成交量 ÷ 總成交量，越高代表短線客越多、股價波動通常越大。借券賣出＝向別人借股票來賣（看空或避險），餘額增加代表空方部位變大，減少（還券）代表回補。資料：證交所、櫃買中心，盤後更新。</p>`;
    const chart = makeChart($('#chart-dtsbl'), { leftPriceScale: { visible: true, borderColor: 'rgba(255,255,255,0.1)' } });
    const bars = chart.addSeries(LightweightCharts.HistogramSeries, { color: 'rgba(245,158,11,0.55)', priceScaleId: 'left', priceFormat: { type: 'price', precision: 1, minMove: 0.1 } }, 0);
    bars.setData(d.days.map((t, i) => ({ time: t, value: ratio[i] })).filter(p => p.value != null));
    const line = chart.addSeries(LightweightCharts.LineSeries, { color: '#7aa2f7', lineWidth: 2, priceLineVisible: false, priceFormat: { type: 'volume' } }, 0);
    line.setData(d.days.map((t, i) => ({ time: t, value: bal[i] })).filter(p => p.value != null));
    showAllBars(chart, L);
  } catch (e) { /* 沒有資料就不顯示 */ }
}

// ---- 分點 ----
const BRANCH_LABEL = { 1: '近1日', 2: '近5日', 3: '近10日', 4: '近20日' };
const BRANCH_NOTE_STOCK = '資料來源：券商公開「主力進出」頁（買超／賣超前 15 名分點，單位：張）。盤後約傍晚更新。';
const BRANCH_NOTE_WB = '權證分點：每天收盤後掃描全市場成交金額 ≥30 萬的權證（約 5,000 支），把同一個分點在這檔股票所有權證的買賣超加總（金額＝張數×權證收盤價）。已排除發行商自己的造市席位；「總公司」常是券商自營。約 20:10 更新，資料由 權證超跌反彈/export_app.py 產生。';
let branchMode = localStorage.getItem('branch_mode') === 'warrant' ? 'warrant' : 'stock';

// 「股票分點 | 權證分點」切換（期間按鈕共用：權證分點時＝近 N 個掃描日）
function paintBranchMode() {
  $$('#branch-mode .range-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === branchMode));
  const note = $('#branch-note');
  if (note) note.textContent = branchMode === 'warrant' ? BRANCH_NOTE_WB : BRANCH_NOTE_STOCK;
}
$$('#branch-mode .range-btn').forEach(btn => btn.addEventListener('click', () => {
  branchMode = btn.dataset.mode;
  localStorage.setItem('branch_mode', branchMode);
  paintBranchMode();
  loadBranch();
}));
paintBranchMode();

const wbCache = {};
async function fetchWarrantBranch(id) {
  const key = `${id}_${Math.floor(Date.now() / 6e5)}`;  // 10 分鐘內同一份
  if (wbCache[key]) return wbCache[key];
  const d = await fetchJsonRetry(`wb/${encodeURIComponent(id)}.json`);
  if (d) wbCache[key] = d;
  return d;
}

const wan = v => `${v > 0 ? '+' : ''}${numFmt(Math.round(v / 1e4))}`;

async function loadWarrantBranch() {
  const body = $('#branch-body');
  const sum = $('#branch-summary');
  const stock = currentStock, tk = tabTicket('branch');
  body.innerHTML = '<div class="loading">載入中…</div>';
  sum.innerHTML = '';
  try {
    const d = await fetchWarrantBranch(stock.stock_id);
    if (!tabLive('branch', tk, stock)) return;
    if (!d || !d.br.length) {
      body.innerHTML = '<div class="error-msg">沒有權證分點資料（沒有發行權證，或近 20 個掃描日沒有分點大量進出這檔的權證）</div>';
      return;
    }
    const want = { 1: 1, 2: 5, 3: 10, 4: 20 }[branchPeriod];
    const days = d.days.slice(0, want);
    const rows = d.br.map(b => {
      let call = 0, put = 0, buyD = 0, sellD = 0;
      days.forEach(dt => {
        const v = b.d[dt];
        if (!v) return;
        call += v[0]; put += v[1];
        if (v[0] > 0) buyD++; else if (v[0] < 0) sellD++;
      });
      return { ...b, call, put, buyD, sellD };
    }).filter(r => r.call || r.put);
    const buy = rows.filter(r => r.call > 0).sort((a, b) => b.call - a.call).slice(0, 15);
    const sell = rows.filter(r => r.call < 0).sort((a, b) => a.call - b.call).slice(0, 10);
    const bear = rows.filter(r => r.put > 0).sort((a, b) => b.put - a.put).slice(0, 5);
    const totBuy = buy.reduce((s, r) => s + r.call, 0);
    const short = days.length < want ? `（資料庫目前只有 ${days.length} 天）` : '';
    sum.innerHTML = `
      <span>資料日 <b>${d.days[0]}</b>（近 ${days.length} 個掃描日${short}）</span>
      <span>前 ${buy.length} 名認購淨買 <b class="up">${wan(totBuy)}</b> 萬</span>`;
    const max = Math.max(1, ...buy.map(r => r.call), ...sell.map(r => -r.call));
    const table = (list, dir) => !list.length ? '' : `
      <div class="branch-title ${dir}">${dir === 'up' ? '收購認購權證的分點' : '賣出認購權證的分點'}（萬元）</div>
      <div class="table-wrap" style="padding-bottom:4px">
        <table class="data-table compact branch-table">
          <thead><tr><th>分點</th><th>認購淨額</th><th>買/賣天</th><th>認售</th></tr></thead>
          <tbody>${list.map(r => `<tr>
            <td><span class="br-link wb-link" data-n="${r.n}">${r.n}</span>${r.hq ? ' <span class="dim">總公司</span>' : ''}${typeof branchTypeTag === 'function' ? branchTypeTag(r) : ''}</td>
            <td class="barcell ${dir}"><div class="bar ${dir}" style="width:${Math.round(Math.abs(r.call) / max * 100)}%"></div><span>${wan(r.call)}</span></td>
            <td>${r.buyD}/${r.sellD}</td>
            <td>${r.put ? wan(r.put) : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`;
    const bearHtml = !bear.length ? '' : `<div class="branch-title down">買認售（看空）</div>
      <div class="branch-note" style="padding-top:0">${bear.map(r => `${r.n} ${wan(r.put)} 萬`).join('、')}</div>`;
    body.innerHTML = table(buy, 'up') + table(sell, 'down') + bearHtml +
      '<div class="branch-note" style="padding-top:0">買/賣天＝期間內淨買、淨賣認購的天數。點分點名稱看每天明細與買了哪些權證。</div>';
    body.querySelectorAll('.wb-link').forEach(el =>
      el.addEventListener('click', () => openWarrantBranchHist(stock, d, el.dataset.n)));
  } catch (e) {
    if (tabLive('branch', tk, stock)) body.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

function openWarrantBranchHist(stock, d, name) {
  const b = d.br.find(x => x.n === name);
  if (!b) return;
  const rows = d.days.filter(dt => b.d[dt]).map(dt => ({ dt, call: b.d[dt][0], put: b.d[dt][1] }));
  const max = Math.max(1, ...rows.map(r => Math.abs(r.call)));
  showModal(`
    <div class="modal-title">${name}｜${stock.stock_name} 權證</div>
    <div class="brh-sum">買最多的權證：${b.w.join('、') || '—'}</div>
    <div class="table-wrap brh-wrap">
      <table class="data-table compact branch-table">
        <thead><tr><th>日期</th><th>認購淨額（萬）</th><th>認售（萬）</th></tr></thead>
        <tbody>${rows.map(r => {
          const dir = r.call >= 0 ? 'up' : 'down';
          return `<tr><td>${r.dt.slice(5)}</td>
            <td class="barcell ${dir}"><div class="bar ${dir}" style="width:${Math.round(Math.abs(r.call) / max * 100)}%"></div><span>${wan(r.call)}</span></td>
            <td>${r.put ? wan(r.put) : '—'}</td></tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <button class="modal-btn" id="wbh-close" style="text-align:center;margin-top:12px">關閉</button>`);
  $('#wbh-close').addEventListener('click', closeModal);
}

async function loadBranch() {
  if (branchMode === 'warrant') return loadWarrantBranch();
  const body = $('#branch-body');
  const sum = $('#branch-summary');
  const stock = currentStock, tk = tabTicket('branch');
  body.innerHTML = '<div class="loading">載入中…</div>';
  sum.innerHTML = '';
  try {
    const d = await Backend.branch(stock.stock_id, branchPeriod);
    if (!tabLive('branch', tk, stock)) return;
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
    body.innerHTML = '<div id="main-hist"></div>' + table(d.buy, 'up') + table(d.sell, 'down') +
      '<div class="branch-note" style="padding-top:0">點分點名稱可看它最近 20 個交易日在這檔的進出。</div>';
    body.querySelectorAll('.br-link').forEach(el =>
      el.addEventListener('click', () => openBranchHist(stock, el.dataset.bid, el.dataset.bhid, el.dataset.name)));
    loadMainHist(stock, tk, d.date);
  } catch (e) {
    if (tabLive('branch', tk, stock)) body.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// 主力買賣超歷史（2026-11-21）：每天前 15 大買超分點合計 − 前 15 大賣超分點合計（張），近 20 個交易日。
// 快速後端 action=mainHist（一次抓 20 天、CDN 快取 1 小時）；交易日用 mk/inst.json 的日期＋分點頁最新資料日。
const mainHistCache = {};
async function loadMainHist(stock, tk, latest) {
  const box = $('#main-hist');
  if (!box) return;
  box.innerHTML = '<div class="section-label">主力買賣超（近 20 日）</div><div class="loading" style="padding:12px">載入中…</div>';
  try {
    let days = [];
    try { days = (await Mk.load('inst')).days.slice(-20); } catch (e) {}
    const lt = latest ? latest.replace(/\//g, '-') : '';
    if (lt && !days.includes(lt) && (!days.length || lt > days[days.length - 1])) days = days.concat(lt).slice(-20);
    if (!days.length) throw new Error('沒有交易日資料');
    const key = `${stock.stock_id}_${days[days.length - 1]}`;
    let rows = mainHistCache[key];
    if (!rows) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      try {
        const j = await (await fetch(`${FAST_URL}?action=mainHist&id=${stock.stock_id}&dates=${days.join(',')}`, { signal: ctl.signal })).json();
        if (j.status !== 200) throw new Error(j.error || '抓不到');
        rows = mainHistCache[key] = j.data;
      } finally { clearTimeout(t); }
    }
    if (!tabLive('branch', tk, stock) || !$('#main-hist')) return;
    let cum = 0;
    const cumRows = rows.map(r => ({ ...r, cum: (cum += r.net) }));
    const sum5 = rows.slice(-5).reduce((a, r) => a + r.net, 0), sum20 = cum;
    const upDays = rows.filter(r => r.net > 0).length;
    box.innerHTML = `<div class="section-label">主力買賣超（近 ${rows.length} 日）</div>
      <div class="branch-summary"><span>近 5 日 <b class="${signClass(sum5)}">${sum5 >= 0 ? '+' : ''}${numFmt(sum5)}</b> 張</span>
        <span>近 ${rows.length} 日 <b class="${signClass(sum20)}">${sum20 >= 0 ? '+' : ''}${numFmt(sum20)}</b> 張</span>
        <span>主力買超 <b>${upDays}</b>／${rows.length} 天</span></div>
      <div class="chart-container" id="chart-main" style="height:200px"></div>
      <div class="legend-row"><span><span class="dot" style="background:#e6413c"></span>主力淨買</span><span><span class="dot" style="background:#1fa363"></span>主力淨賣</span><span><span class="dot" style="background:#f2c744"></span>累計（右軸）</span></div>
      <details class="mh-more"><summary>每日明細</summary>
        <div class="table-wrap"><table class="data-table compact"><thead><tr><th>日期</th><th>前15買</th><th>前15賣</th><th>主力淨</th><th>買超均價</th><th>賣超均價</th></tr></thead>
        <tbody>${rows.slice().reverse().map(r => `<tr><td>${r.date.slice(5)}</td><td>${numFmt(r.buy)}</td><td>${numFmt(r.sell)}</td>
          <td class="${signClass(r.net)}">${r.net >= 0 ? '+' : ''}${numFmt(r.net)}</td><td>${numFmt(r.buyCost, 2)}</td><td>${numFmt(r.sellCost, 2)}</td></tr>`).join('')}</tbody></table></div>
      </details>`;
    const chart = makeChart($('#chart-main'));
    const bars = chart.addSeries(LightweightCharts.HistogramSeries, { priceFormat: { type: 'volume' } }, 0);
    bars.setData(cumRows.map(r => ({ time: r.date, value: r.net, color: r.net >= 0 ? UP_COLOR : DOWN_COLOR })));
    const line = chart.addSeries(LightweightCharts.LineSeries, { color: '#f2c744', lineWidth: 2, priceScaleId: 'mh-cum', priceLineVisible: false }, 0);
    chart.priceScale('mh-cum', 0).applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
    line.setData(cumRows.map(r => ({ time: r.date, value: r.cum })));
    showAllBars(chart, cumRows.length);
  } catch (e) {
    if ($('#main-hist') && tabLive('branch', tk, stock)) box.innerHTML = `<div class="section-label">主力買賣超</div><div class="error-msg">暫時抓不到（${e.message}）</div>`;
  }
}

// 單一分點在這檔股票最近約 20 個交易日的每日進出
async function openBranchHist(stock, bid, bhid, name) {
  showModal(`<div class="modal-title">${name}｜${stock.stock_name}</div><div class="loading">載入中…</div>`);
  const ms = modalSeq;
  try {
    const d = await Backend.branchHist(stock.stock_id, bid, bhid);
    if (!$('#modal').classList.contains('active') || ms !== modalSeq) return;
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
    if (ms === modalSeq) $('#modal-card').innerHTML = `<div class="modal-title">${name}</div><div class="error-msg">載入失敗：${e.message}</div>`;
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
  const ms = modalSeq;
  try {
    const d = await Backend.branchTop(bid, bhid, period);
    if (!$('#modal').classList.contains('active') || ms !== modalSeq) return;
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
    if (ms !== modalSeq) return;
    $('#modal-card').innerHTML = head + `<div class="error-msg">載入失敗：${e.message}</div>`;
    wire();
  }
}

