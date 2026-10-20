// 2nd GPGA OPEN 대회 분위기 BGM — 정해진 시각까지만 재생되고 그 뒤엔 아무것도 하지 않는다.
//
// - 브라우저는 소리 나는 자동재생을 막는 경우가 많아, 먼저 재생을 시도하고
//   막히면 화면을 처음 터치하는 순간 재생한다.
// - 페이지를 옮겨도 듣던 위치부터 이어서 재생한다 (sessionStorage).
// - 왼쪽 아래 ♪ 버튼으로 끄고 켤 수 있고, 끈 상태는 기기에 기억된다 (localStorage).
(function () {
  var END = Date.parse('2026-10-21T16:10:00+09:00');   // 대회날 오후 4시 10분 종료
  var SRC = '/audio/gpga-open.mp3';
  var K_OFF = 'gpga_bgm_off', K_POS = 'gpga_bgm_pos';
  if (Date.now() >= END) return;

  function get(store, k) { try { return store.getItem(k); } catch (_) { return null; } }
  function set(store, k, v) { try { store.setItem(k, v); } catch (_) {} }

  var off = get(localStorage, K_OFF) === '1';
  var audio = new Audio(SRC);
  audio.loop = true;
  audio.preload = off ? 'none' : 'auto';
  audio.volume = 0.6;

  var pos = parseFloat(get(sessionStorage, K_POS));
  if (pos > 0) audio.addEventListener('loadedmetadata', function () {
    try { audio.currentTime = pos % (audio.duration || Infinity); } catch (_) {}
  }, { once: true });

  // ── ♪ 버튼 ──
  var style = document.createElement('style');
  style.textContent =
    '#gpga-bgm{position:fixed;left:12px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:99990;' +
    'width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,214,90,.7);' +
    'background:rgba(10,36,6,.85);color:#ffd65a;font-size:18px;line-height:38px;text-align:center;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.4);cursor:pointer;-webkit-tap-highlight-color:transparent;' +
    'user-select:none;-webkit-user-select:none;padding:0;font-family:inherit}' +
    '#gpga-bgm.on{animation:gpgaBgmPulse 1.6s ease-in-out infinite}' +
    '#gpga-bgm.off{opacity:.55;color:rgba(255,255,255,.6);border-color:rgba(255,255,255,.3)}' +
    '#gpga-bgm.off::after{content:"";position:absolute;left:8px;right:8px;top:50%;height:2px;' +
    'background:currentColor;transform:rotate(-45deg)}' +
    '@keyframes gpgaBgmPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,214,90,.5)}50%{box-shadow:0 0 0 7px rgba(255,214,90,0)}}';
  var btn = document.createElement('button');
  btn.id = 'gpga-bgm';
  btn.type = 'button';
  btn.textContent = '♪';
  btn.setAttribute('aria-label', '대회 음악 켜기/끄기');

  function paint() {
    var playing = !audio.paused;
    btn.className = off ? 'off' : (playing ? 'on' : '');
  }
  function tryPlay() {
    if (off || Date.now() >= END) return;
    var p = audio.play();
    if (p && p.then) p.then(paint, paint); else paint();
  }

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    // 켜진 설정인데 자동재생이 막혀 멈춰 있던 거라면, 이 탭은 '재생' 으로 처리
    if (!off && audio.paused) { tryPlay(); return; }
    off = !off;
    set(localStorage, K_OFF, off ? '1' : '0');
    if (off) audio.pause(); else { audio.preload = 'auto'; tryPlay(); }
    paint();
  });

  // 자동재생이 막혔을 때: 화면 어디든 처음 누르면 재생
  function onFirstGesture(e) {
    if (e.target === btn) return;   // ♪ 버튼은 자기 클릭 처리에 맡긴다
    if (!audio.paused) return detach();
    tryPlay();
    setTimeout(function () { if (!audio.paused) detach(); }, 300);
  }
  var EV = ['pointerup', 'touchend', 'click', 'keydown'];
  function detach() { EV.forEach(function (t) { document.removeEventListener(t, onFirstGesture, true); }); }
  EV.forEach(function (t) { document.addEventListener(t, onFirstGesture, true); });

  // 듣던 위치 저장 → 다음 페이지에서 이어 듣기
  setInterval(function () { if (!audio.paused) set(sessionStorage, K_POS, String(audio.currentTime)); }, 1000);
  window.addEventListener('pagehide', function () { set(sessionStorage, K_POS, String(audio.currentTime)); });

  // 앱을 내리면 멈추고, 다시 보면 이어서
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) audio.pause(); else tryPlay();
    paint();
  });
  audio.addEventListener('play', paint);
  audio.addEventListener('pause', paint);

  // 종료 시각: 3초 동안 소리를 줄이고 멈춘 뒤 버튼도 치운다
  setTimeout(function () {
    var v = audio.volume, step = v / 30;
    var fade = setInterval(function () {
      v = Math.max(0, v - step);
      audio.volume = v;
      if (v <= 0) {
        clearInterval(fade);
        audio.pause();
        audio.removeAttribute('src');
        detach();
        btn.remove();
      }
    }, 100);
  }, END - Date.now());

  function mount() {
    document.head.appendChild(style);
    document.body.appendChild(btn);
    paint();
    tryPlay();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
