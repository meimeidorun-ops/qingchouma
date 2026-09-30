// ---- State ----
let stockIndex = [];        // full TaiwanStockInfo list
let stockIndexReady = false;
let currentStock = null;    // { stock_id, stock_name }
let charts = { kline: null, inst: null, revenue: null, profit: null, holders: null };
let klineRange = 180;
let instRange = 90;
let branchPeriod = 1;
let marginRange = 180;
let klineData = { price: [], inst: [], holding: [] };
let klineOpts = { showInst: true, showBBand: false, indicator: null };
let klineInterval = '1d';
let instUnit = 1000; // 1000 = 張, 1 = 股
let loadedTabs = { rt: false, kline: false, inst: false, margin: false, branch: false, revenue: false, profit: false, holders: false };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function numFmt(n, digits = 0) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function pctFmt(n, digits = 2) {
  if (n == null || isNaN(n)) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(digits)}%`;
}
// FinMind financial statement values are in 元; show in 億.
function fmtYi(v) {
  if (v == null || isNaN(v)) return '—';
  const yi = v / 1e8;
  return numFmt(yi, Math.abs(yi) >= 100 ? 0 : 1);
}
function signClass(n) {
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'flat';
}

// ---- Watchlist (localStorage) ----
function getWatchlist() {
  try { return JSON.parse(localStorage.getItem('watchlist') || '[]'); } catch (e) { return []; }
}
function setWatchlist(list) {
  localStorage.setItem('watchlist', JSON.stringify(list));
}
function isWatched(stockId) {
  return getWatchlist().some(s => s.stock_id === stockId);
}
// ---- Watchlist groups (自選股清單分頁) ----
// `watchlist` stays the flat master list (what the backend/monitoring agent sees);
// `groups` only decides how it is arranged into named tabs. A stock in >=1 group is
// watched; removing it from its last group removes it everywhere (incl. monitoring).
let groups = null; // [{ id, name, ids: [stock_id] }]
let activeGroupId = localStorage.getItem('active_group');

function loadGroupsLocal() {
  try { return JSON.parse(localStorage.getItem('groups') || 'null'); } catch (e) { return null; }
}

function normalizeGroups() {
  const wl = getWatchlist();
  const wlIds = new Set(wl.map(s => s.stock_id));
  if (!Array.isArray(groups) || !groups.length) groups = [{ id: 'g1', name: '自選股清單1', ids: [] }];
  groups.forEach(g => { g.ids = [...new Set((g.ids || []).filter(id => wlIds.has(id)))]; });
  const assigned = new Set(groups.flatMap(g => g.ids));
  groups[0].ids.push(...wl.filter(s => !assigned.has(s.stock_id)).map(s => s.stock_id));
  if (!groups.some(g => g.id === activeGroupId)) activeGroupId = groups[0].id;
}

let pushGroupsTimer = null;
function saveGroups(push = true) {
  localStorage.setItem('groups', JSON.stringify(groups));
  localStorage.setItem('active_group', activeGroupId);
  if (push) {
    clearTimeout(pushGroupsTimer);
    pushGroupsTimer = setTimeout(() => Backend.setGroups(groups).catch(e => console.warn('groups sync failed', e)), 800);
  }
}

async function syncGroupsFromBackend() {
  const remote = await Backend.getGroups();
  if (remote && Array.isArray(remote.groups) && remote.groups.length) {
    groups = remote.groups;
    normalizeGroups();
    saveGroups(false);
  } else {
    // 後端沒有分頁資料：只有「這台裝置本來就有自己的分頁」才往上推。
    // 新網址/新手機（本機沒存過 groups）絕不推，避免後端暫時出錯時用預設空分頁蓋掉「定錨」「我的持股」。
    const hadLocal = !!loadGroupsLocal();
    normalizeGroups();
    saveGroups(hadLocal);
  }
}

function activeGroup() { return groups.find(g => g.id === activeGroupId) || groups[0]; }

function addToGroup(stock, groupId) {
  const list = getWatchlist();
  if (!list.some(s => s.stock_id === stock.stock_id)) {
    list.push({ stock_id: stock.stock_id, stock_name: stock.stock_name });
    setWatchlist(list);
    Backend.upsert(stock).catch(e => console.warn('backend upsert failed', e));
  }
  const g = groups.find(x => x.id === groupId);
  if (g && !g.ids.includes(stock.stock_id)) g.ids.push(stock.stock_id);
  saveGroups();
}

function removeFromGroup(stockId, groupId) {
  const g = groups.find(x => x.id === groupId);
  if (g) g.ids = g.ids.filter(id => id !== stockId);
  if (!groups.some(x => x.ids.includes(stockId))) {
    setWatchlist(getWatchlist().filter(s => s.stock_id !== stockId));
    Backend.remove(stockId).catch(e => console.warn('backend remove failed', e));
  }
  saveGroups();
}

function refreshStar() {
  if (!currentStock) return;
  const watched = isWatched(currentStock.stock_id);
  $('#btn-star').textContent = watched ? '★' : '☆';
  $('#btn-star').classList.toggle('active', watched);
}

function showModal(html) {
  $('#modal-card').innerHTML = html;
  $('#modal').classList.add('active');
}
function closeModal() { $('#modal').classList.remove('active'); }

function openGroupPicker(stock) {
  const rows = groups.map(g => `
    <label class="pick-row"><input type="checkbox" data-g="${g.id}" ${g.ids.includes(stock.stock_id) ? 'checked' : ''}>${g.name}</label>
  `).join('');
  showModal(`<div class="modal-title">「${stock.stock_name}」加入哪些清單？</div>${rows}
    <button class="modal-btn" id="pick-done" style="margin-top:14px;text-align:center">完成</button>`);
  $$('#modal-card input[data-g]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) addToGroup(stock, cb.dataset.g);
      else removeFromGroup(stock.stock_id, cb.dataset.g);
      refreshStar();
    });
  });
  $('#pick-done').addEventListener('click', closeModal);
}

function onStarClick() {
  if (!currentStock) return;
  if (groups.length === 1) {
    if (isWatched(currentStock.stock_id)) removeFromGroup(currentStock.stock_id, groups[0].id);
    else addToGroup(currentStock, groups[0].id);
    refreshStar();
    return;
  }
  if (!isWatched(currentStock.stock_id)) addToGroup(currentStock, activeGroup().id);
  refreshStar();
  openGroupPicker(currentStock);
}

function openGroupMenu() {
  const g = activeGroup();
  showModal(`<div class="modal-title">管理清單</div>
    <button class="modal-btn" id="gm-rename">重新命名「${g.name}」</button>
    <button class="modal-btn" id="gm-add" ${groups.length >= 10 ? 'disabled' : ''}>新增清單</button>
    <button class="modal-btn danger" id="gm-del" ${groups.length <= 1 ? 'disabled' : ''}>刪除「${g.name}」</button>
    <button class="modal-btn" id="gm-cancel" style="text-align:center">取消</button>`);
  $('#gm-cancel').addEventListener('click', closeModal);
  $('#gm-rename').addEventListener('click', () => {
    const name = (prompt('清單名稱', g.name) || '').trim();
    closeModal();
    if (name) { g.name = name.slice(0, 20); saveGroups(); renderWatchlist(); }
  });
  $('#gm-add').addEventListener('click', () => {
    const name = (prompt('新清單名稱', `自選股清單${groups.length + 1}`) || '').trim();
    closeModal();
    if (!name) return;
    const ng = { id: `g${Date.now().toString(36)}`, name: name.slice(0, 20), ids: [] };
    groups.push(ng);
    activeGroupId = ng.id;
    saveGroups();
    renderWatchlist();
  });
  $('#gm-del').addEventListener('click', () => {
    closeModal();
    if (!confirm(`刪除「${g.name}」？清單內只屬於這裡的股票會移到「${groups.find(x => x !== g).name}」。`)) return;
    const rest = groups.filter(x => x !== g);
    const stay = new Set(rest.flatMap(x => x.ids));
    rest[0].ids.push(...g.ids.filter(id => !stay.has(id)));
    groups = rest;
    activeGroupId = rest[0].id;
    saveGroups();
    renderWatchlist();
  });
}

function renderGroupTabs() {
  $('#group-tabs').innerHTML = groups.map(g =>
    `<button class="group-tab ${g.id === activeGroupId ? 'active' : ''}" data-g="${g.id}">${g.name}${g.id === activeGroupId ? ' ✎' : ''}</button>`
  ).join('');
  $$('#group-tabs .group-tab').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.g === activeGroupId) { openGroupMenu(); return; }
    activeGroupId = b.dataset.g;
    saveGroups(false);
    renderWatchlist();
  }));
}

// Merge the shared backend watchlist into this browser's local copy so a fresh
// browser/device/URL starts with the same list. Local-only entries (e.g. a sync
// that failed earlier) are pushed up so nothing is lost.
async function syncWatchlistFromBackend() {
  await ensureStockIndex();
  const remote = await Backend.list();
  const local = getWatchlist();
  const remoteIds = new Set(remote.map(s => s.stock_id));
  const localIds = new Set(local.map(s => s.stock_id));

  const merged = [
    ...local,
    ...remote.filter(s => !localIds.has(s.stock_id)).map(s => ({ stock_id: s.stock_id, stock_name: s.stock_name })),
  ];
  const localOnly = local.filter(s => !remoteIds.has(s.stock_id));
  if (localOnly.length) {
    Backend.bulkUpsert(localOnly.map(s => ({ stock_id: s.stock_id, stock_name: s.stock_name, market: marketFor(s.stock_id) })))
      .catch(e => console.warn('backend bulkUpsert failed', e));
  }
  if (merged.length !== local.length) {
    setWatchlist(merged);
    return true;
  }
  return false;
}

// ---- Navigation ----
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#${id}`).classList.add('active');
}

let rtTimer = null;
let rtHandle = null;
let navStocks = []; // the list the user opened this stock from (◀ ▶ walk through it)

function updateNavButtons() {
  const idx = currentStock ? navStocks.findIndex(s => s.stock_id === currentStock.stock_id) : -1;
  const ok = idx >= 0 && navStocks.length > 1;
  $('#btn-prev').disabled = !ok;
  $('#btn-next').disabled = !ok;
}

function stepStock(delta) {
  const idx = navStocks.findIndex(s => s.stock_id === currentStock.stock_id);
  if (idx < 0 || navStocks.length < 2) return;
  const next = navStocks[(idx + delta + navStocks.length) % navStocks.length];
  openStock({ stock_id: next.stock_id, stock_name: next.stock_name });
}

function stopRtTimer() {
  clearInterval(rtTimer);
  rtTimer = null;
}

function goHome() {
  stopRtTimer();
  showScreen('screen-home');
  renderWatchlist();
}

async function openStock(stock) {
  currentStock = stock;
  if (!navStocks.some(s => s.stock_id === stock.stock_id)) navStocks = [];
  updateNavButtons();
  showScreen('screen-detail');
  $('#dt-name').textContent = stock.stock_name;
  $('#dt-code').textContent = stock.stock_id;
  $('#dq-price').textContent = '—';
  $('#dq-change').textContent = '載入中…';
  $('#dq-change').className = 'dq-change';
  refreshStar();

  // reset to first tab (即時)
  $$('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  $$('.tab-pane').forEach((p, i) => p.classList.toggle('active', i === 0));
  loadedTabs = { rt: false, kline: false, inst: false, margin: false, branch: false, revenue: false, profit: false, holders: false };
  rtHandle = null;

  stopRtTimer();
  rtTimer = setInterval(() => {
    if (document.hidden || !$('#pane-rt').classList.contains('active')) return;
    if (!twMarketOpen() && Date.now() - rtLastLoad < 120e3) return;
    loadRealtime(true);
  }, 15000);

  await loadRealtime();
  loadedTabs.rt = true;
  prefetchStock(stock);
}

// 看「即時」的同時，背景先把其他頁籤的資料抓好存進快取，切頁籤時幾乎不用等。
// FinMind 很快、先平行抓；Apps Script 同時太多請求會互相拖慢，所以日K→分點依序抓。
function prefetchStock(stock) {
  setTimeout(() => {
    if (currentStock !== stock) return;
    const quiet = p => p && p.catch && p.catch(() => {});
    quiet(Api.institutional(stock.stock_id, klineRange));
    quiet(Api.institutional(stock.stock_id, instRange));
    quiet(Api.monthRevenue(stock.stock_id, 36));
    quiet(Api.financials(stock.stock_id, 3));
    quiet(Api.daily(stock, klineRange)
      .then(() => currentStock === stock && Backend.branch(stock.stock_id, branchPeriod)));
  }, 800);
}

// 用箭頭函式包起來：各頁籤的 load 函式在 tab-*.js（比 app.js 晚載入），要到點擊時才去找。
const TAB_LOADERS = {
  rt: () => loadRealtime(true), kline: () => loadKline(), inst: () => loadInstitutional(), margin: () => loadMargin(),
  branch: () => loadBranch(), revenue: () => loadRevenue(), profit: () => loadProfit(), holders: () => loadHolders(),
};

// ---- Search ----
async function ensureStockIndex() {
  if (stockIndexReady) return;
  try {
    stockIndex = await Api.stockList();
    stockIndexReady = true;
  } catch (e) {
    console.error(e);
  }
}

function renderSearchResults(query) {
  const box = $('#search-results');
  if (!query) {
    box.classList.remove('active');
    box.innerHTML = '';
    return;
  }
  box.classList.add('active');
  const q = query.trim().toLowerCase();
  const results = stockIndex.filter(s =>
    s.stock_id.toLowerCase().includes(q) || (s.stock_name || '').toLowerCase().includes(q)
  ).slice(0, 40);

  if (!results.length) {
    box.innerHTML = `<div class="empty-hint">${stockIndexReady ? '找不到符合的股票' : '股票清單載入中…'}</div>`;
    return;
  }
  box.innerHTML = results.map(s => `
    <div class="search-result-item" data-id="${s.stock_id}" data-name="${s.stock_name}">
      <span class="sr-name">${s.stock_name}</span>
      <span class="sr-code">${s.stock_id}</span>
    </div>
  `).join('');
  box.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('click', () => {
      $('#search-input').value = '';
      renderSearchResults('');
      openStock({ stock_id: el.dataset.id, stock_name: el.dataset.name });
    });
  });
}

// ---- Watchlist rendering with live quotes ----
async function renderWatchlist() {
  renderGroupTabs();
  const byId = new Map(getWatchlist().map(s => [s.stock_id, s]));
  const list = activeGroup().ids.map(id => byId.get(id)).filter(Boolean);
  const box = $('#watchlist');
  if (!list.length) {
    box.innerHTML = `<div class="empty-hint">這個清單還沒有股票<br>搜尋股票後點選 ☆ 即可加入</div>`;
    return;
  }
  box.innerHTML = list.map(s => `
    <div class="wl-item" data-id="${s.stock_id}" data-name="${s.stock_name}">
      <div class="wl-left">
        <div class="wl-name">${s.stock_name}</div>
        <div class="wl-code">${s.stock_id}</div>
      </div>
      <div class="wl-right" id="wl-quote-${s.stock_id}">
        <div class="wl-price">—</div>
        <div class="wl-change flat">載入中</div>
      </div>
    </div>
  `).join('');
  box.querySelectorAll('.wl-item').forEach(el => {
    el.addEventListener('click', () => {
      navStocks = list;
      openStock({ stock_id: el.dataset.id, stock_name: el.dataset.name });
    });
  });

  // 先用手機裡上次的報價立刻顯示，再去抓最新的覆蓋（後端約需數秒）。
  const cached = Backend.quotePeek(list);
  if (cached) paintWatchlistQuotes(list, cached, true);
  await refreshWatchlistQuotes(list);
}

// 首頁報價更新：盤中每 20 秒一次、從背景切回 App 時立刻一次（只更新數字，不重畫清單）。
let wlList = [];
let wlBusy = false;
async function refreshWatchlistQuotes(list = wlList) {
  wlList = list;
  if (!list.length || wlBusy) return;
  wlBusy = true;
  try {
    let quotes = {};
    let failed = false;
    try {
      quotes = await Backend.quoteFresh(list);
    } catch (e) {
      failed = true;
      console.warn('live quote fetch failed', e);
    }
    if (wlList !== list) return;
    // 即時報價這次失敗、但手機裡已有「今天」的報價 → 保留它（別用昨天收盤價蓋掉），標示更新失敗，20 秒後會再試。
    const cached = failed ? Backend.quotePeek(list) : null;
    if (failed && cached && quotesAreToday(cached)) {
      await paintWatchlistQuotes(list, cached, true);
      paintQuoteTime(cached, true);
      return;
    }
    await paintWatchlistQuotes(list, quotes, false);  // 失敗時會改顯示收盤價，標籤上附失敗原因
  } finally {
    wlBusy = false;
  }
}

function twToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
}
function quotesAreToday(quotes) {
  return Object.values(quotes || {}).some(q => q && q.date === twToday());
}

function homeActive() {
  return $('#screen-home').classList.contains('active');
}

// 資料時間：顯示報價是幾點的，看得出是不是最新。
// failed=true：這次即時報價沒抓到，附上各來源狀態（例：Google 逾時／快速 抓不到），方便判斷是哪一段壞。
function paintQuoteTime(quotes, failed = false) {
  const el = $('#wl-updated');
  if (!el) return;
  const d = Backend.quoteDiag;
  const why = failed && d ? `　⚠ 更新失敗（Google ${d.gas}、快速 ${d.fast}），稍後重試` : '';
  const vals = Object.values(quotes || {}).filter(q => q && q.time);
  if (!vals.length) { el.textContent = why.trim(); return; }
  const q = vals.reduce((a, b) => ((a.date + a.time) >= (b.date + b.time) ? a : b));
  const day = q.date && q.date !== twToday() ? `${q.date.slice(4, 6)}/${q.date.slice(6, 8)} ` : '';
  const src = vals.some(v => v.src === 'yahoo') ? '・Yahoo' : '・證交所';
  el.textContent = `報價時間 ${day}${q.time}${src}${why || (twMarketOpen() ? '　盤中每 20 秒更新' : '')}`;
}

async function paintWatchlistQuotes(list, quotes, cachedOnly) {
  paintQuoteTime(quotes);
  const missing = [];
  for (const s of list) {
    const q = quotes[s.stock_id];
    if (q && q.price != null) {
      const el = $(`#wl-quote-${s.stock_id}`);
      if (el) {
        el.innerHTML = `
          <div class="wl-price">${numFmt(q.price, 2)}</div>
          <div class="wl-change ${signClass(q.change)}">${q.change >= 0 ? '+' : ''}${numFmt(q.change, 2)} (${pctFmt(q.changePercent)})</div>
        `;
      }
      continue;
    }
    missing.push(s.stock_id);
  }
  if (!missing.length || cachedOnly) return;
  // Live quote unavailable (night/weekend/MIS hiccup): ONE request for all official closes
  // (TWSE + TPEx OpenAPI via Apps Script) instead of one FinMind call per stock.
  let closes = {};
  try { closes = await Backend.closeAll(missing); } catch (e) { console.warn('closeAll failed', e); }
  // 全部都走收盤價備援時，標示收盤資料的日期（民國 1150929 / 西元 20260929 都處理）
  const lbl = $('#wl-updated');
  const dates = Object.values(closes).map(c => String(c.date || '')).filter(Boolean).sort();
  if (lbl && !lbl.textContent && dates.length) {
    const d = dates[dates.length - 1];
    const g = Backend.quoteDiag;
    lbl.textContent = `收盤價 ${d.slice(-4, -2)}/${d.slice(-2)}（即時報價暫時抓不到${g ? `：Google ${g.gas}、快速 ${g.fast}` : ''}）`;
  }
  for (const id of missing) {
    const el = $(`#wl-quote-${id}`);
    if (!el) continue;
    const c = closes[id];
    if (!c || c.close == null) { el.innerHTML = `<div class="wl-change flat">無資料</div>`; continue; }
    const chg = c.change || 0;
    const prev = c.close - chg;
    const pct = prev ? (chg / prev) * 100 : 0;
    el.innerHTML = `
      <div class="wl-price">${numFmt(c.close, 2)}</div>
      <div class="wl-change ${signClass(chg)}">${chg >= 0 ? '+' : ''}${numFmt(chg, 2)} (${pctFmt(pct)})</div>
    `;
  }
}

// ---- 即時 ----
function applyHeaderQuote(price, change, pct) {
  $('#dq-price').textContent = numFmt(price, 2);
  $('#dq-change').textContent = `${change >= 0 ? '+' : ''}${numFmt(change, 2)} (${pctFmt(pct)})`;
  $('#dq-change').className = `dq-change ${signClass(change)}`;
}

let rtLastLoad = 0;
async function loadRealtime(silent = false) {
  const container = $('#chart-rt');
  const stock = currentStock;
  rtLastLoad = Date.now();
  if (!silent || !rtHandle) container.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const [intra, quotes] = await Promise.all([
      Backend.intraday(stock),
      Backend.quote([stock]).catch(() => ({})),
    ]);
    if (stock !== currentStock) return;
    const q = quotes[stock.stock_id];
    const prev = (q && q.prevClose) || intra.prevClose;

    if (q && q.price != null) {
      applyHeaderQuote(q.price, q.change, q.changePercent);
    } else {
      const rows = await Api.daily(stock, 10).catch(() => []);
      if (rows.length) {
        const last = rows[rows.length - 1];
        const p = rows.length > 1 ? rows[rows.length - 2] : last;
        applyHeaderQuote(last.close, last.close - p.close, p.close ? ((last.close - p.close) / p.close) * 100 : 0);
      }
    }

    if (!intra.bars.length || !prev) {
      rtHandle = null;
      container.innerHTML = '<div class="error-msg">目前沒有即時走勢資料</div>';
      $('#rt-stats').innerHTML = '';
      return;
    }
    if (!rtHandle) rtHandle = renderRealtime(container, prev);
    setRealtimeData(rtHandle, intra);

    const bars = intra.bars;
    const hi = Math.max(...bars.map(b => b.high));
    const lo = Math.min(...bars.map(b => b.low));
    const totalLots = bars.reduce((s, b) => s + b.vol, 0) / 1000;
    const cls = (v) => signClass(v - prev);
    $('#rt-stats').innerHTML = [
      ['昨收', numFmt(prev, 2), 'flat'],
      ['開盤', numFmt(bars[0].open, 2), cls(bars[0].open)],
      ['成交量(張)', numFmt(totalLots), 'flat'],
      ['最高', numFmt(hi, 2), cls(hi)],
      ['最低', numFmt(lo, 2), cls(lo)],
      ['振幅', pctFmt(((hi - lo) / prev) * 100).replace('+', ''), 'flat'],
    ].map(([k, v, c]) => `<div><span class="k">${k}</span><span class="v ${c}">${v}</span></div>`).join('');

    const lastT = new Date((bars[bars.length - 1].t + intra.gmtoffset) * 1000);
    const hh = String(lastT.getUTCHours()).padStart(2, '0');
    const mm = String(lastT.getUTCMinutes()).padStart(2, '0');
    $('#rt-note').textContent = `資料時間 ${hh}:${mm}（盤中每 15 秒自動更新；走勢圖來源 Yahoo 財經，可能有 1–2 分鐘延遲，右上角價格以證交所即時為準）`;
  } catch (e) {
    if (stock !== currentStock) return;
    if (!rtHandle) container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// ---- K線 ----
function klineContainerHeight() {
  const intraday = klineInterval !== '1d';
  const extraPanes = (klineOpts.showInst && !intraday ? 1 : 0) + (klineOpts.indicator ? 1 : 0);
  return 260 + extraPanes * 90;
}

function redrawKline() {
  const container = $('#chart-kline');
  if (!klineData.price.length) return;
  container.style.height = `${klineContainerHeight()}px`;
  charts.kline = renderKLine(container, klineData.price, {
    instRows: klineData.inst,
    holdingRows: klineData.holding,
    showInst: klineOpts.showInst && klineInterval === '1d',
    showHolding: false,
    showBBand: klineOpts.showBBand,
    indicator: klineOpts.indicator,
    intraday: klineInterval !== '1d',
    visibleBars: { '60m': 100, '5m': 160 }[klineInterval],
  });
}

async function loadKline() {
  const container = $('#chart-kline');
  container.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const intraday = klineInterval !== '1d';
    // Daily rows always drive the header (prev-close fallback); intraday bars only draw the chart.
    const [priceRows, instRows, chartRows] = await Promise.all([
      Api.daily(currentStock, intraday ? 10 : klineRange),
      intraday ? Promise.resolve([]) : Api.institutional(currentStock.stock_id, klineRange).catch(() => []),
      intraday ? Backend.kbar(currentStock, klineInterval) : Promise.resolve(null),
    ]);
    if (!priceRows.length) { container.innerHTML = '<div class="error-msg">查無資料</div>'; return; }
    const drawRows = chartRows || priceRows;
    if (!drawRows.length) { container.innerHTML = '<div class="error-msg">查無分K資料</div>'; return; }
    klineData = { price: drawRows, inst: instRows, holding: [] };
    redrawKline();

    const last = priceRows[priceRows.length - 1];
    const prev = priceRows.length > 1 ? priceRows[priceRows.length - 2] : last;
    let price = last.close;
    let change = last.close - prev.close;
    let pct = prev.close ? (change / prev.close) * 100 : 0;

    // Prefer a live quote (盤中即時) over FinMind's end-of-day close when available.
    try {
      const quotes = await Backend.quote([currentStock]);
      const q = quotes[currentStock.stock_id];
      if (q && q.price != null) {
        price = q.price;
        change = q.change;
        pct = q.changePercent;
      }
    } catch (e) {
      console.warn('live quote fetch failed', e);
    }

    $('#dq-price').textContent = numFmt(price, 2);
    $('#dq-change').textContent = `${change >= 0 ? '+' : ''}${numFmt(change, 2)} (${pctFmt(pct)})`;
    $('#dq-change').className = `dq-change ${signClass(change)}`;
  } catch (e) {
    container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// ---- Event wiring ----
document.addEventListener('DOMContentLoaded', () => {
  ensureStockIndex();
  groups = loadGroupsLocal();
  normalizeGroups();
  renderWatchlist();
  // Order matters: merge the flat list first so group ids from the backend aren't pruned.
  (async () => {
    try { await syncWatchlistFromBackend(); } catch (e) { console.warn('watchlist sync failed', e); }
    try { await syncGroupsFromBackend(); } catch (e) { console.warn('groups sync failed', e); normalizeGroups(); saveGroups(false); }
    renderWatchlist();
  })();

  // 報價即時性：盤中首頁每 20 秒更新；手機從背景切回來（或過了一段時間再打開）立刻更新。
  setInterval(() => {
    if (!document.hidden && homeActive() && twMarketOpen()) refreshWatchlistQuotes();
  }, 20000);
  let hiddenAt = 0;
  const onResume = () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt < 5000) return;
    if (homeActive()) refreshWatchlistQuotes();
    else if (currentStock && $('#screen-detail').classList.contains('active') && $('#pane-rt').classList.contains('active')) loadRealtime(true);
  };
  document.addEventListener('visibilitychange', onResume);
  window.addEventListener('pageshow', e => { if (e.persisted) { hiddenAt = 0; onResume(); } });
  // 快取先顯示了舊資料、新資料回來了 → 馬上換上去
  window.addEventListener('bk-fresh', e => {
    const key = e.detail;
    if (homeActive() && wlList.length && key === Backend.quoteKey(wlList)) paintWatchlistQuotes(wlList, Backend.quotePeek(wlList) || {}, true);
    else if (currentStock && $('#pane-rt').classList.contains('active') &&
      (key === `i_${currentStock.stock_id}` || key === Backend.quoteKey([currentStock]))) loadRealtime(true);
  });

  $('#btn-group-menu').addEventListener('click', openGroupMenu);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  $('#search-input').addEventListener('input', (e) => {
    renderSearchResults(e.target.value);
  });
  $('#search-input').addEventListener('focus', () => ensureStockIndex());

  $('#btn-back').addEventListener('click', goHome);

  $('#btn-star').addEventListener('click', onStarClick);
  $('#btn-prev').addEventListener('click', () => stepStock(-1));
  $('#btn-next').addEventListener('click', () => stepStock(1));

  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`#pane-${btn.dataset.tab}`).classList.add('active');
      const tab = btn.dataset.tab;
      if (tab === 'rt') {
        loadRealtime(true);
      } else if (!loadedTabs[tab]) {
        loadedTabs[tab] = true;
        TAB_LOADERS[tab]();
      }
    });
  });

  $$('#kline-range .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#kline-range .range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      klineRange = Number(btn.dataset.range);
      loadKline();
    });
  });

  $$('#kline-interval .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#kline-interval .range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      klineInterval = btn.dataset.interval;
      $('#kline-range').style.display = klineInterval === '1d' ? '' : 'none';
      loadKline();
    });
  });

  $$('#kline-layers [data-layer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = { inst: 'showInst', bband: 'showBBand' }[btn.dataset.layer];
      klineOpts[key] = !klineOpts[key];
      btn.classList.toggle('active', klineOpts[key]);
      redrawKline();
    });
  });

  $$('#kline-layers [data-indicator]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#kline-layers [data-indicator]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      klineOpts.indicator = btn.dataset.indicator || null;
      redrawKline();
    });
  });

  $$('#margin-range .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#margin-range .range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      marginRange = Number(btn.dataset.range);
      loadMargin();
    });
  });

  $$('#branch-range .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#branch-range .range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      branchPeriod = Number(btn.dataset.period);
      loadBranch();
    });
  });

  $$('#inst-range .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#inst-range .range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      instRange = Number(btn.dataset.range);
      loadInstitutional();
    });
  });

  [['#hold-big', v => { holdBig = v; }], ['#hold-retail', v => { holdRetail = v; }]].forEach(([sel, set]) => {
    $$(`${sel} .range-btn`).forEach(btn => {
      btn.addEventListener('click', () => {
        $$(`${sel} .range-btn`).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        set(Number(btn.dataset.v));
        redrawHolders();
      });
    });
  });
  $$('#hold-mode .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#hold-mode .range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      holdMode = btn.dataset.mode;
      redrawHolders();
    });
  });

  $$('#inst-unit .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#inst-unit .range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      instUnit = Number(btn.dataset.unit);
      loadInstitutional();
    });
  });

  $('#btn-save-eps').addEventListener('click', async () => {
    if (!currentStock) return;
    const eps2026 = $('#eps-2026-input').value;
    const eps2027 = $('#eps-2027-input').value;
    $('#eps-status').textContent = '儲存中…';
    try {
      await Backend.upsert(currentStock, {
        eps2026: eps2026 === '' ? null : Number(eps2026),
        eps2027: eps2027 === '' ? null : Number(eps2027),
      });
      $('#eps-status').textContent = '已儲存';
      loadEpsEstimate();
    } catch (e) {
      $('#eps-status').textContent = `儲存失敗：${e.message}`;
    }
  });

  $('#btn-settings').addEventListener('click', () => {
    $('#token-input').value = localStorage.getItem('finmind_token') || '';
    $('#settings-panel').classList.add('active');
  });
  $('#btn-settings-close').addEventListener('click', () => {
    $('#settings-panel').classList.remove('active');
  });
  $('#btn-save-token').addEventListener('click', () => {
    localStorage.setItem('finmind_token', $('#token-input').value.trim());
    $('#settings-panel').classList.remove('active');
  });

  $('#btn-anchors-parse').addEventListener('click', async () => {
    const items = parseAnchorsReport($('#anchors-input').value);
    anchorsPending = items;
    $('#anchors-status').textContent = '';
    if (!items.length) {
      $('#anchors-preview').textContent = '沒有找到「名稱(代號)…2026/2027年EPS約A/B元」格式的標的，請確認貼的是完整週報內容。';
      $('#btn-anchors-apply').style.display = 'none';
      return;
    }
    await ensureStockIndex();
    const have = new Set(getWatchlist().map(s => s.stock_id));
    $('#anchors-preview').innerHTML = items.map(i =>
      `${have.has(i.stock_id) ? '更新' : '<b>新增</b>'}　${i.stock_name}（${i.stock_id}）　EPS ${i.eps2026} / ${i.eps2027}`
    ).join('<br>');
    $('#btn-anchors-apply').style.display = '';
  });

  $('#btn-anchors-apply').addEventListener('click', async () => {
    if (!anchorsPending.length) return;
    $('#anchors-status').textContent = '寫入中…';
    try {
      const res = await applyAnchorsItems(anchorsPending);
      const ok = (res.results || []).filter(r => r.ok).length;
      $('#anchors-status').textContent = `已處理 ${ok} 檔（新增或更新 EPS）`;
      $('#anchors-input').value = '';
      $('#anchors-preview').textContent = '';
      $('#btn-anchors-apply').style.display = 'none';
      anchorsPending = [];
      renderWatchlist();
    } catch (e) {
      $('#anchors-status').textContent = `寫入失敗：${e.message}`;
    }
  });

  $('#btn-import').addEventListener('click', async () => {
    const raw = $('#import-input').value;
    if (!raw.trim()) return;
    $('#import-status').textContent = '匯入中…';
    try {
      const result = await importWatchlist(raw);
      let msg = `已加入 ${result.added} 檔（共 ${result.total} 檔）`;
      if (result.notFound.length) msg += `，找不到：${result.notFound.join('、')}`;
      $('#import-status').textContent = msg;
      $('#import-input').value = '';
      renderWatchlist();
    } catch (e) {
      $('#import-status').textContent = `匯入失敗：${e.message}`;
    }
  });
});
