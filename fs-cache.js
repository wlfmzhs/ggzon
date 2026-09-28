// Firestore 로컬 캐시(IndexedDB) 안전 초기화
//
// 로컬 캐시는 재방문 속도를 크게 줄여주지만, 아래 상황에선 IndexedDB가 아예 열리지 않는다.
//   - 카카오톡/인스타 등 인앱 브라우저, 사파리 사생활 보호 모드
//   - 예전 버전 탭이 열려 있어 저장소 스키마 갱신이 막힌 경우
//   - 저장 공간 부족·브라우저 저장소 차단 설정
// 이때 Firestore SDK는 조용히 캐시만 포기하는 게 아니라 이후 모든 읽기/쓰기를
// failed-precondition으로 거절한다. (조인 마감이 계속 실패하던 원인)
//
// 그래서: 캐시 오류가 한 번이라도 감지되면 이 기기에서는 캐시를 끄고(메모리 캐시)
// 다음 방문부터 정상 동작하게 한다. 관리자 작업이 걸린 join.html은 아예 캐시를 쓰지 않는다.
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  getDocs, getDocsFromCache,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 로컬 캐시가 있어도 getDocs 는 항상 서버 응답을 기다린다(오프라인일 때만 캐시).
// 그래서 캐시를 켜 놓고도 화면은 매번 네트워크 왕복만큼 비어 있었다.
// → 기기에 남아 있는 결과로 먼저 그리고(수 ms), 서버 결과가 오면 한 번 더 그린다.
//   paint 는 두 번 불려도 같은 결과가 나오게(innerHTML 교체 방식) 짜야 한다.
const snapSig = (snap) => {
  try { return snap.docs.map(d => d.id + ':' + JSON.stringify(d.data())).join('|'); }
  catch (_) { return null; }
};

export async function getDocsSWR(q, paint) {
  let painted = false, sig = null;
  try {
    const cached = await getDocsFromCache(q);
    if (!cached.empty) { paint(cached, true); painted = true; sig = snapSig(cached); }
  } catch (_) {}
  try {
    const fresh = await getDocs(q);
    // 서버 결과가 캐시와 똑같으면 다시 그리지 않는다 (사진 깜빡임·중복 애니메이션 방지)
    if (!painted || sig === null || snapSig(fresh) !== sig) paint(fresh, false);
    return fresh;
  } catch (e) {
    if (!painted) throw e;   // 캐시로라도 그렸으면 조용히 그 화면을 유지
  }
}

const OFF_KEY = 'ggzon-fs-cache-off';

const cacheDisabled = () => {
  try { return localStorage.getItem(OFF_KEY) === '1'; }
  catch (_) { return true; }   // localStorage조차 막힌 브라우저면 IndexedDB도 기대할 수 없다
};

function disableCache() {
  try {
    if (localStorage.getItem(OFF_KEY) === '1') return;
    localStorage.setItem(OFF_KEY, '1');
    console.warn('[Firestore] 로컬 캐시를 쓸 수 없는 브라우저입니다. 이 기기에서는 캐시 없이 동작합니다.');
  } catch (_) {}
}

// 캐시 계층이 터졌다는 신호를 잡아 스위치를 내린다. 현재 화면은 실패한 그대로 두고
// (자동 새로고침은 입력 중인 내용을 날릴 수 있다) 다음 방문부터 캐시 없이 뜬다.
function watchForCacheFailure() {
  const check = (err) => {
    const code = err?.code || '';
    const msg  = String(err?.message || err || '');
    if (code === 'failed-precondition' || /IndexedDB|persistence|persistence layer/i.test(msg)) disableCache();
  };
  window.addEventListener('unhandledrejection', e => check(e.reason));
  window.addEventListener('error', e => check(e.error));
}

// 페이지에서 `const db = makeDb(app)` 한 줄로 쓴다.
export function makeDb(app) {
  if (cacheDisabled()) return initializeFirestore(app, {});
  try {
    const db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
    watchForCacheFailure();
    return db;
  } catch (e) {
    // 캐시 설정으로 시작조차 못 하면 기본(메모리) 인스턴스로 간다.
    disableCache();
    return getFirestore(app);
  }
}
