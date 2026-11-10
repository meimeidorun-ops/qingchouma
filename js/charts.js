// Chart rendering helpers built on lightweight-charts v5 (loaded from CDN as
// global LightweightCharts). v5 series are created via chart.addSeries(Type,
// options, paneIndex) — Type constructors (CandlestickSeries, LineSeries,
// HistogramSeries) live on the LightweightCharts namespace in the standalone build.

const UP_COLOR = '#e6413c';   // Taiwan convention: red = up / buy
const DOWN_COLOR = '#1fa363'; // green = down / sell

// 同一個容器再畫新圖前，先把舊圖和它的 ResizeObserver 清掉。
// （2026-10-03 前從沒清過：每次重畫都多一張圖 + 一個監聽器，K 線每分鐘自動更新後會越用越慢。）
function disposeChart(container) {
  if (container._qcRo) container._qcRo.disconnect();
  if (container._qcChart) { try { container._qcChart.remove(); } catch (e) {} }
  container._qcRo = null;
  container._qcChart = null;
}

function makeChart(container, opts = {}) {
  disposeChart(container);
  const chart = LightweightCharts.createChart(container, {
    layout: {
      background: { color: 'transparent' },
      textColor: '#c9d1d9',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.05)' },
      horzLines: { color: 'rgba(255,255,255,0.05)' },
    },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
    timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    // 手機：長按進入「十字線模式」，滑動是移動十字線（不是捲動圖），放開後點一下圖才離開
    trackingMode: { exitMode: LightweightCharts.TrackingModeExitMode ? LightweightCharts.TrackingModeExitMode.OnNextTap : 1 },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: false },
    width: container.clientWidth,
    height: container.clientHeight,
    ...opts,
  });

  const ro = new ResizeObserver(() => {
    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    // 自動更新時要保留使用者的縮放範圍（redrawKline 會設 _keepRange），否則照預設顯示全部
    if (chart._keepRange) chart.timeScale().setVisibleLogicalRange(chart._keepRange);
    else if (chart._barCount) showAllBars(chart, chart._barCount);
  });
  ro.observe(container);
  container._qcChart = chart;
  container._qcRo = ro;

  return chart;
}

// chart.timeScale().fitContent() is unreliable here (it can grossly overestimate
// the logical range, especially with multiple price scales, squeezing all bars
// into a sliver of the chart). We always know exactly how many bars we set, so
// set the visible range explicitly instead.
function showAllBars(chart, count) {
  if (count <= 0) return;
  chart._barCount = count;
  const from = chart._window ? Math.max(0, count - chart._window) : 0;
  chart.timeScale().setVisibleLogicalRange({ from, to: count - 1 });
}

function sma(values, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out.push(sum / period);
    else out.push(null);
  }
  return out;
}

function seriesLine(dates, values) {
  return dates.map((d, i) => ({ time: d, value: values[i] })).filter(p => p.value != null);
}

// rows: array of {date, name, buy, sell} -> Map<date, net> aggregated across all names.
function aggregateInstitutionalByDate(rows, div = 1) {
  const byDate = new Map();
  for (const r of rows) {
    const net = (r.buy - r.sell) / div;
    byDate.set(r.date, (byDate.get(r.date) || 0) + net);
  }
  return byDate;
}

function setPaneHeights(chart, extraPaneCount) {
  const panes = chart.panes();
  if (panes[0]) panes[0].setStretchFactor(3);
  if (panes[1]) panes[1].setStretchFactor(1);
  for (let i = 2; i < panes.length; i++) panes[i].setStretchFactor(1.3);
}

function renderKLine(container, priceRows, opts = {}) {
  const { instRows = [], holdingRows = [], showInst = true, showHolding = false, showBBand = false, indicator = null, intraday = false } = opts;
  container.innerHTML = '';
  const chart = makeChart(container, intraday ? { timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: true, secondsVisible: false } } : {});

  const dates = priceRows.map(r => r.date);
  const closes = priceRows.map(r => r.close);
  const highs = priceRows.map(r => r.max);
  const lows = priceRows.map(r => r.min);

  // ---- Pane 0: candles + MA5/MA20 + optional Bollinger Bands ----
  const candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: UP_COLOR, downColor: DOWN_COLOR,
    borderUpColor: UP_COLOR, borderDownColor: DOWN_COLOR,
    wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
  }, 0);
  candleSeries.setData(priceRows.map(r => ({ time: r.date, open: r.open, high: r.max, low: r.min, close: r.close })));

  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const maSeries5 = chart.addSeries(LightweightCharts.LineSeries, { color: '#f2c744', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
  const maSeries20 = chart.addSeries(LightweightCharts.LineSeries, { color: '#7aa2f7', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
  maSeries5.setData(seriesLine(dates, ma5));
  maSeries20.setData(seriesLine(dates, ma20));

  if (showBBand) {
    const bb = computeBollingerBands(closes, 20, 2);
    const bandOpts = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false };
    const upSeries = chart.addSeries(LightweightCharts.LineSeries, { ...bandOpts, color: 'rgba(242,199,68,0.6)' }, 0);
    const midSeries = chart.addSeries(LightweightCharts.LineSeries, { ...bandOpts, color: 'rgba(255,255,255,0.35)' }, 0);
    const lowSeries = chart.addSeries(LightweightCharts.LineSeries, { ...bandOpts, color: 'rgba(242,199,68,0.6)' }, 0);
    upSeries.setData(seriesLine(dates, bb.upper));
    midSeries.setData(seriesLine(dates, bb.mid));
    lowSeries.setData(seriesLine(dates, bb.lower));
  }

  // ---- Pane 1: volume ----
  const volSeries = chart.addSeries(LightweightCharts.HistogramSeries, { priceFormat: { type: 'volume' } }, 1);
  volSeries.setData(priceRows.map(r => ({
    time: r.date,
    value: r.Trading_Volume / 1000,
    color: r.close >= r.open ? 'rgba(230,65,60,0.5)' : 'rgba(31,163,99,0.5)',
  })));

  let paneIdx = 2;

  // ---- Pane 2 (optional): 三大法人買賣超 ----
  if (showInst && instRows.length) {
    const byDate = aggregateInstitutionalByDate(instRows, 1000);
    const dts = Array.from(byDate.keys()).sort();
    const barSeries = chart.addSeries(LightweightCharts.HistogramSeries, { priceFormat: { type: 'volume' } }, paneIdx);
    barSeries.setData(dts.map(d => ({ time: d, value: byDate.get(d), color: byDate.get(d) >= 0 ? UP_COLOR : DOWN_COLOR })));
    let cum = 0;
    const cumSeries = chart.addSeries(LightweightCharts.LineSeries, { color: '#f2c744', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, priceScaleId: 'inst-cum' }, paneIdx);
    chart.priceScale('inst-cum', paneIdx).applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
    cumSeries.setData(dts.map(d => { cum += byDate.get(d); return { time: d, value: cum }; }));
    paneIdx++;
  }

  // ---- Pane 3 (optional): 大戶持股比例 ----
  if (showHolding && holdingRows.length) {
    const holdSeries = chart.addSeries(LightweightCharts.LineSeries, { color: '#7aa2f7', lineWidth: 2 }, paneIdx);
    holdSeries.setData(holdingRows.map(r => ({ time: r.date, value: r.percent })));
    paneIdx++;
  }

  // ---- Pane 4 (optional): KD or MACD ----
  if (indicator === 'kd') {
    const { k, d } = computeKD(highs, lows, closes);
    const kSeries = chart.addSeries(LightweightCharts.LineSeries, { color: '#e6413c', lineWidth: 1 }, paneIdx);
    const dSeries = chart.addSeries(LightweightCharts.LineSeries, { color: '#7aa2f7', lineWidth: 1 }, paneIdx);
    kSeries.setData(seriesLine(dates, k));
    dSeries.setData(seriesLine(dates, d));
    paneIdx++;
  } else if (indicator === 'macd') {
    const { macd, signal, hist } = computeMACD(closes);
    const histSeries = chart.addSeries(LightweightCharts.HistogramSeries, { priceFormat: { type: 'price', precision: 2, minMove: 0.01 } }, paneIdx);
    histSeries.setData(dates.map((d, i) => ({ time: d, value: hist[i], color: (hist[i] || 0) >= 0 ? UP_COLOR : DOWN_COLOR })).filter(p => p.value != null));
    const macdSeries = chart.addSeries(LightweightCharts.LineSeries, { color: '#f2c744', lineWidth: 1 }, paneIdx);
    const signalSeries = chart.addSeries(LightweightCharts.LineSeries, { color: '#7aa2f7', lineWidth: 1 }, paneIdx);
    macdSeries.setData(seriesLine(dates, macd));
    signalSeries.setData(seriesLine(dates, signal));
    paneIdx++;
  }

  setPaneHeights(chart, paneIdx - 2);
  if (opts.visibleBars) chart._window = opts.visibleBars;
  showAllBars(chart, priceRows.length);
  if (opts.infoEl) klineInfo(chart, opts.infoEl, priceRows, { ma5, ma20, instRows, showInst, volUnit: opts.volUnit || '張', intraday, liveLast: opts.liveLast });
  return chart;
}

// 2026-11-10：K 線上方資訊列。手指長按 K 線（或滑鼠移上去）→ 顯示那一根的日期、開高低收、漲跌、量、MA、法人；
// 放開後十字線留著，點一下圖才消失；沒選時顯示最新一根。
function klineInfo(chart, el, rows, o) {
  const idx = new Map(rows.map((r, i) => [String(r.date), i]));
  const instBy = o.showInst && o.instRows.length ? aggregateInstitutionalByDate(o.instRows, 1000) : null;
  const f = (v, d = 2) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
  const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
  const when = t => {
    if (typeof t === 'number') { const s = new Date((t + 28800) * 1000).toISOString(); return `${s.slice(5, 10).replace('-', '/')} ${s.slice(11, 16)}`; }
    return String(t).slice(5).replace('-', '/');
  };
  const paint = i => {
    const r = rows[i];
    if (!r) { el.innerHTML = ''; return; }
    const prev = i > 0 ? rows[i - 1].close : null;
    const chg = prev ? r.close - prev : null, pct = prev ? chg / prev * 100 : null;
    const isLive = o.liveLast && i === rows.length - 1;
    const inst = instBy && !o.intraday ? instBy.get(r.date) : null;
    const c = cls(chg);
    el.innerHTML = `<span class="kli-date">${when(r.date)}${isLive ? ' <span class="dim">盤中</span>' : ''}</span>` +
      `<span>開 <b class="${cls(prev ? r.open - prev : 0)}">${f(r.open)}</b></span>` +
      `<span>高 <b class="${cls(prev ? r.max - prev : 0)}">${f(r.max)}</b></span>` +
      `<span>低 <b class="${cls(prev ? r.min - prev : 0)}">${f(r.min)}</b></span>` +
      `<span>${isLive ? '現價' : '收'} <b class="${c}">${f(r.close)}</b></span>` +
      (chg != null ? `<span class="${c}">${chg > 0 ? '+' : ''}${f(chg)}（${pct > 0 ? '+' : ''}${f(pct)}%）</span>` : '') +
      `<span>量 ${f(r.Trading_Volume / 1000, o.volUnit === '億' ? 0 : 0)} ${o.volUnit}</span>` +
      (o.ma5[i] != null ? `<span class="kli-ma5">MA5 ${f(o.ma5[i])}</span>` : '') +
      (o.ma20[i] != null ? `<span class="kli-ma20">MA20 ${f(o.ma20[i])}</span>` : '') +
      (inst != null ? `<span>法人 <b class="${cls(inst)}">${inst > 0 ? '+' : ''}${f(inst, 0)}</b> ${o.volUnit === '億' ? '億' : '張'}</span>` : '');
  };
  paint(rows.length - 1);
  chart.subscribeCrosshairMove(p => {
    const i = p && p.time != null ? idx.get(String(p.time)) : undefined;
    paint(i == null ? rows.length - 1 : i);
  });
}

function renderInstitutional(container, rows, div = 1) {
  container.innerHTML = '';
  const chart = makeChart(container);

  const byDate = aggregateInstitutionalByDate(rows, div);
  const dates = Array.from(byDate.keys()).sort();

  const barSeries = chart.addSeries(LightweightCharts.HistogramSeries, { priceFormat: { type: 'volume' } }, 0);
  barSeries.setData(dates.map(d => ({
    time: d,
    value: byDate.get(d),
    color: byDate.get(d) >= 0 ? UP_COLOR : DOWN_COLOR,
  })));

  let cum = 0;
  const cumSeries = chart.addSeries(LightweightCharts.LineSeries, { color: '#f2c744', lineWidth: 2, priceScaleId: 'inst-cum' }, 0);
  chart.priceScale('inst-cum', 0).applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
  cumSeries.setData(dates.map(d => {
    cum += byDate.get(d);
    return { time: d, value: cum };
  }));

  showAllBars(chart, dates.length);
  return chart;
}

// Intraday (即時) chart: a baseline line around 昨收 (red above / green below) over a
// fixed 09:00-13:30 axis, with per-minute volume underneath. Returns a handle;
// call setRealtimeData(handle, intra) to (re)fill it without rebuilding the chart.
function renderRealtime(container, prevClose) {
  container.innerHTML = '';
  const chart = makeChart(container, { timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: true, secondsVisible: false } });
  const line = chart.addSeries(LightweightCharts.BaselineSeries, {
    baseValue: { type: 'price', price: prevClose },
    topLineColor: UP_COLOR, topFillColor1: 'rgba(230,65,60,0.28)', topFillColor2: 'rgba(230,65,60,0.02)',
    bottomLineColor: DOWN_COLOR, bottomFillColor1: 'rgba(31,163,99,0.02)', bottomFillColor2: 'rgba(31,163,99,0.28)',
    lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    autoscaleInfoProvider: (original) => {
      const r = original();
      if (!r) return r;
      const dev = Math.max(Math.abs(r.priceRange.maxValue - prevClose), Math.abs(prevClose - r.priceRange.minValue), prevClose * 0.005);
      return { priceRange: { minValue: prevClose - dev * 1.1, maxValue: prevClose + dev * 1.1 }, margins: r.margins };
    },
  }, 0);
  line.createPriceLine({ price: prevClose, color: '#8b949e', lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: '昨收' });
  const vol = chart.addSeries(LightweightCharts.HistogramSeries, {
    priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false,
  }, 1);
  const panes = chart.panes();
  panes[0].setStretchFactor(3);
  if (panes[1]) panes[1].setStretchFactor(1);
  return { chart, line, vol, filled: false };
}

function setRealtimeData(handle, intra) {
  const off = intra.gmtoffset;
  const dayStart = Math.floor((intra.bars[0].t + off) / 86400) * 86400;
  const open = dayStart + 9 * 3600;
  const close = dayStart + 13.5 * 3600;
  const byT = new Map(intra.bars.map(b => [b.t + off, b]));
  const lineData = [], volData = [];
  for (let t = open; t <= close; t += 60) {
    const b = byT.get(t);
    if (b) {
      lineData.push({ time: t, value: b.close });
      volData.push({ time: t, value: b.vol / 1000, color: b.close >= b.open ? 'rgba(230,65,60,0.6)' : 'rgba(31,163,99,0.6)' });
    } else {
      lineData.push({ time: t });
      volData.push({ time: t });
    }
  }
  handle.line.setData(lineData);
  handle.vol.setData(volData);
  showAllBars(handle.chart, lineData.length);
}

// big/retail/price: arrays of {time:'YYYY-MM-DD', value}. Big on the right axis,
// retail on the left axis, price as a hidden-axis overlay.
function renderHolders(container, big, retail, price, precision = 2) {
  container.innerHTML = '';
  const chart = makeChart(container, { leftPriceScale: { visible: true, borderColor: 'rgba(255,255,255,0.1)' } });
  const fmt = { type: 'price', precision, minMove: Math.pow(10, -precision) };
  const opts = { lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: fmt };

  const pxSeries = chart.addSeries(LightweightCharts.LineSeries, { ...opts, color: '#c9d1d9', lineWidth: 1, priceScaleId: 'px', lastValueVisible: false, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } }, 0);
  chart.priceScale('px', 0).applyOptions({ visible: false, scaleMargins: { top: 0.1, bottom: 0.1 } });
  const retailSeries = chart.addSeries(LightweightCharts.LineSeries, { ...opts, color: '#1fa363', priceScaleId: 'left' }, 0);
  const bigSeries = chart.addSeries(LightweightCharts.LineSeries, { ...opts, color: '#e6413c', priceScaleId: 'right' }, 0);
  pxSeries.setData(price);
  retailSeries.setData(retail);
  bigSeries.setData(big);

  showAllBars(chart, big.length);
  return chart;
}

// 融資融券：融資餘額（紅，右軸）、融券餘額（綠，左軸）、股價（灰，隱藏軸）。單位：張
function renderMargin(container, margin, short, price) {
  container.innerHTML = '';
  const chart = makeChart(container, { leftPriceScale: { visible: true, borderColor: 'rgba(255,255,255,0.1)' } });
  const fmt = { type: 'price', precision: 0, minMove: 1 };
  const opts = { lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: fmt };
  const px = chart.addSeries(LightweightCharts.LineSeries, { ...opts, color: '#c9d1d9', lineWidth: 1, priceScaleId: 'px', lastValueVisible: false, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } }, 0);
  chart.priceScale('px', 0).applyOptions({ visible: false, scaleMargins: { top: 0.1, bottom: 0.1 } });
  const shortSeries = chart.addSeries(LightweightCharts.LineSeries, { ...opts, color: DOWN_COLOR, priceScaleId: 'left' }, 0);
  const marginSeries = chart.addSeries(LightweightCharts.LineSeries, { ...opts, color: UP_COLOR, priceScaleId: 'right' }, 0);
  px.setData(price);
  shortSeries.setData(short);
  marginSeries.setData(margin);
  showAllBars(chart, margin.length);
  return chart;
}

function renderRevenue(container, rows) {
  container.innerHTML = '';
  const chart = makeChart(container);

  const sorted = [...rows].sort((a, b) => (a.revenue_year * 100 + a.revenue_month) - (b.revenue_year * 100 + b.revenue_month));
  const barSeries = chart.addSeries(LightweightCharts.HistogramSeries, { priceFormat: { type: 'volume' } }, 0);
  barSeries.setData(sorted.map(r => ({
    time: r.date,
    value: r.revenue,
    color: 'rgba(122,162,247,0.7)',
  })));

  // YoY line
  const byKey = new Map(sorted.map(r => [`${r.revenue_year}-${r.revenue_month}`, r.revenue]));
  const yoy = chart.addSeries(LightweightCharts.LineSeries, { color: '#f2c744', lineWidth: 2, priceScaleId: 'yoy' }, 0);
  chart.priceScale('yoy', 0).applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
  const yoyData = [];
  for (const r of sorted) {
    const prevKey = `${r.revenue_year - 1}-${r.revenue_month}`;
    const prev = byKey.get(prevKey);
    if (prev) yoyData.push({ time: r.date, value: ((r.revenue - prev) / prev) * 100 });
  }
  yoy.setData(yoyData);

  showAllBars(chart, sorted.length);
  return chart;
}

function renderEPS(container, quarters) {
  container.innerHTML = '';
  const chart = makeChart(container);
  const barSeries = chart.addSeries(LightweightCharts.HistogramSeries, { priceFormat: { type: 'price', precision: 2, minMove: 0.01 } }, 0);
  barSeries.setData(quarters.map(q => ({
    time: q.date,
    value: q.eps,
    color: q.eps >= 0 ? UP_COLOR : DOWN_COLOR,
  })));
  showAllBars(chart, quarters.length);
  return chart;
}
