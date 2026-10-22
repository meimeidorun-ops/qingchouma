// 「大盤」頁（2026-10-22）：加權／櫃買指數的即時走勢與日K（疊三大法人合計），三大法人買賣金額、融資融券。
// 首頁大盤指數列（#idx-bar）點一下進來。
// 指數走勢、K 線：鉅亨（TWS:TSE01:INDEX／TWS:OTC01:INDEX，手機直連）。
// 法人買賣金額、融資融券：mk/market.json（台股AI盯盤Agent/market_export.py 抓證交所 BFI82U、MI_MARGN、櫃買 insti/summary、margin/balance）。
const Ix = { mkt: localStorage.getItem('ix_mkt') || 'tse', view: localStorage.getItem('ix_view') || 'd', range: Number(localStorage.getItem('ix_range') || 125),
  showInst: localStorage.getItem('ix_inst') !== '0', ind: localStorage.getItem('ix_ind') || '', who: 'all', charts: {}, rt: null, timer: null };
const IX_SYM = { tse: 'TWS:TSE01:INDEX', otc: 'TWS:OTC01:INDEX' };
const IX_NAME = { tse: '加權指數', otc: '櫃買指數' };

function ixPaintBars() {
  $$('#ix-mkt .range-btn').forEach(b => b.classList.toggle('active', b.dataset.m === Ix.mkt));
  $$('#ix-view [data-v]').forEach(b => b.classList.toggle('active', b.dataset.v === Ix.view));
  $$('#ix-view [data-r]').forEach(b => { b.classList.toggle('active', Number(b.dataset.r) === Ix.range); b.style.display = Ix.view === 'd' ? '' : 'none'; });
  $('#ix-layers').style.display = Ix.view === 'd' ? '' : 'none';
  $('#ix-legend').style.display = Ix.view === 'd' ? '' : 'none';
  $('#ix-layers [data-layer="inst"]').classList.toggle('active', Ix.showInst);
  $$('#ix-layers [data-ind]').forEach(b => b.classList.toggle('active', b.dataset.ind === Ix.ind));
  $$('#ix-inst-who .range-btn').forEach(b => b.classList.toggle('active', b.dataset.w === Ix.who));
}

async function ixHeader() {
  try {
    const d = (await cnyesGet('/v1/quote/quotes/' + IX_SYM[Ix.mkt]))[0];
    const cls = signClass(d['11']);
    const t = twTime(d['200007']);
    $('#ix-head').innerHTML = `<div class="ix-name">${IX_NAME[Ix.mkt]}</div>
      <div><b class="ix-px ${cls}">${numFmt(d['6'], 2)}</b> <span class="${cls}">${d['11'] >= 0 ? '+' : ''}${numFmt(d['11'], 2)}（${pctFmt(d['56'])}）</span></div>
      <div class="dim" style="font-size:12px">開 ${numFmt(d['19'], 2)}｜高 ${numFmt(d['12'], 2)}｜低 ${numFmt(d['13'], 2)}｜成交值 ${numFmt((d['200067'] || 0) / 1e8)} 億｜${t.date.slice(5).replace('-', '/')} ${t.hms.slice(0, 5)}</div>`;
  } catch (e) { $('#ix-head').innerHTML = `<div class="error-msg">指數報價抓不到：${e.message}</div>`; }
}

// 指數日K：鉅亨 resolution=D（由新到舊）→ renderKLine 用的列；量＝成交值，換成「億」（renderKLine 會再 /1000）
async function ixDaily(days) {
  const now = Math.floor(Date.now() / 1000);
  const d = await cnyesGet(`/v1/charting/history?resolution=D&symbol=${IX_SYM[Ix.mkt]}&from=${now}&to=${now - 86400 * Math.ceil(days * 1.5 + 30)}`, 8000);
  const rows = [];
  for (let i = (d.t || []).length - 1; i >= 0; i--) {
    if (d.c[i] == null || d.o[i] == null) continue;
    rows.push({ date: twTime(d.t[i]).date, open: d.o[i], max: d.h[i], min: d.l[i], close: d.c[i], Trading_Volume: (d.v[i] || 0) / 1e5 });
  }
  return rows.slice(-days);
}

// 法人買賣金額 → aggregateInstitutionalByDate 用的列（buy/sell，單位隨 scale）
function ixInstRows(m, who, scale) {
  const out = [];
  if (!m) return out;
  const s = m[Ix.mkt];
  m.days.forEach((date, i) => {
    const parts = who === 'all' ? [s.f[i], s.t[i], s.d[i]] : [s[who][i]];
    if (parts.every(v => v == null)) return;
    const net = parts.reduce((a, v) => a + (v || 0), 0) * scale;
    out.push({ date, buy: net > 0 ? net : 0, sell: net < 0 ? -net : 0 });
  });
  return out;
}

async function ixDrawMain() {
  const box = $('#ix-chart');
  const mkt = Ix.mkt, view = Ix.view;
  const tk = tabTicket('ix-main');
  if (!box.querySelector('canvas')) box.innerHTML = '<div class="loading">載入中…</div>';
  try {
    if (view === 'rt') {
      const now = Math.floor(Date.now() / 1000);
      const d = await cnyesGet(`/v1/charting/history?resolution=1&symbol=${IX_SYM[mkt]}&from=${now}&to=${now - 86400 * 6}&quote=1`, 8000);
      if (!tabLive('ix-main', tk)) return;
      const rows = cnyesRows(d);
      if (!rows.length) { box.innerHTML = '<div class="error-msg">目前沒有走勢資料</div>'; return; }
      // 只留最後一個交易日
      const lastDay = twTime(rows[rows.length - 1].t).date;
      const bars = rows.filter(r => twTime(r.t).date === lastDay).map(r => ({ t: r.t, open: r.o, high: r.h, low: r.l, close: r.c, vol: r.v / 1e5 }));
      const prev = (d.quote && d.quote['21']) || bars[0].open;
      box.style.height = '340px';
      Ix.rt = renderRealtime(box, prev);
      setRealtimeData(Ix.rt, { gmtoffset: 28800, prevClose: prev, bars });
      $('#ix-note').textContent = `資料時間 ${twTime(bars[bars.length - 1].t).hms.slice(0, 5)}（盤中每 20 秒自動更新）`;
      return;
    }
    const [rows, m] = await Promise.all([ixDaily(Ix.range), Mk.load('market').catch(() => null)]);
    if (!tabLive('ix-main', tk)) return;
    if (!rows.length) { box.innerHTML = '<div class="error-msg">查無指數資料</div>'; return; }
    const extra = (Ix.showInst ? 1 : 0) + (Ix.ind ? 1 : 0);
    box.style.height = `${260 + extra * 90}px`;
    let range = null;
    if (Ix.charts.k && Ix.charts.k._ixKey === `${mkt}_${Ix.range}`) { try { range = Ix.charts.k.timeScale().getVisibleLogicalRange(); } catch (e) {} }
    Ix.charts.k = renderKLine(box, rows, { instRows: Ix.showInst ? ixInstRows(m, 'all', 1000) : [], showInst: Ix.showInst, indicator: Ix.ind || null });
    Ix.charts.k._ixKey = `${mkt}_${Ix.range}`;
    if (range) { try { Ix.charts.k.timeScale().setVisibleLogicalRange(range); } catch (e) {} }
    $('#ix-note').textContent = Ix.showInst && !m ? '三大法人資料暫時抓不到' : '';
  } catch (e) {
    if (tabLive('ix-main', tk)) box.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

async function ixDrawChips() {
  const tk = tabTicket('ix-chips');
  const instBox = $('#ix-inst-chart'), mgBox = $('#ix-margin-chart');
  try {
    const [m, px] = await Promise.all([Mk.load('market'), ixDaily(130).catch(() => [])]);
    if (!tabLive('ix-chips', tk)) return;
    const s = m[Ix.mkt];
    // 法人
    Ix.charts.inst = renderInstitutional(instBox, ixInstRows(m, Ix.who, 1), 1);
    const sum = i => [s.f[i], s.t[i], s.d[i]].every(v => v == null) ? null : (s.f[i] || 0) + (s.t[i] || 0) + (s.d[i] || 0);
    const td = v => `<td class="${v == null ? 'flat' : signClass(v)}">${v == null ? '—' : (v > 0 ? '+' : '') + numFmt(v, 2)}</td>`;
    const idx = m.days.map((d, i) => i).reverse().filter(i => s.f[i] != null || s.mg[i] != null);
    $('#ix-inst-table tbody').innerHTML = idx.filter(i => s.f[i] != null).slice(0, 30).map(i => `<tr><td>${m.days[i].slice(5)}</td>${td(s.f[i])}${td(s.t[i])}${td(s.d[i])}${td(sum(i))}</tr>`).join('');
    // 融資融券
    const pxMap = new Map(px.map(r => [r.date, r.close]));
    const mgDays = m.days.map((d, i) => i).filter(i => s.mg[i] != null);
    Ix.charts.mg = renderMargin(mgBox,
      mgDays.map(i => ({ time: m.days[i], value: s.mg[i] })),
      mgDays.filter(i => s.sh[i] != null).map(i => ({ time: m.days[i], value: s.sh[i] })),
      mgDays.filter(i => pxMap.has(m.days[i])).map(i => ({ time: m.days[i], value: pxMap.get(m.days[i]) })));
    $('#ix-margin-table tbody').innerHTML = mgDays.slice().reverse().slice(0, 30).map((i, k, arr) => {
      const j = mgDays[mgDays.indexOf(i) - 1];
      const dm = j != null ? s.mg[i] - s.mg[j] : null;
      const dsh = j != null && s.sh[i] != null && s.sh[j] != null ? s.sh[i] - s.sh[j] : null;
      const ratio = s.mgl[i] ? (s.sh[i] / s.mgl[i] * 100).toFixed(2) + '%' : '—';
      return `<tr><td>${m.days[i].slice(5)}</td><td>${numFmt(s.mg[i], 2)}</td>${td(dm == null ? null : Math.round(dm * 100) / 100)}<td>${numFmt(s.sh[i])}</td>${dsh == null ? '<td class="flat">—</td>' : `<td class="${signClass(dsh)}">${dsh > 0 ? '+' : ''}${numFmt(dsh)}</td>`}<td>${ratio}</td></tr>`;
    }).join('');
  } catch (e) {
    if (!tabLive('ix-chips', tk)) return;
    const msg = `<div class="error-msg">載入失敗：${e.message}（大盤籌碼每個交易日傍晚更新）</div>`;
    instBox.innerHTML = msg; mgBox.innerHTML = msg;
  }
}

function openIndex(mkt) {
  if (mkt) { Ix.mkt = mkt; localStorage.setItem('ix_mkt', mkt); }
  showScreen('screen-index');
  ixPaintBars();
  ixHeader();
  ixDrawMain();
  ixDrawChips();
  clearInterval(Ix.timer);
  // 盤中：指數報價與即時走勢 20 秒、日K 60 秒更新一次
  let n = 0;
  Ix.timer = setInterval(() => {
    if (document.hidden || !$('#screen-index').classList.contains('active')) return;
    if (!twMarketOpen()) return;
    ixHeader();
    if (Ix.view === 'rt' || ++n % 3 === 0) ixDrawMain();
  }, 20000);
}

$('#idx-bar').addEventListener('click', e => {
  const item = e.target.closest('.idx-item');
  openIndex(item && /櫃買/.test(item.innerText) ? 'otc' : 'tse');
});
$('#btn-ix-back').addEventListener('click', () => { clearInterval(Ix.timer); goHome(); });
$('#ix-mkt').addEventListener('click', e => { const m = e.target.dataset.m; if (!m || m === Ix.mkt) return; openIndex(m); });
$('#ix-view').addEventListener('click', e => {
  const ds = e.target.dataset;
  if (ds.v) { Ix.view = ds.v; localStorage.setItem('ix_view', ds.v); }
  else if (ds.r) { Ix.range = Number(ds.r); localStorage.setItem('ix_range', ds.r); }
  else return;
  ixPaintBars();
  $('#ix-chart').innerHTML = '';
  ixDrawMain();
});
$('#ix-layers').addEventListener('click', e => {
  const ds = e.target.dataset;
  if (ds.layer === 'inst') { Ix.showInst = !Ix.showInst; localStorage.setItem('ix_inst', Ix.showInst ? '1' : '0'); }
  else if (ds.ind !== undefined) { Ix.ind = ds.ind; localStorage.setItem('ix_ind', ds.ind); }
  else return;
  ixPaintBars();
  ixDrawMain();
});
$('#ix-inst-who').addEventListener('click', e => { const w = e.target.dataset.w; if (!w) return; Ix.who = w; ixPaintBars(); ixDrawChips(); });
// 切回 App 時在大盤頁 → 重抓
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && $('#screen-index').classList.contains('active')) { ixHeader(); ixDrawMain(); }
});
