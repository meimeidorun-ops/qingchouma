// 全市場資料（2026-10-13）：排行榜、大盤指數、任何一檔的法人／資券／評分，不限自選清單。
// 資料：mk/day.json、inst.json、margin.json、scores.json（台股AI盯盤Agent/market_export.py 每個交易日 17:30、19:30、21:40 產生並部署，
// 來源是證交所／櫃買官方公開資料）＋盤中即時報價直接問鉅亨。
const Mk = {
  cache: {}, stamp: {},
  // 5 分鐘內重複用記憶體裡的；網址帶 5 分鐘一跳的參數，新檔上線最慢 5 分鐘看得到
  async load(name) {
    const c = Mk.cache[name];
    if (c && Date.now() - c.at < 3e5) return c.data;
    try {
      const res = await fetch(`mk/${name}.json?t=${Math.floor(Date.now() / 3e5)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      Mk.cache[name] = { at: Date.now(), data };
      return data;
    } catch (e) {
      if (c) return c.data;  // 離線或暫時失敗：用上一份
      throw e;
    }
  },
  async dayMap() {
    const d = await Mk.load('day');
    if (!d._map) d._map = new Map(d.rows.map(r => [r[0], { id: r[0], name: r[1], close: r[2], pct: r[3], vol: r[4], money: r[5], pct5: r[6], pct20: r[7], mkt: r[8], money20: r[9] }]));
    return d._map;
  },
  // 盤中即時：成交值前 700 檔（＋自選）直接問鉅亨，一次 50 檔平行抓，約 0.5 秒。20 秒內重複用。
  liveAt: 0, liveData: null,
  async live() {
    if (Mk.liveData && Date.now() - Mk.liveAt < 2e4) return Mk.liveData;
    const map = await Mk.dayMap();
    const ids = [...map.values()].sort((a, b) => b.money - a.money).slice(0, 700).map(r => r.id);
    for (const s of getWatchlist()) if (map.has(s.stock_id) && !ids.includes(s.stock_id)) ids.push(s.stock_id);
    const out = new Map();
    const chunks = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    await Promise.all(chunks.map(async c => {
      const data = await cnyesGet('/v2/quote/quotes/' + c.map(cnyesSym).join(','), 8000).catch(() => []);
      for (const d of data || []) {
        if (!d['200010'] || d['6'] == null) continue;
        const t = twTime(d['200007']);
        out.set(d['200010'], { id: d['200010'], name: d['200009'], close: d['6'], pct: d['56'], vol: Math.round(d['200013'] || 0),
          money: (d['200067'] || 0) / 1e6, date: t.date, time: t.hms });
      }
    }));
    if (out.size < 50) throw new Error('即時報價抓不到');
    Mk.liveData = out;
    Mk.liveAt = Date.now();
    return out;
  },
};
const mkEsc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- 個股：法人／資券改用官方全市場資料
// 最近 40 個交易日用 mk（官方、當天傍晚就有、不耗 FinMind 額度）；更早的歷史才用 FinMind。
// FinMind 沒填授權碼或額度用完時，至少還有最近 40 天。
(() => {
  const merge = async (fmCall, mkRows, since) => {
    const own = mkRows.filter(r => r.date >= since);
    if (!own.length) return fmCall();
    const first = own[0].date;
    if (first <= since) return own;  // mk 已經涵蓋整段 → 完全不用 FinMind
    let old = [];
    try { old = (await fmCall()).filter(r => r.date < first); } catch (e) { console.warn('FinMind 歷史抓不到，只顯示近 40 日', e.message); }
    return old.concat(own);
  };
  const instFm = Api.institutional.bind(Api);
  Api.institutional = async (id, days = 90) => {
    let rows = [];
    try {
      const d = await Mk.load('inst');
      const a = d.s[id];
      if (a) d.days.forEach((date, i) => [['Foreign_Investor', a[0][i]], ['Investment_Trust', a[1][i]], ['Dealer', a[2][i]]].forEach(([name, v]) =>
        rows.push({ date, stock_id: id, name, buy: v > 0 ? v * 1000 : 0, sell: v < 0 ? -v * 1000 : 0 })));
    } catch (e) {}
    return merge(() => instFm(id, days), rows, daysAgo(days));
  };
  const marginFm = Api.margin.bind(Api);
  Api.margin = async (id, days = 180) => {
    let rows = [];
    try {
      const d = await Mk.load('margin');
      const a = d.s[id];
      if (a) d.days.forEach((date, i) => { if (i > 0) rows.push({ date, stock_id: id, MarginPurchaseTodayBalance: a[0][i], MarginPurchaseYesterdayBalance: a[0][i - 1],
        ShortSaleTodayBalance: a[1][i], ShortSaleYesterdayBalance: a[1][i - 1] }); });
    } catch (e) {}
    return merge(() => marginFm(id, days), rows, daysAgo(days));
  };
})();

// ---------------------------------------------------------------- 個股：月營收、季財報改用電腦先做好的靜態檔（2026-11-21）
// 起因：手機直接打 FinMind 常「載入失敗」（免費額度、要授權碼）。mk/f/<代號前兩碼>.json ← Agent fin_export.py
// （月營收＝官方＋FinMind 歷史、季財報＝公開資訊觀測站綜合損益表彙總，單季、元）。檔裡沒有的（ETF、新上市）才退回 FinMind。
const MkF = {};
async function mkShard(id) {
  const k = String(id).slice(0, 2);
  if (!MkF[k] || Date.now() - MkF[k].at > 6 * 3600e3) {
    MkF[k] = { at: Date.now(), p: fetch(`mk/f/${k}.json?t=${Math.floor(Date.now() / 36e5)}`).then(r => r.ok ? r.json() : {}).catch(() => ({})) };
  }
  return (await MkF[k].p)[id] || null;
}
(() => {
  const revFm = Api.monthRevenue.bind(Api);
  Api.monthRevenue = async (id, months = 36) => {
    const x = await mkShard(id);
    if (x && x.r && x.r.length >= 13) {
      return x.r.map(([y, m, v]) => ({ date: `${y}-${String(m).padStart(2, '0')}-01`, stock_id: id, revenue_year: y, revenue_month: m, revenue: v }));
    }
    return revFm(id, months);
  };
  const finFm = Api.financials.bind(Api);
  Api.financials = async (id, years = 3) => {
    const x = await mkShard(id);
    if (x && x.q && x.q.length) {
      const rows = [];
      for (const [date, rev, gp, ni, eps] of x.q) {
        if (rev != null) rows.push({ date, stock_id: id, type: 'Revenue', value: rev });
        if (gp != null) rows.push({ date, stock_id: id, type: 'GrossProfit', value: gp });
        if (ni != null) rows.push({ date, stock_id: id, type: 'IncomeAfterTaxes', value: ni });
        if (eps != null) rows.push({ date, stock_id: id, type: 'EPS', value: eps });
      }
      return rows;
    }
    return finFm(id, years);
  };
})();

// 搜尋：FinMind 股票清單抓不到（沒授權碼／額度用完）時，才改用全市場行情檔的代號＋名稱＋上市/上櫃。
// 2026-10-14 修：v52 曾在一開啟就直接用行情檔蓋掉 stockIndex（沒有上市/上櫃欄位）→ marketFor() 把上櫃股都當上市，
// 備援報價查錯市場、新加入的上櫃股也被記成上市。現在只在 FinMind 失敗時備援，而且帶 type。
(() => {
  const fm = Api.stockList.bind(Api);
  Api.stockList = async () => {
    try { return await fm(); } catch (e) {
      const map = await Mk.dayMap();
      return [...map.values()].map(r => ({ stock_id: r.id, stock_name: r.name, type: r.mkt === 'TWO' ? 'tpex' : 'twse' }));
    }
  };
})();

// ---------------------------------------------------------------- 個股：不在自選清單也有評分（全市場成交金額前 350 大）
const MK_PARTS = [['營收創新高', 2], ['營收轉折', 3], ['接近一年高點', 4], ['估值（本益比低）', 5], ['低波動（穩健版才算）', 6]];
async function mkPaintDetailScore(stock) {
  const box = $('#dt-score');
  let d;
  try { d = await Mk.load('scores'); } catch (e) { return; }
  const it = d.items[stock.stock_id];
  if (!it || currentStock !== stock) return;
  const safe = typeof scoreMode !== 'undefined' && scoreMode === 'safe';
  const sc = safe ? it[1] : it[0];
  box.innerHTML = `<span class="sc-badge has ${scoreClass(sc)}">${sc ?? '—'}</span><span class="dt-score-lbl">全市場評分${safe ? '（穩健）' : ''}</span><span class="dt-score-more">細項 ›</span>`;
  box.onclick = () => mkOpenScore(stock.stock_id, stock.stock_name);
  box.hidden = false;
}
// 清單上沒有後端分數的股票（訪客、或後端評分還沒涵蓋）→ 用全市場評分補徽章，排序也算進去
async function mkFillScores(list) {
  let d;
  try { d = await Mk.load('scores'); } catch (e) { return; }
  const safe = scoreMode === 'safe';
  let n = 0;
  for (const s of list) {
    const cur = scoreMap.get(s.stock_id);
    if (cur && cur.score != null) continue;
    const a = d.items[s.stock_id];
    const sc = a ? (safe ? a[1] : a[0]) : null;
    if (sc == null) continue;
    scoreMap.set(s.stock_id, { id: s.stock_id, score: sc, mk: true, signals: (cur && cur.signals) || [] });
    const b = $(`#wl-sc-${s.stock_id}`);
    if (b) { b.textContent = sc; b.className = `sc-badge has ${scoreClass(sc)}`; }
    n++;
  }
  if (n) applyWatchlistSort(list);
}
async function mkOpenScore(id, name) {
  const d = await Mk.load('scores');
  const it = d.items[id];
  if (!it) return;
  const bar = v => v == null ? '<span class="dim">沒有資料</span>' : `<span style="display:inline-block;width:90px;height:6px;border-radius:3px;background:var(--border);vertical-align:middle;margin-right:8px"><span style="display:block;height:6px;border-radius:3px;width:${v}%;background:${v >= 70 ? '#e6413c' : v >= 50 ? '#f2c744' : '#8b949e'}"></span></span>${v}`;
  $('#modal-card').innerHTML = `<h3 style="margin:0 0 4px">${mkEsc(name || id)} <span class="dim" style="font-size:13px">${id}</span></h3>
    <div style="margin:6px 0 12px">積極版 <b class="sc-badge has ${scoreClass(it[0])}">${it[0] ?? '—'}</b>　穩健版 <b class="sc-badge has ${scoreClass(it[1])}">${it[1] ?? '—'}</b></div>
    ${MK_PARTS.map(([lbl, i]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:14px"><span>${lbl}</span><span>${bar(it[i])}</span></div>`).join('')}
    <div style="padding:6px 0;font-size:14px;display:flex;justify-content:space-between"><span>近四季本益比</span><span>${it[7] == null ? '—（虧損或無資料）' : it[7] + ' 倍'}</span></div>
    ${mkScoreHistSlot()}
    <p class="hint" style="margin-top:10px">每一項＝在全市場成交金額前 ${d.popN} 大普通股裡的百分位（0～100，越高越好）。積極版＝前四項平均；穩健版再加低波動。更新 ${d.asOf.slice(5)}。規則計算，非投資建議。</p>
    <button class="save" id="mk-sc-close" style="width:100%;margin-top:6px">關閉</button>`;
  $('#modal').classList.add('active');
  $('#mk-sc-close').onclick = closeModal;
  const safe = localStorage.getItem('score_mode') === 'safe';
  mkFillScoreHist(safe ? it[1] : it[0], safe);
}

// 2026-11-10：分數細項裡的「歷史上同分數區間的成績」（mk/score_stats.json，Agent backtest/score_buckets.py 產生）
function mkScoreHistSlot() { return '<div id="sc-hist" class="sc-hist"></div>'; }
async function mkFillScoreHist(score, safe) {
  const box = $('#sc-hist');
  if (!box || score == null) return;
  try {
    const d = await Mk.load('score_stats');
    const m = d.modes[safe ? 'safe' : 'aggr'];
    const b = m.buckets.find(x => score >= x.lo && score <= x.hi);
    if (!b || !b['3']) return;
    const s1 = b['1'] || {}, s3 = b['3'];
    const sg = v => `${v > 0 ? '+' : ''}${v}%`;
    const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
    const rowsAll = m.buckets.filter(x => x['3']).map(x => `<tr${x === b ? ' class="on"' : ''}><td>${x.lo}～${x.hi}</td><td class="${cls(x['3'].avg)}">${sg(x['3'].avg)}</td><td>${x['3'].up}%</td><td>${x['3'].beat}%</td><td>${x['3'].crash}%</td></tr>`).join('');
    box.innerHTML = `<div class="sc-hist-title">📈 歷史上 ${b.lo}～${b.hi} 分的股票（${safe ? '穩健' : '積極'}版）</div>
      <div class="sc-hist-grid">
        <div><span class="dim">3 個月後平均</span><b class="${cls(s3.avg)}">${sg(s3.avg)}</b><span class="dim">中位數 ${sg(s3.med)}</span></div>
        <div><span class="dim">3 個月後上漲機率</span><b>${s3.up}%</b><span class="dim">1 個月 ${s1.up ?? '—'}%</span></div>
        <div><span class="dim">贏過同期市場平均</span><b>${s3.beat}%</b><span class="dim">平均多 ${sg(s3.exAvg)}</span></div>
        <div><span class="dim">3 個月跌超過 20%</span><b>${s3.crash}%</b><span class="dim">漲超過 30%：${s3.boom}%</span></div>
      </div>
      <details class="sc-hist-more"><summary>看各分數區間比較</summary>
        <table class="data-table compact"><thead><tr><th>分數</th><th>3月平均</th><th>上漲</th><th>贏大盤</th><th>跌>20%</th></tr></thead><tbody>${rowsAll}</tbody></table>
        <div class="dim">全部股票平均：3 個月 ${sg(m.all['3'].avg)}、上漲機率 ${m.all['3'].up}%。</div>
      </details>
      <div class="dim" style="margin-top:6px">${d.from.slice(0, 7)}～${d.to.slice(0, 7)} 每個月用「當時」的資料算分數，再看之後的實際報酬（${s3.n.toLocaleString()} 筆）。不含手續費、股利；過去成績不代表未來，個股差異很大。</div>`;
  } catch (e) { /* 統計檔抓不到就不顯示 */ }
}

// ---------------------------------------------------------------- 首頁：大盤指數（加權、櫃買），盤中 20 秒更新
async function paintIndexBar() {
  const box = $('#idx-bar');
  if (!box) return;
  try {
    const data = await cnyesGet('/v1/quote/quotes/TWS:TSE01:INDEX,TWS:OTC01:INDEX');
    box.innerHTML = (data || []).map(d => {
      const cls = signClass(d['11']);
      const amt = d['200067'] ? `<span class="dim"> ${numFmt(d['200067'] / 1e8)}億</span>` : '';
      return `<div class="idx-item"><span class="dim">${d['200010'] === 'TSE01' ? '加權' : '櫃買'}</span> <b class="${cls}">${numFmt(d['6'], 2)}</b> <span class="${cls}">${d['11'] >= 0 ? '+' : ''}${numFmt(d['11'], 2)}（${pctFmt(d['56'])}）</span>${amt}</div>`;
    }).join('');
    box.hidden = false;
  } catch (e) { /* 抓不到就維持原樣 */ }
}

// ---------------------------------------------------------------- 📊 全市場排行
const Rank = { cat: localStorage.getItem('rk_cat') || 'up', dir: localStorage.getItem('rk_dir') || 'buy', n: Number(localStorage.getItem('rk_n') || 1),
  noEtf: localStorage.getItem('rk_noetf') === '1', liq: localStorage.getItem('rk_liq') !== '0', safe: false, seq: 0 };
const RK_CATS = [['screen', '🔎選股'], ['up', '漲幅'], ['down', '跌幅'], ['money', '成交值'], ['f', '外資'], ['t', '投信'], ['d', '自營'], ['ft', '土洋同步'], ['fta', '三大同步'], ['margin', '融資'], ['dt', '當沖'], ['sbl', '借券'], ['big', '大戶'], ['val', '估值'], ['rev', '營收'], ['ann', '公告'], ['sector', '類股'], ['etf', 'ETF'], ['score', '評分']];
const RK_SEC = [['chg', '漲跌幅'], ['chg5', '5日漲跌'], ['money', '成交值'], ['f', '外資買超'], ['t', '投信買超']];
const RK_ETF = [['prem', '溢價'], ['disc', '折價'], ['in', '資金流入'], ['out', '資金流出'], ['size', '規模'], ['in5', '5日流入'], ['out5', '5日流出']];
const rkIsPrice = () => ['up', 'down', 'money'].includes(Rank.cat);
const rkIsInst = () => ['f', 't', 'd', 'ft', 'fta'].includes(Rank.cat);
// 2026-11-10：同步買賣＝每一方「各自」都是買超（或賣超）才算；三方量體差很多（外資常是投信的好幾倍），
// 所以不看合計多少，而是每一方方向一致、再依合計金額排序，各方張數分開列出。
const RK_GROUP = { f: [0], t: [1], d: [2], ft: [0, 1], fta: [0, 1, 2] };
const rkIsEtf = id => id.startsWith('00');

function paintRankBars() {
  $('#rk-cat').innerHTML = RK_CATS.map(([k, l]) => `<button class="range-btn${Rank.cat === k ? ' active' : ''}" data-cat="${k}">${l}</button>`).join('');
  const btn = (attr, v, lbl, on) => `<button class="range-btn${on ? ' active' : ''}" data-${attr}="${v}">${lbl}</button>`;
  let sub = '';
  if (rkIsInst()) {
    const same = RK_GROUP[Rank.cat].length > 1;
    sub = [['buy', same ? '同買' : '買超'], ['sell', same ? '同賣' : '賣超'], ['streakBuy', same ? '同步連買' : '連買'], ['streakSell', same ? '同步連賣' : '連賣']].map(([v, l]) => btn('dir', v, l, Rank.dir === v)).join('') +
      (Rank.dir.startsWith('streak') ? '' : '<span style="width:8px"></span>' + [1, 5, 10, 20].map(n => btn('n', n, `${n}日`, Rank.n === n)).join(''));
  } else if (Rank.cat === 'margin') {
    sub = [['buy', '增加'], ['sell', '減少']].map(([v, l]) => btn('dir', v, l, (Rank.dir === 'sell') === (v === 'sell'))).join('') +
      '<span style="width:8px"></span>' + [1, 5, 10, 20].map(n => btn('n', n, `${n}日`, Rank.n === n)).join('');
  } else if (Rank.cat === 'score') {
    sub = btn('safe', '0', '積極版', !Rank.safe) + btn('safe', '1', '穩健版', Rank.safe);
  } else if (Rank.cat === 'dt') {
    if (!['hi', 'lo', 'jump'].includes(Rank.dtk)) Rank.dtk = 'hi';
    sub = [['hi', '占比最高'], ['lo', '占比最低'], ['jump', '比 20 日均暴增']].map(([v, l]) => btn('dtk', v, l, Rank.dtk === v)).join('');
  } else if (Rank.cat === 'sbl') {
    if (!['up5', 'dn5', 'sell'].includes(Rank.sblk)) Rank.sblk = 'up5';
    sub = [['up5', '5日餘額增加'], ['dn5', '5日回補（減少）'], ['sell', '今天借券賣出']].map(([v, l]) => btn('sblk', v, l, Rank.sblk === v)).join('');
  } else if (Rank.cat === 'val') {
    if (!['yld', 'pe', 'pb'].includes(Rank.valk)) Rank.valk = 'yld';
    sub = [['yld', '殖利率最高'], ['pe', '本益比最低'], ['pb', '淨值比最低']].map(([v, l]) => btn('valk', v, l, Rank.valk === v)).join('');
  } else if (Rank.cat === 'rev') {
    if (!['yoy', 'mom', 'ytd', 'y3', 'ath', 'high12'].includes(Rank.revk)) Rank.revk = 'yoy';
    sub = [['yoy', '單月年增'], ['y3', '近3月年增'], ['ytd', '累計年增'], ['mom', '月增'], ['ath', '創歷史新高'], ['high12', '創一年新高']].map(([v, l]) => btn('revk', v, l, Rank.revk === v)).join('');
  } else if (Rank.cat === 'ann') {
    if (!['punish', 'notice', 'exdiv'].includes(Rank.annk)) Rank.annk = 'punish';
    sub = [['punish', '處置股'], ['notice', '注意股'], ['exdiv', '除權息預告']].map(([v, l]) => btn('annk', v, l, Rank.annk === v)).join('');
  } else if (Rank.cat === 'big') {
    if (!['up', 'dn', 'hi', 'k1', 'ppl', 'pplup'].includes(Rank.bigk)) Rank.bigk = (Mk.cache.tdcc && Mk.cache.tdcc.data.weeks.length >= 2) ? 'up' : 'hi';
    sub = [['up', '大戶週增'], ['dn', '大戶週減'], ['pplup', '股東人數週增'], ['hi', '大戶比例最高'], ['k1', '千張大戶最高'], ['ppl', '股東人數最多']]
      .map(([v, l]) => btn('bigk', v, l, Rank.bigk === v)).join('');
  } else if (Rank.cat === 'etf') {
    if (!RK_ETF.some(([v]) => v === Rank.etf)) Rank.etf = 'prem';
    sub = RK_ETF.map(([v, l]) => btn('etf', v, l, Rank.etf === v)).join('');
  } else if (Rank.cat === 'sector') {
    if (!RK_SEC.some(([v]) => v === Rank.sec)) Rank.sec = 'chg';
    if (!Rank.secKind) Rank.secKind = localStorage.getItem('rk_seckind') || 'ind';
    sub = (Rank.secCode ? btn('secback', '1', `‹ 全部${Rank.secKind === 'con' ? '概念' : '類股'}`, false) : btn('seckind', 'ind', '產業', Rank.secKind === 'ind') + btn('seckind', 'con', '概念股', Rank.secKind === 'con') + '<span style="width:8px"></span>') +
      RK_SEC.map(([v, l]) => btn('sec', v, l, Rank.sec === v)).join('');
  }
  if (!['score', 'etf', 'sector', 'screen', 'dt', 'sbl', 'big', 'ann', 'val', 'rev'].includes(Rank.cat)) sub += '<span style="width:8px"></span>' + btn('toggle', 'noetf', '排除 ETF', Rank.noEtf) + (rkIsPrice() && Rank.cat !== 'money' ? btn('toggle', 'liq', '成交值≥1億', Rank.liq) : '');
  $('#rk-sub').innerHTML = sub;
}

async function openRank() {
  showScreen('screen-rank');
  paintRankBars();
  const box = $('#rk-list'), sum = $('#rk-summary');
  const seq = ++Rank.seq;
  if (!box.children.length) box.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const day = await Mk.dayMap();
    const dayDate = (await Mk.load('day')).date;
    const watched = new Set(getWatchlist().map(s => s.stock_id));
    let rows = [], note = '', unit = '';
    // 價格：盤中（或行情檔還沒更新到今天）用鉅亨即時；不然用收盤檔
    let px = day, pxNote = `收盤 ${dayDate.slice(5)}`;
    if (rkIsPrice() || rkIsInst() || ['margin', 'sector', 'screen'].includes(Rank.cat)) {
      try {
        const live = await Mk.live();
        const any = live.values().next().value;
        if (any && any.date >= dayDate) {
          px = new Map([...day].map(([k, v]) => [k, v]));
          let last = '';
          live.forEach((q, k) => { px.set(k, Object.assign({}, day.get(k), q)); if (q.time > last) last = q.time; });
          if (rkIsPrice()) px = live;  // 即時排行只排有即時報價的（成交值前 700 檔＋自選）
          pxNote = any.date > dayDate || twMarketOpen() ? `即時 ${last}・鉅亨（成交值前 700 檔）` : `收盤 ${any.date.slice(5)}`;
        }
      } catch (e) { /* 用收盤檔 */ }
    }
    if (seq !== Rank.seq) return;
    const base = id => (!Rank.noEtf || !rkIsEtf(id));
    if (rkIsPrice()) {
      rows = [...px.values()].filter(r => r.pct != null && base(r.id) && (Rank.cat === 'money' || !Rank.liq || r.money >= 100));
      rows.sort(Rank.cat === 'up' ? (a, b) => b.pct - a.pct : Rank.cat === 'down' ? (a, b) => a.pct - b.pct : (a, b) => b.money - a.money);
      rows = rows.map(r => ({ id: r.id, name: r.name, px: r, main: Rank.cat === 'money' ? `${numFmt(r.money / 100, 1)} 億` : '', cls: 'flat',
        sub: `量 ${numFmt(r.vol)} 張｜成交值 ${numFmt(r.money / 100, 1)} 億` }));
      note = pxNote;
    } else if (rkIsInst()) {
      const d = await Mk.load('inst');
      const ks = RK_GROUP[Rank.cat], same = ks.length > 1, L = d.days.length;
      const streak = Rank.dir.startsWith('streak'), sgn = Rank.dir === 'buy' || Rank.dir === 'streakBuy' ? 1 : -1;
      const minRun = same ? 2 : 3;
      const WHO = ['外', '投', '自'];
      for (const id in d.s) {
        if (!base(id) || !day.has(id)) continue;
        const c = day.get(id).close || 0;
        const each = ks.map(k => d.s[id][k] || []);
        if (streak) {
          // 從最新一天往回數：那一天「每一方」都同方向才算一天
          let n = 0;
          const tots = ks.map(() => 0);
          while (n < L && each.every(a => a[L - 1 - n] * sgn > 0)) { each.forEach((a, j) => { tots[j] += a[L - 1 - n]; }); n++; }
          const tot = tots.reduce((s, x) => s + x, 0);
          if (n >= minRun) rows.push({ id, v: n, v2: Math.abs(tot) * c, lots: tot, tots });
        } else {
          const tots = each.map(a => { let s = 0; for (let i = Math.max(0, L - Rank.n); i < L; i++) s += a[i] || 0; return s; });
          if (tots.every(x => x * sgn > 0)) {
            const tot = tots.reduce((s, x) => s + x, 0);
            rows.push({ id, v: Math.abs(tot) * c, v2: 0, lots: tot, tots });
          }
        }
      }
      rows.sort((a, b) => b.v - a.v || b.v2 - a.v2);
      const word = sgn > 0 ? '買' : '賣';
      const lotsTxt = r => same ? ks.map((k, j) => `${WHO[k]} ${r.tots[j] > 0 ? '+' : ''}${numFmt(r.tots[j])}`).join('｜') + ' 張'
        : `${r.lots > 0 ? '+' : ''}${numFmt(r.lots)} 張`;
      rows = rows.map(r => ({ id: r.id, name: day.get(r.id).name, px: px.get(r.id) || day.get(r.id), cls: sgn > 0 ? 'up' : 'down',
        main: streak ? `${same ? '同步' : ''}連${word} ${r.v} 天` : `${sgn > 0 ? '+' : '-'}${numFmt(r.v / 1e5, 1)} 億`,
        sub: `${streak ? '合計 ' : ''}${lotsTxt(r)}${streak ? `（約 ${numFmt(r.v2 / 1e5, 1)} 億）` : ''}` }));
      const who = { f: '外資', t: '投信', d: '自營商', ft: '外資＋投信同步', fta: '三大法人同步' }[Rank.cat];
      note = `${who}${same ? `（每一方都${word}超才列入，依合計金額排序）` : ''}｜資料日 ${d.days[L - 1].slice(5)}${streak ? `（連續 ${minRun} 天以上）` : `，近 ${Math.min(Rank.n, L)} 日${same ? '' : '，依金額排序'}`}｜更新 ${d.updated.slice(5)}`;
    } else if (Rank.cat === 'margin') {
      const d = await Mk.load('margin');
      const L = d.days.length, back = Math.min(Rank.n, L - 1), sgn = Rank.dir === 'sell' ? -1 : 1;
      for (const id in d.s) {
        if (!base(id) || !day.has(id)) continue;
        const a = d.s[id][0], now = a[L - 1], was = a[L - 1 - back];
        if (was < 500 || (now - was) * sgn <= 0) continue;  // 融資餘額不到 500 張的不排
        rows.push({ id, v: (now - was) / was * 100, lots: now - was, bal: now });
      }
      rows.sort((a, b) => (b.v - a.v) * sgn);
      rows = rows.map(r => ({ id: r.id, name: day.get(r.id).name, px: px.get(r.id) || day.get(r.id), cls: sgn > 0 ? 'up' : 'down', main: pctFmt(r.v, 1),
        sub: `${r.lots > 0 ? '+' : ''}${numFmt(r.lots)} 張｜餘額 ${numFmt(r.bal)} 張` }));
      note = `融資餘額增減%｜資料日 ${d.days[L - 1].slice(5)}，近 ${back} 日（餘額 ≥500 張）｜更新 ${d.updated.slice(5)}`;
    } else if (Rank.cat === 'dt' || Rank.cat === 'sbl') {
      // 當沖占比／借券賣出：mk/dt.json（近 20 個交易日）。只排普通股、成交值 ≥1 億（當沖）
      const d = await Mk.load('dt');
      const L = d.days.length;
      for (const [id, s] of Object.entries(d.s)) {
        if (!/^[1-9]\d{3}$/.test(id) || !day.has(id)) continue;
        const p = px.get(id) || day.get(id);
        if (Rank.cat === 'dt') {
          const r = s[0][L - 1];
          if (r == null || !(day.get(id).money >= 100)) continue;
          const prev = s[0].slice(0, L - 1).filter(x => x != null);
          const avg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
          const v = Rank.dtk === 'hi' ? r : Rank.dtk === 'lo' ? -r : (avg ? r - avg : null);
          if (v == null) continue;
          rows.push({ id, name: day.get(id).name, px: p, v, cls: r >= 50 ? 'up' : 'flat', main: `當沖 ${r}%`,
            sub: `20 日平均 ${avg == null ? '—' : avg.toFixed(1)}%｜成交 ${numFmt(day.get(id).money / 100, 1)} 億` });
        } else {
          const b = s[1], b0 = b[L - 1], b5 = b[L - 6];
          if (Rank.sblk === 'sell') {
            const x = s[2][L - 1];
            if (!x) continue;
            rows.push({ id, name: day.get(id).name, px: p, v: x * (p.close || 0), cls: 'down', main: `${numFmt(x)} 張`,
              sub: `約 ${numFmt(x * (p.close || 0) / 1e5, 1)} 億｜餘額 ${numFmt(b0)} 張` });
          } else {
            if (b0 == null || b5 == null || b5 < 100) continue;
            const chg = b0 - b5;
            if ((Rank.sblk === 'up5') !== (chg > 0) || chg === 0) continue;
            rows.push({ id, name: day.get(id).name, px: p, v: Math.abs(chg) * (p.close || 0), cls: chg > 0 ? 'down' : 'up',
              main: `${chg > 0 ? '+' : ''}${numFmt(chg)} 張`, sub: `${chg > 0 ? '+' : ''}${(chg / b5 * 100).toFixed(1)}%｜約 ${numFmt(Math.abs(chg) * (p.close || 0) / 1e5, 1)} 億｜餘額 ${numFmt(b0)} 張` });
          }
        }
      }
      rows.sort((a, b) => b.v - a.v);
      const mk = d.mkt.tse[L - 1], mo = d.mkt.otc[L - 1];
      note = Rank.cat === 'dt' ? `當沖占比｜${d.days[L - 1].slice(5)}｜大盤 上市 ${mk ?? '—'}%、上櫃 ${mo ?? '—'}%｜成交值 ≥1 億`
        : `借券賣出｜${d.days[L - 1].slice(5)}｜依金額排序（借券餘額增加＝空方部位變大）`;
    } else if (Rank.cat === 'val' || Rank.cat === 'rev') {
      // 估值／營收（mk/val.json）：s[id]=[本益比, 殖利率, 淨值比, 營收億, 月增%, 年增%, 累計年增%, 創N月新高, 近3月年增%]
      const d = await Mk.load('val');
      const sg = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`;
      for (const [id, v] of Object.entries(d.s)) {
        const p0 = day.get(id);
        if (!p0 || !(p0.money >= 30)) continue;  // 成交值 3,000 萬以下不排（冷門股數字常失真）
        const [pe, yld, pb, rev, mom, yoy, ytd, hi, y3] = v;
        let key = null, main = '';
        if (Rank.cat === 'val') {
          if (Rank.valk === 'yld') { if (!(yld > 0 && yld <= 30)) continue; key = yld; main = `殖利率 ${yld}%`; }  // 超過 30% 多半是減資退還、一次性配發，不排
          else if (Rank.valk === 'pe') { if (!(pe > 0)) continue; key = -pe; main = `本益比 ${pe}`; }
          else { if (!(pb > 0)) continue; key = -pb; main = `淨值比 ${pb}`; }
        } else {
          if (rev == null) continue;
          const k = Rank.revk;
          if (k === 'ath') { if (!(hi >= 60)) continue; key = yoy ?? 0; main = hi >= 120 ? '歷史新高' : `${Math.floor(hi / 12)} 年新高`; }
          else if (k === 'high12') { if (!(hi >= 12)) continue; key = yoy ?? 0; main = `${hi >= 24 ? Math.floor(hi / 12) + ' 年' : '一年'}新高`; }
          else { const x = { yoy, mom, ytd, y3 }[k]; if (x == null || rev < 1) continue; key = x; main = sg(x); }  // 月營收 1 億以下不排（基期太小）
        }
        rows.push({ id, name: p0.name, px: px.get(id) || p0, v: key, cls: Rank.cat === 'rev' ? signClass(key) : 'flat', main,
          sub: Rank.cat === 'val' ? `本益比 ${pe ?? '—'}｜殖利率 ${yld ?? '—'}%｜淨值比 ${pb ?? '—'}`
            : `${d.revYm ? d.revYm.slice(5) + ' 月' : ''}營收 ${rev} 億｜月增 ${sg(mom)}｜年增 ${sg(yoy)}｜累計 ${sg(ytd)}${hi >= 12 ? `｜${hi >= 120 ? '歷史' : hi + ' 個月'}新高` : ''}` });
      }
      rows.sort((a, b) => b.v - a.v);
      note = Rank.cat === 'val' ? `估值｜${d.perDate ? d.perDate.slice(5) : ''}（證交所／櫃買公布，殖利率用最近一年股利）｜成交值 ≥3,000 萬`
        : `月營收｜${d.revYm || ''}｜年增＝跟去年同月比；「創新高」依年增排序｜成交值 ≥3,000 萬、月營收 ≥1 億`;
    } else if (Rank.cat === 'ann') {
      // 公告：處置股、注意股、除權息預告（mk/notice.json）
      const n = await Mk.load('notice');
      const k = Rank.annk;
      if (k === 'exdiv') {
        const today = twDateStr();
        for (const [date, id, nm, typ, cash] of n.exdiv) {
          if (date < today) continue;
          const p = px.get(id) || day.get(id) || {};
          const yld = cash && p.close ? cash / p.close * 100 : null;
          rows.push({ id, name: nm, px: p, v: date, cls: 'flat', main: `${date.slice(5).replace('-', '/')} 除${typ}`,
            sub: `${cash ? `現金 ${+Number(cash).toFixed(3)} 元` : '金額待公告'}${yld != null ? `｜殖利率約 ${yld.toFixed(2)}%（這一次）` : ''}` });
        }
        rows.sort((a, b) => a.v < b.v ? -1 : 1);
        note = '除權息預告（上市）｜依日期排序｜除權息當天開盤參考價會扣掉股利';
      } else {
        const src = k === 'punish' ? n.punish : n.notice;
        for (const [id, x] of Object.entries(src)) {
          const p = px.get(id) || day.get(id) || {};
          rows.push({ id, name: x[0], px: p, v: k === 'punish' ? x[1] : x[2] + String(x[1]).padStart(3, '0'), cls: k === 'punish' ? 'down' : 'flat',
            main: k === 'punish' ? x[2] : (x[1] > 1 ? `累計 ${x[1]} 次` : '注意'), sub: k === 'punish' ? `處置 ${x[1]}` : `${x[2].slice(5)}｜${x[3]}` });
        }
        rows.sort((a, b) => a.v < b.v ? 1 : -1);
        note = k === 'punish' ? '處置股（目前處置中）｜撮合變慢、大量買賣要預收款券' : '注意股（近 5 天公布）｜漲跌幅、週轉率或本益比異常';
      }
    } else if (Rank.cat === 'big') {
      // 集保大戶（每週）：mk/tdcc.json。大戶＝400 張以上、千張大戶＝1000 張以上、散戶＝50 張以下
      const d = await Mk.load('tdcc');
      const W = d.weeks.length, k = Rank.bigk, needTwo = ['up', 'dn', 'pplup'].includes(k);
      if (needTwo && W < 2) {
        note = `大戶週變化｜集保只提供最新一週，從 ${d.weeks[0].slice(5)} 開始累積，下週六之後就有週變化可以排。先看「大戶比例最高」。`;
      } else {
        for (const [id, s] of Object.entries(d.s)) {
          if (!/^[1-9]\d{3}$/.test(id) || !day.has(id) || !(day.get(id).money >= 50)) continue;  // 普通股、成交值 ≥5,000 萬
          const [big, k1, rt, pp] = s, b = big[W - 1], b1 = big[W - 2];
          if (b == null || !(pp[W - 1] >= 100)) continue;  // 股東不到 100 人（控股、轉換中）不排
          let v, main;
          if (k === 'up' || k === 'dn') { if (b1 == null) continue; const c = b - b1; if ((k === 'up') !== (c > 0) || !c) continue; v = Math.abs(c); main = `${c > 0 ? '+' : ''}${c.toFixed(2)}%`; }
          else if (k === 'pplup') { const p0 = pp[W - 1], p1 = pp[W - 2]; if (!p0 || !p1) continue; const c = (p0 - p1) / p1 * 100; if (c <= 0) continue; v = c; main = `+${c.toFixed(1)}%`; }
          else if (k === 'hi') { v = b; main = `${b.toFixed(1)}%`; }
          else if (k === 'k1') { if (k1[W - 1] == null) continue; v = k1[W - 1]; main = `${v.toFixed(1)}%`; }
          else { if (!pp[W - 1]) continue; v = pp[W - 1]; main = `${numFmt(v)} 人`; }
          rows.push({ id, name: day.get(id).name, px: px.get(id) || day.get(id), v, cls: (k === 'dn') ? 'down' : 'up', main,
            sub: `大戶 ${b.toFixed(1)}%${b1 != null ? `（週 ${b - b1 >= 0 ? '+' : ''}${(b - b1).toFixed(2)}）` : ''}｜千張 ${k1[W - 1] == null ? '—' : k1[W - 1].toFixed(1) + '%'}｜散戶 ${rt[W - 1] == null ? '—' : rt[W - 1].toFixed(1) + '%'}｜股東 ${numFmt(pp[W - 1])} 人` });
        }
        rows.sort((a, b) => b.v - a.v);
        note = `集保大戶（400 張以上）｜${d.weeks[W - 1].slice(5)} 週${W >= 2 ? `，比較 ${d.weeks[W - 2].slice(5)}` : ''}｜成交值 ≥5,000 萬｜每週六更新`;
      }
    } else if (Rank.cat === 'screen') {
      ({ rows, note } = await scrRows(day, px));
      note += `｜價格 ${pxNote}`;
    } else if (Rank.cat === 'sector') {
      // 類股：產業分類 mk/ind.json；價格用即時（成交值前 700 檔有即時，其他用收盤）；法人用 inst.json 最新一天
      // 2026-11-26：也可以看「概念股」（mk/concept.json，一檔可以在好幾個概念裡）；多「5日漲跌」（day.json pct5，用 20 日均成交值加權）
      const con = Rank.secKind === 'con';
      const [I, inst, C] = await Promise.all([Mk.load('ind'), Mk.load('inst').catch(() => null), con ? Mk.load('concept') : null]);
      const names = con ? C.names : I.names;
      const members = new Map();   // 群組 → [代號]
      if (con) for (const [g, ids] of Object.entries(C.mem)) members.set(g, ids);
      else for (const [id, code] of Object.entries(I.s)) { if (!members.has(code)) members.set(code, []); members.get(code).push(id); }
      const k = Rank.sec, L = inst ? inst.days.length : 0;
      const instAmt = (id, w) => { const a = inst && inst.s[id] && inst.s[id][w]; const c = (px.get(id) || day.get(id) || {}).close; return a && c ? a[L - 1] * c : 0; };  // 張×元＝千元
      if (!Rank.secCode) {
        const S = [];
        for (const [code, ids] of members) {
          const s = { code, w: 0, wp: 0, w20: 0, wp5: 0, up: 0, dn: 0, n: 0, money: 0, f: 0, t: 0, best: null };
          for (const id of ids) {
            const p = px.get(id) || day.get(id), d0 = day.get(id);
            if (!p || p.pct == null) continue;
            const m = p.money || 0;
            s.w += m; s.wp += p.pct * m; s.n++; s.money += m;
            if (d0 && d0.pct5 != null && d0.money20) { s.w20 += d0.money20; s.wp5 += d0.pct5 * d0.money20; }
            if (p.pct > 0) s.up++; else if (p.pct < 0) s.dn++;
            s.f += instAmt(id, 0); s.t += instAmt(id, 1);
            if (!s.best || m > s.best.m) s.best = { id, m, name: p.name || (d0 || {}).name, pct: p.pct };
          }
          S.push(s);
        }
        rows = S.filter(s => s.n >= (con ? 2 : 3) && s.w > 0).map(s => {
          const pct = s.wp / s.w, pct5 = s.w20 ? s.wp5 / s.w20 : null;
          const v = k === 'chg' ? pct : k === 'chg5' ? (pct5 ?? -999) : k === 'money' ? s.money : k === 'f' ? s.f : s.t;
          return { id: s.code, sector: s.code, name: names[s.code], px: { close: null, pct }, cls: signClass(k === 'chg5' ? pct5 : k === 'chg' ? pct : v), v,
            main: k === 'chg' ? '' : k === 'chg5' ? `5日 ${pct5 == null ? '—' : pctFmt(pct5)}` : k === 'money' ? `${numFmt(s.money / 100, 0)} 億` : `${v > 0 ? '+' : ''}${numFmt(v / 1e5, 1)} 億`,
            sub: `${s.n} 檔｜漲 ${s.up}・跌 ${s.dn}｜5日 ${pct5 == null ? '—' : pctFmt(pct5)}｜成交 ${numFmt(s.money / 100, 0)} 億｜外資 ${s.f >= 0 ? '+' : ''}${numFmt(s.f / 1e5, 1)} 億｜投信 ${s.t >= 0 ? '+' : ''}${numFmt(s.t / 1e5, 1)} 億${s.best ? `｜龍頭 ${s.best.name || s.best.id}` : ''}` };
        });
        rows.sort((a, b) => b.v - a.v);
        note = `${con ? '概念股（自訂名單）' : '類股'}｜${pxNote}｜漲跌幅＝成交值加權平均；法人＝${inst ? inst.days[L - 1].slice(5) : '—'} 買賣超金額｜點${con ? '概念' : '類股'}看成分股`;
      } else {
        for (const id of members.get(Rank.secCode) || []) {
          const p = px.get(id) || day.get(id), d0 = day.get(id) || {};
          if (!p || p.pct == null) continue;
          const f = instAmt(id, 0), t = instAmt(id, 1);
          const v = k === 'chg' ? p.pct : k === 'chg5' ? (d0.pct5 ?? -999) : k === 'money' ? (p.money || 0) : k === 'f' ? f : t;
          rows.push({ id, name: p.name || d0.name, px: p, cls: signClass(k === 'chg5' ? d0.pct5 : v), v,
            main: k === 'chg' ? '' : k === 'chg5' ? `5日 ${d0.pct5 == null ? '—' : pctFmt(d0.pct5)}` : k === 'money' ? `${numFmt((p.money || 0) / 100, 1)} 億` : `${v > 0 ? '+' : ''}${numFmt(v / 1e5, 1)} 億`,
            sub: `成交 ${numFmt((p.money || 0) / 100, 1)} 億｜5日 ${d0.pct5 == null ? '—' : pctFmt(d0.pct5)}｜外資 ${f >= 0 ? '+' : ''}${numFmt(f / 1e5, 1)} 億｜投信 ${t >= 0 ? '+' : ''}${numFmt(t / 1e5, 1)} 億` });
        }
        rows.sort((a, b) => b.v - a.v);
        note = `${names[Rank.secCode]}（${rows.length} 檔）｜${pxNote}`;
      }
    } else if (Rank.cat === 'etf') {
      // ETF：即時折溢價（快速後端）或收盤檔；5 日流入用 etf_hist 的單位數變化 × 淨值
      const m = await etfData();
      const k = Rank.etf;
      let H = null;
      if (k === 'in5' || k === 'out5') H = await Mk.load('etf_hist').catch(() => null);
      const name = id => (day.get(id) || {}).name || id;
      for (const e of m.values()) {
        if (e.price == null || !e.units) continue;
        const size = e.units * (e.nav || e.price);
        if (size < 5e8 && k !== 'size') continue;  // 規模 5 億以下的小 ETF 不排（折溢價常常很誇張、成交量很小）
        let v = null, main = '', sub = `規模 ${yi(size)} 億｜${e.prem != null ? premTxt(e.prem) : '—'}`;
        if (k === 'prem' || k === 'disc') { if (e.prem == null) continue; v = k === 'prem' ? e.prem : -e.prem; main = premTxt(e.prem); sub = `市價 ${numFmt(e.price, 2)}｜淨值 ${numFmt(e.nav, 2)}｜規模 ${yi(size)} 億`; }
        else if (k === 'in' || k === 'out') {
          if (!e.dUnits) continue;
          const f = e.dUnits * (e.prevNav || e.nav || e.price);
          if ((k === 'in') !== (f > 0)) continue;
          v = Math.abs(f); main = `${f > 0 ? '+' : '-'}${yi(Math.abs(f))} 億`; sub = `單位 ${e.dUnits > 0 ? '+' : ''}${numFmt(e.dUnits / 1000)} 張｜規模 ${yi(size)} 億`;
        } else if (k === 'size') { v = size; main = `${yi(size)} 億`; }
        else if (H && H.s[e.id]) {
          const [u, nav] = H.s[e.id], L = H.days.length;
          let f = 0, n = 0;
          for (let i = Math.max(1, L - 5); i < L; i++) if (u[i] != null && u[i - 1] != null && nav[i] != null) { f += (u[i] - u[i - 1]) * nav[i]; n++; }
          if (!n || (k === 'in5') !== (f > 0)) continue;
          v = Math.abs(f); main = `${f > 0 ? '+' : '-'}${yi(Math.abs(f))} 億`; sub = `近 ${n} 日單位變化｜規模 ${yi(size)} 億`;
        }
        if (v == null) continue;
        rows.push({ id: e.id, name: name(e.id), px: day.get(e.id) || { close: e.price }, cls: (k === 'prem' || k === 'in' || k === 'in5') ? 'up' : (k === 'size' ? 'flat' : 'down'), main, sub, v });
      }
      rows.sort((a, b) => b.v - a.v);
      const any = m.values().next().value || {};
      const lbl = Object.fromEntries(RK_ETF)[k];
      note = `ETF ${lbl}｜${any.live ? '即時' : '收盤'} ${any.date ? any.date.slice(4, 6) + '/' + any.date.slice(6) : ''} ${any.time ? any.time.slice(0, 5) : ''}｜淨值為投信預估${k === 'in5' || k === 'out5' ? `｜歷史從 ${H ? H.days[0].slice(5) : '—'} 起累積` : ''}${k !== 'size' ? '｜規模 5 億以上' : ''}`;
    } else {
      const d = await Mk.load('scores');
      const i = Rank.safe ? 1 : 0;
      rows = Object.entries(d.items).filter(([id, it]) => it[i] != null && day.has(id)).sort((a, b) => b[1][i] - a[1][i] || b[1][1 - i] - a[1][1 - i])
        .map(([id, it]) => ({ id, name: day.get(id).name, px: day.get(id), cls: 'flat', score: it[i], main: '',
          sub: `營收創高 ${it[2] ?? '—'}｜轉折 ${it[3] ?? '—'}｜近高點 ${it[4] ?? '—'}｜估值 ${it[5] ?? '—'}${Rank.safe ? `｜低波動 ${it[6] ?? '—'}` : ''}` }));
      note = `全市場成交金額前 ${d.popN} 大普通股的評分（${Rank.safe ? '穩健' : '積極'}版）｜更新 ${d.asOf.slice(5)}｜點分數看細項`;
    }
    if (seq !== Rank.seq) return;
    sum.innerHTML = `${note}｜★ 在自選清單`;
    Rank.rows = rows = rows.slice(0, 100);
    const panel = Rank.cat === 'screen' && typeof scrPanelHtml === 'function' ? scrPanelHtml() : '';
    if (!rows.length) { box.innerHTML = panel + `<div class="empty-hint">沒有符合的股票${panel ? '<br>試著少勾幾個條件' : ''}</div>`; return; }
    box.innerHTML = panel + rows.map((r, i) => {
      const p = r.px || {};
      return `<div class="rk-row" data-i="${i}">
        <span class="rk-no">${i + 1}</span>
        <div class="rk-name"><b>${mkEsc(r.name || r.id)}</b>${r.score != null ? ` <span class="sc-badge has ${scoreClass(r.score)}" data-score="1">${r.score}</span>` : ''}<br><span class="dim">${r.sector ? '' : `${r.id}${watched.has(r.id) ? ' ★' : ''}　`}${r.sub}</span></div>
        <div class="rk-val">${r.sector ? `<b class="${signClass(p.pct)}">${pctFmt(p.pct)}</b>` : `<b class="${signClass(p.pct)}">${p.close != null ? numFmt(p.close, 2) : '—'}</b> <span class="${signClass(p.pct)}">${p.pct != null ? pctFmt(p.pct) : ''}</span>`}${r.main ? `<br><b class="${r.cls}">${r.main}</b>` : ''}</div>
      </div>`;
    }).join('') + '<div class="branch-note">資料來源：證交所、櫃買中心每天公布的全市場資料（法人約 17:30～19:30、融資約 21:40 更新到這裡），盤中價格來自鉅亨即時報價。資訊整理，非投資建議。</div>';
    box.querySelectorAll('.rk-row').forEach(el => el.addEventListener('click', e => {
      const r = Rank.rows[Number(el.dataset.i)];
      if (e.target.dataset.score) { mkOpenScore(r.id, r.name); return; }
      if (r.sector) {  // 類股 → 看成分股
        Rank.secCode = r.sector;
        $('#rk-list').innerHTML = '';
        const sc = $('#screen-rank .pf-scroll');
        if (sc) sc.scrollTop = 0;
        openRank();
        return;
      }
      const sc = $('#screen-rank .pf-scroll');
      Rank.scroll = sc ? sc.scrollTop : 0;
      Rank.fromRank = true;
      navStocks = Rank.rows.map(x => ({ stock_id: x.id, stock_name: x.name || x.id }));  // 上一檔／下一檔跟著排行順序
      openStock(navStocks[Number(el.dataset.i)]);
    }));
  } catch (e) {
    if (seq === Rank.seq) box.innerHTML = `<div class="error-msg">載入失敗：${e.message}（全市場資料每個交易日 17:30 後更新；網路不穩請稍後再試）</div>`;
  }
}

$('#btn-rank').addEventListener('click', () => { Rank.scroll = 0; $('#rk-list').innerHTML = ''; openRank(); });
$('#btn-rk-back').addEventListener('click', () => { Rank.fromRank = false; goHome(); });
$('#rk-cat').addEventListener('click', e => {
  const c = e.target.dataset.cat;
  if (!c) return;
  Rank.cat = c;
  Rank.secCode = null;
  localStorage.setItem('rk_cat', c);
  if (!rkIsInst() && Rank.dir.startsWith('streak')) Rank.dir = 'buy';
  $('#rk-list').innerHTML = '';
  openRank();
});
$('#rk-sub').addEventListener('click', e => {
  const ds = e.target.dataset;
  if (ds.dir) { Rank.dir = ds.dir; localStorage.setItem('rk_dir', ds.dir); }
  else if (ds.n) { Rank.n = Number(ds.n); localStorage.setItem('rk_n', ds.n); }
  else if (ds.safe) Rank.safe = ds.safe === '1';
  else if (ds.etf) Rank.etf = ds.etf;
  else if (ds.sec) Rank.sec = ds.sec;
  else if (ds.dtk) Rank.dtk = ds.dtk;
  else if (ds.bigk) Rank.bigk = ds.bigk;
  else if (ds.annk) Rank.annk = ds.annk;
  else if (ds.valk) Rank.valk = ds.valk;
  else if (ds.revk) Rank.revk = ds.revk;
  else if (ds.sblk) Rank.sblk = ds.sblk;
  else if (ds.secback) Rank.secCode = null;
  else if (ds.seckind) { Rank.secKind = ds.seckind; localStorage.setItem('rk_seckind', ds.seckind); }
  else if (ds.toggle === 'noetf') { Rank.noEtf = !Rank.noEtf; localStorage.setItem('rk_noetf', Rank.noEtf ? '1' : '0'); }
  else if (ds.toggle === 'liq') { Rank.liq = !Rank.liq; localStorage.setItem('rk_liq', Rank.liq ? '1' : '0'); }
  else return;
  openRank();
});
// 從排行進個股 → 返回鍵回到排行原本的位置（跟雷達同一招：capture 階段先攔）
$('#btn-back').addEventListener('click', async e => {
  if (!Rank.fromRank) return;
  e.stopImmediatePropagation();
  Rank.fromRank = false;
  stopRtTimer();
  await openRank();
  const sc = $('#screen-rank .pf-scroll');
  if (sc) sc.scrollTop = Rank.scroll || 0;
}, true);

// ---------------------------------------------------------------- 自動更新：不管停在哪一頁，資料有新的就換上
const mkActive = id => { const el = $(id); return !!el && el.classList.contains('active'); };
let mkTabAt = {};  // 個股各頁籤上次載入時間
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('.tab-btn'); if (b) mkTabAt[b.dataset.tab] = Date.now(); }, true);

async function mkAutoRefresh(resume) {
  if (document.hidden) return;
  if (homeActive() && (resume || twMarketOpen())) paintIndexBar();
  if (mkActive('#screen-rank')) { if (resume || (twMarketOpen() && rkIsPrice())) openRank(); }
  if (resume && mkActive('#screen-radar') && typeof openRadar === 'function') openRadar();
  if (resume && mkActive('#screen-portfolio') && typeof openPortfolio === 'function' && !mkActive('#modal')) openPortfolio(true);
  // 官方資料檔有新版（法人 17:30／19:30、資券 21:40）→ 正在看的法人／資券／日K 重新載入
  for (const name of ['inst', 'margin', 'scores']) {
    let d;
    try { d = await Mk.load(name); } catch (e) { continue; }
    const stamp = d.updated || d.asOf, old = Mk.stamp[name];
    Mk.stamp[name] = stamp;
    if (!old || old === stamp || !mkActive('#screen-detail') || !currentStock) continue;
    if (name === 'inst' && mkActive('#pane-inst')) loadInstitutional();
    if (name === 'inst' && mkActive('#pane-kline') && klineInterval === '1d') loadKline(true);
    if (name === 'margin' && mkActive('#pane-margin')) loadMargin();
  }
  // 分點：券商頁面傍晚才更新，停在這頁超過 20 分鐘就重抓一次
  if (mkActive('#screen-detail') && currentStock && mkActive('#pane-branch') && Date.now() - (mkTabAt.branch || 0) > 12e5) { mkTabAt.branch = Date.now(); loadBranch(); }
}
setInterval(() => mkAutoRefresh(false), 20000);
(() => {
  let last = 0;
  const on = () => { if (document.hidden || Date.now() - last < 1500) return; last = Date.now(); mkAutoRefresh(true); };
  document.addEventListener('visibilitychange', on);
  window.addEventListener('pageshow', on);
  window.addEventListener('focus', on);
})();
paintIndexBar();
mkAutoRefresh(false);

// ---------------------------------------------------------------- 上市／上櫃以官方最新資料為準（2026-10-14）
// FinMind 股票清單裡「上櫃轉上市」的股票新舊兩筆都在（例：矽格、鈺邦、富鼎），marketFor 可能拿到舊的 → 後端被記錯市場。
// 現在先看 mk/day.json（證交所／櫃買當天資料），沒有才用 FinMind。擁有者的清單若有記錯的，每天自動更正一次（fixMarket）。
(() => {
  const fmFor = marketFor;
  marketFor = id => {
    const c = Mk.cache.day, r = c && c.data._map && c.data._map.get(id);
    return r && r.mkt ? r.mkt : fmFor(id);
  };
})();
Mk.dayMap().then(map => {
  if (!isOwner()) return;
  const key = 'mkfix_' + twToday();
  if (localStorage.getItem(key)) return;
  setTimeout(async () => {  // 等清單從後端同步完再比（本機清單不存市場，要看後端那份）
    try {
      const remote = await Backend.list();
      const fix = remote.filter(s => s.market && map.has(s.stock_id) && map.get(s.stock_id).mkt && s.market !== map.get(s.stock_id).mkt);
      if (fix.length) {
        await Backend.bulkUpsert(fix.map(s => ({ stock_id: s.stock_id, stock_name: s.stock_name, market: map.get(s.stock_id).mkt, fixMarket: true })));
        console.info('已更正上市/上櫃：', fix.map(s => s.stock_id).join(','));
      }
      localStorage.setItem(key, '1');
    } catch (e) { console.warn('上市/上櫃更正失敗', e); }
  }, 15000);
}).catch(() => {});
