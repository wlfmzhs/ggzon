// ggzon-push.js — "라운드 알림 받기" (웹 푸시) 켜기·끄기
//
// 회원이 켜면 이 기기의 FCM 토큰을 users/{uid}/pushTokens/{token} 에 저장한다 (기기마다 1개).
// 서버(functions notifyRoundStart)가 조인에 스코어가 처음 들어올 때 토큰 전체에 보낸다.
// 알림 표시·클릭은 sw.js 가 처리한다 (이 파일은 /sw.js 등록을 FCM 에 넘겨줄 뿐).
//
// 사용:
//   import { mountPushToggle } from '/ggzon-push.js?v=1';
//   mountPushToggle({ app, db, uid, el });     // el 안에 상태 문구와 버튼을 그린다
//
// 아이폰·아이패드: iOS 16.4 이상에서 '홈 화면에 추가'한 앱으로 열었을 때만 웹 푸시가 된다.

import { getMessaging, getToken, deleteToken, isSupported } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js';
import { doc, setDoc, deleteDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Firebase 콘솔 → 프로젝트 설정 → 클라우드 메시징 → 웹 푸시 인증서 → '키 쌍'의 공개 키.
// 공개 키라 코드에 넣어도 되지만, 아직 발급 전이라 비워 둔다. 비어 있으면 버튼이 '준비 중'으로 보인다.
export const VAPID_PUBLIC_KEY = '';

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
