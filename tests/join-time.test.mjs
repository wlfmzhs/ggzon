// 실행: node --test tests/join-time.test.mjs  (저장소 루트에서, Firebase 연결 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatKoTime, kstTeeMs, checkJoinTime } from '../join-time.js';

const kst = s => Date.parse(s + '+09:00');

test('오전/오후 표시', () => {
  assert.equal(formatKoTime('17:23'), '오후 5:23');
  assert.equal(formatKoTime('05:23'), '오전 5:23');
  assert.equal(formatKoTime('00:10'), '오전 12:10');
  assert.equal(formatKoTime('12:00'), '오후 12:00');
  assert.equal(formatKoTime('7:05'), '오전 7:05');
  assert.equal(formatKoTime(''), '');
  assert.equal(formatKoTime('미정'), '미정');
});

test('한국 시간으로 해석', () => {
  assert.equal(kstTeeMs('2026-11-13', '05:23'), Date.parse('2026-11-12T20:23:00Z'));
  assert.equal(kstTeeMs('', '05:23'), null);
  assert.equal(kstTeeMs('2026-11-13', ''), null);
});

test('진해신항 오입력: 야간인데 오전 + 이미 지난 시각', () => {
  const r = checkJoinTime({ date: '2026-11-13', time: '05:23', timeType: 'night', now: kst('2026-11-13T11:15:00') });
  assert.deepEqual(r, { nightAm: true, pmTime: '17:23', past: true });
  // +12시간으로 고치면 지난 시각이 아니다
  assert.equal(checkJoinTime({ date: '2026-11-13', time: r.pmTime, timeType: 'night', now: kst('2026-11-13T11:15:00') }).past, false);
});

test('정상 입력은 통과', () => {
  assert.deepEqual(checkJoinTime({ date: '2026-11-20', time: '17:23', timeType: 'night', now: kst('2026-11-13T11:15:00') }),
    { nightAm: false, pmTime: null, past: false });
  assert.deepEqual(checkJoinTime({ date: '2026-11-20', time: '06:30', timeType: 'day', now: kst('2026-11-13T11:15:00') }),
    { nightAm: false, pmTime: null, past: false });
});

test('주간 라운드의 지난 시각', () => {
  const r = checkJoinTime({ date: '2026-11-13', time: '06:30', timeType: 'day', now: kst('2026-11-13T07:00:00') });
  assert.equal(r.past, true);
  assert.equal(r.nightAm, false);
});
