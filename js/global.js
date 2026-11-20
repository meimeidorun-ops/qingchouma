// 國際盤／電子盤（2026-11-21）：台指期（含夜盤）、美股指數、美股期貨（電子盤）、台股 ADR 折溢價。
// 鉅亨（手機直連）：台指期 TWF:TXF、小台 TWF:MXF、美股指數 GI:*、ADR USS:*、匯率 FX:USDTWD。
// 美股期貨：鉅亨沒有 → 快速後端 action=yspark（Yahoo ES=F／NQ=F／YM=F／RTY=F）。
const GLB = { timer: null, sel: null, chart: null, q: {}, ys: {} };
const GLB_TW = [
  ['TWS:TSE01:INDEX', '加權指數'], ['TWS:OTC01:INDEX', '櫃買指數'],
  ['TWF:TXF:FUTURES', '台指期（近月）'], ['TWF:MXF:FUTURES', '小台指期'],
];
const GLB_US = [['GI:DJI:INDEX', '道瓊'], ['GI:INX:INDEX', 'S&P 500'], ['GI:IXIC:INDEX', '那斯達克'], ['GI:NDX:INDEX', '那斯達克100'], ['GI:SOX:INDEX', '費城半導體']];
const GLB_FUT = [['YM=F', '道瓊期'], ['ES=F', 'S&P 期'], ['NQ=F', '那斯達克期'], ['RTY=F', '羅素2000期']];
// ADR：美股代號、台股代號、1 張 ADR＝幾股台股
const GLB_ADR = [['USS:TSM:STOCK', '2330', 5, '台積電'], ['USS:UMC:STOCK', '2303', 5, '聯電'], ['USS:ASX:STOCK', '3711', 2, '日月光投控'], ['USS:CHT:STOCK', '2412', 10, '中華電']];

const gTime = sec => { if (!sec) return ''; const s = new Date((sec + 28800) * 1000).toISOString(); return `${s.slice(5, 10).replace('-', '/')} ${s.slice(11, 16)}`; };
const gSg = v => v == null ? '' : `${v > 0 ? '+' : ''}${numFmt(v, 2)}`;

// 台指期現在是日盤（08:45～13:45）還是夜盤（15:00～隔天 05:00）
function txSession(sec) {
  if (!sec) return '';
  const h = new Date((sec + 28800) * 1000).getUTCHours() + new Date((sec + 28800) * 1000).getUTCMinutes() / 60;
  return h >= 8.75 && h <= 13.75 ? '日盤' : (h >= 15 || h <= 5) ? '夜盤' : '收盤';
}

async function glbFetch() {
  const syms = [...GLB_TW, ...GLB_US].map(x => x[0]).concat(GLB_ADR.map(a => a[0]), GLB_ADR.map(a => `TWS:${a[1]}:STOCK`), ['FX:USDTWD:FOREX']);
  const [cn, ys] = await Promise.allSettled([
    cnyesGet('/v2/quote/quotes/' + syms.join(',')),
    (async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      try {
        const j = await (await fetch(`${FAST_URL}?action=yspark&s=${encodeURIComponent(GLB_FUT.map(f => f[0]).join(','))}`, { signal: ctl.signal, cache: 'no-store' })).json();
        return j.status === 200 ? j.data : {};
      } finally { clearTimeout(t); }
    })(),
  ]);
  if (cn.status === 'fulfilled') {
    for (const d of cn.value || []) {
      // 回傳的 200010 是代號（不含前綴），用名稱以外的欄位對回完整代號
      const key = syms.find(s => s.split(':')[1] === d['200010']);  // 回傳的 200010 只有中間那段代號
      if (key) GLB.q[key] = { price: d['6'], chg: d['11'], pct: d['56'], prev: d['21'], t: d['200007'], name: d['200009'] };
    }
  }
  if (ys.status === 'fulfilled') GLB.ys = ys.value || {};
  return cn.status === 'fulfilled';
}

function glbRow(key, label, q, extra = '') {
  if (!q || q.price == null) return `<div class="glb-row dim" data-k="${key}"><span>${label}</span><span>—</span></div>`;
  const cls = signClass(q.chg);
  return `<div class="glb-row${GLB.sel === key ? ' on' : ''}" data-k="${key}">
    <div class="glb-name">${label}<span class="dim">${extra}${q.t ? ' ' + gTime(q.t) : ''}</span></div>
    <div class="glb-val"><b class="${cls}">${numFmt(q.price, 2)}</b><span class="${cls}">${gSg(q.chg)}（${pctFmt(q.pct)}）</span></div>
  </div>`;
}

function glbPaint() {
  const box = $('#glb-body');
  if (!box) return;
  const Q = GLB.q;
  const tx = Q['TWF:TXF:FUTURES'], twse = Q['TWS:TSE01:INDEX'];
  const sess = tx ? txSession(tx.t) : '';
  // 期現貨價差：只有日盤時加權指數也在跑，才有意義
  const basis = tx && twse && sess === '日盤' ? tx.price - twse.price : null;
  const tw = GLB_TW.map(([k, l]) => glbRow(k, l, Q[k], k.startsWith('TWF:') && sess ? `　${sess}` : '')).join('');
  const us = GLB_US.map(([k, l]) => glbRow(k, l, Q[k])).join('');
  const fut = GLB_FUT.map(([k, l]) => {
    const y = GLB.ys[k];
    const q = y ? { price: y.price, chg: y.prev != null ? y.price - y.prev : null, pct: y.prev ? (y.price / y.prev - 1) * 100 : null, t: y.t } : null;
    return glbRow(k, l, q, '　電子盤');
  }).join('');
  const fx = Q['FX:USDTWD:FOREX'];
  const adr = GLB_ADR.map(([k, tw, ratio, nm]) => {
    const a = Q[k], l = Q[`TWS:${tw}:STOCK`];
    if (!a || a.price == null) return '';
    const twd = fx && fx.price ? a.price * fx.price / ratio : null;
    const prem = twd && l && l.price ? (twd / l.price - 1) * 100 : null;
    const cls = signClass(a.chg);
    return `<div class="glb-row${GLB.sel === k ? ' on' : ''}" data-k="${k}">
      <div class="glb-name">${nm} ADR<span class="dim">　1 ADR＝${ratio} 股${a.t ? '　' + gTime(a.t) : ''}</span>
        <span class="dim">換算 ${twd ? numFmt(twd, 2) : '—'} 元｜台股 ${l && l.price != null ? numFmt(l.price, 2) : '—'}</span></div>
      <div class="glb-val"><b class="${cls}">${numFmt(a.price, 2)}</b><span class="${cls}">${pctFmt(a.pct)}</span>
        <span class="${prem > 0 ? 'up' : prem < 0 ? 'down' : ''}">${prem == null ? '' : `${prem > 0 ? '溢價' : '折價'} ${Math.abs(prem).toFixed(2)}%`}</span></div>
    </div>`;
  }).join('');
  box.innerHTML = `
    <div class="section-label">台股</div>${tw}
    ${basis != null ? `<div class="glb-note">台指期 − 加權＝<b class="${signClass(basis)}">${gSg(basis)}</b> 點（${basis >= 0 ? '正價差' : '逆價差'}）</div>` : ''}
    ${sess === '夜盤' && tx ? `<div class="glb-note">現在是夜盤：台指期漲跌是跟「今天日盤收盤」比，可以先看明天開盤的方向。</div>` : ''}
    <div class="section-label">美股指數</div>${us}
    <div class="section-label">美股期貨（電子盤，幾乎 24 小時交易）</div>${fut}
    <div class="section-label">台股 ADR（美國掛牌）</div>${adr || '<div class="glb-row dim">—</div>'}
    <div class="glb-note">匯率 美元/台幣 ${fx && fx.price ? numFmt(fx.price, 3) : '—'}。ADR 溢價＝ADR 換算台幣後比台股貴多少；台積電 ADR 長期都有溢價，看「變化」比看絕對值有用。美股盤中（台灣晚上）ADR 的漲跌常被拿來猜隔天台股開盤。</div>`;
  box.querySelectorAll('.glb-row[data-k]').forEach(el => el.addEventListener('click', () => {
    GLB.sel = el.dataset.k;
    glbPaint();
    glbDrawChart();
    const c = $('#glb-chart');
    if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

async function glbDrawChart() {
  const el = $('#glb-chart'), note = $('#glb-chart-note');
  const k = GLB.sel;
  if (!el || !k) return;
  let pts = [], prev = null, label = '';
  try {
    if (GLB.ys[k] || GLB_FUT.some(f => f[0] === k)) {
      const y = GLB.ys[k];
      if (!y) return;
      pts = y.pts.map(([t, c]) => ({ time: t + 28800, value: c }));
      prev = y.prev;
      label = (GLB_FUT.find(f => f[0] === k) || [])[1];
    } else {
      const now = Math.floor(Date.now() / 1000);
      const d = await cnyesGet(`/v1/charting/history?resolution=1&symbol=${k}&from=${now}&to=${now - 86400 * 4}`);
      if (GLB.sel !== k) return;
      // 只留最後一個交易時段（台指期是 15:00 夜盤開始算一天；其他用最後一天）
      const rows = [];
      for (let i = (d.t || []).length - 1; i >= 0; i--) if (d.c[i] != null) rows.push([d.t[i], d.c[i]]);
      if (!rows.length) { el.innerHTML = '<div class="error-msg">沒有走勢資料</div>'; return; }
      const lastT = rows[rows.length - 1][0];
      let start = 0;
      for (let i = rows.length - 1; i > 0; i--) if (rows[i][0] - rows[i - 1][0] > 3 * 3600) { start = i; break; }
      pts = rows.slice(start).filter(r => lastT - r[0] < 86400).map(([t, c]) => ({ time: t + 28800, value: c }));
      const q = GLB.q[k];
      prev = q ? q.prev : null;
      label = ([...GLB_TW, ...GLB_US].find(x => x[0] === k) || [])[1] || (GLB_ADR.find(a => a[0] === k) || [])[3] + ' ADR';
    }
  } catch (e) { el.innerHTML = '<div class="error-msg">走勢載入失敗</div>'; return; }
  el.innerHTML = '';
  const chart = makeChart(el, { timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: true, secondsVisible: false } });
  const base = prev ?? (pts[0] && pts[0].value);
  const s = chart.addSeries(LightweightCharts.BaselineSeries, {
    baseValue: { type: 'price', price: base },
    topLineColor: UP_COLOR, topFillColor1: 'rgba(230,65,60,0.25)', topFillColor2: 'rgba(230,65,60,0.02)',
    bottomLineColor: DOWN_COLOR, bottomFillColor1: 'rgba(31,163,99,0.02)', bottomFillColor2: 'rgba(31,163,99,0.25)', lineWidth: 2,
  }, 0);
  s.setData(pts);
  if (base != null) s.createPriceLine({ price: base, color: 'rgba(255,255,255,0.35)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '昨收' });
  showAllBars(chart, pts.length);
  if (note) note.textContent = `${label} 當天走勢（虛線＝昨收／前一盤收盤）。點其他列切換。`;
}

async function openGlobal() {
  showScreen('screen-global');
  if (!GLB.sel) GLB.sel = 'TWF:TXF:FUTURES';
  $('#glb-body').innerHTML = '<div class="loading">載入中…</div>';
  await glbFetch();
  glbPaint();
  glbDrawChart();
  clearInterval(GLB.timer);
  let n = 0;
  // 數字每 20 秒更新；走勢圖每 60 秒重畫一次（避免一直閃）
  GLB.timer = setInterval(async () => {
    if (document.hidden || !$('#screen-global').classList.contains('active')) return;
    await glbFetch();
    glbPaint();
    if (++n % 3 === 0) glbDrawChart();
  }, 20000);
}

// ---------------------------------------------------------------- 首頁小條：台指期（日／夜盤）、費半、台積電 ADR
async function paintGlobalBar() {
  const box = $('#glb-bar');
  if (!box) return;
  try {
    const d = await cnyesGet('/v2/quote/quotes/TWF:TXF:FUTURES,GI:SOX:INDEX,USS:TSM:STOCK');
    const by = {};
    for (const x of d || []) by[x['200010']] = x;
    const item = (x, lbl) => x ? `<span class="gb-item"><span class="dim">${lbl}</span> <b class="${signClass(x['11'])}">${pctFmt(x['56'])}</b></span>` : '';
    const tx = by.TXF;
    box.innerHTML = (tx ? `<span class="gb-item"><span class="dim">台指期${txSession(tx['200007']) === '夜盤' ? '夜盤' : ''}</span> <b class="${signClass(tx['11'])}">${numFmt(tx['6'], 0)}</b> <span class="${signClass(tx['11'])}">${pctFmt(tx['56'])}</span></span>` : '') +
      item(by.SOX, '費半') + item(by.TSM, '台積ADR') + '<span class="gb-more">國際盤 ›</span>';
    box.hidden = false;
  } catch (e) { /* 抓不到就不顯示 */ }
}

$('#glb-bar').addEventListener('click', () => openGlobal());
$('#btn-glb-back').addEventListener('click', () => { clearInterval(GLB.timer); goHome(); });
paintGlobalBar();
setInterval(() => { if (!document.hidden && $('#screen-home').classList.contains('active')) paintGlobalBar(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) paintGlobalBar(); });
