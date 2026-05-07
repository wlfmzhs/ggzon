(function () {
  const THRESHOLD = 70;
  let startX = 0, startY = 0, pulling = false, refreshing = false, dirLocked = false;
  let ind = null;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes ptr-spin { to { transform: rotate(360deg); } }
    #ptr-ind {
      position:fixed;top:0;left:50%;
      transform:translateX(-50%) translateY(-60px);
      width:36px;height:36px;
      background:#0f2e1a;border:1.5px solid rgba(62,160,102,0.4);
      border-radius:50%;z-index:99999;
      display:flex;align-items:center;justify-content:center;
      transition:transform 0.15s;
    }
    #ptr-arc {
      width:20px;height:20px;
      border:2.5px solid rgba(62,160,102,0.25);
      border-top-color:#3ea066;
      border-radius:50%;
    }
    #ptr-arc.spin { animation:ptr-spin 0.7s linear infinite; }
  `;
  document.head.appendChild(style);

  function createUI() {
    ind = document.createElement('div');
    ind.id = 'ptr-ind';
    const arc = document.createElement('div');
    arc.id = 'ptr-arc';
    ind.appendChild(arc);
    document.body.appendChild(ind);
  }

  function removeUI() {
    if (ind) { ind.remove(); ind = null; }
  }

  function attachTo(el) {
    el.addEventListener('touchstart', e => {
      if (refreshing) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dirLocked = false;
      if (el.scrollTop <= 0) pulling = true;
    }, { passive: true });

    el.addEventListener('touchmove', e => {
      if (!pulling || refreshing) return;
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = e.touches[0].clientY - startY;
      if (!dirLocked) {
        dirLocked = true;
        if (dx > Math.abs(dy)) { pulling = false; removeUI(); return; }
      }
      if (dy <= 0 || el.scrollTop > 0) { pulling = false; removeUI(); return; }

      if (!ind) createUI();
      const progress = Math.min(dy / THRESHOLD, 1);
      const translateY = Math.min(dy * 0.55 - 60, 14);
      ind.style.transform = `translateX(-50%) translateY(${translateY}px)`;

      const arc = document.getElementById('ptr-arc');
      if (arc) {
        arc.style.transform = progress >= 1 ? '' : `rotate(${progress * 300}deg)`;
        arc.classList.toggle('spin', progress >= 1);
        arc.style.borderTopColor = progress >= 1 ? '#fff' : '#3ea066';
      }
    }, { passive: true });

    el.addEventListener('touchend', e => {
      if (!pulling) return;
      pulling = false;
      const dy = e.changedTouches[0].clientY - startY;

      if (dy >= THRESHOLD && ind) {
        refreshing = true;
        const arc = document.getElementById('ptr-arc');
        if (arc) { arc.classList.add('spin'); arc.style.transform = ''; }
        setTimeout(() => location.reload(), 400);
      } else {
        removeUI();
      }
    }, { passive: true });
  }

  function init() {
    const els = document.querySelectorAll('.scroll-area, .content');
    if (els.length > 0) {
      els.forEach(attachTo);
    } else {
      const fallback = document.scrollingElement;
      if (fallback) attachTo(fallback);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
