// ggzon-push.js — "라운드 알림 받기" (웹 푸시) 켜기·끄기
//
// 회원이 켜면 이 기기의 FCM 토큰을 users/{uid}/pushTokens/{token} 에 저장한다 (기기마다 1개).
// 서버(functions notifyRoundStart)가 조인에 스코어가 처음 들어올 때 토큰 전체에 보낸다.
// 알림 표시·클릭은 sw.js 가 처리한다 (이 파일은 /sw.js 등록을 FCM 에 넘겨줄 뿐).
//
// 사용:
//   import { mountPushToggle } from '/ggzon-push.js?v=1';
//   mountPushToggle({ app, db, uid, el });     // el 안에 상태 문구와 버튼을 그린다 (마이페이지)
//   maybeShowPushPrompt();                     // 권유 팝업 (ptr.js 가 회원 페이지마다 부른다)
//
// 아이폰·아이패드: iOS 16.4 이상에서 '홈 화면에 추가'한 앱으로 열었을 때만 웹 푸시가 된다.

import { initializeApp, getApps, getApp, _getProvider } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getMessaging, getToken, deleteToken, isSupported } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js';
import { getFirestore, doc, setDoc, deleteDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Firebase 콘솔 → 프로젝트 설정 → 클라우드 메시징 → 웹 푸시 인증서 → '키 쌍'의 공개 키.
// 공개 키라 코드에 넣어도 된다 (개인 키는 콘솔에만 있다). 비우면 버튼은 '준비 중', 권유 팝업은 뜨지 않는다.
export const VAPID_PUBLIC_KEY = 'BF6JI-0OYKXaxiBmaY0mHUl0K5RrqAdOiFNLmVuxlMJ4MxHluJgec5Yd_0lBbcbR8tNL1wuutPn-Qe_bYH3FZlU';

const LS_KEY = 'ggzon_push';   // { uid, token } — 이 기기에서 켠 상태

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return null; }
}
function writeLocal(v) {
  try { v ? localStorage.setItem(LS_KEY, JSON.stringify(v)) : localStorage.removeItem(LS_KEY); } catch (_) {}
}

export function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}
function isInApp() {
  return /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\//i.test(navigator.userAgent || '');
}

// 지금 이 기기 상태: 'on' | 'off' | 'denied' | 'ios-install' | 'inapp' | 'unsupported' | 'not-ready'
export async function pushState(uid) {
  if (!VAPID_PUBLIC_KEY) return 'not-ready';
  if (isInApp()) return 'inapp';   // 아이폰 카카오톡 인앱도 여기서 걸러진다 (홈 화면 안내를 띄우지 않음)
  if (isIOS() && !isStandalone()) return 'ios-install';
  let ok = false;
  try { ok = await isSupported(); } catch (_) {}
  if (!ok || !('serviceWorker' in navigator) || !('Notification' in window)) return isInApp() ? 'inapp' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const local = readLocal();
  return (Notification.permission === 'granted' && local?.token && local.uid === uid) ? 'on' : 'off';
}

async function saveToken(db, uid, token) {
  await setDoc(doc(db, 'users', uid, 'pushTokens', token), {
    token,
    platform: isIOS() ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'desktop',
    standalone: !!isStandalone(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  writeLocal({ uid, token });
}

async function swRegistration() {
  await navigator.serviceWorker.register('/sw.js');   // ptr.js 와 같은 등록 — 이미 있으면 그대로 쓴다
  return navigator.serviceWorker.ready;
}

export async function enablePush({ app, db, uid }) {
  if (!uid) throw new Error('로그인이 필요해요');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw Object.assign(new Error('알림 권한이 허용되지 않았어요'), { code: 'denied' });
  const token = await getToken(getMessaging(app), {
    vapidKey: VAPID_PUBLIC_KEY,
    serviceWorkerRegistration: await swRegistration(),
  });
  if (!token) throw new Error('알림 토큰을 받지 못했어요');

  // 이 기기에서 다른 계정으로 켜 두었던 토큰이면 그 계정 아래 문서를 먼저 지운다
  const prev = readLocal();
  if (prev?.token && prev.uid && (prev.uid !== uid || prev.token !== token)) {
    try { await deleteDoc(doc(db, 'users', prev.uid, 'pushTokens', prev.token)); } catch (_) {}
  }
  await saveToken(db, uid, token);
  return token;
}

export async function disablePush({ app, db, uid }) {
  const local = readLocal();
  const owner = local?.uid || uid;
  if (local?.token && owner) {
    try { await deleteDoc(doc(db, 'users', owner, 'pushTokens', local.token)); } catch (_) {}
  }
  try { await deleteToken(getMessaging(app)); } catch (_) {}
  writeLocal(null);
}

// 켜 둔 기기는 페이지를 열 때 토큰을 다시 받아 바뀌었으면 고쳐 둔다 (FCM 토큰은 가끔 바뀐다).
async function refreshToken({ app, db, uid }) {
  if (await pushState(uid) !== 'on') return;
  const local = readLocal();
  const token = await getToken(getMessaging(app), {
    vapidKey: VAPID_PUBLIC_KEY,
    serviceWorkerRegistration: await swRegistration(),
  });
  if (!token || token === local.token) return;
  try { await deleteDoc(doc(db, 'users', uid, 'pushTokens', local.token)); } catch (_) {}
  await saveToken(db, uid, token);
}

const STATE_TEXT = {
  'on':          ['켜짐', '조인 라운드가 시작되면 알려 드려요'],
  'off':         ['꺼짐', '조인 라운드가 시작되면 알림을 받아요'],
  'denied':      ['차단됨', '브라우저 설정에서 골갑존 알림을 허용해 주세요'],
  'ios-install': ['홈 화면 필요', '아이폰은 Safari 공유 버튼 → "홈 화면에 추가" 후 홈 화면 아이콘으로 열어야 알림을 받을 수 있어요'],
  'inapp':       ['미지원', '카카오톡 등 앱 안 브라우저에서는 안 돼요. 크롬·사파리로 열어 주세요'],
  'unsupported': ['미지원', '이 브라우저는 웹 알림을 지원하지 않아요'],
  'not-ready':   ['준비 중', '알림 기능을 준비하고 있어요'],
};

// el 안에 [문구 + 켜기/끄기 버튼] 을 그린다. 다시 불러도 결과가 같다(innerHTML 교체).
export function mountPushToggle({ app, db, uid, el, onToast }) {
  if (!el) return;
  const toast = onToast || (m => { try { console.log('[push]', m); } catch (_) {} });
  let busy = false;

  const paint = async () => {
    const st = await pushState(uid);
    const [badge, desc] = STATE_TEXT[st];
    const canToggle = st === 'on' || st === 'off';
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:600;">라운드 알림 받기
            <span style="font-size:11px;font-weight:700;margin-left:6px;padding:2px 8px;border-radius:10px;
              background:${st === 'on' ? 'rgba(62,160,102,0.25)' : 'rgba(255,255,255,0.08)'};
              color:${st === 'on' ? '#5fd68b' : 'rgba(255,255,255,0.5)'};">${badge}</span></div>
          <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-top:3px;line-height:1.45;">${desc}</div>
        </div>
        ${canToggle ? `<button type="button" data-push-toggle style="flex-shrink:0;border:0;border-radius:10px;padding:8px 14px;
          font-size:12.5px;font-weight:800;cursor:pointer;
          background:${st === 'on' ? 'rgba(255,255,255,0.1)' : '#3ea066'};color:#fff;">${st === 'on' ? '끄기' : '켜기'}</button>` : ''}
      </div>`;
    const btn = el.querySelector('[data-push-toggle]');
    if (btn) btn.onclick = async (ev) => {
      ev.stopPropagation();
      if (busy) return;
      busy = true; btn.disabled = true; btn.textContent = '…';
      try {
        if (st === 'on') { await disablePush({ app, db, uid }); toast('라운드 알림을 껐어요'); }
        else { await enablePush({ app, db, uid }); toast('라운드 알림을 켰어요'); }
      } catch (e) {
        console.warn('[push]', e);
        toast(e.code === 'denied' ? '알림 권한을 허용해야 받을 수 있어요' : '알림 설정에 실패했어요. 잠시 후 다시 시도해 주세요');
      } finally {
        busy = false;
        paint();
      }
    };
  };
  paint().then(() => refreshToken({ app, db, uid })).catch(() => {});
  return { refresh: paint };
}

// ───────────────────────────────────────────────────────────
// 라운드 알림 권유 팝업 (ptr.js 가 회원 페이지마다 부른다)
//   띄움: 로그인 회원(이메일·카카오) 중 이 기기에서 아직 안 켰고 권한이 차단(denied)이 아닌 사람.
//         아이폰 사파리(홈 화면 앱 아님)는 같은 팝업에 '홈 화면에 추가' 안내를 띄운다.
//   안 띄움: VAPID 키 없음, 비로그인, 이미 켬, 권한 차단, 인앱 브라우저·미지원 브라우저,
//           이번 세션에 이미 띄움, [나중에]/[확인] 후 7일 이내.
// ───────────────────────────────────────────────────────────
export const PROMPT_LATER_KEY = 'ggzon_push_prompt_later';    // localStorage — [나중에] 누른 시각(ms)
export const PROMPT_SESSION_KEY = 'ggzon_push_prompt_shown';  // sessionStorage — 세션당 1번
const PROMPT_SNOOZE_MS = 7 * 24 * 3600 * 1000;

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC-31zadgV4hkQm7fFqbDrxtJRAIeo6k18",
  authDomain: "ggzon-b33cb.firebaseapp.com",
  projectId: "ggzon-b33cb",
  storageBucket: "ggzon-b33cb.firebasestorage.app",
  messagingSenderId: "774722580869",
  appId: "1:774722580869:web:5beecd26c0b76f753914ec"
};

function ssGet(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (_) {} }
function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

// 이번 세션에 이미 띄웠거나 [나중에] 후 7일이 안 됐으면 true
export function promptSnoozed(now = Date.now()) {
  if (ssGet(PROMPT_SESSION_KEY)) return true;
  const later = Number(lsGet(PROMPT_LATER_KEY) || 0);
  return later > 0 && now - later < PROMPT_SNOOZE_MS;
}

// 페이지가 만든 기본 앱을 쓰고, 없으면(골슐랭·라운드맵 등) 같은 설정으로 만든다
function ensureApp() {
  return getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
}

// 로그인한 회원 uid — 이메일(Firebase Auth) 우선, 없으면 카카오(localStorage)
async function currentUid(app) {
  let fbUid = null;
  try {
    // 메인(index)처럼 Auth 를 안 띄우는 페이지면 다른 페이지와 같은 저장 방식으로 띄운다
    // (getAuth 를 쓰면 쓰지도 않는 구글 팝업용 iframe 을 받아 온다)
    const provider = _getProvider(app, 'auth');
    const auth = provider.isInitialized()
      ? provider.getImmediate()
      : initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence] });
    fbUid = await new Promise(resolve => {
      const t = setTimeout(() => resolve(null), 5000);
      const off = onAuthStateChanged(auth, u => { clearTimeout(t); off(); resolve(u ? u.uid : null); });
    });
  } catch (_) {}
  if (fbUid) return fbUid;
  try { return JSON.parse(localStorage.getItem('ggzon_user') || 'null')?.uid || null; } catch (_) { return null; }
}

export async function maybeShowPushPrompt() {
  if (!VAPID_PUBLIC_KEY) return;
  if (promptSnoozed() || isInApp()) return;
  if (document.getElementById('ggzon-push-prompt')) return;
  const app = ensureApp();
  const uid = await currentUid(app);
  if (!uid) return;
  const st = await pushState(uid);
  if (st !== 'off' && st !== 'ios-install') return;
  if (promptSnoozed() || document.getElementById('ggzon-push-prompt')) return;
  ssSet(PROMPT_SESSION_KEY, '1');
  showPushPrompt({
    mode: st === 'ios-install' ? 'ios' : 'enable',
    onEnable: () => enablePush({ app, db: getFirestore(app), uid }),
  });
}

// 팝업 화면만 그린다 (조건 판단 없음). mode: 'enable' | 'ios'
export function showPushPrompt({ mode = 'enable', onEnable } = {}) {
  const ios = mode === 'ios';
  const wrap = document.createElement('div');
  wrap.id = 'ggzon-push-prompt';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'ggzon-push-title');
  wrap.innerHTML = `
    <style>
      #ggzon-push-prompt{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;
        padding:16px;background:rgba(0,0,0,0.62);-webkit-font-smoothing:antialiased;}
      #ggzon-push-prompt .gp-card{width:100%;max-width:340px;background:#0f2e1a;border:1px solid rgba(62,160,102,0.35);
        border-radius:20px;padding:24px 20px 18px;color:#fff;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,0.45);}
      #ggzon-push-prompt .gp-icon{width:52px;height:52px;margin:0 auto 14px;border-radius:16px;background:rgba(62,160,102,0.2);
        display:flex;align-items:center;justify-content:center;color:#5fd68b;}
      #ggzon-push-prompt h2{margin:0 0 8px;font-size:17px;font-weight:900;letter-spacing:-0.01em;}
      #ggzon-push-prompt p{margin:0;font-size:13.5px;line-height:1.55;color:rgba(255,255,255,0.7);}
      #ggzon-push-prompt .gp-steps{margin:14px 0 0;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,0.06);
        font-size:12.5px;line-height:1.6;color:rgba(255,255,255,0.82);text-align:left;}
      #ggzon-push-prompt .gp-err{margin-top:10px;font-size:12px;color:#ff8a8a;}
      #ggzon-push-prompt .gp-btns{display:flex;gap:8px;margin-top:18px;}
      #ggzon-push-prompt button{flex:1;border:0;border-radius:12px;padding:13px 10px;font-size:14px;font-weight:800;
        cursor:pointer;font-family:inherit;}
      #ggzon-push-prompt .gp-later{background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.75);}
      #ggzon-push-prompt .gp-ok{background:#3ea066;color:#fff;}
      #ggzon-push-prompt button:disabled{opacity:0.6;cursor:default;}
    </style>
    <div class="gp-card">
      <div class="gp-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></div>
      <h2 id="ggzon-push-title">골갑존 라운드 알림 받기</h2>
      <p>회원들의 조인 라운드가 시작되면<br>바로 알려드려요</p>
      ${ios ? `<div class="gp-steps">아이폰은 홈 화면 앱에서만 알림을 받을 수 있어요.<br>
        Safari 아래 <b>공유</b> 버튼 → <b>홈 화면에 추가</b> 후<br>그 아이콘으로 열면 알림을 받을 수 있어요.</div>` : ''}
      <div class="gp-err" hidden></div>
      <div class="gp-btns">
        <button type="button" class="gp-later">나중에</button>
        <button type="button" class="gp-ok">${ios ? '확인' : '알림 받기'}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  const later = () => { lsSet(PROMPT_LATER_KEY, String(Date.now())); close(); };
  const ok = wrap.querySelector('.gp-ok');
  const err = wrap.querySelector('.gp-err');
  wrap.querySelector('.gp-later').onclick = later;
  if (ios) { ok.onclick = later; return wrap; }   // 안내를 확인해도 7일 동안은 다시 띄우지 않는다

  ok.onclick = () => {
    ok.disabled = true; ok.textContent = '설정 중…'; err.hidden = true;
    // 클릭 핸들러에서 곧바로 호출한다. enablePush 의 첫 await 이 권한 요청이라
    // 사용자 동작 안에서 요청돼 iOS·크롬이 막지 않는다.
    Promise.resolve(onEnable && onEnable()).then(() => {
      close();
      try { window.dispatchEvent(new CustomEvent('ggzon-push-change', { detail: { on: true } })); } catch (_) {}
    }, e => {
      console.warn('[push]', e);
      if (e && e.code === 'denied') { close(); return; }   // 차단하면 이후 조건상 다시 뜨지 않는다
      ok.disabled = false; ok.textContent = '다시 시도';
      err.textContent = '알림 설정에 실패했어요. 잠시 후 다시 시도해 주세요';
      err.hidden = false;
    });
  };
  return wrap;
}
