// 首頁 🎯「權證分點雷達」：全市場哪幾檔股票最近有分點在收它的認購權證（2026-10-09）。
// 資料：wb/radar.json（權證超跌反彈/export_app.py 每天全市場掃描後產生，約 20:10 更新）。
// 每列＝「股票 × 分點」，依期間內認購權證淨買超金額排序；點一列 → 打開個股頁的「分點 › 權證分點」。
const Radar = { n: Number(localStorage.getItem('rd_n') || 5), steadyOnly: localStorage.getItem('rd_steady') === '1',
  noHq: localStorage.getItem('rd_nohq') === '1', data: null, at: 0 };

async function radarFetch() {
  if (Radar.data && Date.now() - Radar.at < 6e5) return Radar.data;
  const res = await fetch(`wb/radar.json?t=${Math.floor(Date.now() / 6e5)}`);
  if (!res.ok) throw new Error(res.status === 404 ? '還沒有雷達資料（等今晚全市場掃描跑完）' : `HTTP ${res.status}`);
  Radar.data = await res.json();
  Radar.at = Date.now();
  return Radar.data;
}

// 「持續買進」：期間內淨買認購的天數夠多、賣的天數不到買的 1/3
function radarSteady(r, eff) {
  return eff >= 2 && r.bd >= Math.max(2, Math.ceil(eff * 0.4)) && r.sd * 3 <= r.bd;
}

function paintRadarBars() {
  $$('#rd-range .range-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.n) === Radar.n));
  $('#rd-steady').classList.toggle('active', Radar.steadyOnly);
  $('#rd-nohq').classList.toggle('active', Radar.noHq);
}

async function openRadar() {
  showScreen('screen-radar');
  paintRadarBars();
  const box = $('#rd-list');
  const sum = $('#rd-summary');
  if (!Radar.data) box.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const d = await radarFetch();
    const eff = Math.min(Radar.n, d.days.length);
    let rows = d.win[String(Radar.n)] || [];
    if (Radar.noHq) rows = rows.filter(r => !r.hq);
    if (Radar.steadyOnly) rows = rows.filter(r => radarSteady(r, eff));
    const watched = new Set(getWatchlist().map(s => s.stock_id));
    const short = d.days.length < Radar.n ? `｜資料庫目前只有 ${d.days.length} 天` : '';
    sum.innerHTML = `資料日 <b>${d.days[0]}</b>（近 ${eff} 個掃描日${short}）｜更新 ${d.updated.slice(5)}｜★ 在自選清單`;
    if (!rows.length) {
      box.innerHTML = `<div class="empty-hint">${Radar.steadyOnly ? '沒有符合「持續買進」的分點（資料累積幾天後會比較多）' : '沒有資料'}</div>`;
      return;
    }
    box.innerHTML = rows.slice(0, 60).map((r, i) => {
      const steady = radarSteady(r, eff);
      return `<div class="rd-row" data-i="${i}" style="padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer">
        <div style="display:flex;align-items:baseline;gap:8px">
          <b>${r.name || r.id}</b><span class="dim">${r.id}${watched.has(r.id) ? ' ★' : ''}</span>
          <span style="flex:1"></span><b class="up">+${numFmt(Math.round(r.call / 1e4))} 萬</b>
        </div>
        <div style="display:flex;gap:8px;font-size:13px;margin-top:3px;flex-wrap:wrap">
          <span>${r.b}${r.hq ? ' <span class="dim">（總公司）</span>' : ''}</span>
          <span class="dim">買 ${r.bd} 天／賣 ${r.sd} 天｜收 ${r.nw} 支</span>
          ${steady ? '<span class="up">🔁 持續買進</span>' : ''}
          ${r.put > 0 ? `<span class="down">另買認售 ${numFmt(Math.round(r.put / 1e4))} 萬</span>` : ''}
        </div>
        <div class="dim" style="font-size:12px;margin-top:2px">${(r.w || []).join('、')}</div>
      </div>`;
    }).join('') + '<div class="branch-note">每天收盤後掃描全市場成交金額 ≥30 萬的權證，「股票 × 分點」認購淨買超金額排行（已排除發行商造市席位；總公司常是券商自營）。大額買權證的分點很多是隔日沖，先觀察、不要追高。</div>';
    box.querySelectorAll('.rd-row').forEach(el => el.addEventListener('click', () => {
      const r = rows[Number(el.dataset.i)];
      radarOpenStock(r.id, r.name);
    }));
  } catch (e) {
    box.innerHTML = `<div class="error-msg">載入失敗：${e.message}</div>`;
  }
}

// 打開個股頁並直接切到「分點 › 權證分點」
function radarOpenStock(id, name) {
  branchMode = 'warrant';
  localStorage.setItem('branch_mode', 'warrant');
  paintBranchMode();
  branchPeriod = { 1: 1, 5: 2, 10: 3, 20: 4 }[Radar.n] || 2;  // 個股頁期間跟雷達一致
  $$('#branch-range .range-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.period) === branchPeriod));
  openStock({ stock_id: id, stock_name: name || id });
  setTimeout(() => { const t = document.querySelector('.tab-btn[data-tab="branch"]'); if (t) t.click(); }, 50);
}

$('#btn-radar').addEventListener('click', () => openRadar());
$('#btn-rd-back').addEventListener('click', () => goHome());
$$('#rd-range .range-btn').forEach(b => b.addEventListener('click', () => {
  Radar.n = Number(b.dataset.n);
  localStorage.setItem('rd_n', Radar.n);
  openRadar();
}));
$('#rd-steady').addEventListener('click', () => {
  Radar.steadyOnly = !Radar.steadyOnly;
  localStorage.setItem('rd_steady', Radar.steadyOnly ? '1' : '0');
  openRadar();
});
$('#rd-nohq').addEventListener('click', () => {
  Radar.noHq = !Radar.noHq;
  localStorage.setItem('rd_nohq', Radar.noHq ? '1' : '0');
  openRadar();
});
