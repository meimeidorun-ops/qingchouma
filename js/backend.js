// Wrapper around the Google Apps Script Web App that backs the shared
// watchlist + EPS estimates (bound to the "定錨筆記本" Google Sheet).
// This is also what 台股AI盯盤Agent polls to know what to monitor.

const BACKEND_DEFAULT_URL = 'https://script.google.com/macros/s/AKfycbzACbmPhOULGdJf2l60zeTGOKrPX9PtjAUvOf1xn8aAEQ1yV1FSyXhLt6yxkOprZTzt/exec';
// 寫入密碼（token）不再寫在程式裡（網頁與 GitHub repo 是公開的）：每台裝置在「設定」輸入一次，存在本機。
function backendUrl() {
  return localStorage.getItem('backend_url') || BACKEND_DEFAULT_URL;
}
// 有寫入密碼＝擁有者（同步後端清單）；沒有＝訪客（清單只存在這台裝置，看不到擁有者的清單/EPS/評分/持股）
function isOwner() { return !!localStorage.getItem('backend_token'); }
function tokenQs() { return '&token=' + encodeURIComponent(localStorage.getItem('backend_token') || ''); }
function backendToken() {
  const t = localStorage.getItem('backend_token') || '';
  if (!t) throw new Error('尚未設定後端寫入密碼（請到 ⚙ 設定填一次）');
  return t;
}
// 寫入類 API 的回應要檢查 status（原本沒檢查：密碼錯也顯示「已儲存」）
async function writeJson(res) {
  const j = await res.json();
  if (j.status === 401) throw new Error('後端寫入密碼不正確（請到 ⚙ 設定重新填）');
  if (j.status !== 200) throw new Error(j.error || (j.result && j.result.error) || '後端寫入失敗');
  if (Array.isArray(j.results)) {
    const bad = j.results.find(r => r && r.ok === false);
    if (bad) throw new Error(bad.error || '部分寫入失敗');
  }
  return j;
}

// 快速後端（Netlify Function，functions/api.js）：報價、K線、走勢、分點、收盤價先走這裡（通常 < 1 秒），
// 失敗或逾時才改走 Apps Script。本機測試（localhost）時直接呼叫線上網站的 Function。
const FAST_URL = (/netlify\.app$/.test(location.hostname) ? '' : 'https://earnest-kashata-c95e54.netlify.app') + '/.netlify/functions/api';
async function proxyGet(qs) {
  if (localStorage.getItem('fast_off') !== '1') {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const json = await (await fetch(`${FAST_URL}?${qs}`, { signal: ctl.signal })).json();
      if (json.status === 200 && json.data && !json.data.__error) return json;
      console.warn('fast backend error, fallback to Apps Script', json.error);
    } catch (e) {
      console.warn('fast backend failed, fallback to Apps Script', e);
    } finally {
      clearTimeout(timer);
    }
  }
  return gasGet(qs);
}

// ---- 鉅亨網（cnyes）行情 API：手機直接抓（有 CORS `*`），不經 Google / Netlify，通常 < 0.3 秒 ----
// 2026-10-02 起報價、即時走勢、日K 優先走這裡；失敗才退回原本的路線。上市/上櫃/ETF 都用 TWS:代號:STOCK；興櫃沒有。
// 量的單位是「張」，App 其他地方用「股」，所以 ×1000。（非官方公開 API，對方改版可能失效 → 有備援）
const CNYES = 'https://ws.api.cnyes.com/ws/api';
const cnyesSym = id => `TWS:${id}:STOCK`;
async function cnyesGet(path, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const j = await (await fetch(CNYES + path, { signal: ctl.signal })).json();
    if (j.statusCode !== 200) throw new Error('cnyes ' + (j.message || j.statusCode));
    return j.data;
  } finally {
    clearTimeout(timer);
  }
}
const twTime = sec => { const s = new Date((sec + 28800) * 1000).toISOString(); return { date: s.slice(0, 10), ymd: s.slice(0, 10).replace(/-/g, ''), hms: s.slice(11, 19) }; };
async function cnyesQuotes(stocks) {
  const ids = [...new Set(stocks.map(s => s.stock_id))];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const out = {};
  await Promise.all(chunks.map(async c => {
    const data = await cnyesGet('/v2/quote/quotes/' + c.map(cnyesSym).join(','));
    for (const d of data || []) {
      const id = d['200010'];
      if (!id || d['6'] == null) continue;
      const t = twTime(d['200007']);
      out[id] = {
        price: d['6'], prevClose: d['21'], change: d['11'], changePercent: d['56'],
        open: d['19'], high: d['12'], low: d['13'], vol: d['200013'],
        date: t.ymd, time: t.hms, name: d['200009'], src: 'cnyes',
      };
    }
  }));
  return out;
}
// 歷史 K：cnyes 回傳由新到舊的平行陣列 {t,o,h,l,c,v}；轉成由舊到新
function cnyesRows(d) {
  const rows = [];
  for (let i = (d.t || []).length - 1; i >= 0; i--) {
    if (d.c[i] == null || d.o[i] == null) continue;
    rows.push({ t: d.t[i], o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: (d.v[i] || 0) * 1000 });
  }
  return rows;
}
async function cnyesIntraday(stockId) {
  const now = Math.floor(Date.now() / 1000);
  const d = await cnyesGet(`/v1/charting/history?resolution=1&symbol=${cnyesSym(stockId)}&from=${now}&to=${now - 86400 * 6}&quote=1`);
  const bars = cnyesRows(d).map(r => ({ t: r.t, open: r.o, high: r.h, low: r.l, close: r.c, vol: r.v }));
  if (!bars.length) throw new Error('cnyes intraday empty');
  return { gmtoffset: 28800, prevClose: (d.quote && d.quote['21']) || null, bars };
}
async function cnyesDaily(stock, days) {
  const now = Math.floor(Date.now() / 1000);
  const d = await cnyesGet(`/v1/charting/history?resolution=D&symbol=${cnyesSym(stock.stock_id)}&from=${now}&to=${now - 86400 * (days + 10)}`);
  const since = daysAgo(days);
  const rows = cnyesRows(d).map(r => ({
    date: twTime(r.t).date, stock_id: stock.stock_id, open: r.o, max: r.h, min: r.l, close: r.c, Trading_Volume: r.v,
  })).filter(r => r.date >= since);
  if (!rows.length) throw new Error('cnyes daily empty');
  return rows;
}

// Apps Script 偶爾（尤其同時多個請求時）回一頁 404 HTML，重試一次通常就好。
async function gasGet(qs) {
  for (let i = 0; ; i++) {
    try {
      return await (await fetch(`${backendUrl()}?${qs}`)).json();
    } catch (e) {
      if (i >= 1) throw e;
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

function marketFor(stockId) {
  const s = stockIndex.find(x => x.stock_id === stockId);
  if (s && s.type === 'tpex') return 'TWO';
  return 'TPE';
}

const Backend = {
  async list() {
    const json = await gasGet('action=list' + tokenQs());
    if (json.status === 401) throw new Error('後端寫入密碼不正確（請到 ⚙ 設定重新填）');
    if (json.status !== 200) throw new Error(json.error || 'backend error');
    return json.data;
  },

  async upsert(stock, eps = {}) {
    const body = {
      action: 'upsert',
      token: backendToken(),
      stock_id: stock.stock_id,
      stock_name: stock.stock_name,
      market: stock.market || marketFor(stock.stock_id),
    };
    // EPS：{epsYear, epsA, epsB}（第一年年份、第一年、第二年；null = 清空）。後端年度不符會拒絕。
    if (eps.epsYear !== undefined) Object.assign(body, { epsYear: eps.epsYear, epsA: eps.epsA, epsB: eps.epsB });
    const res = await fetch(backendUrl(), { method: 'POST', body: JSON.stringify(body) });
    return writeJson(res);
  },

  async bulkUpsert(items) {
    const res = await fetch(backendUrl(), {
      method: 'POST',
      body: JSON.stringify({ action: 'bulkUpsert', token: backendToken(), items }),
    });
    return writeJson(res);
  },

  async remove(stockId) {
    const res = await fetch(backendUrl(), {
      method: 'POST',
      body: JSON.stringify({ action: 'remove', token: backendToken(), stock_id: stockId }),
    });
    const j = await res.json();
    if (j.status === 401) throw new Error('後端寫入密碼不正確（請到 ⚙ 設定重新填）');
    return j;  // 404（後端本來就沒有）視為已刪除
  },

  // 定錨改用下一組年度時切換：E 欄（第二年）搬到 D 欄、E 欄清空、年份 +1（後端會先備份工作表）
  async epsRollover(toYear) {
    const res = await fetch(backendUrl(), {
      method: 'POST',
      body: JSON.stringify({ action: 'epsRollover', token: backendToken(), toYear }),
    });
    return writeJson(res);
  },

  // Real-time-ish quotes proxied through the Apps Script backend (TWSE/TPEx
  // MIS feed) since FinMind's free tier only has end-of-day prices.
  // `stocks` is an array of {stock_id, market?}. Returns a map keyed by stock_id.
  // Intraday bars ('5m' | '60m') via Apps Script -> Yahoo. Returns rows shaped like
  // FinMind daily rows; `date` is a unix timestamp shifted into Taipei local time
  // so lightweight-charts (which renders UTC) shows the right clock.
  async kbar(stock, interval) {
    const market = stock.market || marketFor(stock.stock_id);
    const json = await proxyGet(`action=kbar&id=${encodeURIComponent(stock.stock_id)}&market=${market}&interval=${interval}`);
    if (json.status !== 200) throw new Error(json.error || 'backend error');
    const { gmtoffset, bars } = json.data;
    return bars.map(([t, o, h, l, c, v]) => ({
      date: t + gmtoffset, open: o, max: h, min: l, close: c, Trading_Volume: v,
    }));
  },

  // Daily bars via Apps Script -> Yahoo (上市/上櫃都有), shaped like FinMind TaiwanStockPrice rows
  // ({date:'YYYY-MM-DD', open, max, min, close, Trading_Volume}). Saves FinMind quota.
  async daily(stock, days = 240) {
    if (localStorage.getItem('cnyes_off') !== '1') {
      try { return await cnyesDaily(stock, days); } catch (e) { console.warn('cnyes daily failed, fallback', e); }
    }
    const range = days <= 25 ? '1mo' : days <= 88 ? '3mo' : days <= 178 ? '6mo' : days <= 360 ? '1y' : days <= 725 ? '2y' : '5y';
    const market = stock.market || marketFor(stock.stock_id);
    const json = await proxyGet(`action=kbar&id=${encodeURIComponent(stock.stock_id)}&market=${market}&interval=1d&range=${range}`);
    if (json.status !== 200) throw new Error(json.error || 'backend error');
    const { gmtoffset, bars } = json.data;
    const since = daysAgo(days);
    return bars.map(([t, o, h, l, c, v]) => ({
      date: new Date((t + gmtoffset) * 1000).toISOString().slice(0, 10),
      stock_id: stock.stock_id, open: o, max: h, min: l, close: c, Trading_Volume: v,
    })).filter(r => r.date >= since);
  },

  // 分點進出（主力進出前 15 名）。period: 1=近1日 2=近5日 3=近10日 4=近20日。
  async branch(stockId, period = 1) {
    const qs = `action=branch&id=${encodeURIComponent(stockId)}&period=${period}`;
    let json = await proxyGet(qs);
    // 快速後端（Netlify，額度用完暫時無法更新）回的是舊格式：bid 其實是總公司代號、沒有 bhid → 改問 Apps Script（21 版起已修正）
    const first = json.status === 200 && json.data && ((json.data.buy || [])[0] || (json.data.sell || [])[0]);
    if (first && first.bhid === undefined) json = await gasGet(qs);
    if (json.status !== 200) throw new Error(json.error || 'backend error');
    if (json.data && json.data.error) throw new Error(json.data.error);
    return json.data;
  },

  // 單一分點（b=分點代號、bhid=總公司代號）在這檔股票的近期每日進出。Returns {rows:[{date,buy,sell,net}], total}
  async branchHist(stockId, b, bhid) {
    const json = await gasGet(`action=branchHist&id=${encodeURIComponent(stockId)}&b=${encodeURIComponent(b)}&bhid=${encodeURIComponent(bhid || b)}`);
    if (json.status !== 200 || (json.data && json.data.error)) throw new Error(json.error || (json.data && json.data.error) || 'backend error');
    return json.data;
  },

  // 自選股評分＋訊號（Apps Script 算好、快取 30 分鐘）。Returns {asOf, instDates, items:[{id,name,score,parts,pe,yoy,signals,...}]}
  async scores() {
    const json = await gasGet('action=scores' + tokenQs());
    if (json.status === 401) throw new Error('後端寫入密碼不正確（請到 ⚙ 設定重新填）');
    if (json.status !== 200) throw new Error(json.error || 'backend error');
    return json.data;
  },

  // 單一分點近期買超／賣超哪些股票（period 1=近1日、5=近5日）。Returns {date, buy:[{id,name,buy,sell,net}], sell:[...]}
  async branchTop(b, bhid, period = 1) {
    const json = await gasGet(`action=branchTop&b=${encodeURIComponent(b)}&bhid=${encodeURIComponent(bhid || b)}&period=${period}`);
    if (json.status !== 200 || (json.data && json.data.error)) throw new Error(json.error || (json.data && json.data.error) || 'backend error');
    return json.data;
  },

  // Latest official close for many stocks in ONE request (TWSE + TPEx OpenAPI via Apps Script).
  // Returns { id: {close, change, date, market} }.
  async closeAll(ids) {
    if (!ids.length) return {};
    const json = await proxyGet(`action=closeAll&ids=${encodeURIComponent(ids.join(','))}`);
    if (json.status !== 200) throw new Error(json.error || 'backend error');
    return json.data || {};
  },

  // Today's 1-minute bars via Apps Script -> Yahoo. `t` is a raw unix second.
  async intraday(stock) {
    if (localStorage.getItem('cnyes_off') !== '1') {
      try { return await cnyesIntraday(stock.stock_id); } catch (e) { console.warn('cnyes intraday failed, fallback', e); }
    }
    const market = stock.market || marketFor(stock.stock_id);
    const json = await proxyGet(`action=intraday&id=${encodeURIComponent(stock.stock_id)}&market=${market}`);
    if (json.status !== 200) throw new Error(json.error || 'backend error');
    const { gmtoffset, prevClose, bars } = json.data;
    return {
      gmtoffset, prevClose,
      bars: bars.map(([t, o, h, l, c, v]) => ({ t, open: o, high: h, low: l, close: c, vol: v })),
    };
  },

  // Watchlist group layout ({groups:[{id,name,ids}]}) shared across devices.
  async getGroups() {
    const json = await gasGet('action=groups' + tokenQs());
    if (json.status === 401) throw new Error('後端寫入密碼不正確（請到 ⚙ 設定重新填）');
    if (json.status !== 200) throw new Error(json.error || 'backend error');
    return json.data;
  },

  async setGroups(groups) {
    const data = encodeURIComponent(JSON.stringify({ groups }));
    const res = await fetch(`${backendUrl()}?action=setGroups&token=${encodeURIComponent(backendToken())}&data=${data}`);
    return writeJson(res);
  },

  // Weekly 集保股權分散表 (TDCC) via Apps Script. Returns [{d:'YYYYMMDD', pct:[15], ppl:[15]}] ascending.
  // 快取在下方 wrapBackendWithCache（集保每週才更新一次：12 小時內直接用，舊的也先顯示再背景更新）。
  async holders(stockId, weeks = 26) {
    const json = await gasGet(`action=holders&id=${encodeURIComponent(stockId)}&weeks=${weeks}`);
    if (json.status !== 200) throw new Error(json.error || 'backend error');
    return json.data.weeks;
  },

  async quote(stocks) {
    if (!stocks.length) return {};
    // 先問鉅亨（手機直連、最快）；拿到大部分（≥70%，興櫃本來就沒有）就直接用。
    let cnyesStale = null;  // 鉅亨有資料但延遲：先改問證交所，都抓不到才用它
    if (localStorage.getItem('cnyes_off') !== '1') {
      try {
        const c = await cnyesQuotes(stocks);
        const n = Object.keys(c).length;
        if (n && n >= Math.ceil(stocks.length * 0.7)) {
          noteMarketClosed(c);
          const lag = quoteLagMin(c);
          if (lag == null || lag <= 3) {
            Backend.quoteDiag = { cnyes: '鉅亨', gas: '—', fast: '—', at: Date.now() };
            return c;
          }
          // 2026-10-07：盤中最新成交時間比現在慢 3 分鐘以上 → 鉅亨延遲，改用證交所 MIS（Google / 快速後端）
          cnyesStale = c;
          Backend.quoteDiag = { cnyes: `延遲 ${lag} 分` };
          throw new Error('cnyes delayed');
        }
        Backend.quoteDiag = { cnyes: `只拿到 ${n}/${stocks.length}` };
      } catch (e) {
        if (!cnyesStale) Backend.quoteDiag = { cnyes: e && e.name === 'AbortError' ? '逾時' : '失敗' };
        console.warn('cnyes quote failed, fallback', e);
      }
    }
    const cnyesState = (Backend.quoteDiag || {}).cnyes || '關閉';
    const ids = stocks.map(s => `${s.market || marketFor(s.stock_id)}:${s.stock_id}`).join(',');
    // 即時報價：Apps Script 和快速後端同時問。證交所 MIS（最即時）海外主機常連不上，所以：
    // 誰先回「MIS 資料」就用誰；快速後端只拿到 Yahoo 時，再等 Apps Script 最多 3 秒，等不到就用 Yahoo。
    // 舊版 Apps Script（沒有 date 欄位）沒成交時會回開盤價，不採用。
    const qs = `action=quote&ids=${encodeURIComponent(ids)}`;
    const timed = (url, ms) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms);
      return fetch(url, { signal: ctl.signal }).then(r => r.json()).finally(() => clearTimeout(timer));
    };
    const good = j => {
      const vals = j && j.status === 200 && j.data && !j.data.__error ? Object.values(j.data) : [];
      return vals.length && vals.some(v => v && v.date) ? j.data : null;
    };
    // 診斷：記下兩個來源各自的結果（ok-證交所 / ok-Yahoo / 逾時 / 錯誤），清單上方會顯示，出問題時看得出是哪一段壞。
    const diag = { cnyes: cnyesState, gas: '…', fast: '…', at: Date.now() };
    Backend.quoteDiag = diag;
    const isMis = d => d && Object.values(d).some(v => v && v.src !== 'yahoo');
    const label = (key, p) => p.then(j => {
      const d = good(j);
      diag[key] = d ? (isMis(d) ? '證交所' : 'Yahoo') : (j && j.data && j.data.__error ? '抓不到' : '無資料');
      return d;
    }).catch(e => { diag[key] = e && e.name === 'AbortError' ? '逾時' : '連線失敗'; return null; });
    // Apps Script 在試算表重算或同時多個請求時可能要 20 秒以上，等久一點（期間畫面先顯示手機裡的報價）。
    const gas = label('gas', timed(`${backendUrl()}?${qs}`, 25000));
    const fast = localStorage.getItem('fast_off') === '1' ? (diag.fast = '關閉', Promise.resolve(null))
      : label('fast', timed(`${FAST_URL}?${qs}`, 15000));
    const data = await new Promise(resolve => {
      let pending = 2, yahoo = null, waitTimer = null;
      const done = d => { clearTimeout(waitTimer); resolve(d); };
      const settle = d => {
        pending--;
        if (isMis(d)) return done(d);
        if (d) {
          yahoo = d;
          if (!waitTimer) waitTimer = setTimeout(() => done(yahoo), 3000);
        }
        if (!pending) done(yahoo);
      };
      gas.then(settle);
      fast.then(settle);
    });
    if (!data && cnyesStale) return cnyesStale;  // 證交所也抓不到 → 用延遲的鉅亨（畫面會標示延遲）
    if (!data) throw new Error(`quote unavailable (Google:${diag.gas} 快速:${diag.fast})`);
    return data;
  },
};

// ---- 讀取加速：本機快取（stale-while-revalidate）----
// Apps Script 每次回應約 1～10 秒，所以後端讀取一律先看手機裡的快取：
// 夠新就直接用；舊了就去抓新的，但超過 raceMs 還沒回來就先顯示舊資料，新資料回來後存起來下次用。
const BK = {
  read(k) { try { return JSON.parse(localStorage.getItem('bk_' + k) || 'null'); } catch (e) { return null; } },
  write(k, d) {
    const v = JSON.stringify({ t: Date.now(), d });
    try { localStorage.setItem('bk_' + k, v); } catch (e) {
      try { Object.keys(localStorage).filter(x => x.startsWith('bk_')).forEach(x => localStorage.removeItem(x)); localStorage.setItem('bk_' + k, v); } catch (e2) {}
    }
  },
  drop(prefix) { try { Object.keys(localStorage).filter(x => x.startsWith('bk_' + prefix)).forEach(x => localStorage.removeItem(x)); } catch (e) {} },
};
function bkHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
// 先顯示了舊資料、新資料晚點才回來時，發出 'bk-fresh' 事件（detail = key），畫面可以馬上換成新的。
function swr(key, ttlMs, raceMs, fetcher) {
  const c = BK.read(key);
  if (c && Date.now() - c.t < ttlMs && !twCrossedSession(c.t)) return Promise.resolve(c.d);
  let servedStale = false;
  const p = fetcher().then(d => {
    BK.write(key, d);
    if (servedStale) window.dispatchEvent(new CustomEvent('bk-fresh', { detail: key }));
    return d;
  });
  if (!c) return p;
  p.catch(() => {});
  return Promise.race([p, new Promise(r => setTimeout(() => { servedStale = true; r(c.d); }, raceMs))]).catch(() => c.d);
}
// 台股盤中（週一～五 09:00～13:35 台北時間）資料變動快，快取時間縮短。
function twMarketOpen() {
  const n = new Date(Date.now() + 8 * 3600e3);
  const d = n.getUTCDay(), m = n.getUTCHours() * 60 + n.getUTCMinutes();
  if (!(d >= 1 && d <= 5 && m >= 540 && m <= 815)) return false;
  // 國定假日（例：10/10）：當天 09:15 後報價全都不是今天 → 記下「今天休市」，不再當盤中
  try { if (localStorage.getItem('tw_closed_day') === n.toISOString().slice(0, 10).replace(/-/g, '')) return false; } catch (e) {}
  return true;
}
// 盤中報價延遲幾分鐘：今天最新一筆成交時間 vs 現在（收盤後、非盤中回 null）
function quoteLagMin(quotes) {
  if (!twMarketOpen()) return null;
  const n = new Date(Date.now() + 8 * 3600e3);
  const today = n.toISOString().slice(0, 10).replace(/-/g, '');
  const nowMin = Math.min(n.getUTCHours() * 60 + n.getUTCMinutes(), 810);  // 13:30 之後不算延遲
  const mins = Object.values(quotes || {}).filter(q => q && q.date === today && q.time)
    .map(q => Number(q.time.slice(0, 2)) * 60 + Number(q.time.slice(3, 5)));
  if (!mins.length || nowMin < 545) return null;  // 09:05 前剛開盤，不判斷
  return Math.max(0, nowMin - Math.max(...mins));
}
// 由報價判斷今天是否休市（在 Backend.quote 拿到資料後呼叫）
function noteMarketClosed(quotes) {
  const n = new Date(Date.now() + 8 * 3600e3);
  const today = n.toISOString().slice(0, 10).replace(/-/g, '');
  const m = n.getUTCHours() * 60 + n.getUTCMinutes();
  const vals = Object.values(quotes || {}).filter(q => q && q.date);
  if (!twMarketOpen() || m < 555 || vals.length < 3) return;
  if (!vals.some(q => q.date === today)) { try { localStorage.setItem('tw_closed_day', today); } catch (e) {} }
}
// 快取是在「今天開盤前 / 收盤前」存的，而現在已經過了那個時間點 → 視為過期（避免收盤後還看到盤中價）。
function twCrossedSession(savedAt) {
  const tw = t => new Date(t + 8 * 3600e3);
  const now = tw(Date.now()), then = tw(savedAt);
  const day = x => x.toISOString().slice(0, 10), min = x => x.getUTCHours() * 60 + x.getUTCMinutes();
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return false;
  if (day(then) !== day(now)) return min(now) >= 540;
  return [540, 811].some(b => min(then) < b && min(now) >= b);
}
(function wrapBackendWithCache() {
  const raw = Object.assign({}, Backend);
  const qKey = stocks => 'q_' + bkHash(stocks.map(s => s.stock_id).join(','));
  Backend.quoteKey = qKey;
  const qTtl = () => (twMarketOpen() ? 15e3 : 10 * 60e3);
  Backend.list = () => !isOwner() ? Promise.resolve([]) : swr('list', 60e3, 1500, raw.list);  // 訪客看不到擁有者清單/EPS
  Backend.getGroups = () => !isOwner() ? Promise.resolve(null) : swr('groups', 60e3, 1500, raw.getGroups);
  Backend.quote = stocks => swr(qKey(stocks), qTtl(), 1500, () => raw.quote(stocks));
  Backend.quotePeek = stocks => { const c = BK.read(qKey(stocks)); return c ? c.d : null; };
  // 首頁用：快取夠新就用；否則一定去抓，抓不到要「丟錯」讓畫面知道（不能默默回傳昨天的舊報價——
  // 2026-09-30 中午就是這樣：兩個來源都失敗，swr 悄悄回了前一天存的報價，看起來像停在昨收）。
  Backend.quoteFresh = stocks => {
    const k = qKey(stocks), c = BK.read(k);
    if (c && Date.now() - c.t < qTtl() && !twCrossedSession(c.t)) return Promise.resolve(c.d);
    return raw.quote(stocks).then(d => { BK.write(k, d); return d; });
  };
  Backend.closeAll = ids => swr('ca_' + bkHash(ids.join(',')), 30 * 60e3, 2000, () => raw.closeAll(ids));
  Backend.daily = (stock, days) => swr(`d_${stock.stock_id}_${days}`, twMarketOpen() ? 60e3 : 60 * 60e3, 2000, () => raw.daily(stock, days));
  Backend.kbar = (stock, iv) => swr(`k_${stock.stock_id}_${iv}`, twMarketOpen() ? 60e3 : 60 * 60e3, 2000, () => raw.kbar(stock, iv));
  Backend.intraday = stock => swr(`i_${stock.stock_id}`, twMarketOpen() ? 15e3 : 30 * 60e3, 1500, () => raw.intraday(stock));
  Backend.branch = (id, p) => swr(`b2_${id}_${p}`, 30 * 60e3, 2000, () => raw.branch(id, p));  // b2_：舊快取的分點代號是錯的
  Backend.scores = () => !isOwner() ? Promise.reject(new Error('guest')) : swr('scores', 30 * 60e3, 1500, () => raw.scores());
  Backend.branchTop = (b, bhid, p) => swr(`bt_${b}_${p}`, 30 * 60e3, 3000, () => raw.branchTop(b, bhid, p));
  // 舊版大戶快取（holders_*）已不用，清掉避免佔手機空間
  try { Object.keys(localStorage).filter(k => k.startsWith('holders_')).forEach(k => localStorage.removeItem(k)); } catch (e) {}
  Backend.holders = (id, w = 26) => swr(`h_${id}_${w}`, 12 * 3600e3, 1500, () => raw.holders(id, w));
  Backend.branchHist = (id, b, bhid) => swr(`bh2_${id}_${b}`, 60 * 60e3, 3000, () => raw.branchHist(id, b, bhid));
  // 舊版分點快取（代號錯誤）清掉
  try { Object.keys(localStorage).filter(k => /^bk_(b|bh)_/.test(k)).forEach(k => localStorage.removeItem(k)); } catch (e) {}
  // 寫入後讓相關快取失效，下次讀到的是新資料
  // 訪客：加減股票只存本機（不送後端）；EPS、匯入、分頁同步是擁有者功能
  const guestOnly = msg => () => Promise.reject(new Error(msg));
  Backend.upsert = (stock, eps) => !isOwner() ? (eps && eps.epsYear !== undefined ? guestOnly('訪客模式不能儲存預估 EPS')() : Promise.resolve({ status: 200, guest: true }))
    : raw.upsert(stock, eps).finally(() => BK.drop('list'));
  Backend.bulkUpsert = (...a) => !isOwner() ? guestOnly('訪客模式不能匯入')() : raw.bulkUpsert(...a).finally(() => BK.drop('list'));
  Backend.remove = (...a) => !isOwner() ? Promise.resolve({ status: 200, guest: true }) : raw.remove(...a).finally(() => BK.drop('list'));
  Backend.setGroups = (...a) => !isOwner() ? Promise.resolve({ status: 200, guest: true }) : raw.setGroups(...a).finally(() => BK.drop('groups'));
})();
