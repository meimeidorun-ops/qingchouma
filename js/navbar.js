// 底部導覽列（2026-11-22）：仿籌碼K線，把首頁上方的 📊🎯💼⚙ 和各大功能收到最下面一排。
// 主要畫面（自選、大盤、排行、國際）顯示；個股頁、設定頁、搜尋時不顯示（不擋內容）。
const NAV_SCREENS = { 'screen-home': 'home', 'screen-index': 'index', 'screen-rank': 'rank', 'screen-global': 'global', 'screen-radar': 'more', 'screen-portfolio': 'more', 'screen-panic': 'more' };

(() => {
  const nav = document.createElement('nav');
  nav.id = 'bottom-nav';
  nav.innerHTML = [
    ['home', '★', '自選'], ['index', '📈', '大盤'], ['rank', '📊', '排行'], ['screen', '🔎', '選股'], ['global', '🌐', '國際'], ['more', '☰', '更多'],
  ].map(([k, ic, lb]) => `<button data-nav="${k}"><span class="bn-ic">${ic}</span><span class="bn-lb">${lb}</span></button>`).join('');
  document.body.appendChild(nav);
  document.body.classList.add('has-bnav');

  const markActive = id => {
    const k = NAV_SCREENS[id];
    nav.hidden = !k;
    document.body.classList.toggle('bnav-on', !!k);
    let key = k;
    if (id === 'screen-rank' && typeof Rank !== 'undefined' && Rank.cat === 'screen') key = 'screen';
    nav.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.nav === key));
  };
  // 包住 showScreen：每次換畫面同步導覽列
  const orig = showScreen;
  showScreen = id => { orig(id); markActive(id); };  // eslint-disable-line no-global-assign
  markActive((document.querySelector('.screen.active') || {}).id);

  const openMore = () => {
    showModal(`<div class="modal-title">更多功能</div>
      <div class="bn-more">
        <button data-m="panic"><span>🔥</span>極端行情選股<small>恐慌期歷史上表現較好的條件</small></button>
        <button data-m="radar"><span>🎯</span>權證分點雷達<small>全市場分點買權證排行</small></button>
        <button data-m="portfolio"><span>💼</span>操作計畫<small>持股紀錄與建議</small></button>
        <button data-m="settings"><span>⚙</span>設定<small>密碼、FinMind、匯入</small></button>
      </div>
      <button class="modal-btn" id="bn-more-close" style="text-align:center;margin-top:8px">關閉</button>`);
    $('#bn-more-close').addEventListener('click', closeModal);
    document.querySelectorAll('.bn-more [data-m]').forEach(b => b.addEventListener('click', () => {
      closeModal();
      const m = b.dataset.m;
      if (m === 'panic') { if (typeof openPanic === 'function') openPanic(); return; }
      const btn = document.getElementById(`btn-${m}`);
      if (btn) btn.click();
    }));
  };

  nav.addEventListener('click', e => {
    const b = e.target.closest('button[data-nav]');
    if (!b) return;
    const k = b.dataset.nav;
    if (typeof Ix !== 'undefined' && Ix.timer && k !== 'index') clearInterval(Ix.timer);
    if (typeof GLB !== 'undefined' && GLB.timer && k !== 'global') clearInterval(GLB.timer);
    if (k === 'home') goHome();
    else if (k === 'index') openIndex('tse');
    else if (k === 'global') openGlobal();
    else if (k === 'rank' || k === 'screen') {
      if (k === 'screen') { Rank.cat = 'screen'; } else if (Rank.cat === 'screen') { Rank.cat = localStorage.getItem('rk_cat') === 'screen' ? 'up' : (localStorage.getItem('rk_cat') || 'up'); }
      Rank.secCode = null;
      $('#rk-list').innerHTML = '';
      openRank();
    } else if (k === 'more') openMore();
    window.scrollTo({ top: 0 });
  });
})();
