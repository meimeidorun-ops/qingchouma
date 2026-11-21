// 極端行情選股（2026-11-22）：研究結果＋今天全市場符合「恐慌組合」的股票。
// 研究：Agent backtest/panic_study.py → mk/panic_study.json（2018 起盤勢溫度 <20 的恐慌日，24 個因子交叉比較）。
// 今天的清單：用手機上已有的全市場檔即時算（day.json 20 日漲跌、scores.json 營收創新高／轉折、inst.json 投信 20 日、temp.json）。
// 組合＝跌深 20 日、營收創新高、營收轉折、投信 20 日「沒有大買」四項，在成交金額前 350 大裡的排名百分位平均（同研究）。
const Panic = { sort: 'combo' };

async function openPanic() {
  showScreen('screen-panic');
  const box = $('#panic-body');
  box.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const [st, sc, inst, tp, day] = await Promise.all([Mk.load('panic_study'), Mk.load('scores'), Mk.load('inst'), Mk.load('temp').catch(() => null), Mk.dayMap()]);
    const L = inst.days.length;
    // 股票池＝評分檔（成交金額前 350 大普通股）
    const pool = Object.entries(sc.items).filter(([id]) => day.has(id)).map(([id, it]) => {
      const d = day.get(id);
      const t = inst.s[id] ? inst.s[id][1] : null;
      let t20 = null;
      if (t && d.money20 && d.close) { let s = 0; for (let i = Math.max(0, L - 20); i < L; i++) s += t[i] || 0; t20 = s / (d.money20 * 1e3 / d.close * 20); }  // 投信 20 日淨買 ÷ 20 日成交張數
      return { id, name: d.name, d, drop: d.pct20 == null ? null : -d.pct20, revHi: it[2], revTurn: it[3], t20, score: it[0] };
    });
    const rank = key => { const v = pool.filter(x => x[key] != null).sort((a, b) => a[key] - b[key]); v.forEach((x, i) => { x['r_' + key] = (i + 1) / v.length; }); };
    ['drop', 'revHi', 'revTurn', 't20'].forEach(rank);
    pool.forEach(x => {
      const parts = [x.r_drop, x.r_revHi, x.r_revTurn, x.r_t20 != null ? 1 - x.r_t20 : null].filter(v => v != null);
      x.combo = parts.length >= 3 ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length * 100) : null;
    });
    const rows = pool.filter(x => x.combo != null).sort((a, b) => b.combo - a.combo);
    const top = rows.slice(0, 30), bottom = rows.slice(-10).reverse();
    const m = tp && tp.mkt;
    const combo = st.factors.find(f => f.name === '恐慌組合') || {};
    const pct = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
    const fRows = st.factors.filter(f => f.name !== '恐慌組合').slice(0, 24);
    const goodBad = (t) => t == null ? '' : t >= 2 ? 'up' : t <= -2 ? 'down' : '';
    const item = x => `<div class="rk-row" data-id="${x.id}">
        <span class="rk-no" style="color:${x.combo >= 75 ? '#e6413c' : 'inherit'}">${x.combo}</span>
        <div class="rk-name"><b>${mkEsc(x.name)}</b> <span class="dim">${x.id}</span><br>
          <span class="dim">20 日 ${pct(x.d.pct20)}｜營收創高 ${x.revHi ?? '—'}｜轉折 ${x.revTurn ?? '—'}｜投信20日 ${x.t20 == null ? '—' : (x.t20 * 100).toFixed(1) + '%量'}</span></div>
        <div class="rk-val"><b class="${signClass(x.d.pct)}">${numFmt(x.d.close, 2)}</b> <span class="${signClass(x.d.pct)}">${pctFmt(x.d.pct)}</span></div>
      </div>`;
    box.innerHTML = `
      <div class="pn-head">
        <div>目前盤勢溫度 <b style="color:${m ? tempColor(m.temp) : ''}">${m ? m.temp : '—'}</b> ${m ? m.label : ''}</div>
        <div class="dim">${m && m.temp < 20 ? '現在就是研究裡的「恐慌期」' : '現在不是恐慌期（溫度 <20），清單仍可參考，但研究的情境不同'}</div>
      </div>
      <div class="section-label">🔬 研究結論（${st.from.slice(0, 4)}～${st.to.slice(0, 4)}，${st.panicN} 個恐慌日樣本）</div>
      <div class="pn-find">
        <p>恐慌時，<b class="up">跌最深、但營收還在創新高或轉好</b>的股票，之後 20～60 天平均比較強；<b class="down">恐慌前被投信大買、短線動能很強的熱門股</b>，之後平均比較弱（常被倒貨）。</p>
        <p>把這幾項合成「恐慌組合」分數：前 20% 的股票之後 20 天平均比同期全部股票多 <b>${pct(combo.ex20)}</b>、60 天多 <b>${pct(combo.ex60)}</b>（t 值 ${combo.t20 ?? '—'}／${combo.t60 ?? '—'}，大於 2 才算有統計意義）。</p>
        <p class="dim">但前 20% 裡贏過平均的只有約 ${combo.hit20 ?? '—'}%，超額來自整組平均和少數大漲的股票，<b>單一檔不一定會漲</b>。這是歷史統計，不是買賣建議。</p>
      </div>
      <details class="mh-more"><summary>看 24 個條件的完整比較</summary>
        <div class="t-wrap"><table class="data-table compact t-tbl"><thead><tr><th>條件（前 20%）</th><th>恐慌<br>t值</th><th>恐慌 20日<br>超額</th><th>恐慌 60日<br>超額</th><th>平常<br>t值</th></tr></thead><tbody>
        ${fRows.map(f => `<tr><td>${f.name}</td><td class="${goodBad(f.t20)}">${f.t20 ?? '—'}</td><td class="${tCls(f.ex20)}">${pct(f.ex20)}</td><td class="${tCls(f.ex60)}">${pct(f.ex60)}</td><td class="${goodBad(f.t20All)}">${f.t20All ?? '—'}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="dim" style="padding:4px">t 值：每次樣本「條件排名」跟「之後報酬排名」的相關係數平均 ÷ 標準差 × √次數；紅＝顯著有幫助、綠＝顯著有害。超額＝前 20% 平均報酬減全部平均。</div>
      </details>
      <div class="section-label">📋 今天恐慌組合分數最高 30 檔（成交金額前 350 大）</div>
      <div class="pn-list">${top.map(item).join('')}</div>
      <div class="section-label">⚠ 分數最低 10 檔（歷史上恐慌期較弱的型態：漲多、投信大買、營收沒成長）</div>
      <div class="pn-list">${bottom.map(item).join('')}</div>
      <p class="hint" style="padding:6px 16px 20px">分數 0～100＝四項排名的平均（跌深 20 日、營收創新高、營收轉折、投信 20 日沒有大買）。資料日 ${(await Mk.load('day')).date.slice(5)}，每天收盤後更新。
        研究只涵蓋 2018 年以來約 30 次恐慌，樣本有限；請搭配自己的判斷、分散與停損，本頁不構成投資建議。</p>`;
    box.querySelectorAll('.rk-row[data-id]').forEach(el => el.addEventListener('click', () => {
      navStocks = rows.map(x => ({ stock_id: x.id, stock_name: x.name }));
      openStock({ stock_id: el.dataset.id, stock_name: (day.get(el.dataset.id) || {}).name });
    }));
  } catch (e) {
    box.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

$('#btn-panic-back').addEventListener('click', () => goHome());
