// ggzon-auth.js — 카카오/Firebase 통합 인증 헬퍼
// 새 페이지에서는 반드시 이 파일을 import해서 사용할 것
// import { isLoggedIn, getUid, getNick, getKakaoUser } from '/ggzon-auth.js';

export const ADMIN_EMAIL = 'wlfmzhs@naver.com';

/** localStorage에 저장된 카카오 사용자 반환 (동기) */
export function getKakaoUser() {
  return JSON.parse(localStorage.getItem('ggzon_user') || 'null');
}

/** 로그인 여부 확인 — Firebase user 또는 카카오 둘 다 커버 */
export function isLoggedIn(firebaseUser) {
  if (firebaseUser) return true;
  return !!getKakaoUser()?.uid;
}

/** 현재 사용자 uid 반환 */
export function getUid(firebaseUser) {
  if (firebaseUser) return firebaseUser.uid;
  return getKakaoUser()?.uid || null;
}

/** 현재 사용자 닉네임 반환 */
export function getNick(firebaseUser, userDoc) {
  const k = getKakaoUser();
  return userDoc?.nickname
    || userDoc?.name
    || k?.nickname
    || firebaseUser?.displayName
    || firebaseUser?.email?.split('@')[0]
    || '익명';
}

/** 관리자 여부 */
export function isAdmin(firebaseUser) {
  return firebaseUser?.email === ADMIN_EMAIL;
}
