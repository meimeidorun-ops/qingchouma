// 處置股、注意股、除權息預告（2026-11-21）：mk/notice.json（Agent notice_export.py，每天跟著全市場資料更新）
// 個股頁標題下方的提醒、清單上的小標籤、排行「公告」。
const twDateStr = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

function noticeFlags(n, id) {
  const out = [];
  const p = n.punish[id];
  if (p) out.push({ cls: 'bad', short: '處置', text: `處置中 ${p[1]}（${p[2]}）`, tip: '處置期間撮合變慢（約 5～20 分鐘一次），大量買賣要先付款／交券，流動性差。' });
  const t = n.notice[id];
  if (t && !p) out.push({ cls: 'warn', short: '注意', text: `注意股 ${t[2].slice(5)}${t[1] > 1 ? `（累計 ${t[1]} 次）` : ''}`, tip: t[3] });
  const today = twDateStr();
  const ex = n.exdiv.find(x => x[1] === id && x[0] >= today);
  if (ex) out.push({ cls: 'info', short: `除${ex[3]}`, text: `${ex[0].slice(5).replace('-', '/')} 除${ex[3]}${ex[4] ? `｜現金 ${+Number(ex[4]).toFixed(3)} 元` : ''}`, tip: '除權息當天開盤參考價會扣掉股利。' });
  return out;
}

async function paintDetailFlags(stock) {
  const box = $('#dt-flags');
  if (!box) return;
  box.hidden = true;
  try {
    const n = await Mk.load('notice');
    if (currentStock !== stock) return;
    const f = noticeFlags(n, stock.stock_id);
    if (!f.length) return;
    box.innerHTML = f.map(x => `<span class="nf ${x.cls}" title="${x.tip.replace(/"/g, '')}">${x.text}</span>`).join('');
    box.onclick = () => {
      showModal(`<div class="modal-title">${stock.stock_name || stock.stock_id} 公告提醒</div>
        ${f.map(x => `<div class="nf-row"><span class="nf ${x.cls}">${x.text}</span><div class="dim" style="margin-top:4px">${x.tip}</div></div>`).join('')}
        <div class="dim" style="margin-top:8px">資料：證交所、櫃買中心公告（盤後更新）。</div>
        <button class="modal-btn" id="nf-close" style="text-align:center;margin-top:10px">關閉</button>`);
      $('#nf-close').addEventListener('click', closeModal);
    };
    box.hidden = false;
  } catch (e) { /* 沒資料就不顯示 */ }
}

async function noticePaintWatchTags() {
  try {
    const n = await Mk.load('notice');
    for (const el of $$('#watchlist .wl-item')) {
      const f = noticeFlags(n, el.dataset.id);
      let tag = el.querySelector('.nf-tag');
      if (!f.length) { if (tag) tag.remove(); continue; }
      if (!tag) { tag = document.createElement('span'); el.querySelector('.wl-code').appendChild(tag); }
      tag.className = `nf-tag ${f[0].cls}`;
      tag.textContent = f[0].short;
    }
  } catch (e) { /* 不影響清單 */ }
}
