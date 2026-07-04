// ggzon-config.js — 골갑존 유료화/구독 중앙 설정
// ⚠️ 이 파일 하나로 유료화를 켜고 끕니다. 준비가 끝나기 전엔 PAYWALL_ENABLED = false 로 두세요.
// import { PAYWALL_ENABLED, PLAN, TOSS } from '/ggzon-config.js';

// ───────────────────────────────────────────────────────────
// 오픈 스위치
//   false = (기본) 지금과 동일. 아무도 결제 안 해도 모든 기능 열림 → 라이브 앱 영향 0
//   true  = 유료화 시작. isPaid 가 켜진 회원만 유료 기능 사용 가능
// 지인 테스트/정식 오픈 때 이 값만 true 로 바꾸면 됩니다.
export const PAYWALL_ENABLED = false;

// ───────────────────────────────────────────────────────────
// 요금제 (가격은 아직 미정 — 나중에 여기 숫자만 바꾸면 전부 반영됨)
export const PLAN = {
  price: 9900,              // 월 구독료(원). 미정이므로 임시값. 나중에 변경.
  name: '골갑존 프리미엄',   // 결제창/영수증에 표시될 이름
  periodDays: 30,           // 결제 주기(일)
};

// 기존 회원 보호용 플랜값 (그랜드파더링 = 평생 무료)
export const PLAN_FREE_FOREVER = 'free_forever';
export const PLAN_PREMIUM = 'premium';
export const PLAN_NONE = 'none';

// ───────────────────────────────────────────────────────────
// 토스페이먼츠 설정
//   clientKey: 브라우저에 노출되어도 되는 공개키 (test_ck_... / live_ck_...)
//   ⚠️ secretKey(test_sk_.../live_sk_...)는 절대 여기 넣지 마세요! → Cloud Functions 서버에만.
export const TOSS = {
  // 토스페이먼츠 대시보드 > 개발정보 에서 발급받은 "클라이언트 키".
  // 현재 테스트키(test_ck_). 실결제 오픈 때 라이브키(live_ck_)로 바꿉니다.
  clientKey: 'test_ck_vZnjEJeQVxKZwyX2nZRY3PmOoBN0',

  // 카드 등록 성공/실패 후 돌아올 페이지 (같은 도메인)
  successUrl: location.origin + '/subscribe-complete.html',
  failUrl: location.origin + '/subscribe.html?fail=1',
};

// ───────────────────────────────────────────────────────────
// Cloud Functions 엔드포인트 (배포 후 실제 URL로 교체)
//   firebase deploy 후 콘솔에 찍히는 함수 URL을 넣으세요.
//   지역: asia-northeast3 (서울)
export const FUNCTIONS = {
  region: 'asia-northeast3',
  // 예: https://asia-northeast3-ggzon-b33cb.cloudfunctions.net
  baseUrl: 'https://asia-northeast3-ggzon-b33cb.cloudfunctions.net',
};
