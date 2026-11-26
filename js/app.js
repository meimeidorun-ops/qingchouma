// ---- State ----
let stockIndex = [];        // full TaiwanStockInfo list
let stockIndexReady = false;
let currentStock = null;    // { stock_id, stock_name }
let charts = { kline: null, inst: null, revenue: null, profit: null, holders: null };
let klineRange = 180;
const KL_ZOOM_BARS = 60;   // K 線預設只顯示最近 60 根（約 3 個月），看起來比較大
let klineFull = false;     // true＝顯示選定區間全部（按了區間按鈕之後）
let instRange = 90;
let branchPeriod = 1;
let marginRange = 180;
let klineData = { price: [], inst: [], holding: [], margin: [] };
let klineOpts = { showInst: true, showBBand: false, indicator: null,
  showMargin: localStorage.getItem('kl_margin') === '1', showHolding: localStorage.getItem('kl_hold') === '1',
  showMaExtra: false, showMain: localStorage.getItem('kl_main') === '1' };

// ---- 自訂均線（2026-11-26）：最多 6 條，每條可開關、自訂天數；存 localStorage.kl_ma_cfg ----
const MA_COLORS = ['#f2c744', '#ff8fab', '#7aa2f7', '#3ee6ff', '#b98cff', '#ff9f43'];
const MA_DEFAULT = [{ n: 5, on: 1 }, { n: 10, on: 0 }, { n: 20, on: 1 }, { n: 60, on: 0 }, { n: 120, on: 0 }, { n: 240, on: 0 }];
let maCfg = (() => {
  try {
    const c = JSON.parse(localStorage.getItem('kl_ma_cfg') || 'null');
    if (Array.isArray(c) && c.length === 6) return c;
  } catch (e) {}
  const c = MA_DEFAULT.map(x => ({ ...x }));
  if (localStorage.getItem('kl_ma') === '1') { c[1].on = 1; c[3].on = 1; }  // 舊版「均線+」開著 → MA10、MA60 一起開
  return c;
})();
const maActive = () => maCfg.map((m, i) => ({ n: m.n, on: m.on, color: MA_COLORS[i] })).filter(m => m.on && m.n >= 2);

function openMaSettings() {
  const rows = maCfg.map((m, i) => `<div class="ma-row">
      <label class="ma-on"><input type="checkbox" data-i="${i}" ${m.on ? 'checked' : ''}><span class="dot" style="background:${MA_COLORS[i]}"></span></label>
      <span>MA</span><input class="ma-n" type="number" inputmode="numeric" min="2" max="400" step="1" data-i="${i}" value="${m.n}"><span class="dim">日</span>
    </div>`).join('');
  showModal(`<div class="modal-title">均線設定</div>
    <div class="ma-list">${rows}</div>
    <p class="dim" style="font-size:12px;margin:6px 0 10px">勾選要顯示的線、輸入天數（2～400）。日 K 是「天」，60 分 K 是「60 分鐘根數」，5 分 K 是「5 分鐘根數」。設定會記在這支手機。</p>
    <div style="display:flex;gap:8px">
      <button class="modal-btn" id="ma-reset" style="flex:1;text-align:center">恢復預設</button>
      <button class="modal-btn" id="ma-ok" style="flex:1;text-align:center;color:var(--accent)">套用</button>
    </div>`);
  $('#ma-reset').addEventListener('click', () => { maCfg = MA_DEFAULT.map(x => ({ ...x })); saveMa(); closeModal(); });
  $('#ma-ok').addEventListener('click', () => {
    $$('.ma-list input[type=checkbox]').forEach(el => { maCfg[+el.dataset.i].on = el.checked ? 1 : 0; });
    $$('.ma-list .ma-n').forEach(el => { const v = Math.round(Number(el.value)); if (v >= 2 && v <= 400) maCfg[+el.dataset.i].n = v; });
    saveMa();
    closeModal();
  });
}
function saveMa() {
  try { localStorage.setItem('kl_ma_cfg', JSON.stringify(maCfg)); } catch (e) {}
  // 天數變長（例如 MA240）時要多抓暖身資料 → 重新載入；不然只要重畫
  const need = Math.max(...maActive().map(m => m.n), 0);
  if (klineInterval === '1d' && need * 1.5 > (klineData.warm || 130)) loadKline(); else redrawKline(true);
}
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
  const v = JSON.stringify(list);
  try { localStorage.setItem('watchlist', v); } catch (e) {
    // 空間滿了：清掉可重抓的快取（FinMind、後端暫存）再寫一次
    try { Object.keys(localStorage).filter(k => /^(fmfb_|bk_)/.test(k)).forEach(k => localStorage.removeItem(k)); localStorage.setItem('watchlist', v); } catch (e2) { console.warn('watchlist save failed', e2); }
  }
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
  try {
    localStorage.setItem('groups', JSON.stringify(groups));
    localStorage.setItem('active_group', activeGroupId);
  } catch (e) {  // 空間滿了也不能讓切分頁、加股票整個壞掉
    try { Object.keys(localStorage).filter(k => /^(fmfb_|bk_)/.test(k)).forEach(k => localStorage.removeItem(k)); localStorage.setItem('groups', JSON.stringify(groups)); localStorage.setItem('active_group', activeGroupId); } catch (e2) { console.warn('groups save failed', e2); }
  }
  if (push) {
    clearTimeout(pushGroupsTimer);
    pushGroupsTimer = setTimeout(() => Backend.setGroups(groups).catch(e => { console.warn('groups sync failed', e); toastWarn(e); }), 800);
  }
}

async function syncGroupsFromBackend(remoteP) {
  const remote = await (remoteP || Backend.getGroups());
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
    pendSet('remove', stock.stock_id, false);
    pendSet('add', stock.stock_id, true);
    Backend.upsert(stock).then(() => pendSet('add', stock.stock_id, false))
      .catch(e => { console.warn('backend upsert failed', e); toastWarn(e); });
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
    pendSet('add', stockId, false);
    pendSet('remove', stockId, true);
    Backend.remove(stockId).then(() => pendSet('remove', stockId, false))
      .catch(e => { console.warn('backend remove failed', e); toastWarn(e); });
  }
  saveGroups();
}

function refreshStar() {
  if (!currentStock) return;
  const watched = isWatched(currentStock.stock_id);
  $('#btn-star').textContent = watched ? '★' : '☆';
  $('#btn-star').classList.toggle('active', watched);
}

// 2026-10-14：非同步載入的「號碼牌」。快速換股票／換期間／換頁時，晚回來的舊請求不可以蓋掉新的畫面
// （原本法人頁沒防護，會出現上一檔的法人；K 線換週期時舊的日K 可能蓋掉 60 分）。
const tabSeq = {};
function tabTicket(k) { return (tabSeq[k] = (tabSeq[k] || 0) + 1); }
function tabLive(k, t, stock) { return tabSeq[k] === t && (stock === undefined || stock === currentStock); }
let modalSeq = 0;  // 每開一次彈窗 +1；彈窗內容晚回來時比對，避免蓋掉後來開的彈窗

function showModal(html) {
  modalSeq++;
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

// 畫面下方短暫提示（寫入失敗、沒設密碼…），4 秒後消失
function toastWarn(e) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = '⚠ ' + ((e && e.message) || e);
  t.classList.add('show');
  clearTimeout(toastWarn.timer);
  toastWarn.timer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ---- 還沒成功送到後端的新增/刪除（離線或後端出錯時暫存，下次同步重送）----
// 2026-10-03：原本同步會把「本機有、後端沒有」的股票一律推回後端，結果在 A 裝置刪掉的股票會被 B 裝置加回來。
// 改成「後端為準」：只有這台自己新增、還沒送成功的（pending add）才會推上去；這台刪除還沒送成功的（pending remove）會重送刪除。
// 清掉本機的擁有者資料（清單、分頁、待同步、後端快取）
function wipeOwnerLocal() {
  // 2026-10-14：持股暫存（portfolio_cache／portfolio_quotes）也要清，不然切回訪客打開 💼 還看得到上次的持股
  ['watchlist', 'groups', 'active_group', 'wl_pending_add', 'wl_pending_remove', 'portfolio_cache', 'portfolio_quotes'].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
  ['list', 'groups', 'scores', 'portfolio'].forEach(k => BK.drop(k));
}
function pendRead(kind) {
  try { return new Set(JSON.parse(localStorage.getItem('wl_pending_' + kind) || '[]')); } catch (e) { return new Set(); }
}
function pendSet(kind, id, on) {
  if (!isOwner()) return;  // 訪客不累積「待同步」（之後填了密碼也不會把訪客清單推上後端）
  const s = pendRead(kind);
  if (on) s.add(id); else s.delete(id);
  try { localStorage.setItem('wl_pending_' + kind, JSON.stringify([...s])); } catch (e) {}
}

// 後端清單為準同步到本機（新裝置/新網址也會拿到同一份）。
async function syncWatchlistFromBackend() {
  // 股票名稱清單（FinMind）和後端清單（Apps Script，2～14 秒）同時抓
  const [, remote] = await Promise.all([ensureStockIndex(), Backend.list()]);
  const local = getWatchlist();
  const remoteIds = new Set(remote.map(s => s.stock_id));
  const localIds = new Set(local.map(s => s.stock_id));
  const pAdd = pendRead('add'), pRem = pendRead('remove');

  const merged = [
    ...local.filter(s => remoteIds.has(s.stock_id) || pAdd.has(s.stock_id)),
    ...remote.filter(s => !localIds.has(s.stock_id) && !pRem.has(s.stock_id))
      .map(s => ({ stock_id: s.stock_id, stock_name: s.stock_name })),
  ];
  // 重送還沒成功的新增 / 刪除
  const toAdd = local.filter(s => pAdd.has(s.stock_id) && !remoteIds.has(s.stock_id));
  if (toAdd.length) {
    Backend.bulkUpsert(toAdd.map(s => ({ stock_id: s.stock_id, stock_name: s.stock_name, market: marketFor(s.stock_id) })))
      .then(() => toAdd.forEach(s => pendSet('add', s.stock_id, false)))
      .catch(e => console.warn('backend bulkUpsert failed', e));
  }
  pAdd.forEach(id => { if (remoteIds.has(id)) pendSet('add', id, false); });
  pRem.forEach(id => {
    if (!remoteIds.has(id)) { pendSet('remove', id, false); return; }
    Backend.remove(id).then(() => pendSet('remove', id, false)).catch(e => console.warn('backend remove failed', e));
  });
  const changed = merged.map(s => s.stock_id).join() !== local.map(s => s.stock_id).join();
  if (changed) setWatchlist(merged);
  return changed;
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
  // 2026-11-22：上一檔／下一檔停在原本的頁籤（例如在「獲利」看完換下一檔還是「獲利」）
  const cur = ($('.tab-btn.active') || {}).dataset;
  openStock({ stock_id: next.stock_id, stock_name: next.stock_name }, { keepTab: cur && cur.tab });
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

async function openStock(stock, opts = {}) {
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
  loadedTabs = { rt: false, kline: false, inst: false, margin: false, branch: false, revenue: false, profit: false, holders: false, etf: false, news: false };
  // ETF：顯示「ETF」頁籤（折溢價、規模、申購贖回），藏起營收／獲利（ETF 沒有）
  const etfStock = /^00/.test(stock.stock_id);
  $$('.tab-btn[data-tab="etf"]').forEach(b => { b.hidden = !etfStock; });
  $$('.tab-btn[data-tab="revenue"], .tab-btn[data-tab="profit"]').forEach(b => { b.hidden = etfStock; });
  rtHandle = null;

  stopRtTimer();
  let klineTick = 0;
  rtTimer = setInterval(() => {
    if (document.hidden) return;
    const open = twMarketOpen();
    if ($('#pane-rt').classList.contains('active')) {
      if (!open && Date.now() - rtLastLoad < 120e3) return;
      loadRealtime(true);
      return;
    }
    // 2026-10-13：不管停在哪個頁籤（法人、資券、分點…），盤中右上角股價都每 15 秒更新
    if (open) refreshHeaderQuote();
    // K 線頁：盤中每 60 秒自動更新（日K 最後一根、5分/60分）
    if ($('#pane-kline').classList.contains('active') && open && ++klineTick % 4 === 0) loadKline(true);
  }, 15000);

  paintDetailScore(stock);
  // 換股票時要停在原本的頁籤（這一檔有這個頁籤才行，例如 ETF 沒有「獲利」）
  const keep = opts.keepTab && opts.keepTab !== 'rt' ? document.querySelector(`.tab-btn[data-tab="${opts.keepTab}"]`) : null;
  if (keep && !keep.hidden) {
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b === keep));
    $$('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `pane-${opts.keepTab}`));
    loadedTabs[opts.keepTab] = true;
    // 右上角股價（即時頁沒開，所以單獨抓）；抓不到就用全市場收盤檔
    refreshHeaderQuote().then(async () => {
      if ($('#dq-price').textContent !== '—' || typeof Mk === 'undefined') return;
      try {
        const d = (await Mk.dayMap()).get(stock.stock_id);
        if (d && d.close != null && currentStock === stock && $('#dq-price').textContent === '—') {
          const prev = d.pct != null ? d.close / (1 + d.pct / 100) : d.close;
          applyHeaderQuote(d.close, d.close - prev, d.pct || 0);
        }
      } catch (e) {}
    });
    TAB_LOADERS[opts.keepTab]();
    prefetchStock(stock);
    return;
  }
  await loadRealtime();
  loadedTabs.rt = true;
  prefetchStock(stock);
}

// 抓本站的靜態 JSON（wb/、mk/）：失敗（網路瞬斷、部署更新中、拿到的不是 JSON）就等 1.5 秒換個網址參數再試一次。找不到檔案回 null。
async function fetchJsonRetry(path) {
  let err;
  for (let k = 0; k < 2; k++) {
    try {
      const res = await fetch(`${path}?t=${Math.floor(Date.now() / 6e5)}${k ? '_' + Date.now() : ''}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { err = e; await new Promise(r => setTimeout(r, 1500)); }
  }
  throw new Error(/JSON|token/i.test(err.message) ? '資料檔更新中，請稍後再試' : err.message === 'Failed to fetch' ? '網路連線不穩' : err.message);
}

// 個股頁右上角股價：只抓這一檔的即時報價（不重畫走勢圖）
async function refreshHeaderQuote() {
  const stock = currentStock;
  if (!stock) return;
  try {
    const q = (await Backend.quoteFresh([stock], true))[stock.stock_id];
    if (stock === currentStock && q && q.price != null) applyHeaderQuote(q.price, q.change, q.changePercent);
  } catch (e) {}
}

// 個股頁標題下方：評分＋訊號（自選股用後端評分；其他股票用全市場評分 mk/scores.json；點一下看細項）
async function paintDetailScore(stock) {
  const box = $('#dt-score');
  box.hidden = true;
  if (typeof paintDetailTemp === 'function') paintDetailTemp(stock);
  if (typeof paintDetailFlags === 'function') paintDetailFlags(stock);
  if (typeof paintChipSummary === 'function') paintChipSummary(stock);
  if (typeof paintInsight === 'function') paintInsight(stock);
  if (typeof paintPeers === 'function') paintPeers(stock);
  let it = scoreMap.get(stock.stock_id);
  if (!it) {
    try { const d = await Backend.scores(); scoreMap = new Map((d && d.items || []).map(x => [x.id, scoreModeItem(x)])); } catch (e) {}
    it = scoreMap.get(stock.stock_id);
  }
  if (!it) { if (currentStock === stock && typeof mkPaintDetailScore === 'function') mkPaintDetailScore(stock); return; }
  if (currentStock !== stock) return;
  const sigs = (it.signals || []).slice().sort((a, b) => (b.level === 'warn') - (a.level === 'warn'));
  box.innerHTML = `<span class="sc-badge has ${scoreClass(it.score)}">${it.score ?? '—'}</span><span class="dt-score-lbl">評分</span>` +
    sigs.map(s => `<span class="sc-sig ${s.level}">${sigShort(s)}</span>`).join('') + '<span class="dt-score-more">細項 ›</span>';
  box.onclick = () => openScoreDetail(stock.stock_id);
  box.hidden = false;
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
    quiet(Api.daily(stock, klineRange).catch(() => {})
      .then(() => currentStock === stock && Backend.branch(stock.stock_id, branchPeriod)).catch(() => {})
      // 大戶（集保）走 Apps Script 很慢（首次 ~15 秒），排在最後背景先抓，點到頁籤時通常已經好了
      .then(() => currentStock === stock && Backend.holders(stock.stock_id, 26)));
  }, 800);
}

// 用箭頭函式包起來：各頁籤的 load 函式在 tab-*.js（比 app.js 晚載入），要到點擊時才去找。
const TAB_LOADERS = {
  rt: () => loadRealtime(true), kline: () => loadKline(), inst: () => loadInstitutional(), margin: () => loadMargin(),
  branch: () => loadBranch(), revenue: () => loadRevenue(), profit: () => loadProfit(), holders: () => loadHolders(),
  etf: () => loadEtf(), news: () => loadNews(),
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
        <div class="wl-name">${s.stock_name}<span class="sc-badge" id="wl-sc-${s.stock_id}"></span></div>
        <div class="wl-code">${s.stock_id}<span class="sc-sig" id="wl-sig-${s.stock_id}"></span></div>
      </div>
      <div class="wl-right" id="wl-quote-${s.stock_id}">
        <div class="wl-price">—</div>
        <div class="wl-change flat">載入中</div>
      </div>
    </div>
  `).join('');
  box.querySelectorAll('.wl-item').forEach(el => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.sc-badge.has')) { ev.stopPropagation(); openScoreDetail(el.dataset.id); return; }
      // 上一檔/下一檔跟著畫面上的順序（評分排序時也一樣）
      const byIdNow = new Map(list.map(s => [s.stock_id, s]));
      navStocks = [...box.querySelectorAll('.wl-item')].map(x => byIdNow.get(x.dataset.id)).filter(Boolean);
      openStock({ stock_id: el.dataset.id, stock_name: el.dataset.name });
    });
  });
  wlRendered = list;
  paintScores(list);
  if (typeof etfPaintWatchTags === 'function') etfPaintWatchTags();
  if (typeof noticePaintWatchTags === 'function') noticePaintWatchTags();
  if (typeof wlPaintExtra === 'function') wlPaintExtra();

  // 先用手機裡上次的報價立刻顯示，再去抓最新的覆蓋（後端約需數秒）。
  const cached = Backend.quotePeek(list);
  if (cached) paintWatchlistQuotes(list, cached, true);
  await refreshWatchlistQuotes(list);
}

// ---- 自選股評分（Apps Script action=scores）----
// 分數徽章：≥70 綠、50～69 黃、<50 灰；名稱下方顯示最重要的一個訊號；可切換「依評分排序」。點分數看細項。
let scoreMap = new Map();
// 評分版本（2026-10-09）：積極（預設，4 項）／穩健（再加低波動，崩跌率約減半但上漲也少）。每台裝置各自記住。
let scoreMode = localStorage.getItem('score_mode') || 'aggr';
function scoreModeItem(it) {
  // 「營收大增」改嚴（2026-10-13）：後端只看單月年增 ≥30%；Agent 另外算 revBig（再加近 3 月合計年增 ≥20%、當月是近 12 個月前三高），
  // 不符合就把這個標籤拿掉（基期低造成的單月年增不算）。
  if (it && it.signals && it.v2 && it.v2.raw && it.v2.raw.revBig === false) it = Object.assign({}, it, { signals: it.signals.filter(x => !/^rev/.test(x.key)) });
  const s = it && it.v2 && it.v2.raw && it.v2.raw.scoreSafe;
  if (scoreMode !== 'safe' || s == null) return it;
  return Object.assign({}, it, { score: s, scoreAggr: it.score, safeMode: true });
}
function paintScoreModeBtn() {
  const b = $('#wl-score-mode');
  if (b) b.textContent = scoreMode === 'safe' ? '評分：穩健' : '評分：積極';
}
let wlRendered = [];  // 目前清單分頁的股票（原始順序）
// 預設依分數高→低（2026-10-03 改；鍵名換 wl_sort2，讓之前存成「自訂」的裝置也切到分數）
let wlSortMode = localStorage.getItem('wl_sort2') || 'score';
const SIG_SHORT = { instUp: '法人連買', trustUp: '投信連買', instDn: '法人連賣', maUp: '站上月線', maDn: '跌破月線', pe15: '進便宜區', rev: '營收大增', bigUp: '大漲', bigDn: '大跌', mgUp: '融資大增', mgDn: '融資大減' };
function sigShort(sig) {
  const base = sig.key.replace(/\d+$/, '');
  const n = (sig.key.match(/(\d+)$/) || [])[1];
  if (base === 'rev') return '營收大增';
  return (SIG_SHORT[base] || sig.text) + (n && /Up|Dn/.test(base) ? n + '日' : '');
}
function scoreClass(s) { return s == null ? 'sc-na' : s >= 70 ? 'sc-hi' : s >= 50 ? 'sc-mid' : 'sc-lo'; }

async function paintScores(list) {
  const apply = data => {
    scoreMap = new Map((data && data.items || []).map(it => [it.id, scoreModeItem(it)]));
    for (const s of list) {
      const it = scoreMap.get(s.stock_id);
      const b = $(`#wl-sc-${s.stock_id}`), g = $(`#wl-sig-${s.stock_id}`);
      if (b) {
        b.textContent = it && it.score != null ? it.score : '';
        b.className = `sc-badge ${it && it.score != null ? 'has ' + scoreClass(it.score) : ''}`;
      }
      if (g) {
        const sig = it && it.signals && (it.signals.find(x => x.level === 'warn') || it.signals[0]);
        g.textContent = sig ? sigShort(sig) : '';
        g.className = `sc-sig ${sig ? sig.level : ''}`;
      }
    }
    applyWatchlistSort(list);
  };
  try { apply(await Backend.scores()); } catch (e) { console.warn('scores failed', e); }
  // 後端沒有分數的（訪客、ETF 以外的非自選評分對象）用全市場評分補上（market.js）
  if (typeof mkFillScores === 'function') mkFillScores(list);
}

// 2026-11-26：多種排序（分數／漲幅／跌幅／成交值／代號／自訂），按鈕循環切換；價格類排序在報價更新後自動重排
const WL_SORTS = [['score', '分數 高→低'], ['up', '漲幅 高→低'], ['down', '跌幅 大→小'], ['money', '成交值 大→小'], ['code', '代號'], ['custom', '自訂']];
function applyWatchlistSort(list) {
  const box = $('#watchlist');
  const btn = $('#wl-sort');
  if (btn) btn.textContent = `排序：${(WL_SORTS.find(x => x[0] === wlSortMode) || WL_SORTS[0])[1]}`;
  const items = [...box.querySelectorAll('.wl-item')];
  if (!items.length) return;
  const order = new Map(list.map((s, i) => [s.stock_id, i]));
  const q = ['up', 'down', 'money'].includes(wlSortMode) ? (Backend.quotePeek(list) || {}) : {};
  const day = typeof Mk !== 'undefined' && Mk.cache.day && Mk.cache.day.data._map;  // 沒即時報價就用收盤檔
  const pctOf = id => { const x = q[id]; if (x && x.changePercent != null) return x.changePercent; const d = day && day.get(id); return d && d.pct != null ? d.pct : null; };
  const moneyOf = id => { const x = q[id]; if (x && x.turnover) return x.turnover; const d = day && day.get(id); return d && d.money ? d.money * 1e6 : null; };
  const key = el => {
    const id = el.dataset.id;
    if (wlSortMode === 'custom') return order.get(id);
    if (wlSortMode === 'code') return Number(id.replace(/\D/g, '')) || 0;
    if (wlSortMode === 'up') { const p = pctOf(id); return p == null ? 1e9 : -p; }
    if (wlSortMode === 'down') { const p = pctOf(id); return p == null ? 1e9 : p; }
    if (wlSortMode === 'money') { const m = moneyOf(id); return m == null ? 1e18 : -m; }
    const it = scoreMap.get(id);
    return it && it.score != null ? -it.score : 1;  // 沒分數的排最後
  };
  items.sort((a, b) => key(a) - key(b) || order.get(a.dataset.id) - order.get(b.dataset.id)).forEach(el => box.appendChild(el));
}

function openScoreDetail(id) {
  const it = scoreMap.get(id);
  if (!it || it.mk) { if (typeof mkOpenScore === 'function') mkOpenScore(id, (getWatchlist().find(s => s.stock_id === id) || {}).stock_name); return; }
  if (it.v2) return openScoreDetailV2(id, it);
  const P = it.parts || {};
  const row = (label, v, note) => `
    <div class="sd-row"><span class="sd-label">${label}</span>
      <span class="sd-bar"><span style="width:${v == null ? 0 : v / 25 * 100}%"></span></span>
      <span class="sd-val">${v == null ? '—' : v + '/25'}</span></div>
    <div class="sd-note">${note}</div>`;
  const inst = it.instDays ? `近 ${it.instDays} 日外資＋投信買超 ${it.instBuyDays} 天（共 ${it.instNet > 0 ? '+' : ''}${numFmt(it.instNet)} 張），投信買超 ${it.trustDays} 天` : '沒有法人資料';
  const rev = it.yoy != null ? `最新月營收 YoY ${it.yoy > 0 ? '+' : ''}${it.yoy}%（${Number(String(it.revYm).slice(0, 3)) + 1911}/${String(it.revYm).slice(3)}）` : '沒有營收資料';
  const val = it.pe != null ? `${it.peYear} 預估本益比 ${it.pe} 倍（定錨 EPS）` : '沒有預估 EPS';
  const mg = it.mgPct != null ? `融資餘額 ${numFmt(it.mgBal)} 張，5 日 ${it.mgChg > 0 ? '+' : ''}${numFmt(it.mgChg)} 張（${it.mgPct > 0 ? '+' : ''}${it.mgPct}%）；減少＝籌碼沉澱加分，大增＝散戶追價扣分` : '沒有融資資料（或餘額太小）';
  const trend = it.ma20 != null ? `收盤 ${numFmt(it.close, 2)}，月線 ${numFmt(it.ma20, 2)}（${it.close > it.ma20 ? '在月線上' : '在月線下'}）` : '價格資料不足';
  showModal(`
    <div class="modal-title">${it.name}（${id}）評分 <span class="sc-badge has ${scoreClass(it.score)}">${it.score ?? '—'}</span></div>
    ${row('估值', P.val, val)}${row('法人', P.inst, inst)}${row('融資', P.margin, mg)}${row('營收', P.rev, rev)}${row('趨勢', P.trend, trend)}
    <div class="sd-sigs">${(it.signals || []).map(s => `<div class="sd-sig ${s.level}">${s.level === 'warn' ? '⚠' : '✓'} ${s.text}</div>`).join('') || '<div class="dim">目前沒有特別訊號</div>'}</div>
    <div class="dim" style="margin-top:8px">規則計算，僅供參考。5 項各 25 分，換算成 100 分；缺資料的項目不計，少於 3 項不給總分。</div>
    <button class="modal-btn" id="sd-open" style="text-align:center;margin-top:12px">打開個股頁 ›</button>
    <button class="modal-btn" id="sd-close" style="text-align:center">關閉</button>`);
  $('#sd-close').addEventListener('click', closeModal);
  $('#sd-open').addEventListener('click', () => { closeModal(); openStock({ stock_id: id, stock_name: it.name }); });
}

// 評分 v2（2026-10-08）：4 項都是「在你的自選清單裡排第幾（百分位，100＝最好）」，分數＝4 項平均
function openScoreDetailV2(id, it) {
  const P = it.v2.parts || {}, X = it.v2.raw || {};
  const pct = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);
  const row = (label, v, note) => `
    <div class="sd-row"><span class="sd-label">${label}</span>
      <span class="sd-bar"><span style="width:${v == null ? 0 : v}%"></span></span>
      <span class="sd-val">${v == null ? '—' : v}</span></div>
    <div class="sd-note">${note}</div>`;
  const ym = it.v2.ym ? `（到 ${it.v2.ym.replace('-', '/')}）` : '';
  const high = X.revHigh != null ? `近 3 個月營收是近 2 年最高的 ${Math.round(X.revHigh * 100)}%${ym}` : '沒有足夠的月營收資料';
  const turn = X.turn != null ? `近 3 月營收年增 ${pct(X.yoyPrev)} → ${pct(X.yoy3)}（${X.turn >= 0 ? '加速' : '放緩'} ${Math.abs(Math.round(X.turn * 100))} 個百分點）` : '沒有足夠的月營收資料';
  const revNote = X.yoy1 == null ? '' : `<div class="sd-note">最新單月營收年增 ${pct(X.yoy1)}，是近 12 個月第 ${X.revRank12} 高。${X.revBig ? '符合「營收大增」。'
    : X.yoy1 >= 0.3 ? '單月年增雖高，但沒同時符合「近 3 月合計年增 ≥20%、當月是近 12 個月前三高」（多半是去年基期低），不標「營收大增」。' : ''}</div>`;
  const near = X.nearHigh != null ? `股價是近一年最高收盤的 ${Math.round(X.nearHigh * 100)}%` : '股價資料不足';
  const vol = X.vol60 != null ? `近 60 日每天平均波動 ${(X.vol60 * 100).toFixed(1)}%（越小越穩）` : '股價資料不足';
  const fwd = X.peFwd != null ? `；定錨預估 ${X.peFwd} 倍（參考）` : '';
  const val = X.basis === 'fullmarket'
    ? (X.pe != null ? `本益比 ${X.pe} 倍（近四季實際 EPS）${fwd}` : (P.peRank != null ? `近四季虧損${fwd}` : `沒有本益比資料${fwd}`))
    : (X.pe != null ? `預估本益比 ${X.pe} 倍（定錨 EPS）` : (P.peRank != null ? '預估 EPS ≤ 0（虧損）' : '沒有預估 EPS'));
  showModal(`
    <div class="modal-title">${it.name}（${id}）評分 <span class="sc-badge has ${scoreClass(it.score)}">${it.score ?? '—'}</span></div>
    <div class="sd-v2">${row('營收創新高', P.revHigh, high)}${row('營收轉折', P.turn, turn)}${revNote}${row('接近一年高點', P.nearHigh, near)}${row('估值', P.peRank, val)}${it.safeMode ? row('低波動', P.lowVol, vol) : ''}</div>
    <div class="dim" style="margin-top:6px">${it.safeMode ? `穩健版（5 項，含低波動）；積極版分數 ${it.scoreAggr ?? '—'}。` : `積極版（4 項）${X.scoreSafe != null ? `；穩健版分數 ${X.scoreSafe}` : ''}。`}清單上方「評分：積極／穩健」可以切換。</div>
    <div class="sd-sigs">${(it.signals || []).map(s => `<div class="sd-sig ${s.level}">${s.level === 'warn' ? '⚠' : '✓'} ${s.text}</div>`).join('') || '<div class="dim">目前沒有特別訊號</div>'}</div>
    ${typeof mkScoreHistSlot === 'function' ? mkScoreHistSlot() : ''}
    <div class="dim" style="margin-top:8px">新版評分（全市場 2020～2026 驗證）：每項是${X.basis === 'fullmarket' ? `在全市場（成交金額前 ${X.popN || 350} 大普通股）的排名百分位` : '在你的自選清單裡排名百分位'}（100＝最好），分數＝平均；缺資料的項目不算。規則計算，僅供參考。${it.scoreOld != null ? `舊版分數 ${it.scoreOld}。` : ''}</div>
    <button class="modal-btn" id="sd-open" style="text-align:center;margin-top:12px">打開個股頁 ›</button>
    <button class="modal-btn" id="sd-close" style="text-align:center">關閉</button>`);
  $('#sd-close').addEventListener('click', closeModal);
  $('#sd-open').addEventListener('click', () => { closeModal(); openStock({ stock_id: id, stock_name: it.name }); });
  if (typeof mkFillScoreHist === 'function') mkFillScoreHist(it.score, !!it.safeMode);
}

// 首頁報價更新：盤中每 20 秒一次、從背景切回 App 時立刻一次（只更新數字，不重畫清單）。
let wlList = [];
let wlBusy = false;
// 2026-10-06 修：上一次更新還在等（例如興櫃股要等 Google 補收盤價 10～20 秒）時清單被重畫（同步完成、切分頁），
// 原本新的更新會被跳過、舊的那次又因為清單換了而放棄 → 整頁停在「載入中」（盤後不會自動重試）。
// 現在：忙的時候記下「要再跑一次」，舊的那次抓到的報價也先畫到目前畫面上。
let wlAgain = false;
// 2026-10-22：看門狗。iPhone 會把主畫面 App 留在記憶體好幾天；某次更新在背景卡住（請求一直沒回）時，
// wlBusy 永遠是 true，之後每次更新都被跳過 → 清單停在好幾天前（定錨停 10/16、我的持股停 10/19）。
// 現在：更新超過 40 秒還沒結束就視為卡住、直接開新的一輪；卡住的那輪就算之後回來也不准再畫。
let wlBusyAt = 0, wlRun = 0;
async function refreshWatchlistQuotes(list = wlList) {
  wlList = list;
  if (!list.length) return;
  if (wlBusy && Date.now() - wlBusyAt < 40000) { wlAgain = true; return; }
  if (wlBusy) console.warn('上一輪報價更新卡住超過 40 秒，強制重來');
  wlBusy = true;
  wlBusyAt = Date.now();
  const run = ++wlRun;
  try {
    let quotes = {};
    let failed = false;
    const lbl = $('#wl-updated');
    if (lbl && !/更新中/.test(lbl.textContent)) lbl.textContent = (lbl.textContent ? lbl.textContent + '　' : '') + '⟳ 更新中';
    try {
      quotes = await Backend.quoteFresh(list, true);  // 一律抓最新（不用手機裡的暫存）
    } catch (e) {
      failed = true;
      console.warn('live quote fetch failed', e);
    }
    if (run !== wlRun) return;  // 這輪被看門狗判定卡住、已經有新的一輪了
    qlogPush(quotes, failed);
    if (wlList !== list) { if (!failed) await paintWatchlistQuotes(wlList, quotes, true); return; }
    // 即時報價這次失敗、但手機裡已有「今天」的報價 → 保留它（別用昨天收盤價蓋掉），標示更新失敗，20 秒後會再試。
    const cached = failed ? Backend.quotePeek(list) : null;
    if (failed && cached && quotesAreToday(cached)) {
      await paintWatchlistQuotes(list, cached, false);  // false：暫存裡沒有的（興櫃）照樣補收盤價，不要停在「載入中」
      paintQuoteTime(cached, true);
      return;
    }
    await paintWatchlistQuotes(list, quotes, false);  // 失敗時會改顯示收盤價，標籤上附失敗原因
    if (['up', 'down', 'money'].includes(wlSortMode)) applyWatchlistSort(list);  // 價格類排序跟著報價重排
    if (failed && !/收盤價/.test($('#wl-updated').textContent)) paintQuoteTime({}, true);
  } finally {
    if (run === wlRun) {
      wlBusy = false;
      if (wlAgain) { wlAgain = false; refreshWatchlistQuotes(); }
    }
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
  const why = failed && d ? `　⚠ 更新失敗（鉅亨 ${d.cnyes || '—'}、Google ${d.gas}、快速 ${d.fast}），稍後重試` : '';
  const vals = Object.values(quotes || {}).filter(q => q && q.time);
  if (!vals.length) { el.textContent = why.trim(); return; }
  const q = vals.reduce((a, b) => ((a.date + a.time) >= (b.date + b.time) ? a : b));
  const day = q.date && q.date !== twToday() ? `${q.date.slice(4, 6)}/${q.date.slice(6, 8)} ` : '';
  const src = vals.some(v => v.src === 'yahoo') ? '・Yahoo' : vals.some(v => v.src === 'cnyes') ? '・鉅亨' : '・證交所';
  const lag = quoteLagMin(quotes);
  const lagTxt = lag != null && lag > 3 ? `（延遲 ${lag} 分）` : '';
  el.textContent = `報價時間 ${day}${q.time}${src}${lagTxt}${why || (twMarketOpen() ? '　盤中每 20 秒更新' : '')}`;
  // 2026-10-22：報價比「最近一個交易日」還舊 → 紅字提醒＋點了可以重新整理（原本停在 10/16 也看不出異常）
  const stale = q.date && q.date < expectedQuoteDay();
  el.classList.toggle('stale', !!stale);
  if (stale) el.textContent += '　⚠ 不是最新，點這裡重新整理';
}
// 現在應該看到哪一天的報價（YYYYMMDD）：平日 09:05 後（不是休市日）＝今天；否則＝全市場行情檔的最新交易日
function expectedQuoteDay() {
  const n = new Date(Date.now() + 8 * 3600e3), today = twToday();
  const d = n.getUTCDay(), m = n.getUTCHours() * 60 + n.getUTCMinutes();
  let closed = false;
  try { closed = localStorage.getItem('tw_closed_day') === today; } catch (e) {}
  if (d >= 1 && d <= 5 && m >= 560 && !closed) return today;  // 09:20 後（休市日 09:15 就會被記下來）
  const mk = typeof Mk !== 'undefined' && Mk.cache.day && Mk.cache.day.data.date;
  return mk ? mk.replace(/-/g, '') : '00000000';
}

// 報價更新紀錄（最近 30 次）：點清單上方的「報價時間」可以看，出問題時截圖就知道是哪一段壞
function qlogPush(quotes, failed) {
  try {
    const d = Backend.quoteDiag || {};
    const vals = Object.values(quotes || {}).filter(q => q && q.time);
    const newest = vals.length ? vals.reduce((a, b) => ((a.date + a.time) >= (b.date + b.time) ? a : b)) : null;
    const log = JSON.parse(localStorage.getItem('qlog') || '[]');
    log.unshift({ at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 19).replace('T', ' '), ok: !failed,
      src: `鉅亨 ${d.cnyes || '—'}／Google ${d.gas || '—'}／快速 ${d.fast || '—'}`, newest: newest ? newest.time : '—', n: vals.length,
      g: (() => { try { return `${activeGroup().name} ${wlList.length} 檔`; } catch (e) { return ''; } })() });  // 2026-10-16：記是哪個清單
    localStorage.setItem('qlog', JSON.stringify(log.slice(0, 30)));
  } catch (e) {}
}
function openQuoteLog() {
  let log = [];
  try { log = JSON.parse(localStorage.getItem('qlog') || '[]'); } catch (e) {}
  showModal(`
    <div class="modal-title">報價更新紀錄（最近 30 次）</div>
    <div class="dim" style="margin-bottom:6px">時間｜清單｜結果｜最新成交時間｜拿到檔數｜各來源狀態</div>
    <div style="font-size:12px;line-height:1.6;max-height:60vh;overflow:auto">${log.map(r => `<div>${r.at}｜${r.g || '—'}｜${r.ok ? '✓' : '⚠ 失敗'}｜${r.newest}｜${r.n}｜${r.src}</div>`).join('') || '<div class="dim">還沒有紀錄</div>'}</div>
    <button class="modal-btn" id="ql-reload" style="text-align:center;margin-top:10px">重新整理 App（清掉暫存報價、重新抓）</button>
    <button class="modal-btn" id="ql-close" style="text-align:center">關閉</button>`);
  $('#ql-reload').addEventListener('click', () => {
    try { Object.keys(localStorage).filter(k => k.startsWith('bk_q_')).forEach(k => localStorage.removeItem(k)); } catch (e) {}
    location.reload();
  });
  $('#ql-close').addEventListener('click', closeModal);
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
  // 2026-10-14：補收盤價（Apps Script，曾慢到 46 秒）改成背景做，不再卡住清單的「更新中」→ 其他股票照常每 20 秒更新。
  // 興櫃股問了也沒有收盤價：今天問過沒資料的代號記下來，今天不再問。
  const noKey = 'noclose2_' + twToday();  // v57 改用 mk 檔＋FinMind 補收盤價，換鍵名讓 v56 記下的「沒資料」重新試一次
  let noClose = [];
  try { noClose = JSON.parse(localStorage.getItem(noKey) || '[]'); } catch (e) {}
  const ask = missing.filter(id => !noClose.includes(id));
  for (const id of missing.filter(id => noClose.includes(id))) { const el = $(`#wl-quote-${id}`); if (el) el.innerHTML = `<div class="wl-change flat">無資料</div>`; }
  if (ask.length) fillCloses(ask, noKey, noClose);
}

async function fillCloses(missing, noKey, noClose) {
  // 即時報價沒有的股票補「最近收盤價」（2026-10-14 改）：
  //  ①上市櫃：mk/day.json（每天官方全市場收盤，本站靜態檔、很快）；②興櫃（day.json 沒有）：FinMind 日K 最後兩天；
  //  ③mk 檔抓不到時才問 Apps Script closeAll（曾慢到 46 秒）。
  let closes = {}, ok = false;
  const map = typeof Mk !== 'undefined' ? await Mk.dayMap().catch(() => null) : null;
  if (map) {
    const date = (Mk.cache.day && Mk.cache.day.data.date || '').replace(/-/g, '');
    for (const id of missing) {
      const r = map.get(id);
      if (r && r.close != null) closes[id] = { close: r.close, change: r.pct != null ? r.close - r.close / (1 + r.pct / 100) : 0, date };
    }
    ok = true;
  }
  // 興櫃（兩邊都沒有）：FinMind 日K 最後兩天，最多 5 檔（省額度）。先做這個，興櫃不用等慢的 Apps Script。
  // 2026-10-16：查到的結果記在手機裡 30 分鐘（原本盤中每 20 秒都重查，興櫃每次都要繞 Google 後端一圈）
  for (const id of missing.filter(id => !closes[id]).slice(0, 5)) {
    const ck = 'eclose_' + id;
    try { const c = JSON.parse(localStorage.getItem(ck) || 'null'); if (c && Date.now() - c.t < 30 * 60e3) { closes[id] = c.v; continue; } } catch (e) {}
    const s = wlList.find(x => x.stock_id === id) || { stock_id: id };
    const rows = await Api.daily(s, 14).catch(() => []);
    const last = rows[rows.length - 1], prev = rows[rows.length - 2];
    if (last && last.close != null) {
      closes[id] = { close: last.close, change: prev ? last.close - prev.close : 0, date: String(last.date).replace(/-/g, '') };
      try { localStorage.setItem(ck, JSON.stringify({ t: Date.now(), v: closes[id] })); } catch (e) {}
    }
  }
  const rest = missing.filter(id => !closes[id]);
  if (!map && rest.length) {
    try { Object.assign(closes, await Backend.closeAll(rest)); ok = true; } catch (e) { console.warn('closeAll failed', e); }
  }
  if (ok) {
    try {
      Object.keys(localStorage).filter(k => k.startsWith('noclose') && k !== noKey).forEach(k => localStorage.removeItem(k));
      localStorage.setItem(noKey, JSON.stringify([...new Set(noClose.concat(missing.filter(id => !closes[id] || closes[id].close == null)))]));
    } catch (e) {}
  }
  // 全部都走收盤價備援時，標示收盤資料的日期（民國 1150929 / 西元 20260929 都處理）
  const lbl = $('#wl-updated');
  const dates = Object.values(closes).map(c => String(c.date || '')).filter(Boolean).sort();
  if (lbl && !/報價時間|收盤價/.test(lbl.textContent) && dates.length) {  // 標籤只寫了「更新失敗」時也要標出這是收盤價
    const d = dates[dates.length - 1];
    const g = Backend.quoteDiag;
    lbl.textContent = `收盤價 ${d.slice(-4, -2)}/${d.slice(-2)}（即時報價暫時抓不到${g ? `：鉅亨 ${g.cnyes || '—'}、Google ${g.gas}、快速 ${g.fast}` : ''}）`;
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
// 五檔報價（2026-11-26）：快速後端 action=book（證交所 MIS，最佳 5 檔買賣價與張數）。跟著即時頁 15 秒更新；抓不到就收起來。
async function paintBook(stock) {
  const box = $('#rt-book');
  if (!box) return;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    let j;
    try { j = await (await fetch(`${FAST_URL}?action=book&id=${encodeURIComponent(stock.stock_id)}`, { signal: ctl.signal, cache: 'no-store' })).json(); }
    finally { clearTimeout(t); }
    if (currentStock !== stock) return;
    if (j.status !== 200 || !j.data || (!j.data.a.length && !j.data.b.length)) { box.innerHTML = ''; return; }
    const d = j.data, ref = d.y;
    const px = p => p === 0 ? '市價' : numFmt(p, 2);
    const cls = p => !p || !ref ? '' : p > ref ? 'up' : p < ref ? 'down' : '';
    const maxV = Math.max(1, ...d.a.map(x => x[1]), ...d.b.map(x => x[1]));
    const sumA = d.a.reduce((s, x) => s + x[1], 0), sumB = d.b.reduce((s, x) => s + x[1], 0);
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const b = d.b[i], a = d.a[i];
      rows.push(`<div class="bk-row">
        <span class="bk-v">${b ? numFmt(b[1]) : ''}</span>
        <span class="bk-bar b"><i style="width:${b ? (b[1] / maxV * 100).toFixed(0) : 0}%"></i></span>
        <span class="bk-p ${b ? cls(b[0]) : ''}">${b ? px(b[0]) : '—'}</span>
        <span class="bk-p ${a ? cls(a[0]) : ''}">${a ? px(a[0]) : '—'}</span>
        <span class="bk-bar a"><i style="width:${a ? (a[1] / maxV * 100).toFixed(0) : 0}%"></i></span>
        <span class="bk-v">${a ? numFmt(a[1]) : ''}</span></div>`);
    }
    const ratio = sumA + sumB ? sumB / (sumA + sumB) * 100 : 50;
    box.innerHTML = `<div class="bk-wrap">
      <div class="bk-head"><span>買量</span><span>買價</span><span>賣價</span><span>賣量</span></div>${rows.join('')}
      <div class="bk-ratio"><i style="width:${ratio.toFixed(0)}%"></i></div>
      <div class="bk-foot"><span class="up">委買 ${numFmt(sumB)} 張</span><span class="dim">${d.t ? '五檔 ' + d.t.slice(0, 5) : ''}</span><span class="down">委賣 ${numFmt(sumA)} 張</span></div></div>`;
  } catch (e) { box.innerHTML = ''; }
}

async function loadRealtime(silent = false) {
  const container = $('#chart-rt');
  const stock = currentStock;
  rtLastLoad = Date.now();
  if (!silent || !rtHandle) container.innerHTML = '<div class="loading">載入中…</div>';
  if (!silent) $('#rt-book').innerHTML = '';
  paintBook(stock);
  try {
    const [intra, quotes] = await Promise.all([
      Backend.intraday(stock),
      Backend.quote([stock]).catch(() => ({})),
    ]);
    if (stock !== currentStock) return;
    let q = quotes[stock.stock_id];
    // 盤中拿到的報價卻不是今天的（手機裡的舊快取）→ 不用，改用今天的走勢資料
    if (q && q.date && q.date !== twToday() && twMarketOpen()) q = null;
    const prev = (q && q.prevClose) || intra.prevClose;

    const lastBar = intra.bars.length ? intra.bars[intra.bars.length - 1] : null;
    if (q && q.price != null) {
      applyHeaderQuote(q.price, q.change, q.changePercent);
    } else if (lastBar && intra.prevClose) {
      const chg = lastBar.close - intra.prevClose;
      applyHeaderQuote(lastBar.close, chg, (chg / intra.prevClose) * 100);
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
      $('#rt-note').textContent = '';  // 別留著上一檔的「資料時間」
      return;
    }
    if (!rtHandle) rtHandle = renderRealtime(container, prev);
    setRealtimeData(rtHandle, intra);

    const bars = intra.bars;
    const hi = Math.max(...bars.map(b => b.high));
    const lo = Math.min(...bars.map(b => b.low));
    // 成交量：有證交所累計量（鉅亨 200013，張）就用它；分 K 加總只有實際的一半左右
    const totalLots = q && q.vol ? q.vol : bars.reduce((s, b) => s + b.vol, 0) / 1000;
    const cls = (v) => signClass(v - prev);
    const hiQ = q && q.high != null ? q.high : hi, loQ = q && q.low != null ? q.low : lo, openQ = q && q.open != null ? q.open : bars[0].open;
    const cells = [
      ['昨收', numFmt(prev, 2), 'flat'],
      ['開盤', numFmt(openQ, 2), cls(openQ)],
      ['成交量(張)', numFmt(Math.round(totalLots)), 'flat'],
      ['最高', numFmt(hiQ, 2), cls(hiQ)],
      ['最低', numFmt(loQ, 2), cls(loQ)],
      ['振幅', pctFmt(((hiQ - loQ) / prev) * 100).replace('+', ''), 'flat'],
    ];
    // 2026-11-22：漲停／跌停價（鉅亨 75／76）；碰到時標示
    if (q && q.limitUp) cells.push(['漲停', numFmt(q.limitUp, 2) + (q.price >= q.limitUp ? ' 🔒' : ''), 'up']);
    if (q && q.limitDown) cells.push(['跌停', numFmt(q.limitDown, 2) + (q.price <= q.limitDown ? ' 🔒' : ''), 'down']);
    if (q && q.turnover) cells.push(['成交值(億)', numFmt(q.turnover / 1e8, 1), 'flat']);
    $('#rt-stats').innerHTML = cells.map(([k, v, c]) => `<div><span class="k">${k}</span><span class="v ${c}">${v}</span></div>`).join('');

    const lastT = new Date((bars[bars.length - 1].t + intra.gmtoffset) * 1000);
    const hh = String(lastT.getUTCHours()).padStart(2, '0');
    const mm = String(lastT.getUTCMinutes()).padStart(2, '0');
    $('#rt-note').textContent = `資料時間 ${hh}:${mm}（盤中每 15 秒自動更新；走勢圖來源 Yahoo 財經，可能有 1–2 分鐘延遲，右上角價格以證交所即時為準）`;
  } catch (e) {
    if (stock !== currentStock) return;
    if (!rtHandle) { container.innerHTML = `<div class="error-msg">目前沒有即時走勢資料（${e.message}）</div>`; $('#rt-stats').innerHTML = ''; $('#rt-note').textContent = ''; }
    // 走勢抓不到（例：興櫃股）時，右上角至少顯示最近收盤價，不要一直停在「載入中…」
    if (/載入中/.test($('#dq-change').textContent)) {
      const rows = await Api.daily(stock, 14).catch(() => []);
      if (stock !== currentStock) return;
      const last = rows[rows.length - 1], p = rows[rows.length - 2];
      if (last) applyHeaderQuote(last.close, p ? last.close - p.close : 0, p && p.close ? ((last.close - p.close) / p.close) * 100 : 0);
      else { $('#dq-change').textContent = '無報價'; }
    }
  }
}

// ---- K線 ----
function klineContainerHeight() {
  const intraday = klineInterval !== '1d';
  const extraPanes = (klineOpts.showInst && !intraday ? 1 : 0) + (klineOpts.indicator ? 1 : 0)
    + (klineOpts.showMargin && !intraday && klineData.margin.length ? 1 : 0) + (klineOpts.showHolding && !intraday && klineData.holding.length ? 1 : 0)
    + (klineOpts.showMain && !intraday && (klineData.main || []).length ? 1 : 0);
  // 2026-11-26：K 棒主區拉高（原本 260，開兩個副圖後主區只剩一半）
  return 320 + extraPanes * 85;
}

// 日 K 暖身天數（日曆天）：至少 130 天，最長的均線要再多（MA240 ≈ 360 天）
function warmDays() { return Math.max(130, Math.ceil(Math.max(0, ...maActive().map(m => m.n)) * 1.5)); }

// 籌碼分布（2026-11-22，仿籌碼K線）：區間內每根日 K 的成交量平均分到「最低～最高」之間的價位，
// 加總成 24 個價格區段的橫條圖 → 看哪個價位成交最密集（常被當成套牢區或支撐區），標出目前價格。
function paintVolumeProfile() {
  const box = $('#kl-vp');
  if (!box) return;
  const rows = klineInterval === '1d' ? (klineData.win ? klineData.price.slice(-klineData.win) : klineData.price) : [];  // 只算畫面上選的區間
  if (rows.length < 10) { box.innerHTML = ''; return; }
  const lo = Math.min(...rows.map(r => r.min)), hi = Math.max(...rows.map(r => r.max));
  if (!(hi > lo)) { box.innerHTML = ''; return; }
  const N = 24, step = (hi - lo) / N, bins = new Array(N).fill(0);
  for (const r of rows) {
    const v = (r.Trading_Volume || 0) / 1000, a = r.min, b = r.max;
    if (!v) continue;
    if (b <= a) { bins[Math.min(N - 1, Math.floor((a - lo) / step))] += v; continue; }
    for (let k = Math.max(0, Math.floor((a - lo) / step)); k <= Math.min(N - 1, Math.floor((b - lo) / step)); k++) {
      const s = Math.max(a, lo + k * step), e = Math.min(b, lo + (k + 1) * step);
      if (e > s) bins[k] += v * (e - s) / (b - a);
    }
  }
  const max = Math.max(...bins), total = bins.reduce((x, y) => x + y, 0);
  const last = rows[rows.length - 1].close, curK = Math.min(N - 1, Math.max(0, Math.floor((last - lo) / step)));
  const peakK = bins.indexOf(max);
  const above = bins.slice(curK + 1).reduce((x, y) => x + y, 0) / total * 100;  // 目前價以上的成交占比（上方套牢量）
  const months = Math.round(rows.length / 21);
  box.innerHTML = `<div class="section-label">籌碼分布（近 ${months} 個月成交量依價格）</div>
    <div class="vp-wrap">${bins.map((v, k) => k).reverse().map(k => {
      const p0 = lo + k * step, p1 = p0 + step;
      return `<div class="vp-row${k === curK ? ' cur' : ''}${k === peakK ? ' peak' : ''}"><span class="vp-px">${numFmt((p0 + p1) / 2, (p1 > 100 ? 0 : 2))}</span><span class="vp-bar"><i style="width:${(bins[k] / max * 100).toFixed(1)}%;background:${p0 > last ? 'rgba(25,211,140,0.55)' : 'rgba(255,77,94,0.55)'}"></i></span><span class="vp-pct">${(bins[k] / total * 100).toFixed(1)}%</span></div>`;
    }).join('')}</div>
    <p class="hint" style="padding:4px 16px 14px">最密集價位約 <b>${numFmt(lo + (peakK + 0.5) * step, 2)}</b>（金框）；目前 ${numFmt(last, 2)}（亮框）。目前價格<b>以上</b>的成交量占 ${above.toFixed(0)}%：綠色＝在這些價位買進、現在還沒解套的量（上方賣壓），紅色＝成本比現價低的量。用日 K 估算，不是真實的逐筆持股成本。</p>`;
}

function redrawKline(keepRange = false) {
  const container = $('#chart-kline');
  if (!klineData.price.length) return;
  // 自動更新時保留使用者目前縮放／捲動的範圍（不然每分鐘都跳回預設）
  let range = null;
  if (keepRange && charts.kline) { try { range = charts.kline.timeScale().getVisibleLogicalRange(); } catch (e) {} }
  container.style.height = `${klineContainerHeight()}px`;
  charts.kline = renderKLine(container, klineData.price, {
    instRows: klineData.inst,
    holdingRows: klineData.holding,
    marginRows: klineData.margin,
    showInst: klineOpts.showInst && klineInterval === '1d',
    showHolding: klineOpts.showHolding && klineInterval === '1d',
    showMargin: klineOpts.showMargin && klineInterval === '1d',
    maList: maActive(),
    mainRows: klineData.main || [],
    showMain: klineOpts.showMain && klineInterval === '1d',
    showBBand: klineOpts.showBBand,
    indicator: klineOpts.indicator,
    intraday: klineInterval !== '1d',
    // 2026-11-26：預設放大＝日 K 先顯示最近 KL_ZOOM_BARS 根（資料仍載入整個區間，手指縮放／左滑看更多）；
    // 按了區間按鈕（3月／半年／1年／2年）＝要看那整段 → klineFull，同一次開 App 內維持
    visibleBars: klineInterval === '1d' ? (klineFull ? klineData.win : Math.min(klineData.win || KL_ZOOM_BARS, KL_ZOOM_BARS)) : { '60m': 40, '5m': 66 }[klineInterval],
    infoEl: $('#kl-info'),
    liveLast: klineInterval === '1d' && twMarketOpen(),
  });
  paintVolumeProfile();
  // 預設放大時區間按鈕都不亮（畫面不是那整段）；按了才亮
  $$('#kline-range .range-btn').forEach(b => b.classList.toggle('active', klineFull && Number(b.dataset.range) === klineRange));
  // 圖例：只列畫面上真的有的線
  const lg = $('#kl-legend');
  if (lg) {
    const it = maActive().map(m => [m.color, `MA${m.n}`]);
    if (klineOpts.showBBand) it.push(['rgba(242,199,68,0.6)', '布林']);
    if (klineOpts.showMain && klineInterval === '1d') it.push(['rgba(255,143,171,0.85)', (klineData.main || []).length ? '主力（粉＝買超、青＝賣超，近 20 日）' : '主力載入中…']);
    lg.innerHTML = it.map(([c, t]) => `<span><span class="dot" style="background:${c}"></span>${t}</span>`).join('') + '<span class="dim">長按 K 線滑動看當天</span>';
  }
  if (range && charts.kline) {
    try {
      const ch = charts.kline;
      ch._keepRange = range;
      ch.timeScale().setVisibleLogicalRange(range);
      // 使用者之後自己捲動/縮放，就改記新的範圍
      ch.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r) ch._keepRange = r; });
    } catch (e) {}
  }
}

// K 線疊融資、大戶（2026-11-21）：開著才抓，抓到後重畫（不擋 K 線先出來）
// 融資：Api.margin（近 40 日 mk、更早 FinMind）→ 每日餘額與增減（張）
// 大戶：集保每週（Backend.holders）→ 400 張以上持股比例；週資料的日期對到「那天或之前最後一個交易日」
async function klineLoadLayers(stock, tk) {
  const dates = klineData.price.map(r => r.date);
  if (!dates.length) return;
  const snap = d => { let v = null; for (const x of dates) { if (x <= d) v = x; else break; } return v; };
  const jobs = [];
  if (klineOpts.showMargin && !klineData.margin.length) jobs.push(Api.margin(stock.stock_id, klineRange).then(rows => {
    const set = new Set(dates);
    klineData.margin = (rows || []).filter(r => set.has(r.date)).map(r => ({
      date: r.date, bal: r.MarginPurchaseTodayBalance,
      chg: r.MarginPurchaseYesterdayBalance != null && r.MarginPurchaseTodayBalance != null ? r.MarginPurchaseTodayBalance - r.MarginPurchaseYesterdayBalance : null,
    }));
  }).catch(() => {}));
  if (klineOpts.showHolding && !klineData.holding.length) jobs.push(Backend.holders(stock.stock_id, 26).then(weeks => {
    const seen = new Set();
    klineData.holding = (weeks || []).map(w => {
      const d = snap(`${w.d.slice(0, 4)}-${w.d.slice(4, 6)}-${w.d.slice(6, 8)}`);
      const pct = (w.pct || []).slice(11, 15).reduce((a, b) => a + (b || 0), 0);  // 第 11～14 級＝400 張以上
      return d && !seen.has(d) && (seen.add(d), true) ? { date: d, percent: Math.round(pct * 100) / 100 } : null;
    }).filter(Boolean);
  }).catch(() => {}));
  // 主力買賣超（近 20 個交易日，分點頁同一份資料；第一次約 6 秒）
  if (klineOpts.showMain && !(klineData.main || []).length && typeof getMainHist === 'function') jobs.push(getMainHist(stock.stock_id).then(rows => {
    const set = new Set(dates);
    klineData.main = (rows || []).filter(r => set.has(r.date)).map(r => ({ date: r.date, net: r.net }));
  }).catch(() => {}));
  if (!jobs.length) return;
  await Promise.all(jobs);
  if ((tk == null ? currentStock === stock : tabLive('kline', tk, stock)) && klineData.stock === stock.stock_id) redrawKline(true);
}

async function loadKline(silent = false) {
  const container = $('#chart-kline');
  const stock = currentStock;
  const tk = tabTicket('kline');
  if (!silent || !klineData.price.length) container.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const intraday = klineInterval !== '1d';
    // Daily rows always drive the header (prev-close fallback); intraday bars only draw the chart.
    const [priceRows, instRows, chartRows] = await Promise.all([
      // 2026-11-26：日 K 多抓 130 天，讓 MA60、KD、MACD、RSI、布林在畫面最左邊就已經算好（畫面只顯示選的區間）
      Api.daily(currentStock, intraday ? 10 : klineRange + warmDays()),
      intraday ? Promise.resolve([]) : Api.institutional(currentStock.stock_id, klineRange).catch(() => []),
      intraday ? Backend.kbar(currentStock, klineInterval) : Promise.resolve(null),
    ]);
    if (!tabLive('kline', tk, stock)) return;
    if (!priceRows.length) { container.innerHTML = '<div class="error-msg">查無資料</div>'; return; }
    const drawRows = chartRows || priceRows;
    if (!drawRows.length) { container.innerHTML = '<div class="error-msg">查無分K資料</div>'; return; }
    const keep = klineData.stock === stock.stock_id ? klineData : {};
    const cutoff = daysAgo(klineRange);
    const win = intraday ? null : drawRows.filter(r => r.date >= cutoff).length;  // 畫面上要顯示幾根（其餘是暖身用）
    klineData = { price: drawRows, inst: instRows, holding: keep.holding || [], margin: keep.range === klineRange ? (keep.margin || []) : [], main: keep.main || [], stock: stock.stock_id, range: klineRange, win, warm: warmDays() };
    redrawKline(silent);
    if (!intraday) klineLoadLayers(stock, tk);

    const last = priceRows[priceRows.length - 1];
    const prev = priceRows.length > 1 ? priceRows[priceRows.length - 2] : last;
    let price = last.close;
    let change = last.close - prev.close;
    let pct = prev.close ? (change / prev.close) * 100 : 0;

    // Prefer a live quote (盤中即時) over FinMind's end-of-day close when available.
    try {
      const quotes = await Backend.quote([currentStock]);
      const q = quotes[currentStock.stock_id];
      if (q && q.price != null && !(q.date && q.date !== twToday() && twMarketOpen())) {
        price = q.price;
        change = q.change;
        pct = q.changePercent;
      }
    } catch (e) {
      console.warn('live quote fetch failed', e);
    }
    if (stock !== currentStock) return;  // 等報價期間換了股票：別把上一檔的價格寫到新股票的標題

    $('#dq-price').textContent = numFmt(price, 2);
    $('#dq-change').textContent = `${change >= 0 ? '+' : ''}${numFmt(change, 2)} (${pctFmt(pct)})`;
    $('#dq-change').className = `dq-change ${signClass(change)}`;
  } catch (e) {
    if (tabLive('kline', tk, stock)) container.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// 2026-10-22：手機儲存空間（localStorage，iPhone 約 5MB）整理。FinMind 快取每看一檔就多一份（法人 180 天一份就上百 KB），
// 用久了會塞滿，之後清單、分頁、報價紀錄都寫不進去。開 App 時：FinMind 快取只留最近用到的 40 份、刪掉 2 天前的興櫃收盤價暫存。
function pruneStorage() {
  try {
    const fm = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('fmfb_')) { let t = 0; try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch (e) {} fm.push([k, t]); }
      else if (k.startsWith('eclose_')) { try { if (Date.now() - JSON.parse(localStorage.getItem(k)).t > 2 * 86400e3) fm.push([k, -1]); } catch (e) {} }
    }
    fm.filter(x => x[1] === -1).forEach(([k]) => localStorage.removeItem(k));
    const keep = fm.filter(x => x[1] !== -1).sort((a, b) => b[1] - a[1]);
    keep.slice(40).forEach(([k]) => localStorage.removeItem(k));
  } catch (e) { console.warn('pruneStorage', e); }
}

// ---- Event wiring ----
document.addEventListener('DOMContentLoaded', () => {
  pruneStorage();
  ensureStockIndex();
  // 訪客第一次用新版：清掉這台以前存的擁有者清單（之前清單是公開讀的）。擁有者填密碼後會從後端重新同步。
  if (!isOwner() && !localStorage.getItem('guest_v1')) { wipeOwnerLocal(); localStorage.setItem('guest_v1', '1'); }
  $('#guest-note').hidden = isOwner();
  groups = loadGroupsLocal();
  normalizeGroups();
  renderWatchlist();
  // Order matters: merge the flat list first so group ids from the backend aren't pruned.
  if (isOwner()) (async () => {
    // 清單和分頁同時向後端要（原本依序要，等兩次 Apps Script）；套用時仍先清單後分頁
    const groupsP = Backend.getGroups();
    groupsP.catch(() => {});
    try { await syncWatchlistFromBackend(); } catch (e) { console.warn('watchlist sync failed', e); toastWarn(/token|密碼/.test(e.message) ? new Error('後端寫入密碼不正確或已失效，清單沒有同步。請到 ⚙ 設定重新貼上密碼。') : e); }
    try { await syncGroupsFromBackend(groupsP); } catch (e) { console.warn('groups sync failed', e); normalizeGroups(); saveGroups(false); }
    renderWatchlist();
  })();

  // 報價即時性：盤中首頁每 20 秒更新；手機從背景切回來（或過了一段時間再打開）立刻更新。
  setInterval(() => {
    if (!document.hidden && homeActive() && twMarketOpen()) refreshWatchlistQuotes();
  }, 20000);
  // 2026-10-08：每次回到 App（切回前景、從主畫面重開、視窗取得焦點）都立刻抓最新報價（不看離開多久）；
  // 幾個事件常會連續觸發，1.5 秒內只做一次。
  let lastResume = 0;
  // 2026-10-22：在背景放超過 10 分鐘才回來 → 整頁重新載入（等於重開 App）。
  // iPhone 主畫面 App 常常幾天都不真正重開，記憶體裡卡住的狀態會一直留著；重新載入也會順便換上新版。
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); }, true);
  window.addEventListener('pagehide', () => { hiddenAt = hiddenAt || Date.now(); });
  const onResume = () => {
    if (document.hidden) return;
    if (hiddenAt && Date.now() - hiddenAt > 10 * 60e3 && !$('#modal').classList.contains('active')) {
      hiddenAt = 0;
      location.reload();
      return;
    }
    hiddenAt = 0;
    if (Date.now() - lastResume < 1500) return;
    lastResume = Date.now();
    if (homeActive()) refreshWatchlistQuotes();
    else if (currentStock && $('#screen-detail').classList.contains('active') && $('#pane-rt').classList.contains('active')) loadRealtime(true);
    else if (currentStock && $('#screen-detail').classList.contains('active') && $('#pane-kline').classList.contains('active')) { refreshHeaderQuote(); loadKline(true); }
    else if (currentStock && $('#screen-detail').classList.contains('active')) refreshHeaderQuote();
  };
  document.addEventListener('visibilitychange', onResume);
  window.addEventListener('pageshow', onResume);
  window.addEventListener('focus', onResume);
  // 快取先顯示了舊資料、新資料回來了 → 馬上換上去
  window.addEventListener('bk-fresh', e => {
    const key = e.detail;
    if (homeActive() && wlList.length && key === Backend.quoteKey(wlList)) paintWatchlistQuotes(wlList, Backend.quotePeek(wlList) || {}, true);
    else if (currentStock && $('#pane-rt').classList.contains('active') &&
      (key === `i_${currentStock.stock_id}` || key === Backend.quoteKey([currentStock]))) loadRealtime(true);
  });

  $('#btn-group-menu').addEventListener('click', openGroupMenu);
  $('#wl-updated').addEventListener('click', () => {
    if ($('#wl-updated').classList.contains('stale')) {  // 紅字「不是最新」：直接清掉暫存報價、整頁重新載入
      try { Object.keys(localStorage).filter(k => k.startsWith('bk_q_')).forEach(k => localStorage.removeItem(k)); } catch (e) {}
      location.reload();
      return;
    }
    openQuoteLog();
  });
  paintScoreModeBtn();
  $('#wl-score-mode').addEventListener('click', () => {
    scoreMode = scoreMode === 'safe' ? 'aggr' : 'safe';
    try { localStorage.setItem('score_mode', scoreMode); } catch (e) {}
    paintScoreModeBtn();
    paintScores(wlRendered);
  });
  $('#wl-sort').addEventListener('click', () => {
    const i = WL_SORTS.findIndex(x => x[0] === wlSortMode);
    wlSortMode = WL_SORTS[(i + 1) % WL_SORTS.length][0];
    try { localStorage.setItem('wl_sort2', wlSortMode); } catch (e) {}
    applyWatchlistSort(wlRendered);
  });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  $('#search-input').addEventListener('input', (e) => {
    renderSearchResults(e.target.value);
  });
  $('#search-input').addEventListener('focus', () => ensureStockIndex());

  $('#btn-back').addEventListener('click', goHome);

  $('#btn-star').addEventListener('click', onStarClick);
  $('#btn-prev').addEventListener('click', () => stepStock(-1));
  $('#kl-ma-btn').addEventListener('click', openMaSettings);
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
      klineFull = true;
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
    const k0 = { inst: 'showInst', bband: 'showBBand', margin: 'showMargin', hold: 'showHolding', ma: 'showMaExtra', main: 'showMain' }[btn.dataset.layer];
    btn.classList.toggle('active', !!klineOpts[k0]);
    btn.addEventListener('click', () => {
      const key = { inst: 'showInst', bband: 'showBBand', margin: 'showMargin', hold: 'showHolding', ma: 'showMaExtra', main: 'showMain' }[btn.dataset.layer];
      klineOpts[key] = !klineOpts[key];
      btn.classList.toggle('active', klineOpts[key]);
      if (key === 'showMain') localStorage.setItem('kl_main', klineOpts[key] ? '1' : '0');
      if (key === 'showMargin') localStorage.setItem('kl_margin', klineOpts[key] ? '1' : '0');
      if (key === 'showHolding') localStorage.setItem('kl_hold', klineOpts[key] ? '1' : '0');
      redrawKline();
      if ((key === 'showMargin' || key === 'showHolding' || key === 'showMain') && klineOpts[key] && currentStock && klineInterval === '1d') klineLoadLayers(currentStock, null);
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
  $$('#inst-who .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#inst-who .range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      instWho = btn.dataset.who;
      loadInstitutional();
    });
  });

  $('#btn-save-eps').addEventListener('click', async () => {
    if (!currentStock) return;
    const a = $('#eps-2026-input').value.trim();
    const b = $('#eps-2027-input').value.trim();
    $('#eps-status').textContent = '儲存中…';
    try {
      // 空白 = 清除（原本空白會被後端略過、舊數字留著卻顯示「已儲存」）
      await Backend.upsert(currentStock, {
        epsYear: epsYearShown,
        epsA: a === '' ? null : Number(a),
        epsB: b === '' ? null : Number(b),
      });
      // 2026-10-14 修：原本先寫「已儲存」再重新讀取，重新讀取一開始就清空狀態 → 使用者看不到「已儲存」
      await loadEpsEstimate();
      if (!$('#eps-status').textContent) $('#eps-status').textContent = '已儲存';
    } catch (e) {
      $('#eps-status').textContent = `儲存失敗：${e.message}`;
    }
  });

  $('#btn-settings').addEventListener('click', () => {
    $('#token-input').value = localStorage.getItem('finmind_token') || '';
    $('#backend-token-input').value = localStorage.getItem('backend_token') || '';
    $('#settings-panel').classList.add('active');
  });
  $('#btn-settings-close').addEventListener('click', () => {
    $('#settings-panel').classList.remove('active');
  });
  $('#btn-save-token').addEventListener('click', async () => {
    localStorage.setItem('finmind_token', $('#token-input').value.trim());
    const bt = $('#backend-token-input').value.trim();
    const prevBt = localStorage.getItem('backend_token') || '';
    if (bt !== prevBt) {
      if (bt) {  // 先確認密碼對不對（錯的話後端回 401）
        try {
          const r = await (await fetch(`?action=groups&token=${encodeURIComponent(bt)}`)).json();
          if (r.status === 401) { alert('後端寫入密碼不正確，沒有儲存。'); return; }
        } catch (e) { console.warn('token check failed', e); }
      }
      // 訪客 ⇄ 擁有者：本機清單換掉（擁有者從後端重新同步；登出的裝置不留擁有者資料）
      wipeOwnerLocal();
      if (bt) localStorage.setItem('backend_token', bt); else { localStorage.removeItem('backend_token'); localStorage.setItem('guest_v1', '1'); }
      location.reload();
      return;
    }
    $('#settings-panel').classList.remove('active');
  });

  $('#btn-anchors-parse').addEventListener('click', async () => {
    const items = parseAnchorsReport($('#anchors-input').value);
    anchorsPending = items;
    $('#anchors-status').textContent = '';
    if (!items.length) {
      $('#anchors-preview').textContent = '沒有找到「名稱(代號)…YYYY/YYYY年EPS約A/B元」格式的標的，請確認貼的是完整週報內容。';
      $('#btn-anchors-apply').style.display = 'none';
      return;
    }
    await ensureStockIndex();
    const have = new Set(getWatchlist().map(s => s.stock_id));
    let Y = 2026;
    try { Y = await backendEpsYear(); } catch (e) {}
    anchorsYear = Y;
    const newest = Math.max(...items.map(i => i.year));
    const rows = items.map(i => {
      const tag = i.year < Y ? '<span class="down">略過（舊年度）</span>' : have.has(i.stock_id) ? '更新' : '<b>新增</b>';
      return `${tag}　${i.stock_name}（${i.stock_id}）　${i.year}/${i.year + 1} EPS ${i.epsA} / ${i.epsB}`;
    });
    let head = '';
    if (newest > Y) {
      // 定錨已改用下一組年度 → 先問要不要切換（E 欄搬到 D 欄、年份 +1；後端會先備份工作表）
      head = `<b class="up">定錨週報已改用 ${newest}/${newest + 1} 年，App 目前是 ${Y}/${Y + 1} 年。</b><br>` +
        `按「切換年度並匯入」會：${Y + 1} 年 EPS 搬到第一欄、第二欄改放 ${Y + 2} 年（試算表會先自動備份）。<br><br>`;
      $('#btn-anchors-apply').textContent = `切換到 ${Y + 1}/${Y + 2} 年並匯入`;
    } else {
      $('#btn-anchors-apply').textContent = '確認匯入';
    }
    anchorsRollTo = newest > Y ? Y + 1 : null;
    $('#anchors-preview').innerHTML = head + rows.join('<br>');
    $('#btn-anchors-apply').style.display = '';
  });

  $('#btn-anchors-apply').addEventListener('click', async () => {
    if (!anchorsPending.length) return;
    $('#anchors-status').textContent = '寫入中…';
    try {
      let Y = anchorsYear;
      if (anchorsRollTo) {
        if (!confirm(`確定把 EPS 年度從 ${Y}/${Y + 1} 切換到 ${anchorsRollTo}/${anchorsRollTo + 1}？\n（試算表會先備份；一年只需做一次）`)) { $('#anchors-status').textContent = ''; return; }
        const r = await Backend.epsRollover(anchorsRollTo);
        Y = r.result.epsYear;
        BK.drop('list');
      }
      const res = await applyAnchorsItems(anchorsPending, Y);
      const ok = (res.results || []).filter(r => r.ok).length;
      $('#anchors-status').textContent = `已處理 ${ok} 檔（新增或更新 ${Y}/${Y + 1} EPS）`;
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
