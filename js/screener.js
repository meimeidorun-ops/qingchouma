// 選股篩選器（2026-11-21）：排行裡的「選股」分類。勾條件 → 全市場（上市櫃普通股）同時符合的股票。
// 資料都是已經在用的全市場檔：mk/day.json、inst.json、margin.json、scores.json、temp.json、ind.json。
const SCR_GROUPS = [
  ['籌碼', [
    ['fbuy3', '外資連買 3 天↑'], ['tbuy3', '投信連買 3 天↑'], ['ft5', '土洋同買（5 日）'], ['inst5', '三大法人 5 日買超'],
    ['tfirst', '投信剛開始買'], ['mgdn5', '融資 5 日減少'], ['sbldn5', '借券 5 日回補'], ['lowdt', '當沖占比 <30%'],
    ['fsell3', '外資連賣 3 天↑'], ['mgup5', '融資 5 日增 10%↑'], ['sblup5', '借券 5 日增加'],
  ]],
  ['技術', [
    ['up', '今天上漲'], ['ma60', '站上季線'], ['high60', '創 60 日新高'], ['up5', '5 日上漲'],
    ['rsiLow', 'RSI<30 超賣'], ['notHot', '溫度不過熱（<80）'], ['cold', '溫度偏冷（<40）'], ['volUp', '量增（成交值>20日均×1.5）'],
  ]],
  ['基本面', [
    ['score70', '評分 ≥70'], ['revHigh', '營收創新高（≥80）'], ['revTurn', '營收轉折（≥80）'], ['pe15', '本益比 <15'],
  ]],
  ['範圍', [['liq', '成交值 ≥1 億'], ['liq5', '成交值 ≥5 億'], ['tse', '只看上市'], ['otc', '只看上櫃']]],
];
const SCR_LABEL = Object.fromEntries(SCR_GROUPS.flatMap(g => g[1]));
const SCR_SORT = [['money', '成交值'], ['pct', '漲跌幅'], ['score', '評分'], ['f5', '外資5日'], ['t5', '投信5日']];
const Scr = {
  on: new Set((() => { try { return JSON.parse(localStorage.getItem('scr_on') || 'null') || ['liq', 'ft5', 'ma60']; } catch (e) { return ['liq', 'ft5', 'ma60']; } })()),
  sort: localStorage.getItem('scr_sort') || 'money',
  save() { try { localStorage.setItem('scr_on', JSON.stringify([...this.on])); localStorage.setItem('scr_sort', this.sort); } catch (e) {} },
};

function scrPanelHtml() {
  return `<div class="scr-panel">${SCR_GROUPS.map(([g, items]) => `<div class="scr-grp"><span class="scr-g">${g}</span>${items.map(([k, l]) =>
    `<button class="scr-chip${Scr.on.has(k) ? ' on' : ''}" data-scr="${k}">${l}</button>`).join('')}</div>`).join('')}
    <div class="scr-grp"><span class="scr-g">排序</span>${SCR_SORT.map(([k, l]) => `<button class="scr-chip sort${Scr.sort === k ? ' on' : ''}" data-scrsort="${k}">${l}</button>`).join('')}
      <button class="scr-chip clear" data-scrclear="1">清除條件</button></div></div>`;
}

async function scrRows(day, px) {
  const [inst, mg, sc, tp, dtd] = await Promise.all(['inst', 'margin', 'scores', 'temp', 'dt'].map(n => Mk.load(n).catch(() => null)));
  const DL = dtd ? dtd.days.length : 0;
  const on = Scr.on, L = inst ? inst.days.length : 0, ML = mg ? mg.days.length : 0;
  const run = (a, sgn) => { let n = 0; while (a && n < a.length && a[a.length - 1 - n] * sgn > 0) n++; return n; };
  const sum = (a, n) => { let s = 0; if (a) for (let i = Math.max(0, a.length - n); i < a.length; i++) s += a[i] || 0; return s; };
  const need = k => on.has(k);
  const rows = [];
  for (const [id, d] of day) {
    if (!/^[1-9]\d{3}$/.test(id)) continue;  // 普通股
    const p = px.get(id) || d;
    if (p.pct == null || p.close == null) continue;
    if (need('liq') && !(p.money >= 100)) continue;
    if (need('liq5') && !(p.money >= 500)) continue;
    if (need('tse') && d.mkt !== 'TPE') continue;
    if (need('otc') && d.mkt !== 'TWO') continue;
    if (need('up') && !(p.pct > 0)) continue;
    if (need('up5') && !(d.pct5 > 0)) continue;
    const I = inst && inst.s[id], f = I && I[0], t = I && I[1], dl = I && I[2];
    if ((need('fbuy3') || need('tbuy3') || need('ft5') || need('inst5') || need('fsell3') || need('tfirst')) && !I) continue;
    if (need('fbuy3') && run(f, 1) < 3) continue;
    if (need('tbuy3') && run(t, 1) < 3) continue;
    if (need('fsell3') && run(f, -1) < 3) continue;
    if (need('ft5') && !(sum(f, 5) > 0 && sum(t, 5) > 0)) continue;
    if (need('inst5') && !(sum(f, 5) + sum(t, 5) + sum(dl, 5) > 0)) continue;
    // 投信剛開始買：最近 1～2 天買超，之前 10 天幾乎沒買（合計 ≤0）
    if (need('tfirst') && !(t && t[L - 1] > 0 && run(t, 1) <= 2 && sum(t.slice(0, Math.max(0, L - run(t, 1))), 10) <= 0)) continue;
    const M = mg && mg.s[id] && mg.s[id][0];
    if (need('mgdn5') || need('mgup5')) {
      if (!M || M[ML - 1] == null || M[ML - 6] == null || M[ML - 6] < 200) continue;
      const chg = (M[ML - 1] - M[ML - 6]) / M[ML - 6];
      if (need('mgdn5') && !(chg < 0)) continue;
      if (need('mgup5') && !(chg >= 0.1)) continue;
    }
    const D = dtd && dtd.s[id];  // [當沖占比%[], 借券餘額[], 借券賣出[]]
    if (need('lowdt') && !(D && D[0][DL - 1] != null && D[0][DL - 1] < 30)) continue;
    if (need('sbldn5') || need('sblup5')) {
      const b0 = D && D[1][DL - 1], b5 = D && D[1][DL - 6];
      if (b0 == null || b5 == null || b5 < 100) continue;
      if (need('sbldn5') && !(b0 < b5)) continue;
      if (need('sblup5') && !(b0 > b5)) continue;
    }
    const T = tp && tp.stk.s[id];  // [溫度, 60日乖離%, 20日漲跌%, RSI, 區間位置%]
    if ((need('ma60') || need('high60') || need('rsiLow') || need('notHot') || need('cold')) && !T) continue;
    if (need('ma60') && !(T[1] > 0)) continue;
    if (need('high60') && !(T[4] >= 98)) continue;
    if (need('rsiLow') && !(T[3] < 30)) continue;
    if (need('notHot') && !(T[0] < 80)) continue;
    if (need('cold') && !(T[0] < 40)) continue;
    // 量增：今天成交值 ≥ 前 20 日平均 ×1.5（day.json 第 10 欄；盤中用即時成交值，早盤自然比較難達到）
    if (need('volUp') && !(d.money20 && p.money >= d.money20 * 1.5)) continue;
    const S = sc && sc.items[id];  // [積極, 穩健, 營收創高, 轉折, 近高點, 估值, 低波動, 本益比]
    if ((need('score70') || need('revHigh') || need('revTurn')) && !S) continue;
    if (need('score70') && !(S[0] >= 70)) continue;
    if (need('revHigh') && !(S[2] >= 80)) continue;
    if (need('revTurn') && !(S[3] >= 80)) continue;
    if (need('pe15') && !(S && S[7] != null && S[7] > 0 && S[7] < 15)) continue;
    const f5 = sum(f, 5) * p.close, t5 = sum(t, 5) * p.close;  // 張×元＝千元
    rows.push({ id, name: d.name, px: p, score: S ? S[0] : null, f5, t5, temp: T ? T[0] : null,
      v: { money: p.money || 0, pct: p.pct, score: S ? S[0] ?? -1 : -1, f5, t5 }[Scr.sort] });
  }
  rows.sort((a, b) => b.v - a.v);
  const total = rows.length;
  const out = rows.map(r => ({ id: r.id, name: r.name, px: r.px, score: r.score, cls: 'flat', main: '',
    sub: `成交 ${numFmt((r.px.money || 0) / 100, 1)} 億｜外資5日 ${r.f5 >= 0 ? '+' : ''}${numFmt(r.f5 / 1e5, 1)} 億｜投信5日 ${r.t5 >= 0 ? '+' : ''}${numFmt(r.t5 / 1e5, 1)} 億${r.temp != null ? `｜溫度 ${r.temp}` : ''}` }));
  const conds = [...on].map(k => SCR_LABEL[k]).filter(Boolean);
  const note = `選股｜符合 ${total} 檔${total > 100 ? '（顯示前 100）' : ''}｜條件：${conds.join('、') || '無（全部）'}｜法人 ${inst ? inst.days[L - 1].slice(5) : '—'}、融資 ${mg ? mg.days[ML - 1].slice(5) : '—'}`;
  return { rows: out, note };
}

// 條件按鈕（事件綁在 #rk-list，畫面重畫也有效）
$('#rk-list').addEventListener('click', e => {
  const b = e.target.closest('.scr-chip');
  if (!b) return;
  e.stopPropagation();
  if (b.dataset.scr) {
    const k = b.dataset.scr;
    if (Scr.on.has(k)) Scr.on.delete(k); else {
      Scr.on.add(k);
      // 互斥的條件
      const ex = { tse: 'otc', otc: 'tse', liq: 'liq5', liq5: 'liq', fbuy3: 'fsell3', fsell3: 'fbuy3', mgdn5: 'mgup5', mgup5: 'mgdn5', notHot: 'cold', cold: 'notHot', sbldn5: 'sblup5', sblup5: 'sbldn5' }[k];
      if (ex) Scr.on.delete(ex);
    }
  } else if (b.dataset.scrsort) Scr.sort = b.dataset.scrsort;
  else if (b.dataset.scrclear) Scr.on = new Set(['liq']);
  Scr.save();
  openRank();
}, true);
