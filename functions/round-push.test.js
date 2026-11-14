// 실행: cd functions && npm test   (Node 내장 테스트 러너, Firebase 연결 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roundStartDecision, roundStartText, roundStartUrl, runRoundStartPush, hasAnyScore, autoCloseBaseOf,
} from './round-push.js';

const E = Array(18).fill(null);
const holes = (i, v) => { const h = [...E]; h[i] = v; return h; };
const base = {
  course: '서라벌CC', date: '2026-11-07', time: '07:30', status: 'recruiting', joinType: 'field',
  participants: [{ uid: 'a', name: '김골갑' }, { uid: 'kakao_1', name: '이버디' }, { uid: 'g1', name: '박파', isGuest: true }],
};
const at = hhmm => new Date(`2026-11-07T${hhmm}:00+09:00`);
const before = { ...base, scores: {} };
const after = { ...base, scores: { a: { holes: holes(0, 5) } } };

test('첫 스코어 입력 시 발송', () => {
  assert.deepEqual(roundStartDecision(before, after, at('07:45')), { send: true, reason: 'first-score' });
});

test('South 출발(10번 홀부터)도 첫 입력으로 본다', () => {
  const a = { ...base, scores: { a: { holes: holes(9, 4) } } };
  assert.equal(roundStartDecision(before, a, at('07:45')).send, true);
});

test('이미 스코어가 있던 조인의 추가 입력은 보내지 않는다', () => {
  const a2 = { ...base, scores: { a: { holes: [5, 4, ...E.slice(2)] } } };
  assert.equal(roundStartDecision(after, a2, at('07:50')).reason, 'not-first-score');
});

test('스코어 아닌 필드 변경(참가자 등)은 보내지 않는다', () => {
  assert.equal(roundStartDecision(before, { ...before, memo: 'x' }, at('07:45')).reason, 'no-score');
});

test('roundStartNotifiedAt 이 있으면 보내지 않는다', () => {
  assert.equal(roundStartDecision(before, { ...after, roundStartNotifiedAt: {} }, at('07:45')).reason, 'already-notified');
});

test('티업 1시간 경계: 정확히 1시간은 발송, 1시간 1분은 건너뜀', () => {
  assert.equal(roundStartDecision(before, after, at('08:30')).send, true);
  assert.equal(roundStartDecision(before, after, at('08:31')).reason, 'over-1h-after-tee');
});

test('며칠 지난 라운드 스코어를 뒤늦게 입력해도 보내지 않는다', () => {
  assert.equal(roundStartDecision(before, after, new Date('2026-11-10T12:00:00+09:00')).reason, 'over-1h-after-tee');
});

test('마감·스크린·티업 정보 없음은 건너뜀', () => {
  assert.equal(roundStartDecision(before, { ...after, status: 'closed' }, at('07:45')).reason, 'closed');
  assert.equal(roundStartDecision(before, { ...after, joinType: 'screen' }, at('07:45')).reason, 'screen');
  assert.equal(roundStartDecision(before, { ...after, date: '' }, at('07:45')).reason, 'no-tee-time');
});

test('hasAnyScore: 0타·undefined 처리', () => {
  assert.equal(hasAnyScore({ a: { holes: [undefined, null] } }), false);
  assert.equal(hasAnyScore({ a: { holes: holes(3, 0) } }), true);   // 파 대비 0 같은 값도 입력으로 본다
  assert.equal(hasAnyScore(undefined), false);
});

test('문구 생성', () => {
  assert.equal(roundStartText(base).body, '서라벌CC에서 김골갑·이버디·박파 라운드가 시작되었습니다');
  const five = { ...base, participants: ['가', '나', '다', '라', '마'].map((n, i) => ({ uid: 'u' + i, name: n })) };
  assert.equal(roundStartText(five).body, '서라벌CC에서 가·나·다·라 외 1명 라운드가 시작되었습니다');
  assert.equal(roundStartText({ course: '', participants: [] }).body, '골프장에서 라운드가 시작되었습니다');
  assert.equal(roundStartUrl('abc123'), '/score.html?id=abc123');
});

// 트랜잭션처럼 동작하는 가짜 저장소: 먼저 선점한 한 번만 true
function fakeDeps(tokens, codes = {}) {
  const state = { notified: false, sends: [], removed: [], records: [] };
  return {
    state,
    deps: {
      claim: async () => { if (state.notified) return false; state.notified = true; return true; },
      loadTokens: async () => tokens,
      sendBatch: async (t, payload) => { state.sends.push({ t, payload }); return t.map(x => codes[x] ? { ok: false, code: codes[x] } : { ok: true }); },
      removeRefs: async refs => { state.removed.push(...refs); },
      record: async r => { state.records.push(r); },
    },
  };
}

test('중복 방지: 동시에 두 번 트리거돼도 한 번만 발송', async () => {
  const { state, deps } = fakeDeps([{ token: 't1', ref: 'users/a/pushTokens/t1' }]);
  const args = { joinId: 'J1', before, after, now: at('07:45'), deps };
  const [r1, r2] = await Promise.all([runRoundStartPush(args), runRoundStartPush(args)]);
  assert.deepEqual([r1.sent, r2.sent].sort(), [false, true]);
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].payload.url, '/score.html?id=J1');
  // 이후 다시 와도(roundStartNotifiedAt 기록 뒤 갱신) 보내지 않는다
  const r3 = await runRoundStartPush({ ...args, before: after, after: { ...after, roundStartNotifiedAt: {} } });
  assert.equal(r3.sent, false);
  assert.equal(state.sends.length, 1);
});

test('토큰 중복 제거·무효 토큰 삭제·일시 오류 토큰 보존', async () => {
  const { state, deps } = fakeDeps([
    { token: 't1', ref: 'users/a/pushTokens/t1' },
    { token: 't1', ref: 'users/b/pushTokens/t1' },          // 같은 기기에서 계정 바꿔 저장
    { token: 'dead', ref: 'users/c/pushTokens/dead' },
    { token: 'busy', ref: 'users/d/pushTokens/busy' },
  ], { dead: 'messaging/registration-token-not-registered', busy: 'messaging/internal-error' });
  const r = await runRoundStartPush({ joinId: 'J2', before, after, now: at('07:45'), deps });
  assert.deepEqual(state.sends[0].t, ['t1', 'dead', 'busy']);
  assert.deepEqual(state.removed, ['users/c/pushTokens/dead']);
  assert.deepEqual({ success: r.success, failure: r.failure, removed: r.removed }, { success: 1, failure: 2, removed: 1 });
});

test('500개 단위로 나눠 보낸다', async () => {
  const many = Array.from({ length: 1201 }, (_, i) => ({ token: 't' + i, ref: 'r' + i }));
  const { state, deps } = fakeDeps(many);
  await runRoundStartPush({ joinId: 'J3', before, after, now: at('07:45'), deps });
  assert.deepEqual(state.sends.map(s => s.t.length), [500, 500, 201]);
});

test('건너뛸 조인은 선점(claim)도 하지 않는다', async () => {
  const { state, deps } = fakeDeps([{ token: 't1', ref: 'r' }]);
  const r = await runRoundStartPush({ joinId: 'J4', before, after, now: at('09:00'), deps });
  assert.equal(r.reason, 'over-1h-after-tee');
  assert.equal(state.notified, false);
  assert.equal(state.sends.length, 0);
});

// ── 자동 마감 안전망 기준 시각 ──
const H10 = 10 * 3600 * 1000;
const kst = s => new Date(s + '+09:00');
const ts = d => ({ toMillis: () => d.getTime() });   // Firestore Timestamp 흉내

test('자동마감 기준: 정상 조인은 티업 시각', () => {
  const j = { date: '2026-11-13', time: '17:23', createdAt: ts(kst('2026-11-10T09:00:00')) };
  assert.equal(autoCloseBaseOf(j).getTime(), kst('2026-11-13T17:23:00').getTime());
});

test('자동마감 기준: 만들 때 이미 티업이 지났으면 만든 시각 (진해신항 05:23 오입력)', () => {
  const j = { date: '2026-11-13', time: '05:23', timeType: 'night', createdAt: ts(kst('2026-11-13T11:15:12')) };
  const base = autoCloseBaseOf(j).getTime();
  assert.equal(base, kst('2026-11-13T11:15:12').getTime());
  // 예전 기준이면 15:23 에 닫혔다. 새 기준으로는 15:25 에도 열려 있고 21:15 이후에 닫힌다
  assert.ok(kst('2026-11-13T15:25:00').getTime() < base + H10);
  assert.ok(kst('2026-11-13T21:16:00').getTime() >= base + H10);
});

test('자동마감 기준: createdAt 이 없거나 Date·문자열이어도 동작', () => {
  assert.equal(autoCloseBaseOf({ date: '2026-11-13', time: '07:00' }).getTime(), kst('2026-11-13T07:00:00').getTime());
  assert.equal(autoCloseBaseOf({ date: '2026-11-13', time: '07:00', createdAt: kst('2026-11-13T08:00:00') }).getTime(), kst('2026-11-13T08:00:00').getTime());
  assert.equal(autoCloseBaseOf({ date: '2026-11-13', time: '07:00', createdAt: '2026-11-12T00:00:00Z' }).getTime(), kst('2026-11-13T07:00:00').getTime());
  assert.equal(autoCloseBaseOf({ date: '', time: '07:00' }), null);
});
