// 盤勢溫度計＋個股溫度（2026-11-10）
// 資料 mk/temp.json：台股AI盯盤Agent/market_temp.py 每個交易日跟 market_export 一起產生。
// 這裡只顯示「現在多熱／多冷」和「歷史上同溫度之後的實際表現」，不給買賣指令。
const TEMP_COLORS = ['#3b82f6', '#60a5fa', '#a3a3a3', '#f59e0b', '#ef4444'];
const tempIdx = t => t == null ? 2 : t < 20 ? 0 : t < 40 ? 1 : t < 60 ? 2 : t < 80 ? 3 : 4;
const tempColor = t => TEMP_COLORS[tempIdx(t)];
const tempLabel = t => ['極冷（恐慌）', '偏冷', '中性', '偏熱', '過熱'][tempIdx(t)];
const tSg = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`;
const tCls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';

async function tempData() { return Mk.load('temp'); }

function tempGauge(t) {
  return `<div class="tg-bar"><div class="tg-fill"></div><div class="tg-pin" style="left:${Math.max(0, Math.min(100, t))}%"></div></div>
    <div class="tg-scale"><span>恐慌</span><span>偏冷</span><span>中性</span><span>偏熱</span><span>過熱</span></div>`;
}

// 歷史上同溫度之後：一句白話＋表格
function tempStatsHtml(stats, t, kind) {
  const cur = stats.find(b => t >= b.lo && t <= b.hi);
  const k1 = kind === 'mkt' ? '20' : '20', k3 = '60';
  const who = kind === 'mkt' ? '大盤' : '這類股票';
  let say = '';
  if (cur && cur[k1] && cur[k3]) {
    const a = cur[k1], b = cur[k3];
    say = `歷史上${kind === 'mkt' ? '大盤' : '股票'}在「${cur.label}」之後：1 個月${who}平均 ${tSg(a.avg)}、上漲機率 ${a.up}%；3 個月平均 ${tSg(b.avg)}、上漲機率 ${b.up}%。` +
      `但最差的 10% 情況，3 個月還會${b.p10 < 0 ? `再跌 ${Math.abs(b.p10)}% 以上` : `只漲 ${b.p10}%`}。`;
  }
  const rows = stats.map(b => {
    const a = b[k1] || {}, c = b[k3] || {};
    return `<tr${b === cur ? ' class="on"' : ''}><td><span class="tdot" style="background:${tempColor(b.lo)}"></span>${b.label.slice(0, 2)}</td>
      <td class="${tCls(a.avg)}">${tSg(a.avg)}</td><td>${a.up ?? '—'}%</td><td class="${tCls(c.avg)}">${tSg(c.avg)}</td><td>${c.up ?? '—'}%</td><td class="down">${tSg(c.p10)}</td>
      ${kind === 'mkt' ? `<td>${b.episodes ?? '—'}</td>` : `<td>${c.beat ?? '—'}%</td>`}</tr>`;
  }).join('');
  return `${say ? `<div class="t-say">${say}</div>` : ''}
    <div class="t-wrap"><table class="data-table compact t-tbl"><thead><tr><th>溫度</th><th>1月<br>平均</th><th>1月<br>上漲</th><th>3月<br>平均</th><th>3月<br>上漲</th><th>3月<br>最差10%</th>${kind === 'mkt' ? '<th>段數</th>' : '<th>贏<br>大盤</th>'}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------- 首頁小條
async function paintTempBar() {
  const box = $('#temp-bar');
  if (!box) return;
  try {
    const d = await tempData(), m = d.mkt;
    if (m.temp == null) return;
    box.innerHTML = `<span class="tb-dot" style="background:${tempColor(m.temp)}"></span>盤勢溫度 <b style="color:${tempColor(m.temp)}">${m.temp}</b> ${m.label}<span class="dim">　${m.date.slice(5)} 收盤</span><span class="tb-more">看說明 ›</span>`;
    box.hidden = false;
  } catch (e) { /* 沒有資料就不顯示 */ }
}

// ---------------------------------------------------------------- 大盤頁「盤勢溫度」
const PART_INFO = {
  dev60: ['指數乖離', v => `加權指數離 60 日均線 ${tSg(v)}`],
  r20: ['20 日漲跌', v => `近 20 個交易日 ${tSg(v)}`],
  breadth: ['市場寬度', v => `${v}% 的股票站上自己的 20 日均線`],
  hl: ['新高新低', v => `創 60 日新高比新低${v >= 0 ? '多' : '少'} ${Math.abs(v)}%（占全部股票）`],
  vol: ['波動', v => `20 日年化波動 ${v}%（越高越恐慌，所以反過來算）`],
};
async function paintIndexTemp() {
  const box = $('#ix-temp');
  if (!box) return;
  try {
    const d = await tempData(), m = d.mkt;
    if (m.temp == null) { box.innerHTML = ''; return; }
    const parts = Object.entries(PART_INFO).map(([k, [lbl, fmt]]) => {
      const p = m.parts[k] || {};
      return `<div class="tp-row"><span class="tp-lbl">${lbl}</span><span class="tp-bar"><span style="width:${p.p ?? 0}%;background:${tempColor(p.p)}"></span></span><span class="tp-val">${p.p ?? '—'}</span></div>
        <div class="tp-note">${p.v == null ? '—' : fmt(p.v)}</div>`;
    }).join('');
    box.innerHTML = `<div class="section-label">🌡 盤勢溫度（加權指數，${m.date.slice(5)} 收盤）</div>
      <div class="t-head"><b style="color:${tempColor(m.temp)}">${m.temp}</b><span style="color:${tempColor(m.temp)}">${m.label}</span></div>
      <div style="padding:0 16px">${tempGauge(m.temp)}</div>
      <div class="t-parts">${parts}</div>
      <div class="chart-container" id="ix-temp-chart" style="height:200px"></div>
      <div class="legend-row"><span><span class="dot" style="background:#f59e0b"></span>溫度（左軸 0～100）</span><span><span class="dot" style="background:#8b949e"></span>加權指數（右軸）</span></div>
      <div class="t-stats">${tempStatsHtml(m.stats, m.temp, 'mkt')}</div>
      <p class="hint" style="padding:4px 16px 12px">溫度＝上面 5 項各自跟 ${m.from.slice(0, 4)} 年以來的歷史比（百分位）再平均，0 最冷、100 最熱。每一項只跟「當天以前」的歷史比，不偷看未來。
        表格是 ${m.from.slice(0, 7)} 起 ${m.days} 個交易日，大盤在各溫度區間之後 1 個月（20 日）、3 個月（60 日）的實際漲跌；「段數」是連續落在該區間算一段，段數少的樣本參考價值較低。
        溫度只描述現在的位置和歷史機率，不是買賣訊號；同樣溫度之後的走勢差異很大。</p>`;
    const el = $('#ix-temp-chart');
    const chart = makeChart(el, { leftPriceScale: { visible: true, borderColor: 'rgba(255,255,255,0.1)' } });
    const ts = chart.addSeries(LightweightCharts.LineSeries, { color: '#f59e0b', lineWidth: 2, priceScaleId: 'left', priceLineVisible: false }, 0);
    ts.setData(m.hist.map(h => ({ time: h[0], value: h[1] })));
    chart.priceScale('left').applyOptions({ autoScale: false, scaleMargins: { top: 0.05, bottom: 0.05 } });
    ts.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    [20, 80].forEach(v => ts.createPriceLine({ price: v, color: 'rgba(255,255,255,0.25)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false }));
    const xs = chart.addSeries(LightweightCharts.LineSeries, { color: '#8b949e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
    xs.setData(m.hist.map(h => ({ time: h[0], value: h[2] })));
    showAllBars(chart, m.hist.length);
  } catch (e) { box.innerHTML = ''; }
}

// ---------------------------------------------------------------- 個股溫度
async function paintDetailTemp(stock) {
  const box = $('#dt-temp');
  if (!box) return;
  box.hidden = true;
  try {
    const d = await tempData();
    const s = d.stk.s[stock.stock_id];
    if (!s || currentStock !== stock) return;
    const t = s[0];
    box.innerHTML = `<span class="tb-dot" style="background:${tempColor(t)}"></span>溫度 <b style="color:${tempColor(t)}">${t}</b> ${tempLabel(t)}<span class="dim">　60 日乖離 ${tSg(s[1])}、20 日 ${tSg(s[2])}</span><span class="dt-score-more">說明 ›</span>`;
    box.onclick = () => openStockTemp(stock, s, d);
    box.hidden = false;
  } catch (e) { /* 沒資料不顯示 */ }
}

function openStockTemp(stock, s, d) {
  const t = s[0];
  const row = (lbl, v, note) => `<div class="tp-row"><span class="tp-lbl">${lbl}</span><span class="tp-note" style="padding:0">${note}</span></div>`;
  showModal(`
    <div class="modal-title">${stock.stock_name || stock.stock_id}（${stock.stock_id}）溫度 <b style="color:${tempColor(t)}">${t}</b> ${tempLabel(t)}</div>
    ${tempGauge(t)}
    <div class="t-parts" style="margin-top:8px">
      ${row('60 日乖離', s[1], `股價離 60 日均線 ${tSg(s[1])}`)}
      ${row('20 日漲跌', s[2], `近 20 個交易日 ${tSg(s[2])}`)}
      ${row('RSI14', s[3], `${s[3]}（70 以上偏熱、30 以下偏冷）`)}
      ${row('區間位置', s[4], `在近 60 日最低～最高之間的 ${s[4]}% 位置`)}
    </div>
    <div class="t-stats">${tempStatsHtml(d.stk.stats, t, 'stk')}</div>
    <div class="dim" style="margin-top:6px">個股溫度＝4 項跟全市場所有股票、${d.stk.from} 起所有日子比的百分位平均，只看「價格漲多跌多」，不看基本面和籌碼。
      表格是 ${d.stk.from} 起每 20 個交易日抽樣（${d.stk.samples.toLocaleString()} 筆）的實際表現；可以看到各溫度之後的平均差距不大，所以它比較適合用來知道「現在追高還是撿便宜」，不適合單獨當買賣依據。資料日 ${d.stk.date.slice(5)}。</div>
    <button class="modal-btn" id="tp-close" style="text-align:center;margin-top:12px">關閉</button>`);
  $('#tp-close').addEventListener('click', closeModal);
}

// ---------------------------------------------------------------- 掛勾
$('#temp-bar').addEventListener('click', () => {
  openIndex('tse');
  setTimeout(() => { const el = $('#ix-temp'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 300);
});
paintTempBar();
document.addEventListener('visibilitychange', () => { if (!document.hidden) paintTempBar(); });
