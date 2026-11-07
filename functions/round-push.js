// functions/round-push.js — 조인 라운드 시작 웹 푸시 (판단·문구·발송 순서)
//
// Firebase 에 의존하지 않는 순수 로직만 둔다. 실제 Firestore·FCM 호출은 index.js 의
// notifyRoundStart 가 deps 로 넣어 준다 → `node --test` 로 바로 검증할 수 있다.
//
// 발송 조건: 조인에 스코어가 '처음' 들어온 순간(이전 문서엔 입력된 홀이 하나도 없고 이번에 생김).
//   - 마감(closed)·스크린 조인은 보내지 않는다. 취소된 조인은 문서가 삭제되므로 트리거가 오지 않는다.
//   - 티업 1시간이 지난 조인은 보내지 않는다 (지난 라운드 스코어를 뒤늦게 입력할 때 알림이 가지 않게).
//   - 조인 문서의 roundStartNotifiedAt 으로 한 번만 보낸다 (트랜잭션으로 선점한 쪽만 발송).

export const SKIP_AFTER_TEE_MS = 60 * 60 * 1000;
export const MAX_NAMES = 4;

// 조인의 date(YYYY-MM-DD)·time(HH:MM)은 한국 시간
export function teeTimeOf(j) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(j.date || '')) return null;
  const m = String(j.time || '').match(/(\d{1,2}):(\d{2})/);
  const hhmm = m ? `${m[1].padStart(2, '0')}:${m[2]}` : '00:00';
  const t = new Date(`${j.date}T${hhmm}:00+09:00`);
  return isNaN(t) ? null : t;
}

// 누군가 한 홀이라도 입력했는가 (South 출발이면 1번 홀이 비어 있을 수 있어 홀 번호는 보지 않는다)
export function hasAnyScore(scores) {
  return Object.values(scores || {}).some(s =>
    ((s || {}).holes || []).some(v => v !== null && v !== undefined));
}

// 보낼지 여부와 이유. reason 은 로그용.
export function roundStartDecision(before, after, now = new Date()) {
  const b = before || {}, a = after || {};
  if (a.status === 'closed') return { send: false, reason: 'closed' };
  if (a.joinType === 'screen') return { send: false, reason: 'screen' };
  if (a.roundStartNotifiedAt) return { send: false, reason: 'already-notified' };
  if (!hasAnyScore(a.scores)) return { send: false, reason: 'no-score' };
  if (hasAnyScore(b.scores)) return { send: false, reason: 'not-first-score' };
  const tee = teeTimeOf(a);
  if (!tee) return { send: false, reason: 'no-tee-time' };
  if (now.getTime() > tee.getTime() + SKIP_AFTER_TEE_MS) return { send: false, reason: 'over-1h-after-tee' };
  return { send: true, reason: 'first-score' };
}

// "{골프장}에서 {참가자1}·{참가자2}·{참가자3} 라운드가 시작되었습니다"
export function roundStartText(j) {
  const course = String(j.course || '').trim() || '골프장';
  const names = (j.participants || []).map(p => String((p || {}).name || '').trim()).filter(Boolean);
  let who = names.slice(0, MAX_NAMES).join('·');
  if (names.length > MAX_NAMES) who += ` 외 ${names.length - MAX_NAMES}명`;
  const body = who
    ? `${course}에서 ${who} 라운드가 시작되었습니다`
    : `${course}에서 라운드가 시작되었습니다`;
  return { title: '⛳ 골갑존 LIVE', body };
}

export function roundStartUrl(joinId) {
  return `/score.html?id=${encodeURIComponent(joinId)}`;
}

// FCM 오류 중 '토큰을 지워야 하는' 것 (나머지는 일시 오류로 보고 남겨 둔다)
export const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

// 한 번의 트리거 처리.
// deps:
//   claim()            → 이 조인의 발송권을 트랜잭션으로 얻으면 true (이미 기록돼 있으면 false)
//   loadTokens()       → [{ token, ref }]  (같은 토큰이 여러 회원 아래 있을 수 있다)
//   sendBatch(tokens, payload) → [{ ok, code }]  tokens 와 같은 순서, 최대 500개씩 호출된다
//   removeRefs(refs)   → 무효 토큰 문서 삭제
//   record(result)     → 발송 결과를 조인 문서에 남긴다 (선택)
export async function runRoundStartPush({ joinId, before, after, now = new Date(), deps }) {
  const decision = roundStartDecision(before, after, now);
  if (!decision.send) return { sent: false, reason: decision.reason };
  if (!(await deps.claim())) return { sent: false, reason: 'claimed-elsewhere' };

  const { title, body } = roundStartText(after);
  const payload = { title, body, url: roundStartUrl(joinId), tag: `round-start-${joinId}` };

  const rows = await deps.loadTokens();
  const refsByToken = new Map();
  for (const { token, ref } of rows) {
    if (!token) continue;
    if (!refsByToken.has(token)) refsByToken.set(token, []);
    refsByToken.get(token).push(ref);
  }
  const tokens = [...refsByToken.keys()];

  let success = 0, failure = 0;
  const dead = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const res = await deps.sendBatch(chunk, payload);
    res.forEach((r, k) => {
      if (r.ok) { success++; return; }
      failure++;
      if (DEAD_TOKEN_CODES.has(r.code)) dead.push(...refsByToken.get(chunk[k]));
    });
  }
  if (dead.length) await deps.removeRefs(dead);
  const result = { sent: true, reason: decision.reason, payload, tokens: tokens.length, success, failure, removed: dead.length };
  if (deps.record) await deps.record(result);
  return result;
}
