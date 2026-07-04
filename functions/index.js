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
