// 定錨週報匯入、自選清單匯入。從 app.js 拆出（2026-09-29）。

// ---- 定錨週報匯入 ----
// A stock block looks like "1. 台表科(6278)：...定錨預估，2026/2027年EPS約11.72/18.11元".
// 也接受「2026/2027年財測EPS維持20.0~22.0/46.0~48.0元」這種區間寫法 → 取中間值（使用者指定）。
// Only blocks with such a 2026/2027 EPS pair are picked up.
const ANCHORS_NUM = '[\\-−]?[0-9]+(?:\\.[0-9]+)?';
const ANCHORS_VAL = `(${ANCHORS_NUM}(?:\\s*[~～]\\s*${ANCHORS_NUM})?)`;
// 年份不寫死：抓「YYYY/YYYY 年…EPS…」裡的兩個年份（2026-10-03 起；定錨明年會改成 2027/2028）
const ANCHORS_EPS_RE = new RegExp(`(20\\d\\d)\\s*\\/\\s*(20\\d\\d)\\s*年?[^0-9\\n]{0,6}?EPS[^0-9\\-−]{0,8}${ANCHORS_VAL}\\s*\\/\\s*${ANCHORS_VAL}`);
function anchorsMid(s) {
  const p = String(s).replace(/−/g, '-').split(/\s*[~～]\s*/).map(parseFloat);
  return p.length === 2 ? Math.round((p[0] + p[1]) / 2 * 100) / 100 : p[0];
}
function parseAnchorsReport(text) {
  const end = text.indexOf('\n留言');
  if (end > 0) text = text.slice(0, end);
  const headRe = /(?:^|\n)\s*\d+\.\s*([^\s()（）:：]{1,12})[(（](\d{4,6})[)）][：:]/g;
  const heads = [];
  let m;
  while ((m = headRe.exec(text))) heads.push({ name: m[1], id: m[2], start: m.index + m[0].length });
  const items = [];
  heads.forEach((h, i) => {
    const block = text.slice(h.start, i + 1 < heads.length ? heads[i + 1].start : text.length);
    const e = ANCHORS_EPS_RE.exec(block);
    if (!e || Number(e[2]) !== Number(e[1]) + 1) return;
    items.push({
      stock_id: h.id, stock_name: h.name,
      year: Number(e[1]), epsA: anchorsMid(e[3]), epsB: anchorsMid(e[4]),
    });
  });
  return items;
}

let anchorsPending = [];
let anchorsYear = 2026;    // 後端目前 EPS 第一年
let anchorsRollTo = null;  // 週報是新年度時要切換到的年份

// 後端目前的 EPS 第一年（清單每列都帶 epsYear；舊後端沒有就當 2026）
async function backendEpsYear() {
  const list = await Backend.list();
  const y = list.length && list[0].epsYear;
  return Number(y) || 2026;
}

// items: [{stock_id, stock_name, year, epsA, epsB}]，year 必須等於後端的 epsYear（呼叫前先處理年度切換）
async function applyAnchorsItems(items, epsYear) {
  await ensureStockIndex();
  const byId = new Map(stockIndex.map(s => [s.stock_id, s]));
  const list = getWatchlist();
  const have = new Set(list.map(s => s.stock_id));
  const payload = [];
  const added = [];
  for (const it of items) {
    if (it.year !== epsYear) continue;  // 舊年度的週報不寫（避免寫錯欄）
    const info = byId.get(it.stock_id);
    const name = info ? info.stock_name : it.stock_name;
    if (!have.has(it.stock_id)) {
      list.push({ stock_id: it.stock_id, stock_name: name });
      activeGroup().ids.push(it.stock_id);
      have.add(it.stock_id);
      added.push(it.stock_id);
      pendSet('add', it.stock_id, true);
    }
    payload.push({
      stock_id: it.stock_id, stock_name: name, market: marketFor(it.stock_id),
      epsYear, epsA: it.epsA, epsB: it.epsB,
    });
  }
  setWatchlist(list);
  saveGroups();
  const res = payload.length ? await Backend.bulkUpsert(payload) : { results: [] };
  added.forEach(id => pendSet('add', id, false));
  return res;
}

// ---- Import watchlist ----
async function importWatchlist(raw) {
  await ensureStockIndex();
  const codes = raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
  const byId = new Map(stockIndex.map(s => [s.stock_id, s]));
  const list = getWatchlist();
  const existingIds = new Set(list.map(s => s.stock_id));
  let added = 0;
  const notFound = [];
  const newStocks = [];
  for (const code of codes) {
    if (existingIds.has(code)) continue;
    const stock = byId.get(code);
    if (!stock) { notFound.push(code); continue; }
    list.push({ stock_id: stock.stock_id, stock_name: stock.stock_name });
    newStocks.push(stock);
    existingIds.add(code);
    added++;
  }
  setWatchlist(list);
  activeGroup().ids.push(...newStocks.map(s => s.stock_id));
  saveGroups();
  if (newStocks.length) {
    newStocks.forEach(s => pendSet('add', s.stock_id, true));
    Backend.bulkUpsert(newStocks.map(s => ({
      stock_id: s.stock_id, stock_name: s.stock_name, market: marketFor(s.stock_id),
    }))).then(() => newStocks.forEach(s => pendSet('add', s.stock_id, false)))
      .catch(e => { console.warn('backend bulkUpsert failed', e); toastWarn(e); });
  }
  return { added, total: codes.length, notFound };
}

