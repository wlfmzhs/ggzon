// ─────────────────────────────────────────────────────────────
// 골슐랭스타 명단 · 현 챔피언
// 대회 자리배치 / 조편성 / 출력물에서 참가자 이름 옆에 표시하는 데 쓴다.
//
// ⚠️ 스타 수가 바뀌거나 새 스타가 생기면 아래 목록과 함께
//    golchelin-star.html · golchelin-star-detail.html 의 배열도 같이 고칠 것.
//    (그쪽 배열은 순서(index)가 상세 페이지 주소가 되므로 새 인물은 항상 맨 뒤에 추가)
// ─────────────────────────────────────────────────────────────

const GOLCHELIN_STARS = {
  '어정우': 3,
  '이상훈': 2,
  '임지헌': 2,
  '이원석': 2,
  '김도영': 2,
  '김덕규': 2,
  '황우익': 2,
  '이용훈': 1,
  '김철영': 1,
  '권성민': 1,
  '고관우': 1,
};

// 현 챔피언 — 1st GPGA OPEN 우승 (data-gpga-2025.js 의 winner 와 같은 사람)
const GOLCHELIN_CHAMPION = '김도영';

// 이름 비교용 정규화.
// 자리배치에서 동명이인은 "김도영2" 처럼 뒤에 숫자가 붙으므로 떼어내고 비교한다.
function golchelinKey(name) {
  return String(name || '').replace(/\s+/g, '').replace(/\d+$/, '');
}

// 골슐랭 스타 개수 (아니면 0)
function golchelinStarsOf(name) {
  return GOLCHELIN_STARS[golchelinKey(name)] || 0;
}

function isGolchelinChampion(name) {
  const key = golchelinKey(name);
  return !!key && key === GOLCHELIN_CHAMPION;
}

// 모듈 스크립트(type="module")에서도 쓸 수 있게 명시적으로 올려둔다.
// (const 는 window 프로퍼티가 되지 않는다)
if (typeof window !== 'undefined') {
  window.GOLCHELIN_STARS = GOLCHELIN_STARS;
  window.GOLCHELIN_CHAMPION = GOLCHELIN_CHAMPION;
  window.golchelinKey = golchelinKey;
  window.golchelinStarsOf = golchelinStarsOf;
  window.isGolchelinChampion = isGolchelinChampion;
}
