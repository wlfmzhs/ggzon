// event-popup.js — 대회 참가자 전용 안내 팝업
// 신청자(registrations.userId === 내 uid)에게만, 대회 당일까지 하루 1번 띄운다.
// 문구는 대회 문서(공지·룰·집결 정보)에서 그대로 가져오므로 관리 화면에서 고치면 팝업도 바뀐다.
// 사용: import { showEventPopup } from './event-popup.js'; showEventPopup(db, uid);

import { doc, getDoc, collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 팝업을 띄울 대회 (끝난 대회는 날짜가 지나면 저절로 안 뜸)
const POPUP_TOURNAMENTS = ['uoLAb4oGaA6WoSXAVxId']; // 2nd GPGA OPEN

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "16:00" → "PM 4:00"
function ampm(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
  if (!m) return hm || '';
  const h = +m[1];
  return `${h < 12 ? 'AM' : 'PM'} ${h % 12 || 12}:${m[2]}`;
}

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

export async function showEventPopup(db, uid) {
  if (!uid || document.getElementById('evp-overlay')) return;
  const today = todayStr();
  for (const tid of POPUP_TOURNAMENTS) {
    const seenKey = `ggzon_evpopup_${tid}_${uid}`;
    if (lsGet(seenKey) === today) continue;
    try {
      const reg = await getDocs(query(collection(db, 'tournaments', tid, 'registrations'), where('userId', '==', uid), limit(1)));
      if (reg.empty) continue;
      const snap = await getDoc(doc(db, 'tournaments', tid));
      if (!snap.exists()) continue;
      const t = { id: tid, ...snap.data() };
      if (!t.date || t.date < today) continue; // 대회 끝남
      render(t, today);
      lsSet(seenKey, today);
      return; // 한 번에 하나만
    } catch (e) { /* 안내 팝업은 실패해도 앱 사용에 지장 없게 조용히 넘어감 */ }
  }
}

function render(t, today) {
  const days = Math.round((new Date(t.date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
  const dLabel = days === 0 ? 'D-DAY' : `D-${days}`;
  const dt = new Date(t.date + 'T00:00:00');
  const dateLabel = `${dt.getMonth() + 1}월 ${dt.getDate()}일 (${WEEK[dt.getDay()]})`;

  const noticeLines = String(t.notice || '').split('\n').map(s => s.trim()).filter(Boolean);
  const warnLines = noticeLines.filter(s => /제외|실격|불참|주의/.test(s));
  const plainLines = noticeLines.filter(s => !warnLines.includes(s));
  const rules = String(t.rule || '').split('\n').map(s => s.trim()).filter(Boolean);
  const gather = t.gatherTime ? `${ampm(t.gatherTime)} ${t.gatherPlace || ''}`.trim() : (t.gatherInfo || '');
  const tee = t.teeUpTimeDisplay || ampm(t.teeUpTime);

  const style = document.createElement('style');
  style.textContent = `
    #evp-overlay { position: fixed; inset: 0; z-index: 99999; background: rgba(0,0,0,0.72);
      display: flex; align-items: center; justify-content: center; padding: 20px;
      font-family: 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif; animation: evp-fade .25s ease; }
    :where(#evp-overlay *) { box-sizing: border-box; margin: 0; padding: 0; }
    .evp-card { width: 100%; max-width: 360px; max-height: calc(100vh - 40px); overflow-y: auto;
      background: #101c15; border: 1px solid rgba(62,160,102,0.3); border-radius: 18px;
      padding: 22px 18px 16px; color: #fff; animation: evp-up .35s cubic-bezier(.2,.9,.3,1.2); }
    .evp-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .evp-tag { font-size: 11px; font-weight: 800; color: #3ea066; letter-spacing: 0.3px; }
    .evp-d { font-size: 12px; font-weight: 900; color: #101c15; background: #f0c040;
      border-radius: 20px; padding: 3px 10px; letter-spacing: 0.5px; }
    .evp-name { font-size: 22px; font-weight: 900; letter-spacing: -0.5px; margin-top: 2px; }
    .evp-when { font-size: 12px; color: rgba(255,255,255,0.55); margin-top: 4px; }
    .evp-key { margin-top: 16px; border-radius: 12px; padding: 14px;
      background: rgba(240,192,64,0.08); border: 1px solid rgba(240,192,64,0.35); }
    .evp-key-label { font-size: 11px; font-weight: 800; color: #f0c040; }
    .evp-key-main { font-size: 19px; font-weight: 900; margin-top: 4px; letter-spacing: -0.4px; }
    .evp-key-sub { font-size: 13px; color: rgba(255,255,255,0.8); margin-top: 6px; line-height: 1.5; }
    .evp-warn { margin-top: 10px; border-radius: 12px; padding: 12px 14px;
      background: rgba(255,80,80,0.1); border: 1px solid rgba(255,90,90,0.4);
      font-size: 13px; font-weight: 800; color: #ff8080; line-height: 1.45; }
    .evp-sec { font-size: 11px; font-weight: 800; color: rgba(255,255,255,0.45); margin: 16px 0 8px; }
    .evp-rules { display: flex; flex-wrap: wrap; gap: 6px; }
    .evp-rule { font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.85);
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px; padding: 5px 10px; }
    .evp-btns { display: flex; gap: 8px; margin-top: 18px; }
    .evp-btn { flex: 1; border: none; border-radius: 12px; padding: 13px 0; font-size: 14px; font-weight: 800;
      font-family: inherit; cursor: pointer; }
    .evp-btn.main { background: #3ea066; color: #fff; }
    .evp-btn.sub { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.7); }
    .evp-foot { text-align: center; font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 10px; }
    @keyframes evp-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes evp-up { from { opacity: 0; transform: translateY(16px) scale(.97); } to { opacity: 1; transform: none; } }
  `;
  document.head.appendChild(style);

  const ov = document.createElement('div');
  ov.id = 'evp-overlay';
  ov.innerHTML = `
    <div class="evp-card" role="dialog" aria-modal="true">
      <div class="evp-top">
        <span class="evp-tag">참가자 필독 안내</span>
        <span class="evp-d">${dLabel}</span>
      </div>
      <div class="evp-name">${esc(t.name)}</div>
      <div class="evp-when">${dateLabel}${t.golfCourseName ? ' · ' + esc(t.golfCourseName) : ''}${tee ? ' · 첫 티오프 ' + esc(tee) : ''}</div>

      ${gather ? `<div class="evp-key">
        <div class="evp-key-label">집결</div>
        <div class="evp-key-main">${esc(gather)}</div>
        ${plainLines.length ? `<div class="evp-key-sub">${plainLines.map(esc).join('<br>')}</div>` : ''}
      </div>` : ''}
      ${warnLines.map(s => `<div class="evp-warn">⚠ ${esc(s)}</div>`).join('')}

      ${rules.length ? `<div class="evp-sec">경기 룰</div>
      <div class="evp-rules">${rules.map(r => `<span class="evp-rule">${esc(r)}</span>`).join('')}</div>` : ''}

      <div class="evp-btns">
        <button class="evp-btn sub" data-act="close">확인</button>
        <button class="evp-btn main" data-act="go">대회 상세 보기</button>
      </div>
      <div class="evp-foot">대회 날까지 하루 한 번 안내해 드려요</div>
    </div>`;
  const close = () => { ov.remove(); style.remove(); };
  ov.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'go') location.href = `event.html?eventId=${encodeURIComponent(t.id)}`;
    else if (act === 'close' || e.target === ov) close();
  });
  document.body.appendChild(ov);
}
