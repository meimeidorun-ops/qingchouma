// ETF：折溢價、規模、申購贖回、受益人數（2026-11-20）
// 即時：快速後端 action=etf（證交所 MIS all_etf.txt，各投信預估淨值，約 15 秒更新）；失敗用 mk/etf.json（每天收盤後）。
// 歷史：mk/etf_hist.json（Agent etf_export.py 每天存一份，2026-11-20 起累積）；受益人數：集保股權分散表（每週，Backend.holders）。
const ETF = { live: null, liveAt: 0 };
const isEtfId = id => /^00/.test(String(id || ''));

// 回傳 Map(代號 → {id, units, dUnits, price, nav, prem, prevNav, date, time, live})
async function etfData(force = false) {
  if (!force && ETF.live && Date.now() - ETF.liveAt < 20000) return ETF.live;
  let rows = null, live = false;
  if (localStorage.getItem('fast_off') !== '1') {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const j = await (await fetch(`${FAST_URL}?action=etf`, { signal: ctl.signal, cache: 'no-store' })).json();
      clearTimeout(t);
      if (j.status === 200 && j.data && j.data.length) { rows = j.data; live = true; }
    } catch (e) { /* 改用每日檔 */ }
  }
  const m = new Map();
  if (live) {
    for (const r of rows) m.set(r[0], { id: r[0], units: r[1], dUnits: r[2], price: r[3], nav: r[4], prem: r[5], prevNav: r[6], date: r[7], time: r[8], live: true });
  } else {
    const d = await Mk.load('etf');
    for (const r of d.rows) m.set(r[0], { id: r[0], name: r[1], units: r[2], dUnits: r[3], price: r[4], nav: r[5], prem: r[6], prevNav: r[7], date: (d.date || '').replace(/-/g, ''), time: '', live: false });
  }
  ETF.live = m;
  ETF.liveAt = Date.now();
  return m;
}

const yi = v => v == null ? '—' : numFmt(v / 1e8, Math.abs(v) >= 1e10 ? 0 : 1);  // 元 → 億
const premCls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
const premTxt = v => v == null ? '—' : `${v > 0 ? '溢價 ' : v < 0 ? '折價 ' : ''}${Math.abs(v).toFixed(2)}%`;

async function loadEtf() {
  const stock = currentStock, tk = tabTicket('etf');
  const box = $('#etf-body');
  box.innerHTML = '<div class="loading">載入中…</div>';
  if (typeof loadDividends === 'function') loadDividends(stock, '#div-etf', 'etf', tk);
  try {
    const [m, H] = await Promise.all([etfData(), Mk.load('etf_hist').catch(() => null)]);
    if (!tabLive('etf', tk, stock)) return;
    const e = m.get(stock.stock_id);
    if (!e) { box.innerHTML = '<div class="error-msg">證交所沒有這檔的淨值資料（可能是剛上市或已下市）</div>'; return; }
    const size = e.units != null && e.nav != null ? e.units * e.nav : null;
    const flow = e.dUnits != null && e.nav != null ? e.dUnits * (e.prevNav || e.nav) : null;
    const when = e.date ? `${e.date.slice(4, 6)}/${e.date.slice(6, 8)}${e.time ? ' ' + e.time.slice(0, 5) : ''}` : '';
    const h = H && H.s[stock.stock_id];
    let histHtml = '';
    if (h) {
      const days = H.days, n = days.length;
      const rows = [];
      for (let i = n - 1; i >= 0 && rows.length < 30; i--) {
        if (h[0][i] == null) continue;
        const du = i > 0 && h[0][i - 1] != null ? h[0][i] - h[0][i - 1] : null;
        rows.push(`<tr><td>${days[i].slice(5)}</td><td>${h[2][i] != null ? numFmt(h[2][i], 2) : '—'}</td><td>${h[1][i] != null ? numFmt(h[1][i], 2) : '—'}</td>
          <td class="${premCls(h[3][i])}">${h[3][i] != null ? (h[3][i] > 0 ? '+' : '') + h[3][i].toFixed(2) + '%' : '—'}</td>
          <td class="${signClass(du)}">${du == null ? '—' : (du > 0 ? '+' : '') + numFmt(du / 1000)}</td>
          <td class="${signClass(du)}">${du == null || h[1][i] == null ? '—' : (du > 0 ? '+' : '') + yi(du * h[1][i])}</td>
          <td>${h[1][i] != null ? yi(h[0][i] * h[1][i]) : '—'}</td></tr>`);
      }
      histHtml = `
        <div class="section-label">每日折溢價與規模</div>
        <div class="chart-container" id="chart-etf" style="height:240px"></div>
        <div class="legend-row"><span><span class="dot" style="background:#f59e0b"></span>折溢價%（左軸）</span><span><span class="dot" style="background:#7aa2f7"></span>規模 億（右軸）</span></div>
        <div class="table-wrap"><table class="data-table compact"><thead><tr><th>日期</th><th>市價</th><th>淨值</th><th>折溢價</th><th>單位增減(張)</th><th>估計金額(億)</th><th>規模(億)</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
        ${n < 20 ? `<p class="hint" style="padding:4px 16px">證交所不提供歷史資料，從 ${days[0].slice(5)} 開始每天收盤後自動累積（目前 ${n} 天）。</p>` : ''}`;
    }
    box.innerHTML = `
      <div class="etf-card">
        <div class="etf-big"><span class="dim">折溢價</span><b class="${premCls(e.prem)}">${premTxt(e.prem)}</b><span class="dim">${e.live ? '即時' : '收盤'} ${when}</span></div>
        <div class="etf-grid">
          <div><span class="dim">市價</span><b>${e.price != null ? numFmt(e.price, 2) : '—'}</b></div>
          <div><span class="dim">預估淨值</span><b>${e.nav != null ? numFmt(e.nav, 2) : '—'}</b></div>
          <div><span class="dim">前日淨值</span><b>${e.prevNav != null ? numFmt(e.prevNav, 2) : '—'}</b></div>
          <div><span class="dim">規模</span><b>${yi(size)} 億</b></div>
          <div><span class="dim">發行張數</span><b>${e.units != null ? numFmt(e.units / 1000) : '—'}</b></div>
          <div><span class="dim">單位增減</span><b class="${signClass(e.dUnits)}">${e.dUnits == null ? '—' : (e.dUnits > 0 ? '+' : '') + numFmt(e.dUnits / 1000) + ' 張'}</b></div>
        </div>
        <div class="etf-flow ${signClass(flow)}">${flow == null || !e.dUnits ? '今天發行單位沒有變化（沒有淨申購或淨贖回）'
          : `${e.dUnits > 0 ? '淨申購（資金流入）' : '淨贖回（資金流出）'}約 ${yi(Math.abs(flow))} 億元`}</div>
        <p class="hint">溢價＝市價比淨值貴（買貴了）；折價＝市價比淨值便宜。溢價太高時買進，等溢價收斂就會吃虧，<b>溢價超過 1% 要特別小心</b>。
          「單位增減」是投信公告的發行單位變化，增加＝有人向投信申購（錢流進這檔 ETF）、減少＝贖回。淨值是投信盤中估算，跟收盤後正式淨值會有小差距。</p>
      </div>
      ${histHtml}
      <div class="section-label">受益人數（每週，集保）</div>
      <div class="chart-container" id="chart-etf-ppl" style="height:200px"><div class="loading">載入中…</div></div>
      <p class="hint" style="padding:4px 16px 16px">受益人數增加＝持有這檔 ETF 的人變多。三大法人買賣在「法人買賣超」頁籤。</p>`;
    if (h) etfDrawHist(H, h);
    etfDrawPeople(stock, tk);
  } catch (err) {
    if (tabLive('etf', tk, stock)) box.innerHTML = `<div class="error-msg">載入失敗：${err.message}</div>`;
  }
}

function etfDrawHist(H, h) {
  const el = $('#chart-etf');
  if (!el) return;
  const chart = makeChart(el, { leftPriceScale: { visible: true, borderColor: 'rgba(255,255,255,0.1)' } });
  const pts = (arr, f) => H.days.map((d, i) => ({ time: d, value: f(i) })).filter(p => p.value != null && isFinite(p.value));
  const size = chart.addSeries(LightweightCharts.HistogramSeries, { color: 'rgba(122,162,247,0.45)', priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 0);
  size.setData(pts(null, i => h[0][i] != null && h[1][i] != null ? h[0][i] * h[1][i] / 1e8 : null));
  const prem = chart.addSeries(LightweightCharts.LineSeries, { color: '#f59e0b', lineWidth: 2, priceScaleId: 'left', pointMarkersVisible: true, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } }, 0);
  prem.setData(pts(null, i => h[3][i]));
  prem.createPriceLine({ price: 0, color: 'rgba(255,255,255,0.3)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  showAllBars(chart, H.days.length);
}

async function etfDrawPeople(stock, tk) {
  const el = $('#chart-etf-ppl');
  try {
    const weeks = await Backend.holders(stock.stock_id, 26);
    if (!tabLive('etf', tk, stock) || !el) return;
    if (!weeks || !weeks.length) { el.innerHTML = '<div class="error-msg">查無集保資料</div>'; return; }
    el.innerHTML = '';
    const chart = makeChart(el);
    const s = chart.addSeries(LightweightCharts.AreaSeries, { lineColor: '#7aa2f7', topColor: 'rgba(122,162,247,0.35)', bottomColor: 'rgba(122,162,247,0.02)', lineWidth: 2, priceFormat: { type: 'volume' } }, 0);
    const data = weeks.map(w => ({ time: `${w.d.slice(0, 4)}-${w.d.slice(4, 6)}-${w.d.slice(6, 8)}`, value: (w.ppl || []).slice(0, 15).reduce((a, b) => a + (b || 0), 0) }));
    s.setData(data);
    showAllBars(chart, data.length);
    const a = data[0].value, b = data[data.length - 1].value;
    const note = el.nextElementSibling;
    if (note && a) note.innerHTML = `最新 ${numFmt(b)} 人，${data.length} 週前 ${numFmt(a)} 人（${b >= a ? '+' : ''}${((b / a - 1) * 100).toFixed(1)}%）。受益人數增加＝持有的人變多。三大法人買賣在「法人買賣超」頁籤。`;
  } catch (e) {
    if (el && tabLive('etf', tk, stock)) el.innerHTML = `<div class="error-msg">集保資料載入失敗：${e.message}</div>`;
  }
}

// 清單上 ETF 那一列加折溢價小標籤（有就畫，沒有就算了）
async function etfPaintWatchTags() {
  const rows = $$('#watchlist [data-id]').filter(el => isEtfId(el.dataset.id));
  if (!rows.length) return;
  try {
    const m = await etfData();
    for (const el of rows) {
      const e = m.get(el.dataset.id);
      let tag = el.querySelector('.etf-tag');
      if (!e || e.prem == null) { if (tag) tag.remove(); continue; }
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'etf-tag';
        const host = el.querySelector('.wl-code, .stock-code, .code') || el.querySelector('div');
        if (!host) continue;
        host.appendChild(tag);
      }
      tag.className = `etf-tag ${premCls(e.prem)}`;
      tag.textContent = `${e.prem > 0 ? '溢' : e.prem < 0 ? '折' : ''}${Math.abs(e.prem).toFixed(2)}%`;
    }
  } catch (e) { /* 不影響清單 */ }
}
