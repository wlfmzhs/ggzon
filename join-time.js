// join-time.js — 조인 시각 표시·입력 검증 (순수 함수, Firebase 의존 없음)
// 조인의 date(YYYY-MM-DD)·time(HH:MM)은 한국 시간이다.
// 2026-11-13 진해신항CC: 야간 라운드 17:23 을 모바일 시간 피커에서 오전 05:23 으로 잘못 골라
// 만들자마자 티업이 지난 조인이 됐고, 자동 마감에 닫혔다. 그래서
//  - 시각을 '오후 5:23' 처럼 오전/오후를 붙여 보여 주고
//  - 저장할 때 '야간인데 오전 시각', '이미 지난 시각' 을 확인받는다.
// 검증: node --test tests/join-time.test.mjs

function parseHHMM(hhmm) {
  const m = String(hhmm || '').match(/^\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? { h, mi } : null;
}

// '17:23' → '오후 5:23', '00:10' → '오전 12:10', '12:00' → '오후 12:00'. 형식이 다르면 그대로 돌려준다.
export function formatKoTime(hhmm) {
  const t = parseHHMM(hhmm);
  if (!t) return String(hhmm || '');
  const h12 = t.h % 12 === 0 ? 12 : t.h % 12;
  return `${t.h < 12 ? '오전' : '오후'} ${h12}:${String(t.mi).padStart(2, '0')}`;
}

// 한국 시간 date·time → epoch ms (없거나 잘못되면 null)
export function kstTeeMs(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  const t = parseHHMM(time);
  if (!t) return null;
  const ms = Date.parse(`${date}T${String(t.h).padStart(2, '0')}:${String(t.mi).padStart(2, '0')}:00+09:00`);
  return Number.isFinite(ms) ? ms : null;
}

// 저장 전 점검.
//  nightAm: 야간(night)인데 12시 전 시각 → pmTime 에 +12시간 한 값('05:23' → '17:23')
//  past:    날짜·시각이 now 보다 이전
export function checkJoinTime({ date, time, timeType, now = Date.now() }) {
  const t = parseHHMM(time);
  const nightAm = timeType === 'night' && !!t && t.h < 12;
  const pmTime = nightAm ? `${String(t.h + 12).padStart(2, '0')}:${String(t.mi).padStart(2, '0')}` : null;
  const ms = kstTeeMs(date, time);
  return { nightAm, pmTime, past: ms !== null && ms < now };
}
