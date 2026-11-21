// 智能摘要（2026-11-22）：點進個股時，把手機上已有的全市場資料整理成「四面向評估＋優勢／風險重點」。
// 規則式判斷（不是 AI 猜測、也不是買賣建議）：估值 val.json、評分 scores.json、法人 inst.json、融資 margin.json、
// 當沖／借券 dt.json、大戶 tdcc.json、溫度 temp.json、公告 notice.json、行情 day.json。
const INS_LV = [[-99, '偏空', 'down'], [-1, '略偏空', 'down'], [0, '中性', 'flat'], [1, '略偏多', 'up'], [2, '偏多', 'up']];
const insLevel = v => { let r = INS_LV[0]; for (const x of INS_LV) if (v >= x[0]) r = x; return r; };

async function buildInsight(id) {
  const names = ['day', 'val', 'scores', 'inst', 'margin', 'dt', 'tdcc', 'temp', 'notice'];
  const D = {};
  await Promise.all(names.map(async n => { try { D[n] = n === 'day' ? await Mk.dayMap() : await Mk.load(n); } catch (e) { D[n] = null; } }));
  const p = D.day && D.day.get(id);
  if (!p) return null;
  const pro = [], con = [], neu = [];
  const sc = { fund: 0, val: 0, chip: 0, tech: 0 };
  const sg = v => `${v > 0 ? '+' : ''}${v}`;
  const fmt = v => numFmt(Math.round(v));
  // ---- 基本面：月營收、評分 ----
  const V = D.val && D.val.s[id];  // [本益比, 殖利率, 淨值比, 營收億, 月增, 年增, 累計年增, 創N月新高, 近3月年增]
  if (V) {
    const [pe, yld, pb, rev, mom, yoy, ytd, hi, y3] = V;
    if (yoy != null) {
      if (yoy >= 50) { sc.fund += 2; pro.push(`最新月營收年增 ${sg(yoy)}%，成長非常強`); }
      else if (yoy >= 20) { sc.fund += 1; pro.push(`最新月營收年增 ${sg(yoy)}%`); }
      else if (yoy <= -30) { sc.fund -= 2; con.push(`最新月營收年減 ${yoy}%，衰退明顯`); }
      else if (yoy <= -10) { sc.fund -= 1; con.push(`最新月營收年減 ${yoy}%`); }
    }
    if (hi >= 120) { sc.fund += 1; pro.push('月營收創歷史新高'); } else if (hi >= 24) { sc.fund += 1; pro.push(`月營收創 ${Math.floor(hi / 12)} 年新高`); }
    if (ytd != null && Math.abs(ytd) >= 10) (ytd > 0 ? neu : con).push(`今年累計營收年${ytd > 0 ? '增' : '減'} ${Math.abs(ytd)}%`);
    // ---- 估值 ----
    if (pe != null) {
      if (pe < 12) { sc.val += 1; pro.push(`本益比 ${pe} 倍，偏低`); }
      else if (pe > 60) { sc.val -= 2; con.push(`本益比 ${pe} 倍，很高（市場已預期很多成長）`); }
      else if (pe > 35) { sc.val -= 1; con.push(`本益比 ${pe} 倍，偏高`); }
      else neu.push(`本益比 ${pe} 倍`);
    } else neu.push('近四季虧損或沒有本益比');
    if (yld >= 5) { sc.val += 1; pro.push(`殖利率 ${yld}%，偏高`); }
    if (pb > 8) { sc.val -= 1; con.push(`股價淨值比 ${pb} 倍，偏高`); } else if (pb > 0 && pb < 1) { sc.val += 1; pro.push(`股價淨值比 ${pb}，低於淨值`); }
  }
  const S = D.scores && D.scores.items[id];
  if (S && S[0] != null) {
    if (S[0] >= 75) { sc.fund += 1; pro.push(`全市場評分 ${S[0]}（營收創高、轉折、近一年高點、估值綜合排名前段）`); }
    else if (S[0] < 30) { sc.fund -= 1; con.push(`全市場評分 ${S[0]}，排名後段`); }
  }
  // ---- 籌碼面 ----
  const I = D.inst && D.inst.s[id];
  const avgLots = p.money20 && p.close ? p.money20 * 1e3 / p.close : null;  // 20 日平均每天成交張數
  if (I) {
    const L = D.inst.days.length;
    const sum = (a, n) => { let s = 0; for (let i = Math.max(0, L - n); i < L; i++) s += a[i] || 0; return s; };
    const run = a => { const sgn = Math.sign(a[L - 1] || 0); let n = 0; while (sgn && n < L && Math.sign(a[L - 1 - n] || 0) === sgn) n++; return sgn * n; };
    [['外資', I[0]], ['投信', I[1]]].forEach(([nm, a]) => {
      const s5 = sum(a, 5), r = run(a);
      const big = avgLots ? Math.abs(s5) / (avgLots * 5) : 0;  // 5 日買賣超占 5 日成交量
      if (r >= 3) { sc.chip += 1; pro.push(`${nm}連買 ${r} 天（5 日 ${sg(fmt(s5))} 張）`); }
      else if (r <= -3) { sc.chip -= 1; con.push(`${nm}連賣 ${-r} 天（5 日 ${fmt(s5)} 張）`); }
      else if (big >= 0.1) (s5 > 0 ? pro : con).push(`${nm} 5 日${s5 > 0 ? '買' : '賣'}超 ${fmt(Math.abs(s5))} 張（占成交量 ${(big * 100).toFixed(0)}%）`);
    });
  }
  const M = D.margin && D.margin.s[id];
  if (M && M[0]) {
    const L = D.margin.days.length, m0 = M[0][L - 1], m5 = M[0][L - 6];
    if (m0 != null && m5 >= 200) {
      const c = (m0 / m5 - 1) * 100;
      if (c >= 10) { sc.chip -= 1; con.push(`融資 5 日增加 ${c.toFixed(1)}%（散戶追價、籌碼變亂）`); }
      else if (c <= -8) { sc.chip += 1; pro.push(`融資 5 日減少 ${Math.abs(c).toFixed(1)}%（籌碼沉澱）`); }
    }
  }
  const DT = D.dt && D.dt.s[id];
  if (DT) {
    const L = D.dt.days.length, r0 = DT[0][L - 1], b0 = DT[1][L - 1], b5 = DT[1][L - 6];
    if (r0 >= 50) con.push(`當沖占比 ${r0}%，短線客很多、波動大`);
    if (b0 != null && b5 >= 200) { const c = (b0 / b5 - 1) * 100; if (c >= 10) { sc.chip -= 1; con.push(`借券賣出餘額 5 日增加 ${c.toFixed(0)}%（空方加碼）`); } else if (c <= -10) { sc.chip += 1; pro.push(`借券賣出 5 日回補 ${Math.abs(c).toFixed(0)}%`); } }
  }
  const T = D.tdcc && D.tdcc.s[id];
  if (T) {
    const W = D.tdcc.weeks.length, b = T[0][W - 1], b1 = T[0][W - 2];
    if (b != null && b1 != null) {
      const c = b - b1;
      if (c >= 0.5) { sc.chip += 1; pro.push(`400 張以上大戶本週增加 ${c.toFixed(2)} 個百分點（${b.toFixed(1)}%）`); }
      else if (c <= -0.5) { sc.chip -= 1; con.push(`400 張以上大戶本週減少 ${Math.abs(c).toFixed(2)} 個百分點（${b.toFixed(1)}%）`); }
    }
  }
  // ---- 技術面：位置、溫度 ----
  const TP = D.temp && D.temp.stk.s[id];  // [溫度, 60日乖離%, 20日漲跌%, RSI, 區間位置%]
  if (TP) {
    const [t, dev60, r20, rsi] = TP;
    if (dev60 > 0) { sc.tech += 1; neu.push(`股價在季線之上（乖離 ${sg(dev60)}%）`); } else { sc.tech -= 1; neu.push(`股價在季線之下（乖離 ${dev60}%）`); }
    if (t >= 85) { sc.tech -= 1; con.push(`個股溫度 ${t}（過熱）：短線漲多，追高風險較大`); }
    else if (t <= 15) neu.push(`個股溫度 ${t}（跌深）：短線超跌，歷史上恐慌期跌深股反彈機率較高，但也可能續跌`);
    if (rsi >= 80) con.push(`RSI ${rsi}，短線過熱`); else if (rsi <= 20) neu.push(`RSI ${rsi}，短線超賣`);
  }
  if (p.pct20 != null && Math.abs(p.pct20) >= 15) neu.push(`近 20 日${p.pct20 > 0 ? '漲' : '跌'} ${Math.abs(p.pct20).toFixed(1)}%`);
  // ---- 公告 ----
  const N = D.notice;
  if (N) {
    if (N.punish[id]) con.unshift(`處置中（${N.punish[id][1]}）：撮合變慢、流動性差`);
    else if (N.notice[id]) con.unshift(`列為注意股（${N.notice[id][2].slice(5)}）：近期漲跌或週轉率異常`);
  }
  const mkt = D.temp && D.temp.mkt;
  const clamp = v => Math.max(-2, Math.min(2, v));
  return { sc: { fund: clamp(sc.fund), val: clamp(sc.val), chip: clamp(sc.chip), tech: clamp(sc.tech) }, pro, con, neu, mkt, date: D.temp ? D.temp.stk.date : '' };
}

async function paintInsight(stock) {
  const box = $('#dt-insight');
  if (!box) return;
  box.hidden = true;
  if (/^00/.test(stock.stock_id)) return;  // ETF 另有 ETF 頁籤
  try {
    const r = await buildInsight(stock.stock_id);
    if (!r || currentStock !== stock) return;
    const chip = (lbl, v) => { const [, t, c] = insLevel(v); return `<span class="ins-chip ${c}"><i>${lbl}</i>${t}</span>`; };
    box.innerHTML = `<span class="ins-ic">🧠</span>${chip('基本', r.sc.fund)}${chip('估值', r.sc.val)}${chip('籌碼', r.sc.chip)}${chip('技術', r.sc.tech)}<span class="dt-score-more">重點 ›</span>`;
    box.onclick = () => {
      const li = (arr, cls) => arr.length ? arr.map(x => `<li class="${cls}">${x}</li>`).join('') : '<li class="dim">（沒有特別的）</li>';
      showModal(`<div class="modal-title">🧠 ${mkEsc(stock.stock_name || stock.stock_id)} 智能摘要</div>
        <div class="ins-grid">${chip('基本面', r.sc.fund)}${chip('估值', r.sc.val)}${chip('籌碼面', r.sc.chip)}${chip('技術面', r.sc.tech)}</div>
        <div class="ins-sec up">✅ 優勢</div><ul class="ins-ul">${li(r.pro, 'up')}</ul>
        <div class="ins-sec down">⚠ 風險</div><ul class="ins-ul">${li(r.con, 'down')}</ul>
        <div class="ins-sec">📌 其他觀察</div><ul class="ins-ul">${li(r.neu, '')}</ul>
        ${r.mkt ? `<div class="ins-mkt">大盤溫度 <b style="color:${tempColor(r.mkt.temp)}">${r.mkt.temp}</b> ${r.mkt.label}${r.mkt.temp < 20 ? '：整體在恐慌區，個股常被一起錯殺，也常一起反彈，波動會比平常大。' : r.mkt.temp >= 80 ? '：整體偏熱，留意追高風險。' : '。'}</div>` : ''}
        <p class="dim" style="margin-top:8px">依公開資料用固定規則整理（資料日 ${r.date.slice(5)}），每一面向的評估是「目前數據偏向哪一邊」，<b>不是買賣建議</b>，也沒有考慮你的資金和風險承受度。要不要買、買多少，請搭配自己的判斷與停損。</p>
        <button class="modal-btn" id="ins-close" style="text-align:center;margin-top:10px">關閉</button>`);
      $('#ins-close').addEventListener('click', closeModal);
    };
    box.hidden = false;
  } catch (e) { /* 沒資料就不顯示 */ }
}
