// 同業比較（2026-11-26，仿籌碼K線「同業」）：同產業（mk/ind.json）成交值前 12 大＋本檔，
// 比較漲跌、20 日漲跌、本益比、殖利率、月營收年增、評分。點一列開那檔（上一檔／下一檔跟著同業順序）。
// 2026-11-26（v89）：上方「本益比比較」← mk/pe_grp.json（每月同業本益比中位數）＋ mk/pe/<前兩碼>.json（個股每月本益比）。
//   群組可切：官方產業別／自訂概念（例如記憶體，pe_grp.mem）。有概念時預設用概念。
let peerGroupSel = {};   // 代號 → 選的群組
let peerPeRange = 60;    // 走勢圖顯示幾個月（36／60／全部）
const PeShard = {};
async function peShard(id) {
  const k = String(id).slice(0, 2);
  if (!PeShard[k] || Date.now() - PeShard[k].at > 6 * 3600e3) {
    PeShard[k] = { at: Date.now(), p: fetch(`mk/pe/${k}.json?t=${Math.floor(Date.now() / 36e5)}`).then(r => r.ok ? r.json() : null).catch(() => null) };
  }
  return PeShard[k].p;
}

// 百分位：v 在 arr 裡比幾 % 的值還高（0＝歷史最低、100＝最高）
function pePctile(arr, v) {
  const a = arr.filter(x => x != null);
  if (!a.length || v == null) return null;
  return Math.round(a.filter(x => x < v).length / a.length * 100);
}

async function paintPeers(stock) {
  const box = $('#peer-box');
  if (!box) return;
  box.innerHTML = '';
  if (/^00/.test(stock.stock_id)) return;
  try {
    const [I, V, S, day, G] = await Promise.all([Mk.load('ind'), Mk.load('val').catch(() => null), Mk.load('scores').catch(() => null), Mk.dayMap(), Mk.load('pe_grp').catch(() => null)]);
    if (currentStock !== stock) return;
    const sid = stock.stock_id;
    // 可選群組：概念（有包含這檔的）＋官方產業
    const opts = [];
    if (G && G.mem) for (const [k, ids] of Object.entries(G.mem)) if (ids.includes(sid)) opts.push(k);
    if (I.s[sid]) opts.push(I.s[sid]);
    if (!opts.length) return;
    let grp = peerGroupSel[sid];
    if (!opts.includes(grp)) grp = opts[0];
    const isConcept = /^c_/.test(grp);
    const gname = (G && G.names[grp]) || I.names[grp] || grp;
    let ids = isConcept ? G.mem[grp].filter(id => day.has(id)) : Object.keys(I.s).filter(id => I.s[id] === grp && day.has(id));
    if (ids.length < 2) return;
    ids.sort((a, b) => (day.get(b).money || 0) - (day.get(a).money || 0));
    let pick = ids.slice(0, isConcept ? 20 : 12);
    if (!pick.includes(sid)) pick = pick.slice(0, pick.length - 1).concat(sid);
    const sg = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
    // 預估本益比：自選清單裡有定錨 EPS 的（擁有者才有；後端最多等 4 秒，等不到就不顯示這欄）
    const backendList = isOwner() ? await Promise.race([Backend.list().catch(() => []), new Promise(r => setTimeout(() => r([]), 4000))]) : [];
    if (currentStock !== stock) return;
    const Y = Number(backendList[0] && backendList[0].epsYear) || 2026;
    const fwdPe = (id, close) => {
      const e = backendList.find(s => s.stock_id === id);
      if (!e || !close) return null;
      const a = e.epsA !== undefined ? e.epsA : e.eps2026, b = e.epsB !== undefined ? e.epsB : e.eps2027;
      const eps = new Date().getMonth() >= 6 && b > 0 ? b : a;   // 7 月起看下一年
      return eps > 0 ? Math.round(close / eps * 10) / 10 : null;
    };
    const rows = pick.map(id => {
      const d = day.get(id), v = V && V.s[id], s = S && S.items[id];
      return { id, name: d.name, pct: d.pct, pct20: d.pct20, pe: v ? v[0] : null, fpe: fwdPe(id, d.close), yld: v ? v[1] : null, yoy: v ? v[5] : null, score: s ? s[0] : null };
    });
    const hasF = rows.some(r => r.fpe != null);
    // 產業平均（中位數比較不受極端值影響）
    const med = key => { const a = rows.map(r => r[key]).filter(x => x != null && isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
    const m = { pct20: med('pct20'), yoy: med('yoy') };
    const me = rows.find(r => r.id === sid);
    const cmp = [];
    if (me) {
      if (me.yoy != null && m.yoy != null) cmp.push(`月營收年增 ${sg(me.yoy)}，同業中位數 ${sg(m.yoy)}`);
      if (me.pct20 != null && m.pct20 != null) cmp.push(`近 20 日 ${sg(me.pct20)}，同業中位數 ${sg(m.pct20)}`);
    }
    const chips = opts.length > 1 ? `<div class="range-bar peer-grp">${opts.map(k => `<button class="range-btn ${k === grp ? 'active' : ''}" data-grp="${k}">${mkEsc((G && G.names[k]) || I.names[k] || k)}</button>`).join('')}</div>` : '';
    box.innerHTML = `<div class="section-label">同業比較（${mkEsc(gname)}，共 ${ids.length} 檔${ids.length > pick.length ? `，取成交值前 ${pick.length}` : ''}）</div>
      ${chips}
      <div id="pe-cmp"></div>
      ${cmp.length ? `<div class="peer-sum">${cmp.map(x => `<div>• ${x}</div>`).join('')}</div>` : ''}
      <div class="table-wrap"><table class="data-table compact peer-tbl"><thead><tr><th>股票</th><th>漲跌</th><th>20日</th><th>本益比</th>${hasF ? '<th>預估<br>本益比</th>' : ''}<th>殖利率</th><th>營收<br>年增</th><th>評分</th></tr></thead><tbody>
      ${rows.map(r => `<tr data-id="${r.id}" class="${r.id === sid ? 'me' : ''}"><td><b>${mkEsc(r.name)}</b><br><span class="dim">${r.id}</span></td>
        <td class="${signClass(r.pct)}">${r.pct == null ? '—' : pctFmt(r.pct)}</td><td class="${signClass(r.pct20)}">${sg(r.pct20)}</td>
        <td>${r.pe ?? '<span class="dim">虧損</span>'}</td>${hasF ? `<td>${r.fpe ?? '—'}</td>` : ''}<td>${r.yld == null ? '—' : r.yld + '%'}</td><td class="${signClass(r.yoy)}">${sg(r.yoy)}</td><td>${r.score ?? '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="hint" style="padding:2px 16px 14px">本益比＝股價 ÷ 近四季 EPS（證交所／櫃買每天公布；虧損沒有本益比）。${hasF ? `預估本益比＝收盤 ÷ 定錨預估 EPS（${new Date().getMonth() >= 6 ? Y + 1 : Y} 年，只有自選清單裡有填的）。` : ''}${isConcept ? '概念股名單是自訂的。' : '產業分類：證交所／櫃買公布的產業別。'}評分只有成交金額前 350 大才有。點一列看那檔。</p>`;
    box.querySelectorAll('.peer-grp [data-grp]').forEach(b => b.addEventListener('click', () => { peerGroupSel[sid] = b.dataset.grp; paintPeers(stock); }));
    box.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => {
      if (tr.dataset.id === sid) return;
      navStocks = rows.map(r => ({ stock_id: r.id, stock_name: r.name }));
      const cur = ($('.tab-btn.active') || {}).dataset;
      openStock({ stock_id: tr.dataset.id, stock_name: day.get(tr.dataset.id).name }, { keepTab: cur && cur.tab });
    }));
    if (G && G.g[grp]) paintPeCompare(stock, G, grp, gname, rows, me);
  } catch (e) { /* 沒資料不顯示 */ }
}

// 本益比比較：現在 vs 同業、本檔與同業各自在歷史的位置、每月走勢圖
async function paintPeCompare(stock, G, grp, gname, rows, me) {
  const el = $('#pe-cmp');
  if (!el) return;
  const sh = await peShard(stock.stock_id);
  if (currentStock !== stock || !el.isConnected) return;
  const months = G.m, gser = G.g[grp].map(x => x[0]);
  const my = sh && sh.s[stock.stock_id] && sh.m.join() === months.join() ? sh.s[stock.stock_id] : null;
  const nowG = G.g[grp][G.g[grp].length - 1];   // [中位數, 有本益比, 虧損]
  const myNow = me && me.pe != null ? me.pe : (my ? my[my.length - 1] : null);
  const gNow = nowG[0];
  const lines = [];
  if (myNow != null && gNow != null) {
    const diff = Math.round((myNow / gNow - 1) * 100);
    const cheaper = rows.filter(r => r.pe != null && r.pe < myNow).length;
    const withPe = rows.filter(r => r.pe != null).length;
    lines.push(`本檔 <b>${myNow}</b> 倍，${mkEsc(gname)}中位數 <b>${gNow}</b> 倍 → ${diff < 0 ? `比同業低 ${-diff}%` : diff > 0 ? `比同業高 ${diff}%` : '跟同業差不多'}（表中有本益比的 ${withPe} 檔裡第 ${cheaper + 1} 低）`);
  } else if (myNow == null) {
    lines.push(`本檔近四季虧損，沒有本益比；${mkEsc(gname)}中位數 ${gNow ?? '—'} 倍`);
  }
  if (nowG[2]) lines.push(`同業 ${nowG[1] + nowG[2]} 檔裡有 ${nowG[2]} 檔虧損（不列入中位數）`);
  const yrs = Math.round(months.length / 12);
  const pMy = my ? pePctile(my, myNow) : null, pG = pePctile(gser, gNow);
  const fmtRange = arr => { const a = arr.filter(x => x != null && x <= 300).sort((x, y) => x - y); return a.length ? `最低 ${a[0]}、中位 ${a[Math.floor(a.length / 2)]}、最高 ${a[a.length - 1]}` : ''; };
  const pctTxt = p => p == null ? '' : p <= 20 ? `<span class="pe-lo">歷史低檔（第 ${p} 百分位）</span>` : p >= 80 ? `<span class="pe-hi">歷史高檔（第 ${p} 百分位）</span>` : `第 ${p} 百分位`;
  if (pMy != null) lines.push(`本檔近 ${yrs} 年本益比：${fmtRange(my)} → 現在在${pctTxt(pMy)}`);
  if (pG != null) lines.push(`${mkEsc(gname)}中位數近 ${yrs} 年：${fmtRange(gser)} → 現在在${pctTxt(pG)}`);
  // 相對本益比：本檔 ÷ 同業中位數，跟自己過去比
  if (my) {
    const rel = my.map((v, i) => v != null && gser[i] ? v / gser[i] : null);
    const rNow = rel[rel.length - 1], rel5 = rel.slice(-60).filter(x => x != null).sort((a, b) => a - b);
    if (rNow != null && rel5.length >= 24) {
      const rm = rel5[Math.floor(rel5.length / 2)];
      lines.push(`相對同業：現在是同業的 ${rNow.toFixed(2)} 倍，近 5 年通常是 ${rm.toFixed(2)} 倍（${rNow < rm * 0.85 ? '比平常更便宜' : rNow > rm * 1.15 ? '比平常更貴' : '跟平常差不多'}）`);
    }
  }
  // 景氣循環提醒：整個族群都在歷史低檔時
  const note = pG != null && pG <= 25
    ? `<div class="pe-note">整個${mkEsc(gname)}族群的本益比都在自己歷史的低檔。像記憶體這類景氣循環股常見的情況是：<b>獲利在高峰時本益比最低、獲利谷底時本益比最高（甚至虧損）</b>，市場會提前反應「獲利之後可能下滑」，所以本益比低但股價不一定漲。可以搭配看：月營收年增有沒有開始放緩（上方營收圖）、預估 EPS 有沒有繼續往上修、同業虧損家數的變化。以上是數據說明，不是買賣建議。</div>`
    : '';
  el.innerHTML = `<div class="pe-box">
      <div class="pe-title">本益比比較</div>
      ${lines.map(x => `<div>• ${x}</div>`).join('')}
      <div class="range-bar pe-rng">${[[36, '3年'], [60, '5年'], [0, '全部']].map(([n, t]) => `<button class="range-btn ${n === peerPeRange ? 'active' : ''}" data-n="${n}">${t}</button>`).join('')}
        <span class="pe-leg"><i style="background:#ffd166"></i>本檔 <i style="background:#38d6f5"></i>${mkEsc(gname)}中位數</span></div>
      <div id="pe-chart" class="chart-box" style="height:200px"></div>
      <div class="hint" style="padding:0">每月最後一個交易日的本益比；中斷＝那段期間虧損。超過 60 倍畫在 60。</div>
      ${note}</div>`;
  el.querySelectorAll('.pe-rng [data-n]').forEach(b => b.addEventListener('click', () => { peerPeRange = +b.dataset.n; paintPeCompare(stock, G, grp, gname, rows, me); }));
  const n = peerPeRange || months.length, from = Math.max(0, months.length - n);
  // 獲利很小時本益比會衝到上百、把圖壓扁 → 圖上超過 60 倍畫成 60（文字數字不受影響）
  const pts = (arr) => arr.slice(from).map((v, i) => { const ym = months[from + i], time = `${ym.slice(0, 4)}-${ym.slice(4)}-01`; return v != null && v <= 300 ? { time, value: Math.min(v, 60) } : { time }; });
  const box = $('#pe-chart');
  const chart = makeChart(box);
  const o = { lineWidth: 2, priceLineVisible: false, lastValueVisible: true, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } };
  chart.addSeries(LightweightCharts.LineSeries, { ...o, color: '#38d6f5' }).setData(pts(gser));
  if (my) chart.addSeries(LightweightCharts.LineSeries, { ...o, color: '#ffd166' }).setData(pts(my));
  showAllBars(chart, months.length - from);
}
