(function () {
  const THRESHOLD = 70;
  let startY = 0, pulling = false, refreshing = false;
  let ind = null, bar = null;

  function getScrollEl() {
    return document.querySelector('.scroll-area, .content') || document.scrollingElement;
  }

  function createUI() {
    bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:3px;background:#3ea066;width:0;z-index:99999;';
    document.body.appendChild(bar);

    ind = document.createElement('div');
    ind.style.cssText = `
      position:fixed;top:8px;left:50%;
      transform:translateX(-50%) translateY(-80px);
      background:#0f2e1a;border:1px solid rgba(62,160,102,0.35);
      color:#3ea066;font-size:12px;font-weight:700;
      padding:7px 18px;border-radius:20px;z-index:99999;
      transition:transform 0.15s;white-space:nowrap;
      font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;
    `;
    ind.textContent = '당겨서 새로고침';
    document.body.appendChild(ind);
  }

  function removeUI() {
    if (bar)  { bar.remove();  bar = null; }
    if (ind)  { ind.remove();  ind = null; }
  }

  function init() {
    const el = getScrollEl();
    if (!el) return;

    el.addEventListener('touchstart', e => {
      if (refreshing) return;
      if (el.scrollTop <= 0) {
        startY = e.touches[0].clientY;
        pulling = true;
      }
    }, { passive: true });

    el.addEventListener('touchmove', e => {
      if (!pulling || refreshing) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || el.scrollTop > 0) { pulling = false; removeUI(); return; }

      if (!ind) createUI();
      const progress = Math.min(dy / THRESHOLD, 1);
      bar.style.width = (progress * 100) + '%';

      const translateY = Math.min(dy * 0.55 - 80, 8);
      ind.style.transform = `translateX(-50%) translateY(${translateY}px)`;

      const ready = progress >= 1;
      ind.textContent  = ready ? '놓으면 새로고침' : '당겨서 새로고침';
      ind.style.color  = ready ? '#fff'     : '#3ea066';
      ind.style.background = ready ? '#2d7a4f' : '#0f2e1a';
    }, { passive: true });

    el.addEventListener('touchend', e => {
      if (!pulling) return;
      pulling = false;
      const dy = e.changedTouches[0].clientY - startY;

      if (dy >= THRESHOLD && ind) {
        refreshing = true;
        ind.textContent = '새로고침 중...';
        ind.style.transform = 'translateX(-50%) translateY(8px)';
        if (bar) bar.style.width = '100%';
        setTimeout(() => location.reload(), 350);
      } else {
        removeUI();
      }
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
