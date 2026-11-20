// 個股新聞（2026-11-21）：快速後端 action=news（鉅亨個股新聞，CDN 快取 5 分鐘）。點標題用新分頁開鉅亨原文。
async function loadNews() {
  const box = $('#news-body');
  const stock = currentStock, tk = tabTicket('news');
  box.innerHTML = '<div class="loading">載入中…</div>';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    let j;
    try { j = await (await fetch(`${FAST_URL}?action=news&id=${encodeURIComponent(stock.stock_id)}`, { signal: ctl.signal })).json(); }
    finally { clearTimeout(t); }
    if (!tabLive('news', tk, stock)) return;
    if (j.status !== 200) throw new Error(j.error || '抓不到');
    const items = j.data || [];
    if (!items.length) { box.innerHTML = '<div class="empty-hint">鉅亨沒有這檔的相關新聞</div>'; return; }
    const ago = sec => {
      const m = Math.floor((Date.now() / 1000 - sec) / 60);
      if (m < 60) return `${Math.max(1, m)} 分鐘前`;
      if (m < 1440) return `${Math.floor(m / 60)} 小時前`;
      const s = new Date((sec + 28800) * 1000).toISOString();
      return `${s.slice(5, 10).replace('-', '/')} ${s.slice(11, 16)}`;
    };
    const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    box.innerHTML = items.map(n => `
      <a class="news-item" href="https://news.cnyes.com/news/id/${encodeURIComponent(n.id)}" target="_blank" rel="noopener">
        <div class="news-title">${esc(n.title)}</div>
        ${n.summary ? `<div class="news-sum">${esc(n.summary)}</div>` : ''}
        <div class="news-time">${ago(n.t)}・鉅亨網</div>
      </a>`).join('') + '<div class="branch-note">新聞來自鉅亨網，點標題開原文。新聞內容不代表本 App 觀點，也不是投資建議。</div>';
  } catch (e) {
    if (tabLive('news', tk, stock)) box.innerHTML = `<div class="error-msg">新聞載入失敗：${e.message}</div>`;
  }
}
