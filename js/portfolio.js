// 操作計畫頁（持股紀錄）＋ 短線計畫狀態 ＋ 盯盤 Agent 的買賣建議。
// 資料存在 Apps Script 後端（Holdings.gs）的「庫存紀錄」工作表；讀寫都要 token。
// 規則計算（停損、持有天數、本益比、帳戶保險絲、候選股）由本機的 台股AI盯盤Agent
// 每天收盤後算好寫回後端（advice），這裡只負責輸入紀錄與顯示，避免兩邊各算一套。

const Portfolio = {
  lots: [],
  settings: null,
  advice: null,
  quotes: {},
  eps: {},
  view: 'open',

  async api(body) {
    const res = await fetch(backendUrl(), {
      method: 'POST',
      body: JSON.stringify(Object.assign({ token: backendToken() }, body)),
    });
    const json = await res.json();
    if (json.status !== 200) throw new Error(json.error || '後端錯誤');
    return json;
  },

  async load() {
    const res = await fetch(`${backendUrl()}?action=portfolio&token=${encodeURIComponent(backendToken())}`);
    const json = await res.json();
    if (json.status === 401) throw new Error('token 不正確');
    if (json.status !== 200) throw new Error(json.error || '後端還沒有操作計畫功能（請先更新 Apps Script）');
    this.lots = json.data.lots || [];
    this.settings = json.data.settings;
    this.advice = json.data.advice;
    try { localStorage.setItem('portfolio_cache', JSON.stringify(json.data)); } catch (e) {}
  },

  loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem('portfolio_cache') || 'null');
      if (c) { this.lots = c.lots || []; this.settings = c.settings; this.advice = c.advice; return true; }
    } catch (e) {}
    return false;
  },

  openLots() { return this.lots.filter(l => l.status === 'open'); },
  closedLots() { return this.lots.filter(l => l.status === 'closed').sort((a, b) => (b.sell_date || '').localeCompare(a.sell_date || '')); },

  async loadQuotes() {
    const ids = [...new Set(this.openLots().map(l => l.stock_id))];
    if (!ids.length) return;
    const stocks = ids.map(id => ({ stock_id: id, market: (this.lots.find(l => l.stock_id === id) || {}).market }));
    let q = {};
    try { q = await Backend.quote(stocks); } catch (e) { console.warn('quote failed', e); }
    const missing = ids.filter(id => !(q[id] && q[id].price != null));
    if (missing.length) {
      try {
        const c = await Backend.closeAll(missing);
        missing.forEach(id => { if (c[id] && c[id].close != null) q[id] = { price: c[id].close, change: c[id].change }; });
      } catch (e) { console.warn('closeAll failed', e); }
    }
    this.quotes = q;
    try {
      const list = await Backend.list();
      this.eps = Object.fromEntries(list.map(s => [s.stock_id, s]));
    } catch (e) {}
  },
};

function pfDaysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}
function pfToday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function pfEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 每檔的即時狀態（只做顯示用的簡單計算；正式建議以 Agent 寫回的 advice 為準）
function pfLotStatus(lot) {
  const s = Portfolio.settings || {};
  const q = Portfolio.quotes[lot.stock_id];
  const price = q && q.price != null ? q.price : null;
  const pnlPct = price != null ? (price / lot.buy_price - 1) * 100 : null;
  const pnl = price != null ? (price - lot.buy_price) * lot.shares : null;
  const days = pfDaysBetween(lot.buy_date, pfToday());
  const chips = [];
  if (lot.strategy === 'plan') {
    const stop = lot.buy_price * (1 - (s.stop_pct || 12) / 100);
    if (price != null && price <= stop) chips.push(['bad', '跌破停損']);
    else if (price != null && price <= stop * 1.04) chips.push(['warn', '接近停損']);
    if (days >= (s.max_hold_days || 90)) chips.push(['bad', '持有期滿']);
    else if (days >= (s.max_hold_days || 90) - 14) chips.push(['warn', `剩 ${(s.max_hold_days || 90) - days} 天`]);
  }
  const e = Portfolio.eps[lot.stock_id];
  const eps = e ? e['eps' + (s.eps_year || 2026)] : null;
  const pe = price != null && eps > 0 ? price / eps : null;
  if (pe != null && pe >= (s.pe_sell || 30)) chips.push(['bad', `本益比 ${pe.toFixed(1)}`]);
  return { price, pnlPct, pnl, days, pe, chips };
}

function pfAdviceFor(stockId) {
  const a = Portfolio.advice;
  if (!a || !a.actions) return [];
  return a.actions.filter(x => x.stock_id === stockId);
}

function renderPortfolio() {
  const open = Portfolio.openLots();
  const closed = Portfolio.closedLots();
  const s = Portfolio.settings || {};

  // ---- 總覽 ----
  let mv = 0, cost = 0, planMv = 0, planCost = 0, planCount = new Set();
  open.forEach(l => {
    const st = pfLotStatus(l);
    const p = st.price != null ? st.price : l.buy_price;
    mv += p * l.shares; cost += l.buy_price * l.shares;
    if (l.strategy === 'plan') { planMv += p * l.shares; planCost += l.buy_price * l.shares; planCount.add(l.stock_id); }
  });
  let realized = 0, planRealized = 0;
  closed.forEach(l => {
    const r = (l.sell_price - l.buy_price) * l.shares;
    realized += r;
    if (l.strategy === 'plan' && (!s.plan_start || l.sell_date >= s.plan_start)) planRealized += r;
  });
  const cap = s.capital || 600000;
  const planEquity = cap + planRealized + (planMv - planCost);
  const planPct = (planEquity / cap - 1) * 100;
  const fuse = planPct <= -(s.fuse_stop_pct || 17) ? ['bad', '已觸發：計畫結束'] :
               planPct <= -(s.fuse_pause_pct || 10) ? ['warn', '暫停買進'] : ['ok', '正常'];
  const unreal = mv - cost;

  $('#pf-summary').innerHTML = `
    <div class="pf-sum-grid">
      <div><div class="pf-k">持股市值</div><div class="pf-v">${numFmt(mv)}</div></div>
      <div><div class="pf-k">未實現損益</div><div class="pf-v ${signClass(unreal)}">${unreal >= 0 ? '+' : ''}${numFmt(unreal)}</div></div>
      <div><div class="pf-k">已實現損益</div><div class="pf-v ${signClass(realized)}">${realized >= 0 ? '+' : ''}${numFmt(realized)}</div></div>
    </div>
    <div class="pf-plan">
      <div class="pf-plan-row"><span>短線計畫（本金 ${numFmt(cap)}）</span>
        <b class="${signClass(planPct)}">${numFmt(planEquity)}（${pctFmt(planPct, 1)}）</b></div>
      <div class="pf-plan-row"><span>持股檔數</span><b>${planCount.size} / ${s.max_positions || 5}</b></div>
      <div class="pf-plan-row"><span>帳戶保險絲</span><span class="pf-chip ${fuse[0]}">${fuse[1]}</span></div>
    </div>`;

  // ---- Agent 建議 ----
  const a = Portfolio.advice;
  const box = $('#pf-advice');
  if (!a) {
    box.innerHTML = `<div class="pf-card"><div class="pf-card-title">盯盤系統建議</div>
      <p class="hint">還沒有建議。電腦上的盯盤系統每天收盤後（18:30）會依你的計畫規則檢查持股，週日晚上會附上候選清單。</p></div>`;
  } else {
    const acts = (a.actions || []).map(x => `<li class="pf-act ${x.type}"><b>${pfEsc(x.label || x.type)}</b>　${pfEsc(x.name || '')} ${pfEsc(x.stock_id || '')}<br><span class="hint">${pfEsc(x.reason || '')}</span></li>`).join('');
    const cands = (a.candidates || []).map(c => `<li><b>${pfEsc(c.name)} ${pfEsc(c.stock_id)}</b>　本益比 ${c.pe != null ? c.pe.toFixed(1) : '—'}${c.pe_next != null ? ` / 明年 ${c.pe_next.toFixed(1)}` : ''}
        ${c.shares ? `<br><span class="hint">第一批約 ${numFmt(c.shares)} 股（${numFmt(c.amount)} 元）</span>` : ''}
        ${(c.flags || []).length ? `<br><span class="hint">${c.flags.map(pfEsc).join('、')}</span>` : ''}</li>`).join('');
    box.innerHTML = `<div class="pf-card">
      <div class="pf-card-title">盯盤系統建議 <span class="hint">${pfEsc(a.at || '')}</span></div>
      ${acts ? `<ul class="pf-list">${acts}</ul>` : '<p class="hint">今天沒有需要動作的持股。</p>'}
      ${(a.notes || []).map(n => `<p class="hint">${pfEsc(n)}</p>`).join('')}
      ${cands ? `<div class="pf-card-title" style="margin-top:12px">本週候選（依你的規則排序${a.candidates_at ? `，${pfEsc(a.candidates_at)}` : ''}）</div><ul class="pf-list">${cands}</ul>
        <p class="hint">候選只是依規則篩出來的清單，要讀過定錨筆記、寫得出理由再買。</p>` : ''}
    </div>`;
  }

  // ---- 清單 ----
  $$('#pf-tabs .range-btn').forEach(b => b.classList.toggle('active', b.dataset.view === Portfolio.view));
  const listBox = $('#pf-list');
  if (Portfolio.view === 'open') {
    if (!open.length) { listBox.innerHTML = `<div class="empty-hint">還沒有持股紀錄<br>按右上角「＋」新增一筆買進</div>`; return; }
    const sorted = [...open].sort((x, y) => (x.strategy === y.strategy ? 0 : x.strategy === 'plan' ? -1 : 1));
    listBox.innerHTML = sorted.map(l => {
      const st = pfLotStatus(l);
      const adv = pfAdviceFor(l.stock_id).map(x => ['bad', x.label || x.type]);
      const chips = [...adv, ...st.chips].map(c => `<span class="pf-chip ${c[0]}">${pfEsc(c[1])}</span>`).join('');
      return `<div class="wl-item pf-item" data-id="${l.id}">
        <div class="wl-left">
          <div class="wl-name">${pfEsc(l.stock_name || l.stock_id)} <span class="pf-tag ${l.strategy}">${l.strategy === 'plan' ? '短線' : '長期'}</span></div>
          <div class="wl-code">${l.stock_id}　${numFmt(l.shares)} 股 @ ${numFmt(l.buy_price, 2)}　${st.days} 天</div>
          <div class="pf-chips">${chips}</div>
        </div>
        <div class="wl-right">
          <div class="wl-price">${st.price != null ? numFmt(st.price, 2) : '—'}</div>
          <div class="wl-change ${signClass(st.pnl)}">${st.pnl != null ? `${st.pnl >= 0 ? '+' : ''}${numFmt(st.pnl)}（${pctFmt(st.pnlPct, 1)}）` : ''}</div>
        </div>
      </div>`;
    }).join('');
  } else {
    if (!closed.length) { listBox.innerHTML = `<div class="empty-hint">還沒有賣出紀錄</div>`; return; }
    listBox.innerHTML = closed.map(l => {
      const r = (l.sell_price - l.buy_price) * l.shares;
      const pct = (l.sell_price / l.buy_price - 1) * 100;
      return `<div class="wl-item pf-item" data-id="${l.id}">
        <div class="wl-left">
          <div class="wl-name">${pfEsc(l.stock_name || l.stock_id)} <span class="pf-tag ${l.strategy}">${l.strategy === 'plan' ? '短線' : '長期'}</span></div>
          <div class="wl-code">${l.buy_date} → ${l.sell_date}　${numFmt(l.shares)} 股</div>
        </div>
        <div class="wl-right">
          <div class="wl-price">${numFmt(l.buy_price, 2)} → ${numFmt(l.sell_price, 2)}</div>
          <div class="wl-change ${signClass(r)}">${r >= 0 ? '+' : ''}${numFmt(r)}（${pctFmt(pct, 1)}）</div>
        </div>
      </div>`;
    }).join('');
  }
  listBox.querySelectorAll('.pf-item').forEach(el => el.addEventListener('click', () => pfLotMenu(el.dataset.id)));
}

async function openPortfolio(refresh = true) {
  showScreen('screen-portfolio');
  if (Portfolio.loadCache()) renderPortfolio();
  else $('#pf-list').innerHTML = `<div class="empty-hint">載入中…</div>`;
  if (!refresh) return;
  try {
    await Portfolio.load();
    await Portfolio.loadQuotes();
    renderPortfolio();
  } catch (e) {
    $('#pf-list').innerHTML = `<div class="empty-hint">讀取失敗：${pfEsc(e.message)}</div>`;
  }
}

function pfField(id, label, attrs = '', value = '') {
  return `<label class="pf-label" for="${id}">${label}</label><input class="pf-input" id="${id}" ${attrs} value="${pfEsc(value)}">`;
}

async function pfAddForm(prefill = {}) {
  await ensureStockIndex();
  showModal(`<div class="modal-title">新增買進紀錄</div>
    ${pfField('pf-f-code', '股票代號或名稱', 'placeholder="例如 2441 或 超豐" autocomplete="off"', prefill.stock_id || '')}
    <div class="hint" id="pf-f-name"></div>
    <div class="pf-row2">
      <div>${pfField('pf-f-shares', '股數（1 張 = 1000 股）', 'type="number" inputmode="numeric" min="1"')}</div>
      <div>${pfField('pf-f-price', '成交價', 'type="number" inputmode="decimal" step="0.01"')}</div>
    </div>
    ${pfField('pf-f-date', '買進日期', 'type="date"', pfToday())}
    <label class="pf-label">類型</label>
    <div class="range-bar" id="pf-f-type" style="padding:0 0 8px">
      <button class="range-btn ${prefill.strategy === 'long' ? '' : 'active'}" data-v="plan">短線計畫</button>
      <button class="range-btn ${prefill.strategy === 'long' ? 'active' : ''}" data-v="long">長期持有</button>
    </div>
    <label class="pf-label" for="pf-f-reason">理由（短線計畫必填：為什麼 3 個月內會漲）</label>
    <textarea class="pf-input" id="pf-f-reason" rows="3"></textarea>
    <p class="hint" id="pf-f-msg"></p>
    <button class="modal-btn" id="pf-f-save" style="text-align:center">儲存</button>
    <button class="modal-btn" id="pf-f-cancel" style="text-align:center">取消</button>`);
  let type = prefill.strategy === 'long' ? 'long' : 'plan';
  $$('#pf-f-type .range-btn').forEach(b => b.addEventListener('click', () => {
    type = b.dataset.v;
    $$('#pf-f-type .range-btn').forEach(x => x.classList.toggle('active', x === b));
  }));
  const resolve = () => {
    const q = $('#pf-f-code').value.trim();
    const hit = stockIndex.find(s => s.stock_id === q) || stockIndex.find(s => s.stock_name === q);
    $('#pf-f-name').textContent = hit ? `${hit.stock_name}（${hit.stock_id}）` : (q ? '找不到這檔股票' : '');
    return hit;
  };
  $('#pf-f-code').addEventListener('input', resolve);
  resolve();
  $('#pf-f-cancel').addEventListener('click', closeModal);
  $('#pf-f-save').addEventListener('click', async () => {
    const hit = resolve();
    const shares = Number($('#pf-f-shares').value);
    const price = Number($('#pf-f-price').value);
    const reason = $('#pf-f-reason').value.trim();
    if (!hit) return ($('#pf-f-msg').textContent = '請輸入正確的股票代號');
    if (!(shares > 0) || !(price > 0)) return ($('#pf-f-msg').textContent = '股數和成交價都要填');
    if (type === 'plan' && !reason) return ($('#pf-f-msg').textContent = '短線計畫請寫下買進理由');
    $('#pf-f-msg').textContent = '儲存中…';
    try {
      await Portfolio.api({ action: 'lotAdd', lot: {
        stock_id: hit.stock_id, stock_name: hit.stock_name, market: marketFor(hit.stock_id),
        shares, buy_price: price, buy_date: $('#pf-f-date').value || pfToday(), strategy: type, reason,
      } });
      closeModal();
      openPortfolio();
    } catch (e) { $('#pf-f-msg').textContent = `儲存失敗：${e.message}`; }
  });
}

function pfLotMenu(id) {
  const l = Portfolio.lots.find(x => x.id === id);
  if (!l) return;
  const adv = pfAdviceFor(l.stock_id);
  showModal(`<div class="modal-title">${pfEsc(l.stock_name)} ${l.stock_id}　${numFmt(l.shares)} 股 @ ${numFmt(l.buy_price, 2)}</div>
    ${l.reason ? `<p class="hint">理由：${pfEsc(l.reason)}</p>` : ''}
    ${adv.map(x => `<p class="hint"><b>${pfEsc(x.label || x.type)}</b>：${pfEsc(x.reason || '')}</p>`).join('')}
    <button class="modal-btn" id="pf-m-chart">看走勢</button>
    ${l.status === 'open' ? `<button class="modal-btn" id="pf-m-sell">賣出</button>
    <button class="modal-btn" id="pf-m-add">加碼 / 補第二批</button>` : ''}
    <button class="modal-btn danger" id="pf-m-del">刪除這筆紀錄（輸入錯誤時用）</button>
    <button class="modal-btn" id="pf-m-cancel" style="text-align:center">取消</button>`);
  $('#pf-m-cancel').addEventListener('click', closeModal);
  $('#pf-m-chart').addEventListener('click', () => { closeModal(); openStock({ stock_id: l.stock_id, stock_name: l.stock_name }); });
  if ($('#pf-m-add')) $('#pf-m-add').addEventListener('click', () => pfAddForm({ stock_id: l.stock_id, strategy: l.strategy }));
  if ($('#pf-m-sell')) $('#pf-m-sell').addEventListener('click', () => pfSellForm(l));
  $('#pf-m-del').addEventListener('click', () => {
    showModal(`<div class="modal-title">確定刪除 ${pfEsc(l.stock_name)} 這筆紀錄？</div>
      <p class="hint">刪除後無法復原。已經賣出的股票請用「賣出」，紀錄才會保留下來做績效檢討。</p>
      <button class="modal-btn danger" id="pf-d-yes" style="text-align:center">刪除</button>
      <button class="modal-btn" id="pf-d-no" style="text-align:center">取消</button>`);
    $('#pf-d-no').addEventListener('click', closeModal);
    $('#pf-d-yes').addEventListener('click', async () => {
      try { await Portfolio.api({ action: 'lotDelete', id: l.id }); closeModal(); openPortfolio(); }
      catch (e) { alertInModal(`刪除失敗：${e.message}`); }
    });
  });
}

function alertInModal(msg) {
  showModal(`<div class="modal-title">${pfEsc(msg)}</div><button class="modal-btn" id="pf-ok" style="text-align:center">好</button>`);
  $('#pf-ok').addEventListener('click', closeModal);
}

function pfSellForm(l) {
  const st = pfLotStatus(l);
  showModal(`<div class="modal-title">賣出 ${pfEsc(l.stock_name)} ${l.stock_id}</div>
    <div class="pf-row2">
      <div>${pfField('pf-s-shares', `股數（持有 ${numFmt(l.shares)}）`, 'type="number" inputmode="numeric" min="1"', l.shares)}</div>
      <div>${pfField('pf-s-price', '成交價', 'type="number" inputmode="decimal" step="0.01"', st.price != null ? st.price : '')}</div>
    </div>
    ${pfField('pf-s-date', '賣出日期', 'type="date"', pfToday())}
    ${pfField('pf-s-note', '賣出原因（例如：停損、期滿、本益比到 30、理由被推翻）', '')}
    <p class="hint" id="pf-s-msg"></p>
    <button class="modal-btn" id="pf-s-save" style="text-align:center">確認賣出</button>
    <button class="modal-btn" id="pf-s-cancel" style="text-align:center">取消</button>`);
  $('#pf-s-cancel').addEventListener('click', closeModal);
  $('#pf-s-save').addEventListener('click', async () => {
    const shares = Number($('#pf-s-shares').value), price = Number($('#pf-s-price').value);
    if (!(shares > 0) || shares > l.shares || !(price > 0)) return ($('#pf-s-msg').textContent = '股數或價格不正確');
    $('#pf-s-msg').textContent = '儲存中…';
    try {
      await Portfolio.api({ action: 'lotSell', id: l.id, shares, price, date: $('#pf-s-date').value || pfToday(), note: $('#pf-s-note').value.trim() });
      closeModal();
      openPortfolio();
    } catch (e) { $('#pf-s-msg').textContent = `儲存失敗：${e.message}`; }
  });
}

function pfSettingsForm() {
  const s = Portfolio.settings || {};
  const f = [
    ['capital', '短線計畫本金（元）'], ['stock_budget', '其中放個股的上限（元）'], ['max_positions', '最多同時持有幾檔'],
    ['stop_pct', '單檔停損（%）'], ['max_hold_days', '最長持有（天）'], ['second_batch_days', '幾天內補第二批'],
    ['pe_buy', '買進：預估本益比低於'], ['pe_sell', '賣出：預估本益比達到'], ['eps_year', '用哪一年的預估 EPS'],
    ['fuse_pause_pct', '帳戶虧損達 % 暫停買進'], ['fuse_stop_pct', '帳戶虧損達 % 計畫結束'],
  ];
  showModal(`<div class="modal-title">短線計畫規則</div>
    ${f.map(([k, lab]) => pfField(`pf-set-${k}`, lab, 'type="number" inputmode="decimal"', s[k] != null ? s[k] : '')).join('')}
    ${pfField('pf-set-plan_start', '計畫開始日（這天以後賣出的短線紀錄才算進計畫損益）', 'type="date"', s.plan_start || '')}
    <p class="hint" id="pf-set-msg">改了規則之後，盯盤系統下次檢查就會用新規則。</p>
    <button class="modal-btn" id="pf-set-save" style="text-align:center">儲存</button>
    <button class="modal-btn" id="pf-set-cancel" style="text-align:center">取消</button>`);
  $('#pf-set-cancel').addEventListener('click', closeModal);
  $('#pf-set-save').addEventListener('click', async () => {
    const settings = {};
    f.forEach(([k]) => { const v = $(`#pf-set-${k}`).value; if (v !== '') settings[k] = Number(v); });
    settings.plan_start = $('#pf-set-plan_start').value || '';
    try {
      const r = await Portfolio.api({ action: 'planSettings', settings });
      Portfolio.settings = r.settings;
      closeModal();
      renderPortfolio();
    } catch (e) { $('#pf-set-msg').textContent = `儲存失敗：${e.message}`; }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  $('#btn-portfolio').addEventListener('click', () => openPortfolio());
  $('#btn-pf-back').addEventListener('click', () => goHome());
  $('#btn-pf-add').addEventListener('click', () => pfAddForm());
  $('#btn-pf-settings').addEventListener('click', pfSettingsForm);
  $$('#pf-tabs .range-btn').forEach(b => b.addEventListener('click', () => { Portfolio.view = b.dataset.view; renderPortfolio(); }));
});
