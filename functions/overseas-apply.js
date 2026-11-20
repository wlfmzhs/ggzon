// functions/overseas-apply.js — 해외라운드 비회원(로그인 안 한 사람) 참가 신청
//
// 유튜브 설명란 등 외부 링크로 들어온 비회원은 Firebase Auth 세션도, 카카오 uid 도 없다.
// Firestore 규칙을 넓혀 익명 쓰기를 열지 않고, 이 서버 함수가 대신 검증해 Admin SDK 로 쓴다.
//
// Firebase 에 의존하지 않는 순수 로직만 둔다. 실제 Firestore 호출은 index.js 의
// overseasGuestApply 가 store 로 넣어 준다 → `node --test` 로 바로 검증할 수 있다.
//
// 저장 형식 (회원 신청과 같은 컬렉션·같은 id 규칙 '{tripId}_{userId}'):
//   overseasApply/{tripId}_guest_xxx         공개 — 마스킹 이름(김○○)·인원·유입 경로·isGuest. 연락처·메모는 넣지 않는다.
//   overseasApplyContacts/{tripId}_guest_xxx 관리자 전용 — 실명·연락처·메모·동의 기록
//   overseasApplyRate/{key}                  서버 전용 — 빈도 제한 기록 (규칙에 match 가 없어 브라우저는 못 읽고 못 쓴다)
// 같은 연락처로 다시 신청하면 새 문서를 만들지 않고 기존 신청을 고친다(합치기).

import { createHash, randomBytes } from 'node:crypto';

// 모집 중인 해외라운드. overseas.html 의 TRIP_ID·CAPACITY 와 값을 맞춘다 (정원 판단은 이 값이 기준).
export const TRIPS = {
  'danang-2702': { capacity: 20, open: true },
};

export const AIRPORTS = ['부산', '인천', '청주'];
export const ROOMS = ['동반자와 같은 방', '룸메이트 매칭 희망'];
export const MAX_PEOPLE = 4;
export const CONSENT_VERSION = 'overseas-guest-2026-11';

// 빈도 제한: [창 길이(ms), 허용 횟수]
export const RATE_LIMITS = {
  ip:    [[10 * 60 * 1000, 5], [24 * 60 * 60 * 1000, 20]],
  phone: [[10 * 60 * 1000, 3], [24 * 60 * 60 * 1000, 6]],
};

export class ApplyError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export const phoneDigits = s => String(s ?? '').replace(/\D/g, '');
export function formatPhone(d) {
  return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

// 공개 명단용 이름: 첫 글자만 남기고 나머지는 ○ (최대 3칸). '김철수' → '김○○', 'Tom' → 'T○○'
export function maskName(name) {
  const chars = [...String(name).trim()];
  if (!chars.length) return '';
  return chars[0] + '○'.repeat(Math.min(Math.max(chars.length - 1, 1), 3));
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMemo = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);

// 브라우저가 보낸 값을 그대로 믿지 않고 여기서 다시 검사·정리한다.
export function validateGuestApply(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.website) throw new ApplyError(400, 'bot', '잘못된 요청입니다');          // 사람 눈엔 안 보이는 칸(봇 걸러내기)
  const tripId = String(b.tripId || '');
  const trip = TRIPS[tripId];
  if (!trip) throw new ApplyError(400, 'trip', '모집 중인 여행이 아닙니다');
  if (!trip.open) throw new ApplyError(409, 'closed', '모집이 마감되었습니다');

  const name = clean(b.name, 20);
  if (name.length < 2 || /[<>{}\\]/.test(name)) throw new ApplyError(400, 'name', '이름을 정확히 입력해 주세요');

  const digits = phoneDigits(b.phone);
  if (!/^01[016789]\d{7,8}$/.test(digits)) throw new ApplyError(400, 'phone', '연락처를 정확히 입력해 주세요 (휴대폰 번호)');

  const people = Number(b.people);
  if (!Number.isInteger(people) || people < 1 || people > MAX_PEOPLE) throw new ApplyError(400, 'people', `인원은 1~${MAX_PEOPLE}명입니다`);

  if (b.consent !== true) throw new ApplyError(400, 'consent', '개인정보 수집·이용에 동의해 주세요');

  const airport = AIRPORTS.includes(b.airport) ? b.airport : AIRPORTS[0];
  const room = ROOMS.includes(b.room) ? b.room : ROOMS[0];
  const memo = cleanMemo(b.memo, 300);
  const src = /^[a-z0-9_-]{1,20}$/.test(String(b.src || '')) ? String(b.src) : 'direct';

  return { tripId, trip, name, digits, phone: formatPhone(digits), people, airport, room, memo, src };
}

export const hashKey = (kind, value) => kind + '_' + createHash('sha256').update(`ggzon-overseas:${kind}:${value}`).digest('hex').slice(0, 32);
export const newGuestUserId = () => 'guest_' + randomBytes(9).toString('hex');

// 빈도 제한 판단: 지난 기록(ms 배열)에 지금을 더해도 각 창의 허용 횟수 이내인가
export function rateDecision(stamps, limits, now) {
  const longest = Math.max(...limits.map(([w]) => w));
  const kept = (stamps || []).filter(t => typeof t === 'number' && now - t < longest);
  for (const [w, max] of limits) {
    if (kept.filter(t => now - t < w).length >= max) return { ok: false, kept };
  }
  return { ok: true, kept: [...kept, now] };
}

// 정원 판단: 인원(people) 합계 기준 — 화면의 신청 현황 막대와 같은 기준.
// 내 기존 신청(합치기 대상)은 빼고 계산한다 → 인원을 줄이거나 같은 인원으로 수정하는 건 정원이 차도 된다.
export function capacityDecision(applicants, myApplyId, people, capacity) {
  const others = applicants.filter(a => a.id !== myApplyId).reduce((s, a) => s + (Number(a.people) || 1), 0);
  return { ok: others + people <= capacity, others, remaining: Math.max(0, capacity - others) };
}

// 신청 한 건 처리. store 는 index.js 가 Firestore 트랜잭션으로 구현해 넣는다:
//   store.checkRate(key, limits, now) → boolean   (기록까지 함께 남김)
//   store.runTransaction(async tx => ...)  tx: findContactByPhone(tripId, phone), listApplicants(tripId),
//                                              getApply(id), set(coll, id, data), serverTime()
export async function handleGuestApply(body, ip, store, now = Date.now()) {
  const v = validateGuestApply(body);

  // 남용 방지 — IP·연락처 각각. (같은 사람이 고쳐 쓰는 몇 번은 넉넉히 허용)
  if (ip && !(await store.checkRate(hashKey('ip', ip), RATE_LIMITS.ip, now)))
    throw new ApplyError(429, 'rate', '신청이 너무 잦습니다. 잠시 후 다시 시도해 주세요');
  if (!(await store.checkRate(hashKey('phone', v.tripId + ':' + v.digits), RATE_LIMITS.phone, now)))
    throw new ApplyError(429, 'rate', '같은 연락처로 신청이 너무 잦습니다. 잠시 후 다시 시도해 주세요');

  return store.runTransaction(async tx => {
    const existing = await tx.findContactByPhone(v.tripId, v.phone);   // 같은 연락처 → 같은 신청으로 합친다
    const applicants = await tx.listApplicants(v.tripId);
    const prevApply = existing ? applicants.find(a => a.id === existing.id) || null : null;
    // 연락처는 남았는데 공개 신청이 지워진 경우(관리자 삭제 등)는 새 신청으로 본다
    const merged = !!(existing && prevApply);
    const userId = merged ? existing.userId : newGuestUserId();
    const id = `${v.tripId}_${userId}`;

    const cap = capacityDecision(applicants, merged ? id : null, v.people, v.trip.capacity);
    if (!cap.ok) {
      throw new ApplyError(409, 'full', cap.remaining > 0
        ? `남은 자리가 ${cap.remaining}명입니다. 인원을 줄여 주세요`
        : '정원이 모두 찼습니다 (모집 마감)');
    }

    const ts = tx.serverTime();
    const base = { tripId: v.tripId, userId, isGuest: true, src: v.src };
    tx.set('overseasApply', id, {
      ...base,
      name: maskName(v.name),
      people: v.people, airport: v.airport, room: v.room,
      createdAt: merged && prevApply.createdAt ? prevApply.createdAt : ts,
      updatedAt: ts,
    });
    tx.set('overseasApplyContacts', id, {
      ...base,
      name: v.name, phone: v.phone, memo: v.memo, people: v.people,
      consent: { agreed: true, version: CONSENT_VERSION, at: ts },
      createdAt: merged && existing.createdAt ? existing.createdAt : ts,
      updatedAt: ts,
    });
    return { ok: true, merged, id, people: v.people, total: cap.others + v.people, capacity: v.trip.capacity };
  });
}
