// functions/index.js — 골갑존 정기결제(토스페이먼츠 빌링) 서버
// 지역: asia-northeast3 (서울)
//
// 보안 핵심:
//  - 토스 secretKey 는 절대 코드/깃에 넣지 않고 Firebase Secret 으로 주입합니다.
//      firebase functions:secrets:set TOSS_SECRET_KEY   ← 배포 전에 1회 실행
//  - 결제 금액(amount)은 '서버'가 결정합니다. 클라이언트가 보낸 금액은 절대 신뢰하지 않음.
//  - isPaid / plan / billingKey 등 결제 상태는 오직 이 서버(Admin SDK)만 기록합니다.

import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';

initializeApp();
const db = getFirestore();

const TOSS_SECRET_KEY = defineSecret('TOSS_SECRET_KEY');

// ── 요금제 (ggzon-config.js 의 PLAN 과 값을 맞춰두세요) ──
const PRICE = 9900;                 // 월 구독료(원) — 서버가 결정하는 진짜 금액
const PLAN_NAME = '골갑존 프리미엄';
const PERIOD_DAYS = 30;

const REGION = 'asia-northeast3';
const TOSS_API = 'https://api.tosspayments.com/v1';

// 토스 API 인증 헤더 (secretKey + ':' 을 base64)
function tossAuthHeader(secret) {
  return 'Basic ' + Buffer.from(secret + ':').toString('base64');
}

// 다음 결제일 = 오늘 + PERIOD_DAYS
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// ───────────────────────────────────────────────────────────
// 1) 빌링키 발급 + 첫 결제
//    브라우저(subscribe-complete.html)에서 카드 인증 성공 후 호출.
//    body: { uid, authKey, customerKey, name?, email? }
// ───────────────────────────────────────────────────────────
export const issueBilling = onRequest(
  { region: REGION, cors: true, secrets: [TOSS_SECRET_KEY] },
  async (req, res) => {
    try {
      if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
      const { uid, authKey, customerKey, name, email } = req.body || {};
      if (!uid || !authKey || !customerKey) {
        res.status(400).json({ ok: false, error: '필수값 누락' });
        return;
      }
      const secret = TOSS_SECRET_KEY.value();

      // (1) authKey → billingKey 발급
      const issueRes = await fetch(`${TOSS_API}/billing/authorizations/issue`, {
        method: 'POST',
        headers: { 'Authorization': tossAuthHeader(secret), 'Content-Type': 'application/json' },
        body: JSON.stringify({ authKey, customerKey }),
      });
      const issued = await issueRes.json();
      if (!issueRes.ok) {
        logger.error('빌링키 발급 실패', issued);
        res.status(400).json({ ok: false, error: issued.message || '빌링키 발급 실패' });
        return;
      }
      const billingKey = issued.billingKey;

      // (2) 첫 달 즉시 결제
      const orderId = `GGZON_${uid}_${Date.now()}`;
      const payRes = await fetch(`${TOSS_API}/billing/${billingKey}`, {
        method: 'POST',
        headers: { 'Authorization': tossAuthHeader(secret), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerKey,
          amount: PRICE,              // ← 서버가 정한 금액
          orderId,
          orderName: PLAN_NAME,
          customerName: name || undefined,
          customerEmail: email || undefined,
        }),
      });
      const pay = await payRes.json();
      if (!payRes.ok) {
        logger.error('첫 결제 실패', pay);
        // 빌링키는 저장해두되 유료 활성화는 안 함
        await db.doc(`billing/${uid}`).set({
          billingKey, customerKey, cardIssued: true, firstPaymentFailed: true,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        res.status(400).json({ ok: false, error: pay.message || '결제 실패' });
        return;
      }

      const now = new Date();
      const nextBilling = addDays(now, PERIOD_DAYS);

      // (3) 빌링 정보는 비공개 컬렉션(billing)에만 저장 — 클라이언트 접근 불가
      await db.doc(`billing/${uid}`).set({
        billingKey,
        customerKey,
        cardCompany: pay.card?.issuerCode || pay.method || '',
        cardNumberMasked: pay.card?.number || '',
        lastOrderId: orderId,
        lastPaymentAt: Timestamp.fromDate(now),
        firstPaymentFailed: false,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      // (4) 유료 활성화 — users 문서의 결제상태는 서버만 기록
      await db.doc(`users/${uid}`).set({
        isPaid: true,
        plan: 'premium',
        subscriptionStatus: 'active',
        subscribedAt: Timestamp.fromDate(now),
        nextBillingDate: Timestamp.fromDate(nextBilling),
      }, { merge: true });

      // (5) 결제 내역 기록
      await db.collection('paymentHistory').add({
        uid, orderId, amount: PRICE, status: 'paid', type: 'first',
        paidAt: Timestamp.fromDate(now),
      });

      logger.info(`구독 시작: ${uid}`);
      res.json({ ok: true, nextBillingDate: nextBilling.toISOString() });
    } catch (e) {
      logger.error('issueBilling 예외', e);
      res.status(500).json({ ok: false, error: '서버 오류' });
    }
  }
);

// ───────────────────────────────────────────────────────────
// 2) 매일 새벽 실행 — 오늘 결제일이 된 구독 자동결제
// ───────────────────────────────────────────────────────────
export const chargeSubscriptions = onSchedule(
  { region: REGION, schedule: 'every day 03:00', timeZone: 'Asia/Seoul', secrets: [TOSS_SECRET_KEY] },
  async () => {
    const secret = TOSS_SECRET_KEY.value();
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    const snap = await db.collection('users').where('subscriptionStatus', '==', 'active').get();
    logger.info(`정기결제 점검: 활성 구독 ${snap.size}건`);

    for (const docSnap of snap.docs) {
      const u = docSnap.data();
      const uid = docSnap.id;
      const next = u.nextBillingDate?.toDate ? u.nextBillingDate.toDate() : null;
      if (!next || next > now) continue;                       // 아직 결제일 안 됨
      if (u.lastBillingRunDate === todayStr) continue;          // 오늘 이미 처리 (중복방지)

      try {
        const billDoc = await db.doc(`billing/${uid}`).get();
        const billingKey = billDoc.exists ? billDoc.data().billingKey : null;
        const customerKey = billDoc.exists ? billDoc.data().customerKey : null;
        if (!billingKey) { logger.warn(`빌링키 없음: ${uid}`); continue; }

        const orderId = `GGZON_${uid}_${Date.now()}`;
        const payRes = await fetch(`${TOSS_API}/billing/${billingKey}`, {
          method: 'POST',
          headers: { 'Authorization': tossAuthHeader(secret), 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerKey, amount: PRICE, orderId, orderName: PLAN_NAME }),
        });
        const pay = await payRes.json();

        if (payRes.ok) {
          const nextBilling = addDays(now, PERIOD_DAYS);
          await db.doc(`users/${uid}`).set({
            isPaid: true, subscriptionStatus: 'active',
            nextBillingDate: Timestamp.fromDate(nextBilling),
            lastBillingRunDate: todayStr,
          }, { merge: true });
          await db.doc(`billing/${uid}`).set({
            lastOrderId: orderId, lastPaymentAt: Timestamp.fromDate(now),
          }, { merge: true });
          await db.collection('paymentHistory').add({
            uid, orderId, amount: PRICE, status: 'paid', type: 'recurring',
            paidAt: Timestamp.fromDate(now),
          });
          logger.info(`정기결제 성공: ${uid}`);
        } else {
          // 실패 → 유예(past_due). 재시도는 다음날 다시 시도(결제일이 과거이므로).
          await db.doc(`users/${uid}`).set({
            subscriptionStatus: 'past_due', lastBillingRunDate: todayStr,
          }, { merge: true });
          await db.collection('paymentHistory').add({
            uid, orderId, amount: PRICE, status: 'failed', type: 'recurring',
            error: pay.message || '', paidAt: Timestamp.fromDate(now),
          });
          logger.warn(`정기결제 실패: ${uid} — ${pay.message}`);
        }
      } catch (e) {
        logger.error(`정기결제 예외: ${uid}`, e);
      }
    }
  }
);

// ───────────────────────────────────────────────────────────
// 3) 구독 해지 — body: { uid }
//    즉시 끊지 않고 다음 결제일까지는 유료 유지, 이후 자동 종료
// ───────────────────────────────────────────────────────────
export const cancelSubscription = onRequest(
  { region: REGION, cors: true },
  async (req, res) => {
    try {
      if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }
      const { uid } = req.body || {};
      if (!uid) { res.status(400).json({ ok: false, error: 'uid 필요' }); return; }
      await db.doc(`users/${uid}`).set({
        subscriptionStatus: 'canceled',
        canceledAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      // isPaid 는 다음 결제일까지 유지 → 아래 종료 스케줄러가 정리
      logger.info(`구독 해지 예약: ${uid}`);
      res.json({ ok: true });
    } catch (e) {
      logger.error('cancelSubscription 예외', e);
      res.status(500).json({ ok: false });
    }
  }
);

// ───────────────────────────────────────────────────────────
// 4) 매일 실행 — 해지 예약된 구독이 만료일 지나면 유료 종료
// ───────────────────────────────────────────────────────────
export const expireCanceled = onSchedule(
  { region: REGION, schedule: 'every day 04:00', timeZone: 'Asia/Seoul' },
  async () => {
    const now = new Date();
    const snap = await db.collection('users').where('subscriptionStatus', '==', 'canceled').get();
    for (const docSnap of snap.docs) {
      const u = docSnap.data();
      const next = u.nextBillingDate?.toDate ? u.nextBillingDate.toDate() : null;
      if (next && next > now) continue; // 아직 이용기간 남음
      await db.doc(`users/${docSnap.id}`).set({
        isPaid: false, plan: 'none', subscriptionStatus: 'none',
      }, { merge: true });
      logger.info(`구독 종료: ${docSnap.id}`);
    }
  }
);

// ───────────────────────────────────────────────────────────
// 5) 5분마다 — 조인 자동 마감 + 정산
//    ① 스코어 입력이 끝난 조인: 마지막 스코어 입력(lastScoreAt) 후 30분 동안 입력이 없고,
//       스코어를 입력한 참가자 전원이 18홀을 다 채웠으면 마감 (그늘집 휴식 중 9홀에서 끊기지 않게)
//    ② 안전망: 라운드 시작(티업) 10시간이 지난 조인은 스코어와 상관없이 마감
//    join.html 의 closeJoinAndAward 와 같은 규칙:
//    스코어기록(scoreHistory)·핸디캡 갱신, 참여 +10P, 스코어 보너스, 월 4회 한도.
//    참가자별 지급 원장(pointAwardedUids/scoreAwardedUids)으로 멱등 → 관리자 수동 마감과 겹쳐도 이중지급 없음.
// ───────────────────────────────────────────────────────────
const AUTO_CLOSE_AFTER_H = 10;
const AUTO_CLOSE_AFTER_LAST_SCORE_MIN = 30;

const scoreBonusPts   = t => t < 0 ? 40 : t <= 5 ? 30 : t <= 9 ? 20 : t <= 15 ? 15 : 10;
const scoreBonusLabel = t => t < 0 ? '언더파' : t <= 5 ? 'E~+5' : t <= 9 ? '+6~+9' : t <= 15 ? '+10~+15' : '+16이상';

// 조인의 date(YYYY-MM-DD)·time(HH:MM)은 한국 시간
function teeTimeOf(j) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(j.date || '')) return null;
  const m = String(j.time || '').match(/(\d{1,2}):(\d{2})/);
  const hhmm = m ? `${m[1].padStart(2, '0')}:${m[2]}` : '00:00';
  const t = new Date(`${j.date}T${hhmm}:00+09:00`);
  return isNaN(t) ? null : t;
}

function partyMembersOf(j, uid) {
  const all   = j.participants || [];
  const parts = (Array.isArray(j.parties) ? j.parties : []).filter(g => ((g || {}).uids || []).length);
  if (!parts.length) return all;
  const mine = parts.find(g => (g.uids || []).includes(uid));
  if (!mine) {
    const assigned = new Set(parts.flatMap(g => g.uids || []));
    return all.filter(x => !assigned.has(x.uid));
  }
  return mine.uids.map(u => all.find(x => x.uid === u)).filter(Boolean);
}

async function ensureScoreHistory(j, joinId, p, holes, total) {
  const histRef = db.doc(`users/${p.uid}/scoreHistory/${joinId}`);
  if ((await histRef.get()).exists) return;
  await histRef.set({
    course: j.course || '', frontCourse: j.frontCourse || '', backCourse: j.backCourse || '',
    date: j.date || '',
    companions: partyMembersOf(j, p.uid).filter(x => x.uid !== p.uid).map(x => ({ name: x.name, uid: x.uid })),
    totalScore: total, holes, parHoles: [], joinId,
    submittedAt: FieldValue.serverTimestamp(),
  });
  try {
    const all = await db.collection(`users/${p.uid}/scoreHistory`).orderBy('submittedAt', 'desc').get();
    const scores = all.docs.map(d => d.data().totalScore ?? 0);
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    const recent10 = scores.slice(0, 10), recent3 = scores.slice(0, 3), prev3 = scores.slice(3, 6);
    await db.doc(`users/${p.uid}`).update({
      handicap: recent10.length ? Math.round(avg(recent10) * 10) / 10 : null,
      bestScore: scores.length ? Math.min(...scores) : null,
      roundCount: scores.length,
      handicapTrend: (recent3.length === 3 && prev3.length === 3) ? Math.round((avg(recent3) - avg(prev3)) * 10) / 10 : null,
      statsUpdatedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) { logger.warn(`핸디캡 갱신 실패 uid=${p.uid}`, e); }
}

async function autoCloseOne(joinId) {
  const ref = db.doc(`joins/${joinId}`);
  // 상태 변경은 트랜잭션으로 — 이미 마감된 조인이면 건너뛴다
  const j = await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().status === 'closed') return null;
    tx.update(ref, { status: 'closed', autoClosedAt: FieldValue.serverTimestamp() });
    return s.data();
  });
  if (!j) return false;

  const participants = j.participants || [];
  const scores = j.scores || {};
  const now = new Date().toISOString();
  const hasLedger = Array.isArray(j.pointAwardedUids) || Array.isArray(j.scoreAwardedUids);
  const legacy = !hasLedger && j.pointsAwarded === true;
  const pointUids = new Set(j.pointAwardedUids || (legacy ? participants.map(p => p.uid) : []));
  const scoreUids = new Set(j.scoreAwardedUids || (legacy ? participants.map(p => p.uid) : []));

  // 같은 달 마감된 필드 조인 (월 4회 포인트 한도 계산용)
  const month = (j.date || '').slice(0, 7);
  const monthSnap = month
    ? await db.collection('joins').where('date', '>=', `${month}-01`).where('date', '<=', `${month}-31`).get()
    : { docs: [] };
  const monthClosed = monthSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(x => x.id !== joinId && x.status === 'closed' && x.joinType !== 'screen');

  for (const p of participants) {
    if (!p.uid || p.isGuest) continue;
    const holes = (scores[p.uid] || {}).holes || Array(18).fill(null);
    const total = holes.reduce((a, v) => a + (v ?? 0), 0);
    const hasScore = holes.some(v => v !== null);
    try {
      if (hasScore) await ensureScoreHistory(j, joinId, p, holes, total);
      const prior = monthClosed.filter(x => (x.participants || []).some(px => px.uid === p.uid)).length;
      if (prior >= 4) continue;
      const userRef = db.doc(`users/${p.uid}`);
      if (!pointUids.has(p.uid)) {
        await userRef.update({ totalPoints: FieldValue.increment(10) });
        pointUids.add(p.uid);
        await db.collection('pointHistory').add({
          uid: p.uid, name: p.name || '골퍼', type: '조인참여', amount: 10,
          ref: j.course || '', date: now, roundDate: j.date || '', joinId,
        });
      }
      if (hasScore && !scoreUids.has(p.uid)) {
        const pts = scoreBonusPts(total);
        await userRef.update({ totalPoints: FieldValue.increment(pts) });
        scoreUids.add(p.uid);
        await db.collection('pointHistory').add({
          uid: p.uid, name: p.name || '골퍼', type: '스코어', amount: pts,
          ref: `${j.course || '라운드'} (${scoreBonusLabel(total)})`, date: now, roundDate: j.date || '', joinId,
        });
      }
    } catch (e) {
      logger.error(`[자동마감] 참가자 처리 실패 join=${joinId} uid=${p.uid}`, e);
    }
  }

  await ref.update({
    pointsAwarded: true, scoreBonusAwarded: true,
    pointAwardedUids: [...pointUids], scoreAwardedUids: [...scoreUids],
  });
  logger.info(`[자동마감] ${joinId} ${j.course || ''} ${j.date || ''} ${j.time || ''} — 참가자 ${participants.length}명`);
  return true;
}

// 스코어를 입력한 참가자가 있고, 그 전원이 18홀을 다 채웠는가
function scoresComplete(j) {
  const started = Object.values(j.scores || {})
    .map(s => (s || {}).holes || [])
    .filter(h => h.some(v => v !== null && v !== undefined));
  return started.length > 0 &&
    started.every(h => h.length >= 18 && h.slice(0, 18).every(v => v !== null && v !== undefined));
}

// 스코어가 바뀔 때마다 서버가 '마지막 스코어 입력 시각'을 기록한다.
// (앱 수정 없이 동작 — 예전 버전 앱에서 입력해도 기록됨. lastScoreAt 만 바뀐 갱신은 scores 가 같아 다시 쓰지 않음)
export const markLastScore = onDocumentUpdated(
  { region: REGION, document: 'joins/{joinId}' },
  async (event) => {
    const before = event.data?.before?.data() || {};
    const after  = event.data?.after?.data()  || {};
    if (after.status === 'closed') return;
    if (JSON.stringify(before.scores || {}) === JSON.stringify(after.scores || {})) return;
    await event.data.after.ref.update({ lastScoreAt: FieldValue.serverTimestamp() });
  }
);

export const autoCloseJoins = onSchedule(
  { region: REGION, schedule: 'every 5 minutes', timeZone: 'Asia/Seoul' },
  async () => {
    const nowMs = Date.now();
    const cutoff = nowMs - AUTO_CLOSE_AFTER_H * 3600 * 1000;
    const scoreCutoff = nowMs - AUTO_CLOSE_AFTER_LAST_SCORE_MIN * 60 * 1000;
    const snap = await db.collection('joins').where('status', '!=', 'closed').get();
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // ② 티업 10시간 경과 — 연결된 팀(partyIds)도 수동 마감처럼 함께 마감
    const dueByTee = all.filter(j => { const t = teeTimeOf(j); return t && t.getTime() <= cutoff; });
    // ① 마지막 스코어 입력 30분 경과 + 입력 완료 — 팀마다 진행 속도가 달라 이 조인만 마감
    const teeIds = new Set(dueByTee.map(j => j.id));
    const dueByScore = all.filter(j => {
      if (teeIds.has(j.id)) return false;
      const last = j.lastScoreAt?.toMillis ? j.lastScoreAt.toMillis() : null;
      const t = teeTimeOf(j);
      return last && last <= scoreCutoff && (!t || t.getTime() <= nowMs) && scoresComplete(j);
    });

    const due = [
      ...dueByTee.map(j => ({ j, ids: [j.id, ...(j.partyIds || (j.partyId ? [j.partyId] : []))] })),
      ...dueByScore.map(j => ({ j, ids: [j.id] })),
    ].sort((a, b) => (teeTimeOf(a.j) || 0) - (teeTimeOf(b.j) || 0));   // 월 4회 한도가 날짜순으로 적용되도록
    for (const { j, ids } of due) {
      for (const id of ids) {
        try {
          if (await autoCloseOne(id) && !teeIds.has(j.id))
            logger.info(`[자동마감] 마지막 스코어 입력 ${AUTO_CLOSE_AFTER_LAST_SCORE_MIN}분 경과로 마감: ${id}`);
        }
        catch (e) { logger.error(`[자동마감] 실패 join=${id}`, e); }
      }
    }
  }
);
