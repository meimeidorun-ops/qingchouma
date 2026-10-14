// 全市場資料（2026-10-13）：排行榜、大盤指數、任何一檔的法人／資券／評分，不限自選清單。
// 資料：mk/day.json、inst.json、margin.json、scores.json（台股AI盯盤Agent/market_export.py 每天 17:10、21:40 產生並部署，
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
    if (!d._map) d._map = new Map(d.rows.map(r => [r[0], { id: r[0], name: r[1], close: r[2], pct: r[3], vol: r[4], money: r[5], pct5: r[6], pct20: r[7], mkt: r[8] }]));
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
// 最近 40 個交易日用 mk（官方、當天 17:10／21:40 就有、不耗 FinMind 額度）；更早的歷史才用 FinMind。
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
async function mkOpenScore(id, name) {
  const d = await Mk.load('scores');
  const it = d.items[id];
  if (!it) return;
  const bar = v => v == null ? '<span class="dim">沒有資料</span>' : `<span style="display:inline-block;width:90px;height:6px;border-radius:3px;background:var(--border);vertical-align:middle;margin-right:8px"><span style="display:block;height:6px;border-radius:3px;width:${v}%;background:${v >= 70 ? '#e6413c' : v >= 50 ? '#f2c744' : '#8b949e'}"></span></span>${v}`;
  $('#modal-card').innerHTML = `<h3 style="margin:0 0 4px">${mkEsc(name || id)} <span class="dim" style="font-size:13px">${id}</span></h3>
    <div style="margin:6px 0 12px">積極版 <b class="sc-badge has ${scoreClass(it[0])}">${it[0] ?? '—'}</b>　穩健版 <b class="sc-badge has ${scoreClass(it[1])}">${it[1] ?? '—'}</b></div>
    ${MK_PARTS.map(([lbl, i]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:14px"><span>${lbl}</span><span>${bar(it[i])}</span></div>`).join('')}
    <div style="padding:6px 0;font-size:14px;display:flex;justify-content:space-between"><span>近四季本益比</span><span>${it[7] == null ? '—（虧損或無資料）' : it[7] + ' 倍'}</span></div>
    <p class="hint" style="margin-top:10px">每一項＝在全市場成交金額前 ${d.popN} 大普通股裡的百分位（0～100，越高越好）。積極版＝前四項平均；穩健版再加低波動。更新 ${d.asOf.slice(5)}。規則計算，非投資建議。</p>
    <button class="save" id="mk-sc-close" style="width:100%;margin-top:6px">關閉</button>`;
  $('#modal').classList.add('active');
  $('#mk-sc-close').onclick = closeModal;
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
const RK_CATS = [['up', '漲幅'], ['down', '跌幅'], ['money', '成交值'], ['f', '外資'], ['t', '投信'], ['d', '自營'], ['margin', '融資'], ['score', '評分']];
const rkIsPrice = () => ['up', 'down', 'money'].includes(Rank.cat);
const rkIsInst = () => ['f', 't', 'd'].includes(Rank.cat);
const rkIsEtf = id => id.startsWith('00');

function paintRankBars() {
  $('#rk-cat').innerHTML = RK_CATS.map(([k, l]) => `<button class="range-btn${Rank.cat === k ? ' active' : ''}" data-cat="${k}">${l}</button>`).join('');
  const btn = (attr, v, lbl, on) => `<button class="range-btn${on ? ' active' : ''}" data-${attr}="${v}">${lbl}</button>`;
  let sub = '';
  if (rkIsInst()) {
    sub = [['buy', '買超'], ['sell', '賣超'], ['streakBuy', '連買'], ['streakSell', '連賣']].map(([v, l]) => btn('dir', v, l, Rank.dir === v)).join('') +
      (Rank.dir.startsWith('streak') ? '' : '<span style="width:8px"></span>' + [1, 5, 10, 20].map(n => btn('n', n, `${n}日`, Rank.n === n)).join(''));
  } else if (Rank.cat === 'margin') {
    sub = [['buy', '增加'], ['sell', '減少']].map(([v, l]) => btn('dir', v, l, (Rank.dir === 'sell') === (v === 'sell'))).join('') +
      '<span style="width:8px"></span>' + [1, 5, 10, 20].map(n => btn('n', n, `${n}日`, Rank.n === n)).join('');
  } else if (Rank.cat === 'score') {
    sub = btn('safe', '0', '積極版', !Rank.safe) + btn('safe', '1', '穩健版', Rank.safe);
  }
  if (Rank.cat !== 'score') sub += '<span style="width:8px"></span>' + btn('toggle', 'noetf', '排除 ETF', Rank.noEtf) + (rkIsPrice() && Rank.cat !== 'money' ? btn('toggle', 'liq', '成交值≥1億', Rank.liq) : '');
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
    if (rkIsPrice() || rkIsInst() || Rank.cat === 'margin') {
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
      const k = { f: 0, t: 1, d: 2 }[Rank.cat], L = d.days.length;
      const streak = Rank.dir.startsWith('streak'), sgn = Rank.dir === 'buy' || Rank.dir === 'streakBuy' ? 1 : -1;
      for (const id in d.s) {
        if (!base(id) || !day.has(id)) continue;
        const a = d.s[id][k], c = day.get(id).close || 0;
        if (streak) {
          let n = 0, tot = 0;
          while (n < L && a[L - 1 - n] * sgn > 0) { tot += a[L - 1 - n]; n++; }
          if (n >= 3) rows.push({ id, v: n, v2: Math.abs(tot) * c, lots: tot });
        } else {
          let tot = 0;
          for (let i = Math.max(0, L - Rank.n); i < L; i++) tot += a[i];
          if (tot * sgn > 0) rows.push({ id, v: Math.abs(tot) * c, v2: 0, lots: tot });
        }
      }
      rows.sort((a, b) => b.v - a.v || b.v2 - a.v2);
      rows = rows.map(r => ({ id: r.id, name: day.get(r.id).name, px: px.get(r.id) || day.get(r.id), cls: sgn > 0 ? 'up' : 'down',
        main: streak ? `連${sgn > 0 ? '買' : '賣'} ${r.v} 天` : `${sgn > 0 ? '+' : '-'}${numFmt(r.v / 1e5, 1)} 億`,
        sub: `${streak ? '合計 ' : ''}${r.lots > 0 ? '+' : ''}${numFmt(r.lots)} 張${streak ? `（約 ${numFmt(r.v2 / 1e5, 1)} 億）` : ''}` }));
      note = `${{ f: '外資', t: '投信', d: '自營商' }[Rank.cat]}｜資料日 ${d.days[L - 1].slice(5)}${streak ? '（連續 3 天以上）' : `，近 ${Math.min(Rank.n, L)} 日，依金額排序`}｜更新 ${d.updated.slice(5)}`;
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
    if (!rows.length) { box.innerHTML = '<div class="empty-hint">沒有符合的股票</div>'; return; }
    box.innerHTML = rows.map((r, i) => {
      const p = r.px || {};
      return `<div class="rk-row" data-i="${i}">
        <span class="rk-no">${i + 1}</span>
        <div class="rk-name"><b>${mkEsc(r.name || r.id)}</b>${r.score != null ? ` <span class="sc-badge has ${scoreClass(r.score)}" data-score="1">${r.score}</span>` : ''}<br><span class="dim">${r.id}${watched.has(r.id) ? ' ★' : ''}　${r.sub}</span></div>
        <div class="rk-val"><b class="${signClass(p.pct)}">${p.close != null ? numFmt(p.close, 2) : '—'}</b> <span class="${signClass(p.pct)}">${p.pct != null ? pctFmt(p.pct) : ''}</span>${r.main ? `<br><b class="${r.cls}">${r.main}</b>` : ''}</div>
      </div>`;
    }).join('') + '<div class="branch-note">資料來源：證交所、櫃買中心每天公布的全市場資料（法人約 17:10、融資約 21:40 更新到這裡），盤中價格來自鉅亨即時報價。資訊整理，非投資建議。</div>';
    box.querySelectorAll('.rk-row').forEach(el => el.addEventListener('click', e => {
      const r = Rank.rows[Number(el.dataset.i)];
      if (e.target.dataset.score) { mkOpenScore(r.id, r.name); return; }
      const sc = $('#screen-rank .pf-scroll');
      Rank.scroll = sc ? sc.scrollTop : 0;
      Rank.fromRank = true;
      navStocks = Rank.rows.map(x => ({ stock_id: x.id, stock_name: x.name || x.id }));  // 上一檔／下一檔跟著排行順序
      openStock(navStocks[Number(el.dataset.i)]);
    }));
  } catch (e) {
    if (seq === Rank.seq) box.innerHTML = `<div class="error-msg">載入失敗：${e.message}（全市場資料每天 17:10 後更新）</div>`;
  }
}

$('#btn-rank').addEventListener('click', () => { Rank.scroll = 0; $('#rk-list').innerHTML = ''; openRank(); });
$('#btn-rk-back').addEventListener('click', () => { Rank.fromRank = false; goHome(); });
$('#rk-cat').addEventListener('click', e => {
  const c = e.target.dataset.cat;
  if (!c) return;
  Rank.cat = c;
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
  // 官方資料檔有新版（法人 17:10、資券 21:40）→ 正在看的法人／資券／日K 重新載入
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
