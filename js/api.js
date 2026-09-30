// FinMind API wrapper with localStorage caching
const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4/data';

function getToken() {
  return localStorage.getItem('finmind_token') || '';
}

function cacheKey(dataset, params) {
  return `fm_${dataset}_${JSON.stringify(params)}`;
}

// Persistent cache (localStorage) keyed WITHOUT start_date, so the same stock's data is
// reused across days / app restarts. Entries younger than ttl are served without calling
// FinMind; older entries are still used as a fallback when FinMind fails or is over quota.
function stableKey(dataset, params) {
  const p = Object.assign({}, params); delete p.start_date;
  return `fmfb_${dataset}_${JSON.stringify(p)}`;
}
function readStore(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function writeStore(key, data, startDate) {
  const val = JSON.stringify({ t: Date.now(), s: startDate || '', data });
  try { localStorage.setItem(key, val); return; } catch (e) {}
  // Storage full: drop the oldest half of FinMind entries and retry once.
  try {
    const ents = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('fmfb_')) { const v = readStore(k); ents.push([k, v ? v.t : 0]); }
    }
    ents.sort((x, y) => x[1] - y[1]).slice(0, Math.ceil(ents.length / 2)).forEach(([k]) => localStorage.removeItem(k));
    localStorage.setItem(key, val);
  } catch (e) {}
}

function sliceFrom(data, startDate) {
  return startDate ? data.filter(r => !r.date || r.date >= startDate) : data;
}

async function finmindGet(dataset, params = {}, { ttlMs = 10 * 60 * 1000, force = false } = {}) {
  const key = stableKey(dataset, params);
  const stored = readStore(key);
  // Fresh enough and covers the requested date range -> no FinMind call at all.
  const covers = stored && (!params.start_date || !stored.s || stored.s <= params.start_date);
  if (!force && stored && covers && Date.now() - stored.t < ttlMs) return sliceFrom(stored.data, params.start_date);

  const url = new URL(FINMIND_BASE);
  url.searchParams.set('dataset', dataset);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(url.toString(), { headers });
    if (res.status === 402 || res.status === 429) throw new Error('FinMind 本小時額度已用完');
    if (!res.ok) throw new Error(`FinMind HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== 200) throw new Error(/limit|upper/i.test(json.msg || '') ? 'FinMind 本小時額度已用完' : (json.msg || 'FinMind error'));
    writeStore(key, json.data, params.start_date);
    return json.data;
  } catch (err) {
    // Quota exhausted or network hiccup — use the last known-good copy if we have one.
    if (stored) {
      console.warn(`FinMind fetch failed (${err.message}), using cached copy for ${dataset}`);
      return sliceFrom(stored.data, params.start_date);
    }
    throw err;
  }
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return fmtDate(d);
}

const Api = {
  async stockList() {
    const cached = localStorage.getItem('fm_stock_info');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.t < 7 * 24 * 60 * 60 * 1000) return parsed.data;
      } catch (e) {}
    }
    const data = await finmindGet('TaiwanStockInfo', {}, { ttlMs: 0 });
    const map = new Map();
    for (const row of data) {
      if (row.type !== 'twse' && row.type !== 'tpex') continue;
      map.set(row.stock_id, row); // later rows overwrite -> latest info
    }
    const list = Array.from(map.values());
    try {
      localStorage.setItem('fm_stock_info', JSON.stringify({ t: Date.now(), data: list }));
    } catch (e) {}
    return list;
  },

  // 日K：先走 Apps Script -> Yahoo（不耗 FinMind 額度），失敗才用 FinMind。
  async daily(stock, days = 240) {
    const key = `yd_${stock.stock_id}_${days}`;
    try {
      const c = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (c && Date.now() - c.t < (twMarketOpen() ? 60 * 1000 : 10 * 60 * 1000) && !twCrossedSession(c.t)) return c.data;
    } catch (e) {}
    try {
      const rows = await withTodayBar(stock, await Backend.daily(stock, days));
      if (rows.length) {
        try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), data: rows })); } catch (e) {}
        return rows;
      }
    } catch (e) { console.warn('daily via backend failed, falling back to FinMind', e); }
    return Api.price(stock.stock_id, days);
  },

  async price(stockId, days = 240) {
    return finmindGet('TaiwanStockPrice', {
      data_id: stockId,
      start_date: daysAgo(days),
    }, { ttlMs: 15 * 60 * 1000 });
  },

  async institutional(stockId, days = 90) {
    return finmindGet('TaiwanStockInstitutionalInvestorsBuySell', {
      data_id: stockId,
      start_date: daysAgo(days),
    }, { ttlMs: 60 * 60 * 1000 }); // 法人盤後每日一次
  },

  // 融資融券（每日盤後，單位：張）
  async margin(stockId, days = 180) {
    return finmindGet('TaiwanStockMarginPurchaseShortSale', {
      data_id: stockId,
      start_date: daysAgo(days),
    }, { ttlMs: 60 * 60 * 1000 });
  },

  async monthRevenue(stockId, months = 36) {
    return finmindGet('TaiwanStockMonthRevenue', {
      data_id: stockId,
      start_date: daysAgo(months * 31),
    }, { ttlMs: 12 * 60 * 60 * 1000 }); // 月營收每月公布一次，半天更新即可
  },

  async financials(stockId, years = 3) {
    return finmindGet('TaiwanStockFinancialStatements', {
      data_id: stockId,
      start_date: daysAgo(years * 366),
    }, { ttlMs: 24 * 60 * 60 * 1000 }); // 季報，一天更新一次
  },

  async holdingSharesPer(stockId, weeks = 52) {
    return finmindGet('TaiwanStockHoldingSharesPer', {
      data_id: stockId,
      start_date: daysAgo(weeks * 7),
    }, { ttlMs: 60 * 60 * 1000 });
  },
};

// Yahoo 的日K在當天（甚至收盤後好幾個小時）最後一根的 close 是 null，會被濾掉 → 日K少了今天。
// 用當日 1 分K（即時走勢，同一來源、已有快取）組出這一根補上：開=第一筆、高低=極值、收=最後一筆、量=加總。
async function withTodayBar(stock, rows) {
  if (!rows.length) return rows;
  let intra;
  try { intra = await Backend.intraday(stock); } catch (e) { return rows; }
  const bars = (intra && intra.bars) || [];
  if (!bars.length) return rows;
  const off = intra.gmtoffset || 28800;
  const day = new Date((bars[bars.length - 1].t + off) * 1000).toISOString().slice(0, 10);
  if (rows[rows.length - 1].date >= day) return rows;
  const today = bars.filter(b => new Date((b.t + off) * 1000).toISOString().slice(0, 10) === day);
  if (!today.length) return rows;
  // 量：1 分K 加總會漏掉收盤集合競價等，約只有實際的一半 → 有當天的即時報價（證交所累計量，單位張）就用它
  let vol = today.reduce((a, b) => a + (b.vol || 0), 0);
  let q = null;
  try { q = await Backend.quote([stock]); } catch (e) {}
  q = q && q[stock.stock_id];
  if (q && q.vol && q.date === day.replace(/-/g, '')) vol = q.vol * 1000;
  return rows.concat([{
    date: day, stock_id: stock.stock_id,
    open: today[0].open,
    max: Math.max(...today.map(b => b.high)),
    min: Math.min(...today.map(b => b.low)),
    close: today[today.length - 1].close,
    Trading_Volume: vol,
  }]);
}

// HoldingSharesLevel looks like "1,000,001以上" / "400,001-600,000" — pull out
// the lower bound so we can pick the big-holder tier without hardcoding the
// exact Chinese label. >=1,000,000 shares == >=1,000 lots (千張大戶).
function holdingLevelLowerBound(level) {
  const m = String(level || '').replace(/,/g, '').match(/\d+/);
  return m ? Number(m[0]) : NaN;
}

// Collapses TaiwanStockHoldingSharesPer rows into a per-date big-holder % series.
function bigHolderSeries(rows) {
  const byDate = new Map();
  for (const r of rows) {
    const lower = holdingLevelLowerBound(r.HoldingSharesLevel);
    if (!(lower >= 1000000)) continue;
    byDate.set(r.date, (byDate.get(r.date) || 0) + Number(r.percent || 0));
  }
  return Array.from(byDate.keys()).sort().map(date => ({ date, percent: byDate.get(date) }));
}
