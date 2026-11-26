// 每日盤後報告（2026-11-26）← mk/report.json（Agent daily_report.py，跟著 market_export 17:30／19:30／21:40 更新）
// 首頁 #rep-bar 一行摘要，點了進 #screen-report。「自選股重點」用 report.flags 對手機裡的自選清單（自選名單不在公開檔裡）。
// 只做資料整理，不是買賣建議。
const REP_FLAG_ICON = { lu: '🔺', ld: '🔻', vol: '💥', fbuy: '🟥', fsell: '🟩', tbuy: '🏦', tsell: '🏚', mgup: '⚠', rev: '📈', pun: '⛔', ex: '💰' };

async function paintRepBar() {
  const box = $('#rep-bar');
  if (!box) return;
  try {
    const r = await Mk.load('report');
    if (!r || !r.headline || !r.headline.length) return;
    const ids = new Set(getWatchlist().map(s => s.stock_id));
    const hits = Object.keys(r.flags || {}).filter(id => ids.has(id)).length;
    box.innerHTML = `<span class="rep-ic">📰</span><span class="rep-txt"><b>盤後報告 ${r.date.slice(5).replace('-', '/')}</b>　${mkEsc(r.headline.find(h => h.startsWith('強勢族群')) || r.headline[0])}</span>${hits ? `<span class="rep-hit">自選 ${hits}</span>` : ''}<span class="rep-go">›</span>`;
    box.hidden = false;
  } catch (e) { /* 沒有報告就不顯示 */ }
}

async function openReport() {
  showScreen('screen-report');
  const box = $('#report-body');
  box.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const [r, day] = await Promise.all([Mk.load('report'), Mk.dayMap()]);
    const wl = getWatchlist();
    const mine = wl.filter(s => r.flags[s.stock_id]).map(s => ({ id: s.stock_id, name: s.stock_name || (day.get(s.stock_id) || {}).name || s.stock_id, f: r.flags[s.stock_id] }));
    // 警示類排前面
    const pri = f => f.some(x => ['pun', 'ld', 'mgup', 'fsell', 'tsell'].includes(x[0])) ? 0 : 1;
    mine.sort((a, b) => pri(a.f) - pri(b.f) || b.f.length - a.f.length);
    const stockRow = (id, name, txt, cls) => `<div class="rep-row" data-id="${id}"><div><b>${mkEsc(name)}</b> <span class="dim">${id}</span>${wl.some(s => s.stock_id === id) ? ' ★' : ''}</div><div class="rep-sub ${cls || ''}">${txt}</div></div>`;
    let html = `<div class="rep-head"><div class="rep-date">${r.date}　<span class="dim">更新 ${r.updated.slice(5)}</span></div>${r.headline.map(h => `<div>• ${mkEsc(h)}</div>`).join('')}</div>`;
    html += `<div class="section-label">⭐ 自選股重點</div>`;
    if (!wl.length) html += '<div class="empty-hint" style="padding:8px 16px">自選清單是空的（訪客模式看不到擁有者的清單）</div>';
    else if (!mine.length) html += '<div class="empty-hint" style="padding:8px 16px">今天自選清單裡沒有特別的籌碼或價格訊號</div>';
    else html += mine.map(m => {
      const d = day.get(m.id) || {};
      return stockRow(m.id, m.name, `${d.pct != null ? `<span class="${signClass(d.pct)}">${pctFmt(d.pct)}</span>　` : ''}${m.f.map(x => `<span class="rep-tag t-${x[0]}">${REP_FLAG_ICON[x[0]] || ''}${mkEsc(x[1])}</span>`).join('')}`);
    }).join('');
    for (const s of r.sections) {
      html += `<div class="section-label">${mkEsc(s.t)}${s.note ? `<span class="dim" style="font-weight:400;font-size:11px">　${mkEsc(s.note)}</span>` : ''}</div>`;
      html += s.items.map(it => it.id ? stockRow(it.id, it.name, mkEsc(it.txt), it.cls)
        : `<div class="rep-row${it.grp ? ' rep-grp' : ''}"${it.grp ? ` data-grp="${it.grp}"` : ''}><div><b>${mkEsc(it.name)}</b>${it.grp ? ' <span class="dim">›</span>' : ''}</div><div class="rep-sub">${mkEsc(it.txt)}</div></div>`).join('');
    }
    html += `<div class="branch-note">每天 17:30／19:30／21:40 依證交所、櫃買公布的資料自動整理（法人約 19:30 齊、融資約 21:40）。族群＝產業別＋自訂概念股，漲跌幅用成交值加權。圖示：🔺漲停 🔻跌停 💥爆量 🟥外資大買 🟩外資大賣 🏦投信連買 🏚投信連賣 ⚠融資暴增 📈營收新高 ⛔處置 💰除權息。資料整理，非投資建議。</div>`;
    box.innerHTML = html;
    const stocks = [...box.querySelectorAll('.rep-row[data-id]')].map(el => ({ stock_id: el.dataset.id, stock_name: el.querySelector('b').textContent }));
    box.querySelectorAll('.rep-row[data-id]').forEach(el => el.addEventListener('click', () => {
      navStocks = stocks;
      repRemember();
      Rep.fromStock = true;
      if (typeof Rank !== 'undefined') Rank.fromRank = false;
      openStock({ stock_id: el.dataset.id, stock_name: el.querySelector('b').textContent });
    }));
    box.querySelectorAll('.rep-row[data-grp]').forEach(el => el.addEventListener('click', () => {
      const g = el.dataset.grp;
      repRemember();
      Rep.fromRank = true;
      Rank.cat = 'sector'; Rank.sec = 'chg'; Rank.secKind = /^c_/.test(g) ? 'con' : 'ind'; Rank.secCode = g;
      $('#rk-list').innerHTML = '';
      openRank();
    }));
  } catch (e) {
    box.innerHTML = `<div class="error-msg">還沒有盤後報告（每個交易日 17:30 後產生）：${mkEsc(e.message)}</div>`;
  }
}

// 從報告點進個股／族群 → 返回鍵回到報告原本的捲動位置（跟排行、雷達同一招：capture 階段先攔）
const Rep = { scroll: 0, fromStock: false, fromRank: false };
function repRemember() { const sc = $('#screen-report .pf-scroll'); Rep.scroll = sc ? sc.scrollTop : 0; }
async function repBack() {
  await openReport();
  const sc = $('#screen-report .pf-scroll');
  if (sc) sc.scrollTop = Rep.scroll || 0;
}
$('#btn-back').addEventListener('click', e => {
  if (!Rep.fromStock || (typeof Rank !== 'undefined' && Rank.fromRank)) return;  // 報告→族群→個股：先回排行（排行那邊處理）
  e.stopImmediatePropagation();
  Rep.fromStock = false;
  stopRtTimer();
  repBack();
}, true);
$('#btn-rk-back').addEventListener('click', e => {
  if (!Rep.fromRank) return;
  e.stopImmediatePropagation();
  Rep.fromRank = false;
  if (typeof Rank !== 'undefined') Rank.fromRank = false;
  repBack();
}, true);
// 中途改去別的畫面（首頁、大盤、國際…）就忘掉「從報告來的」，之後的返回照舊
{
  const orig = showScreen;
  showScreen = id => { if (!['screen-detail', 'screen-report', 'screen-rank'].includes(id)) Rep.fromStock = Rep.fromRank = false; orig(id); };  // eslint-disable-line no-global-assign
}
$('#rep-bar').addEventListener('click', () => { Rep.fromStock = Rep.fromRank = false; openReport(); });
$('#btn-report-back').addEventListener('click', () => { Rep.fromStock = Rep.fromRank = false; goHome(); });
paintRepBar();
document.addEventListener('visibilitychange', () => { if (!document.hidden) paintRepBar(); });
