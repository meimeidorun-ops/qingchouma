// 自選清單多顯示一個籌碼數字（2026-11-21）：清單上方「欄位：…」按鈕循環切換，選擇存在 localStorage.wl_extra。
// 資料都是全市場檔（每天收盤後），所以只在清單畫出來時畫一次。
const WLX = [
  ['', '無'], ['f5', '外資5日'], ['t5', '投信5日'], ['inst5', '法人5日'], ['mg5', '融資5日'], ['dt', '當沖%'], ['big', '大戶%'], ['temp', '溫度'], ['pct20', '20日漲跌'],
];
let wlExtra = (() => { try { return localStorage.getItem('wl_extra') || ''; } catch (e) { return ''; } })();

function wlExtraLabel() { return `欄位：${(WLX.find(x => x[0] === wlExtra) || WLX[0])[1]}`; }

async function wlPaintExtra() {
  const btn = $('#wl-extra');
  if (btn) btn.textContent = wlExtraLabel();
  const items = $$('#watchlist .wl-item');
  items.forEach(el => { const x = el.querySelector('.wl-extra'); if (x) x.remove(); });
  if (!wlExtra || !items.length) return;
  const need = { f5: ['inst'], t5: ['inst'], inst5: ['inst'], mg5: ['margin'], dt: ['dt'], big: ['tdcc'], temp: ['temp'], pct20: ['day'] }[wlExtra] || [];
  const D = {};
  try { await Promise.all(need.map(async n => { D[n] = await Mk.load(n); })); } catch (e) { return; }
  const day = D.day ? await Mk.dayMap() : null;
  const sum5 = a => { if (!a) return null; let s = 0; for (let i = Math.max(0, a.length - 5); i < a.length; i++) s += a[i] || 0; return s; };
  for (const el of items) {
    const id = el.dataset.id;
    let v = null, txt = '', cls = '';
    if (D.inst) {
      const I = D.inst.s[id];
      if (I) v = wlExtra === 'f5' ? sum5(I[0]) : wlExtra === 't5' ? sum5(I[1]) : sum5(I[0]) + sum5(I[1]) + sum5(I[2]);
      if (v != null) { txt = `${v > 0 ? '+' : ''}${numFmt(Math.round(v))} 張`; cls = signClass(v); }
    } else if (D.margin) {
      const M = D.margin.s[id], L = D.margin.days.length;
      if (M && M[0][L - 1] != null && M[0][L - 6]) { v = (M[0][L - 1] / M[0][L - 6] - 1) * 100; txt = `資 ${v > 0 ? '+' : ''}${v.toFixed(1)}%`; cls = signClass(-v); }
    } else if (D.dt) {
      const s = D.dt.s[id], L = D.dt.days.length;
      if (s && s[0][L - 1] != null) { v = s[0][L - 1]; txt = `沖 ${v}%`; cls = v >= 50 ? 'up' : ''; }
    } else if (D.tdcc) {
      const s = D.tdcc.s[id], W = D.tdcc.weeks.length;
      if (s && s[0][W - 1] != null) { v = s[0][W - 1]; const c = s[0][W - 2] != null ? v - s[0][W - 2] : null; txt = `大戶 ${v.toFixed(1)}%${c != null ? `（${c >= 0 ? '+' : ''}${c.toFixed(1)}）` : ''}`; cls = c != null ? signClass(c) : ''; }
    } else if (D.temp) {
      const s = D.temp.stk.s[id];
      if (s) { v = s[0]; txt = `溫度 ${v}`; cls = v >= 80 ? 'up' : v < 20 ? 'down' : ''; }
    } else if (day) {
      const p = day.get(id);
      if (p && p.pct20 != null) { v = p.pct20; txt = `20日 ${v > 0 ? '+' : ''}${v.toFixed(1)}%`; cls = signClass(v); }
    }
    if (!txt) continue;
    const span = document.createElement('div');
    span.className = `wl-extra ${cls}`;
    span.textContent = txt;
    // 放左邊（右邊的報價區每 20 秒會整塊重畫）
    const left = el.querySelector('.wl-left');
    if (left) left.appendChild(span);
  }
}

$('#wl-extra').addEventListener('click', () => {
  const i = WLX.findIndex(x => x[0] === wlExtra);
  wlExtra = WLX[(i + 1) % WLX.length][0];
  try { localStorage.setItem('wl_extra', wlExtra); } catch (e) {}
  wlPaintExtra();
});
$('#wl-extra').textContent = wlExtraLabel();
