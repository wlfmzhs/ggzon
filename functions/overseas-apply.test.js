// 실행: cd functions && npm test   (Node 내장 테스트 러너, Firebase 연결 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskName, validateGuestApply, rateDecision, capacityDecision, handleGuestApply, ApplyError, RATE_LIMITS,
} from './overseas-apply.js';

// Firestore 대신 쓰는 메모리 저장소
function memStore(seed = []) {
  const data = { overseasApply: new Map(), overseasApplyContacts: new Map(), rate: new Map() };
  for (const a of seed) data.overseasApply.set(a.id, a);
  return {
    data,
    async checkRate(key, limits, now) {
      const d = rateDecision(data.rate.get(key), limits, now);
      data.rate.set(key, d.kept);
      return d.ok;
    },
    async runTransaction(fn) {
      const writes = [];
      const r = await fn({
        async findContactByPhone(tripId, phone) {
          for (const [id, c] of data.overseasApplyContacts) if (c.tripId === tripId && c.phone === phone && c.isGuest) return { id, ...c };
          return null;
        },
        async listApplicants(tripId) {
          return [...data.overseasApply].filter(([, a]) => a.tripId === tripId).map(([id, a]) => ({ id, ...a }));
        },
        set: (c, id, d) => writes.push([c, id, d]),
        serverTime: () => 'TS',
      });
      writes.forEach(([c, id, d]) => data[c].set(id, d));
      return r;
    },
  };
}
const ok = { tripId: 'danang-2702', name: '김철수', phone: '010-1234-5678', people: 2, departure: '인천', consent: true, src: 'youtube', memo: '야간 추가 희망' };
const code = async (p, c) => assert.rejects(p, e => e instanceof ApplyError && e.code === c);

test('이름 마스킹', () => {
  assert.equal(maskName('김철수'), '김○○');
  assert.equal(maskName('이훈'), '이○');
  assert.equal(maskName('남궁민수호'), '남○○○');
  assert.equal(maskName('Tom'), 'T○○');
});

test('입력 검증', () => {
  const v = validateGuestApply({ ...ok, phone: '01012345678', src: '<x>' });
  assert.equal(v.phone, '010-1234-5678');
  assert.equal(v.departure, '인천');
  assert.equal(validateGuestApply({ ...ok, departure: '부산' }).departure, '부산');
  assert.equal(v.src, 'direct');
  for (const [patch, c] of [
    [{ phone: '02-123-4567' }, 'phone'], [{ phone: '' }, 'phone'], [{ name: ' ' }, 'name'], [{ name: '<b>' }, 'name'],
    [{ people: 5 }, 'people'], [{ people: 1.5 }, 'people'], [{ consent: 'true' }, 'consent'], [{ consent: undefined }, 'consent'],
    [{ tripId: 'x' }, 'trip'], [{ website: 'http://spam' }, 'bot'],
    [{ departure: undefined }, 'departure'], [{ departure: '' }, 'departure'], [{ departure: '청주' }, 'departure'], [{ departure: '김해' }, 'departure'],
  ]) assert.throws(() => validateGuestApply({ ...ok, ...patch }), e => e.code === c, JSON.stringify(patch));
});

test('신청 저장 — 공개 문서엔 마스킹 이름만, 연락처는 관리자 문서에', async () => {
  const s = memStore();
  const r = await handleGuestApply(ok, '1.2.3.4', s, 1e12);
  assert.equal(r.merged, false);
  assert.match(r.id, /^danang-2702_guest_[0-9a-f]{18}$/);
  const pub = s.data.overseasApply.get(r.id);
  assert.equal(pub.name, '김○○');
  assert.equal(pub.isGuest, true);
  assert.equal(pub.src, 'youtube');
  assert.equal(pub.departure, '인천');
  assert.equal(r.id, `${pub.tripId}_${pub.userId}`);            // 기존 id 규칙
  assert.equal(pub.phone, undefined);
  assert.equal(pub.memo, undefined);
  const c = s.data.overseasApplyContacts.get(r.id);
  assert.equal(c.name, '김철수');
  assert.equal(c.phone, '010-1234-5678');
  assert.equal(c.consent.agreed, true);
});

test('같은 연락처 재신청은 하나로 합친다', async () => {
  const s = memStore();
  const a = await handleGuestApply(ok, '1.2.3.4', s, 1e12);
  const b = await handleGuestApply({ ...ok, phone: '01012345678', name: '김철수', people: 3 }, '1.2.3.4', s, 1e12 + 1000);
  assert.equal(b.merged, true);
  assert.equal(b.id, a.id);
  assert.equal(s.data.overseasApply.size, 1);
  assert.equal(s.data.overseasApply.get(a.id).people, 3);
  assert.equal(b.total, 3);
});

test('정원(인원 합계 20) 초과는 거절, 내 기존 인원은 빼고 계산', async () => {
  const seed = Array.from({ length: 9 }, (_, i) => ({ id: `danang-2702_m${i}`, tripId: 'danang-2702', userId: `m${i}`, people: 2 })); // 18명
  const s = memStore(seed);
  await code(handleGuestApply({ ...ok, people: 3 }, 'a', s, 1e12), 'full');    // 18+3 > 20
  const r = await handleGuestApply({ ...ok, people: 2 }, 'a', s, 1e12);         // 18+2 = 20 → 가능
  assert.equal(r.total, 20);
  await code(handleGuestApply({ ...ok, phone: '010-9999-0000', people: 1 }, 'b', s, 1e12), 'full'); // 다른 사람은 마감
  const m = await handleGuestApply({ ...ok, people: 1 }, 'a', s, 1e12 + 1);     // 내 신청 줄이기는 가능
  assert.equal(m.merged, true);
  assert.equal(m.total, 19);
});

test('정원 판단 함수', () => {
  const list = [{ id: 'a', people: 4 }, { id: 'b' }];     // people 없으면 1명 (화면 막대와 같은 기준)
  assert.deepEqual(capacityDecision(list, null, 1, 5), { ok: false, others: 5, remaining: 0 });
  assert.deepEqual(capacityDecision(list, 'a', 4, 5), { ok: true, others: 1, remaining: 4 });
  assert.equal(capacityDecision(list, null, 1, 6).ok, true);
});

test('빈도 제한 — IP 10분 5회, 연락처 10분 3회', async () => {
  const s = memStore();
  for (let i = 0; i < 5; i++) await handleGuestApply({ ...ok, phone: `010-0000-000${i}`, people: 1 }, '9.9.9.9', s, 1e12 + i);
  await code(handleGuestApply({ ...ok, phone: '010-0000-0099', people: 1 }, '9.9.9.9', s, 1e12 + 10), 'rate');
  // 10분 지나면 다시 가능
  const r = await handleGuestApply({ ...ok, phone: '010-0000-0099', people: 1 }, '9.9.9.9', s, 1e12 + RATE_LIMITS.ip[0][0] + 10);
  assert.equal(r.ok, true);

  const s2 = memStore();
  for (let i = 0; i < 3; i++) await handleGuestApply({ ...ok, people: 1 }, `ip${i}`, s2, 1e12 + i);
  await code(handleGuestApply({ ...ok, people: 1 }, 'ip9', s2, 1e12 + 5), 'rate');
});
