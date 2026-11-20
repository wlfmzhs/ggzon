# 골갑존 (GOLGAB ZONE / GGZON)

골프 커뮤니티 PWA(`www.ggzon.co.kr`). 조인, 스코어·핸디캡·포인트, 대회, 중고 거래, 구독 결제 기능이 있다.
빌드 단계가 없는 정적 사이트다. 루트의 HTML이 페이지 하나씩이고, 페이지마다 인라인 `<script type="module">`에서 Firebase SDK를 CDN으로 불러 Firestore에 직접 읽고 쓴다.

## 구조

- 루트 `*.html`: 페이지. `join`, `event`, `score`, `dashboard`, `my`처럼 큰 파일은 수천 줄이다.
- 루트 `*.js`: 페이지 공용 모듈. `data-*.js`는 코드에 고정된 지난 대회·콘텐츠 데이터다.
- `functions/`: Cloud Functions(Node 20, ESM, `asia-northeast3`). 정기결제, 조인 자동 마감, GG ISSUE 요약.
- `firestore.rules`: 앱의 실질적인 권한 계층. 쓰기는 대부분 브라우저에서 바로 나가므로 여기서 막아야 한다.

## 명령어

루트에는 `package.json`이 없다. 빌드, 테스트, 린트, 개발 서버 설정은 저장소에 없다.

```sh
# Functions 의존성 설치
cd functions && npm ci

# 배포 (firebase CLI는 저장소 의존성이 아니라 별도 설치)
firebase deploy --only firestore:rules
firebase deploy --only functions
firebase deploy --only functions:summarizeGGIssue   # 함수 하나만

# Functions 비밀값 등록 (값은 코드·깃에 넣지 않는다)
firebase functions:secrets:set TOSS_SECRET_KEY
firebase functions:secrets:set ANTHROPIC_API_KEY
```

로컬에서 볼 때는 저장소 루트를 웹 루트로 서빙해야 한다. `/ggzon-auth.js` 같은 절대 경로를 쓰므로 `file://`로는 동작하지 않는다.

## 배포

- 프론트는 GitHub Pages로 서비스된다(`CNAME`, `.nojekyll`, `404.html`). `firebase.json`에 Hosting 설정이 없고, CI 설정도 없다. 게시 브랜치 설정은 저장소 파일로는 확인할 수 없다.
- `firestore.rules`와 `functions/`는 푸시만으로 반영되지 않는다. 위의 `firebase deploy`를 따로 실행해야 한다.
- 규칙이나 함수에 의존하는 프론트 변경은 Firebase 쪽 배포 여부까지 확인한다.

## 운영 데이터 주의

- 개발·운영 환경이 분리되어 있지 않다. Firebase 프로젝트는 `ggzon-b33cb` 하나이고 에뮬레이터 설정도 없어서, 로컬에서 연 페이지도 운영 Firestore를 읽고 쓴다.
- 카카오 로그인 리다이렉트 주소는 운영 도메인으로 고정되어 있다(`login.html`의 `KAKAO_REDIRECT_URI`).
- `seed-courses.html`, `fix-jinhae-par.html`, `migrate-grandfather.html`은 운영 DB를 직접 고치는 일회성 관리자 페이지다. 열어서 실행할 때 주의한다.
- `*_export.json`은 회원 개인정보 export이므로 커밋하지 않는다(`.gitignore`).

## 인증

로그인이 두 종류이고, 카카오 회원은 Firebase Auth 세션이 없다.

- 이메일 회원: Firebase Auth 사용. `request.auth.uid`로 식별한다.
- 카카오 회원: uid가 `kakao_<id>`이고 `localStorage`의 `ggzon_user`에만 저장된다. Firestore 요청에서 `request.auth == null`이다.
- 따라서 `request.auth`만 보는 규칙이나 코드는 카카오 회원을 막는다. 사용자 판별은 `ggzon-auth.js`의 헬퍼를 쓰고, 규칙에는 카카오 분기(`isKakaoOwner` 등)도 함께 넣는다.
- 관리자 판별은 이메일 하드코딩이다. 같은 값이 `firestore.rules`, `functions/index.js`, `ggzon-auth.js`, 여러 HTML에 흩어져 있어 바꾸려면 전부 고쳐야 한다.

## 함께 고쳐야 하는 곳

- **조인 마감·포인트**: `join.html`의 `closeJoinAndAward`와 `functions/index.js`의 `autoCloseOne`이 같은 규칙을 따로 구현한다. 지급은 `pointAwardedUids`/`scoreAwardedUids` 원장으로 중복을 막으므로 이 필드를 유지한다.
- **스코어 보너스**: 최대값 40은 `scoreBonusPts`(양쪽 모두)와 `firestore.rules`의 `validPointAward` 상한에 함께 걸려 있다.
- **구독 가격**: `ggzon-config.js`의 `PLAN`과 `functions/index.js`의 `PRICE`·`PLAN_NAME`·`PERIOD_DAYS`를 맞춘다. 실제 청구 금액은 서버 값이다.
- **새 페이지**: `404.html`의 `PAGES`에 넣어야 어긋난 링크가 복구된다.
- **해외라운드 정원·여행**: `overseas.html`의 `TRIP_ID`·`CAPACITY`·`DEPARTURES`(출발지 인천·부산)와 `functions/overseas-apply.js`의 `TRIPS`·`DEPARTURES`를 맞춘다. 비회원 신청(`overseasGuestApply`)의 정원 판단은 서버 값이고, 회원 신청은 화면에서만 막는다. 정원은 신청 건수가 아니라 인원(`people`) 합계다.
- **새 Firestore 필드**: `firestore.rules`가 허용 필드 목록(`onlyAllowedJoinFields`, `onlyDonationFields` 등)으로 쓰기를 제한하는 경로에서는, 목록에 없는 필드를 저장하면 권한 오류로 실패한다.
- **Firebase SDK 버전**: `10.12.0`이 각 페이지와 `fs-cache.js`, `event-popup.js`에 URL로 박혀 있다. 올릴 때는 전부 같이 바꾼다.

## 결제

- `PAYWALL_ENABLED`(`ggzon-config.js`)가 현재 `false`라 유료화는 꺼져 있다. 토스 클라이언트 키도 아직 테스트 키다.
- 토스 시크릿 키를 프론트 코드에 넣지 않는다. 시크릿 키는 Functions의 Firebase Secret으로만 주입한다.
- `billing`, `paymentHistory` 컬렉션은 서버(Admin SDK)만 기록한다. `users`의 `isPaid`, `plan`, `subscriptionStatus` 등 결제 필드는 회원이 직접 바꿀 수 없고, 규칙상 관리자 계정만 예외다(`migrate-grandfather.html`이 이 경로를 쓴다).

## 캐시

- `sw.js`는 HTML을 네트워크 우선으로, 같은 출처의 JS·CSS·이미지를 stale-while-revalidate로 처리한다. 공용 JS를 고쳐도 첫 로드에는 옛 파일이 나올 수 있다.
- 공용 스크립트의 동작을 바꾸면 불러오는 쪽의 `?v=`를 올린다(예: `gpga-bgm.js?v=4`). `fs-cache.js`는 페이지마다 `?v=` 유무가 달라 URL별로 따로 캐시되므로 함께 확인한다.
- 로컬 캐시를 쓰는 페이지는 `fs-cache.js`의 `makeDb`로 Firestore를 초기화한다. `join.html`은 관리자 작업이 걸려 있어 일부러 캐시를 쓰지 않는다.
- `getDocsSWR`의 `paint`는 캐시 결과와 서버 결과로 두 번 불릴 수 있다. `innerHTML` 교체처럼 다시 불려도 결과가 같게 짠다.

## 대회 데이터

- 스코어 위치가 대회마다 다르다. 라이브 스코어표로 치른 대회(2nd GPGA OPEN부터)는 `joins/{liveJoinId}.scores`, 그 외에는 `tournaments/{id}/scores`에 있다.
- `data-gpga-2026.js`의 `holes`는 타수가 아니라 파 대비 값이고, `[North 1~9, South 1~9]` 순서다. South 출발자도 순서가 같다.

## 커밋

최근 커밋 메시지는 한국어로, 사용자가 겪은 문제와 해결을 함께 적는다(`git log` 참고).
