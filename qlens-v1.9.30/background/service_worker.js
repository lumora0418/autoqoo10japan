/**
 * QLens — Background Service Worker v1.8.0
 *
 * QSM API 상황:
 *  - 쓰기: ItemsBasic.SetNewGoods, ItemsContents.*, ItemsOptions.* → 작동
 *  - 읽기: GoodsService.ItemsLookup → ❌ "Can't find service" (Japan API 미지원)
 *
 * 해결책:
 *  - 상품 목록: QSM 웹페이지 직접 fetch (credentials:include → 로그인 세션 사용)
 *  - 주문 목록: OrderService.OrderNewslookup QAPI 시도
 *  - 대시보드 KPI: 위 두 데이터 합산
 */
'use strict';

const RETENTION_DAYS = { '1month': 30, '6months': 180, '1year': 365 };

chrome.runtime.onInstalled.addListener(() => { _setupRetentionAlarm(); });
chrome.runtime.onStartup.addListener(() => { _setupRetentionAlarm(); });

function _setupRetentionAlarm() {
  chrome.alarms.get('lens_retention_check', ex => {
    if (ex) return;
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(10, 0, 0, 0);
    chrome.alarms.create('lens_retention_check', { when: next.getTime(), periodInMinutes: 60 * 24 });
  });
  // 신규주문 폴링 알람 (30분마다) — 데스크톱 알림용
  chrome.alarms.get('lens_neworder_poll', ex => {
    if (!ex) chrome.alarms.create('lens_neworder_poll', { delayInMinutes: 5, periodInMinutes: 30 });
  });
}

/* ── 신규주문 폴링 → 데스크톱 알림 ──
   인증서가 캐시돼 있으면 ShippingBasic.GetShippingInfo_v2(stat=1)를 호출,
   신규주문 수가 이전보다 늘면 알림. 인증서 없으면 조용히 스킵. */
async function _pollNewOrders() {
  try {
    const d = await new Promise(r => chrome.storage.local.get(
      ['lensQsmCertKey', 'lensQsmCertKeyTime', 'lensNewOrderPollEnabled', '_lastUnshippedNotice'], r));
    // 사용자가 끄지 않았을 때만 (기본 ON)
    if (d.lensNewOrderPollEnabled === false) return;
    const certKey = d.lensQsmCertKey;
    // 인증서 4h 만료 — 만료면 폴링 스킵 (대시보드 열 때 갱신됨)
    if (!certKey || !d.lensQsmCertKeyTime || Date.now() - d.lensQsmCertKeyTime > 4 * 60 * 60 * 1000) return;

    const now = new Date();
    const start = new Date(now.getTime() - 7 * 86400000);
    const fmt = dt => dt.getFullYear() + String(dt.getMonth()+1).padStart(2,'0') + String(dt.getDate()).padStart(2,'0');
    const url  = 'https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi/ShippingBasic.GetShippingInfo_v2';
    const body = new URLSearchParams({
      returnType: 'application/json',
      search_Sdate: fmt(start), search_Edate: fmt(now), ShippingStat: '1',
    }).toString();
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'GiosisCertificationKey': certKey, 'QAPIVersion': '1.0' },
      body,
    });
    const j = await r.json().catch(() => ({}));
    const result = j.ResultObject || j.resultObject;
    const newCnt = Array.isArray(result) ? result.length : 0;

    const prev = d._lastUnshippedNotice || { count: 0, newCnt: 0, ts: 0 };
    if (newCnt > (prev.newCnt || 0) && Date.now() - prev.ts > 300000) {
      const delta = newCnt - (prev.newCnt || 0);
      chrome.notifications.create('qlens-bg-order-' + Date.now(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('assets/icons/lens-128.png'),
        title: '🛍️ QLens — 새 주문 도착!',
        message: `신규 주문 ${delta}건이 들어왔어요! (대기 중 총 ${newCnt}건) — 클릭하면 대시보드가 열립니다.`,
        priority: 2,
      }, () => { if (chrome.runtime.lastError) {/* 무시 */} });
      chrome.storage.local.set({ _lastUnshippedNotice: { count: newCnt, newCnt, ts: Date.now() } });
    } else if (newCnt !== (prev.newCnt || 0)) {
      // 알림 없이 카운트만 갱신
      chrome.storage.local.set({ _lastUnshippedNotice: { ...prev, newCnt, ts: prev.ts } });
    }
  } catch (e) {
    console.warn('[QLens SW] 신규주문 폴링 오류:', e.message);
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'lens_neworder_poll') { _pollNewOrders(); return; }
  if (alarm.name !== 'lens_retention_check') return;
  chrome.storage.local.get(['lensAnalyticsSnapshots','lensAnalyticsConfig'], d => {
    const snaps = Array.isArray(d.lensAnalyticsSnapshots) ? d.lensAnalyticsSnapshots : [];
    const cfg   = d.lensAnalyticsConfig || { retentionPeriod: '1month', lastCleanupNotice: 0 };
    if (!snaps.length) return;
    const days = RETENTION_DAYS[cfg.retentionPeriod] || 30;
    const old  = snaps.filter(s => s.ts < Date.now() - days * 86400_000);
    if (!old.length || Date.now() - cfg.lastCleanupNotice < 86400_000) return;
    const lbl = { '1month':'1개월','6months':'6개월','1year':'1년' }[cfg.retentionPeriod] || '1개월';
    try {
      chrome.notifications.create('lens_cleanup_' + Date.now(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('assets/icons/lens-128.png'),
        title: '🔍 QLens — 데이터 정리 시기',
        message: `보존 기간(${lbl})을 초과한 스냅샷이 ${old.length}개 있습니다.`,
        priority: 1
      });
      cfg.lastCleanupNotice = Date.now();
      chrome.storage.local.set({ lensAnalyticsConfig: cfg });
    } catch (e) { console.warn('[QLens SW] 알림 오류:', e.message); }
  });
});

chrome.notifications?.onClicked?.addListener(id => {
  if (id.startsWith('lens_cleanup_') || id.startsWith('qlens-bg-order-') || id.startsWith('qlens-order-') || id.startsWith('qlens-unshipped-')) {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
    chrome.notifications.clear(id);
  }
});

/* ── Q10 Auto → QLens 상품 수신 (onMessageExternal) ─────────── */
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // Q10 Auto 연결 테스트 ping
  if (msg.type === 'LENS_PING') {
    sendResponse({ ok: true, ts: new Date().toISOString(), name: 'QLens' });
    return true;
  }

  // Q10 Auto 스캔 상품 수신 → chrome.storage에 큐 저장
  if (msg.type === 'Q10_AUTO_PRODUCT') {
    const product = msg.product || {};
    if (!product.name && !product.sourceUrl) {
      sendResponse({ ok: false, error: '상품 데이터 없음' });
      return true;
    }

    // 기존 큐 로드 후 추가
    chrome.storage.local.get(['lensIncomingQueue'], d => {
      const queue = Array.isArray(d.lensIncomingQueue) ? d.lensIncomingQueue : [];
      queue.unshift({
        ...product,
        receivedAt: Date.now(),
        source: 'Q10_AUTO',
      });
      // 최대 50개 유지
      chrome.storage.local.set({ lensIncomingQueue: queue.slice(0, 50) }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        console.log('[QLens] Q10 Auto 상품 수신:', product.name);
        sendResponse({ ok: true, queued: queue.length });

        // 대시보드가 열려 있으면 알림
        chrome.tabs.query({ url: chrome.runtime.getURL('dashboard/*') }, tabs => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
              type: 'LENS_NEW_PRODUCT_FROM_Q10',
              product,
            }).catch(() => {});
          });
        });
      });
    });
    return true;
  }
});

/* ── 공통 헤더 ── */
const QSM_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja-JP,ko-KR,ko;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

/* ── 메시지 핸들러 ── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  /* ══════════════════════════════════════
     사이드패널 → 대시보드: 시트 가격 업데이트 요청
  ══════════════════════════════════════ */
  if (msg.type === 'LENS_SIDEPANEL_UPDATE_PRICE') {
    (async () => {
      try {
        // 대시보드 탭 찾기
        const dashTabs = await chrome.tabs.query({
          url: chrome.runtime.getURL('dashboard/index.html') + '*',
        });
        if (dashTabs.length === 0) {
          sendResponse({ ok: false, error: 'QLens 대시보드가 열려 있지 않습니다' });
          return;
        }
        // 대시보드로 메시지 전달
        const res = await chrome.tabs.sendMessage(dashTabs[0].id, {
          type: 'LENS_UPDATE_PRICE_FROM_PANEL',
          code: msg.code,
          newSourcePrice: msg.newSourcePrice,
          sourceUrl: msg.sourceUrl,
        });
        sendResponse(res || { ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  /* ══════════════════════════════════════
     0. Apps Script Webhook 프록시 (모든 LENS 호출 통일)
     - service_worker 경유로 fetch (CORS/302 우회)
     - 로그인 페이지(HTML) 감지 시 친절한 에러
  ══════════════════════════════════════ */
  if (msg.type === 'LENS_AI_ADVICE') {
    (async () => {
      try {
        const s = msg.settings || {};
        const prompt = msg.prompt || '';
        const provider = s.lensAiProvider || (s.lensApiKeyGemini ? 'gemini' : s.lensApiKeyGroq ? 'groq' : s.lensApiKeyClaude ? 'claude' : s.lensApiKeyChatgpt ? 'chatgpt' : '');
        if (!provider || (!s.lensApiKeyGemini && !s.lensApiKeyChatgpt && !s.lensApiKeyGroq && !s.lensApiKeyClaude)) { sendResponse({ ok: false, error: 'AI 키 미설정' }); return; }

        if (provider === 'gemini' && s.lensApiKeyGemini) {
          const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-flash-latest'];
          let lastErr = '';
          for (const model of models) {
            try {
              const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${s.lensApiKeyGemini}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }],
                  generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
                }),
              });
              const d = await r.json();
              if (d.candidates?.[0]?.content?.parts?.[0]?.text) {
                sendResponse({ ok: true, text: d.candidates[0].content.parts[0].text.trim() });
                return;
              }
              if (d.error) {
                lastErr = d.error.message || '';
                // 할당량/속도 제한이면 다음 모델 시도, 그 외(잘못된 키 등)는 즉시 종료
                if (/quota|rate|429|resource.?exhausted/i.test(lastErr)) continue;
                sendResponse({ ok: false, error: 'Gemini: ' + lastErr });
                return;
              }
            } catch (e) { lastErr = e.message; }
          }
          sendResponse({ ok: false, error: 'Gemini 응답 없음' + (lastErr ? ' (' + lastErr.slice(0, 80) + ')' : ' — 키 또는 사용량 한도를 확인하세요') });
          return;
        }

        if (provider === 'groq' && s.lensApiKeyGroq) {
          const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.lensApiKeyGroq}` },
            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 4096 }),
          });
          const d = await r.json();
          if (d.choices?.[0]?.message?.content) {
            sendResponse({ ok: true, text: d.choices[0].message.content.trim() });
            return;
          }
          if (d.error) { sendResponse({ ok: false, error: 'Groq: ' + (d.error.message||'') }); return; }
        }

        if (provider === 'claude' && s.lensApiKeyClaude) {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': s.lensApiKeyClaude,
              'anthropic-version': '2023-06-01',
              'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
          });
          const d = await r.json();
          if (d.content?.[0]?.text) {
            sendResponse({ ok: true, text: d.content[0].text.trim() });
            return;
          }
          if (d.error) { sendResponse({ ok: false, error: 'Claude: ' + (d.error.message||'') }); return; }
        }

        if (provider === 'chatgpt' && s.lensApiKeyChatgpt) {
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.lensApiKeyChatgpt}` },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 4096 }),
          });
          const d = await r.json();
          if (d.choices?.[0]?.message?.content) {
            sendResponse({ ok: true, text: d.choices[0].message.content.trim() });
            return;
          }
          if (d.error) { sendResponse({ ok: false, error: 'ChatGPT: ' + (d.error.message||'') }); return; }
        }

        // 선택한 provider 키가 비었거나 응답 실패 시 — 입력된 다른 키로 순차 폴백
        if (s.lensApiKeyGemini && provider !== 'gemini') {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${s.lensApiKeyGemini}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          });
          const d = await r.json();
          if (d.candidates?.[0]?.content?.parts?.[0]?.text) {
            sendResponse({ ok: true, text: d.candidates[0].content.parts[0].text.trim() });
            return;
          }
        }
        if (s.lensApiKeyGroq && provider !== 'groq') {
          const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.lensApiKeyGroq}` },
            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 4096 }),
          });
          const d = await r.json();
          if (d.choices?.[0]?.message?.content) {
            sendResponse({ ok: true, text: d.choices[0].message.content.trim() });
            return;
          }
        }
        if (s.lensApiKeyClaude && provider !== 'claude') {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': s.lensApiKeyClaude, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
          });
          const d = await r.json();
          if (d.content?.[0]?.text) {
            sendResponse({ ok: true, text: d.content[0].text.trim() });
            return;
          }
        }
        if (s.lensApiKeyChatgpt && provider !== 'chatgpt') {
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.lensApiKeyChatgpt}` },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 4096 }),
          });
          const d = await r.json();
          if (d.choices?.[0]?.message?.content) {
            sendResponse({ ok: true, text: d.choices[0].message.content.trim() });
            return;
          }
        }
        sendResponse({ ok: false, error: 'AI 응답 실패' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'LENS_WEBHOOK_PROXY' || msg.type === 'LENS_TEST_SHEETS_WEBHOOK') {
    (async () => {
      try {
        const url = msg.url;
        const body = msg.body || { action: 'LENS_PING' };

        const res = await fetch(url, {
          method: 'POST',
          // text/plain → CORS preflight 회피 (Apps Script가 e.postData.contents로 받음)
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body),
          redirect: 'follow',
        });

        if (!res.ok) {
          sendResponse({ _fetchError: `HTTP ${res.status} ${res.statusText}` });
          return;
        }

        const text = await res.text();

        // HTML 응답 = Apps Script가 로그인 페이지 반환 (배포 권한 문제)
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
          if (text.includes('Authorization') || text.includes('Sign in') || text.includes('accounts.google.com')) {
            sendResponse({
              _fetchError: 'Apps Script가 Google 로그인을 요구합니다.\n→ Apps Script 에디터 → 배포 → 배포 관리 → 설정(⚙️) → "다음 사용자로 실행: 나", "액세스: 모든 사용자"로 다시 배포하세요.'
            });
            return;
          }
          sendResponse({ _fetchError: 'Apps Script가 HTML을 반환했습니다 (배포 설정 문제 의심).\n→ .gs 코드 전체를 다시 붙여넣고 [새 배포]로 재배포하세요.' });
          return;
        }

        try {
          const json = JSON.parse(text);
          // 테스트 전용 응답 형식 (호환)
          if (msg.type === 'LENS_TEST_SHEETS_WEBHOOK') {
            if (json.ok) sendResponse({ ok: true, msg: json.msg || 'pong', ts: json.ts });
            else sendResponse({ ok: false, error: json.error || 'Unknown' });
          } else {
            // 일반 프록시 — JSON 그대로 전달
            sendResponse(json);
          }
        } catch (parseErr) {
          sendResponse({ _fetchError: `JSON 파싱 실패: ${text.slice(0, 200)}` });
        }
      } catch (err) {
        sendResponse({ _fetchError: err.message });
      }
    })();
    return true; // async
  }

  /* ══════════════════════════════════════
     1. QSM 인증서 발급 (QAPI 공통)
  ══════════════════════════════════════ */
  if (msg.type === 'QSM_CREATE_CERT') {
    const { apiKey, userId, password } = msg;
    console.group('[QLens] 🔑 인증서 발급');
    console.log('userId:', userId, '/ apiKey 앞 8자:', apiKey?.slice(0,8));
    console.groupEnd();

    const endpoints = [
      { label: 'REST POST',
        url: 'https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi/CertificationAPI.CreateCertificationKey',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'GiosisCertificationKey': apiKey, 'QAPIVersion': '1.0' },
        body: new URLSearchParams({ returnType: 'application/json', user_id: userId, pwd: password }).toString()
      },
      { label: 'GET',
        url: `https://api.qoo10.jp/GMKT.INC.Front.QAPIService/Certification.api/CreateCertificationKey?key=${encodeURIComponent(apiKey)}&user_id=${encodeURIComponent(userId)}&pwd=${encodeURIComponent(password)}`,
        method: 'GET'
      }
    ];
    (async () => {
      for (const ep of endpoints) {
        try {
          const opt = { method: ep.method };
          if (ep.headers) opt.headers = ep.headers;
          if (ep.body)    opt.body    = ep.body;
          const r = await fetch(ep.url, opt);
          const text = await r.text();
          console.log(`[QLens] 인증서 ${ep.label} → ${r.status}:`, text.slice(0,200));
          let result = {};
          try { result = JSON.parse(text); } catch {
            const m = text.match(/<ResultObject>([^<]+)<\/ResultObject>/);
            if (m) result = { ResultObject: m[1] };
          }
          const certKey = result.ResultObject || result.resultObject;
          if (certKey && String(certKey).length > 5) {
            console.log('[QLens] ✅ 인증서 발급 성공:', ep.label);
            sendResponse({ ok: true, certKey: String(certKey) }); return;
          }
          console.warn('[QLens] ❌ 인증서 없음:', result.ResultMsg || result.resultMsg);
        } catch (e) { console.error('[QLens] 인증서 오류:', ep.label, e.message); }
      }
      sendResponse({ ok: false, error: '인증서 발급 실패 — API 키/ID/비밀번호 확인 필요' });
    })();
    return true;
  }

  /* ══════════════════════════════════════
     2. QSM 일반 API 호출 (쓰기용 + OrderService)
  ══════════════════════════════════════ */
  if (msg.type === 'QSM_API_CALL') {
    const { method, certKey, params, version } = msg;
    // ★ 모든 QAPI는 api.qoo10.jp에서만 작동
    // www.qoo10.jp는 API 문서 페이지(HTML)만 반환하므로 절대 사용 금지
    const url  = `https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi/${method}`;
    const body = new URLSearchParams({ returnType: 'application/json', ...(params || {}) }).toString();
    console.log(`[QLens] 📡 ${method} (v${version||'1.0'})`, params);

    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'GiosisCertificationKey': certKey,
        'QAPIVersion': String(version || '1.0')
      },
      body
    })
    .then(r => r.text())
    .then(text => {
      console.log(`[QLens] 📥 ${method} 응답:`, text.slice(0, 400));
      let j = {};
      try { j = JSON.parse(text); } catch { j = { _raw: text }; }
      const code = j.ResultCode ?? j.resultCode;
      const ok   = code === 0 || code === '0' || code === 'OK';
      sendResponse({ ok, code, msg: j.ResultMsg || j.resultMsg,
                     result: j.ResultObject || j.resultObject, full: j, _raw: text.slice(0,200) });
    })
    .catch(e => { console.error(`[QLens] ${method} 오류:`, e.message); sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  /* ══════════════════════════════════════════════════════
     3. ★ QSM_SCRAPE_TAB — executeScript로 렌더된 DOM 직접 읽기
        fetch()는 JS 렌더 전 빈 HTML만 반환 → executeScript 사용
        동작: 열린 QSM 탭 찾기 → 없으면 새탭 → executeScript 주입
  ══════════════════════════════════════════════════════ */
  if (msg.type === 'QSM_SCRAPE_TAB') {
    const { targetUrl, scriptFn, openIfMissing = true } = msg;

    // 보안: qoo10.jp / qoo10analytics.qoo10.jp 허용
    try {
      const u = new URL(targetUrl);
      const allowed = ['qoo10.jp','qoo10.com','seller.qoo10.jp'];
      if (!allowed.some(d => u.hostname === d || u.hostname.endsWith('.'+d))) {
        sendResponse({ ok: false, error: 'qoo10 도메인만 허용' }); return;
      }
    } catch { sendResponse({ ok: false, error: '잘못된 URL' }); return; }

    (async () => {
      let tabId = null;
      let openedNewTab = false;

      try {
        // 1) 기존 QSM 탭 찾기 (Error/Login 페이지 제외)
        const allTabs = await chrome.tabs.query({ url: ['https://qsm.qoo10.jp/*', 'https://qoo10analytics.qoo10.jp/*'] });
        const tabs = allTabs.filter(t => {
          const u = t.url || '';
          return !u.includes('Notice.aspx') &&
                 !u.includes('/Error') &&
                 !u.includes('/Login') &&
                 !u.includes('aspxerrorpath');
        });

        if (tabs.length > 0) {
          // 타겟 URL에 가장 가까운 탭 우선
          const matched = tabs.find(t => t.url && t.url.includes(new URL(targetUrl).pathname.split('/').pop())) || tabs[0];
          tabId = matched.id;
          console.log('[QLens] 기존 QSM 탭 사용:', tabId, matched.url);
        }

        // 2) 없으면 새 탭 열기 (한 번만)
        if (tabId === null) {
          if (!openIfMissing) {
            sendResponse({ ok: false, error: 'QSM_TAB_NOT_OPEN', msg: 'QSM 탭을 열어주세요' });
            return;
          }
          console.log('[QLens] 새 QSM 탭 오픈:', targetUrl);
          const newTab = await chrome.tabs.create({ url: targetUrl, active: false });
          tabId = newTab.id;
          openedNewTab = true;

          // 페이지 로드 완료 대기 (최대 10초)
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('페이지 로드 타임아웃')), 10000);
            const listener = (updatedTabId, info) => {
              if (updatedTabId === tabId && info.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                setTimeout(resolve, 1500); // JS 렌더 대기
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        } else if (msg.navigate) {
          // 기존 탭을 targetUrl로 이동
          await chrome.tabs.update(tabId, { url: targetUrl });
          await new Promise(r => setTimeout(r, 3000));
        }

        // ★ 결과 탭이 Error로 리다이렉트됐는지 확인 — 무한 루프 방지
        const finalTab = await chrome.tabs.get(tabId).catch(() => null);
        if (finalTab?.url?.includes('Notice.aspx') || finalTab?.url?.includes('aspxerrorpath')) {
          sendResponse({ ok: false, error: 'QSM_LOGIN_REQUIRED', msg: 'QSM 로그인이 필요합니다 - 새 탭에서 qsm.qoo10.jp 로그인 후 다시 시도하세요' });
          return;
        }

        // 3) executeScript — 렌더된 DOM 읽기
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: new Function('return (' + scriptFn + ')()'),
        });

        const data = results?.[0]?.result;
        console.log('[QLens] executeScript 결과:', JSON.stringify(data)?.slice(0, 200));
        sendResponse({ ok: true, data, tabId, openedNewTab });

      } catch (e) {
        console.error('[QLens] QSM_SCRAPE_TAB 오류:', e.message);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  /* ── 구형 QSM_WEB_FETCH 호환 (제거 예정) ── */
  if (msg.type === 'QSM_WEB_FETCH') {
    sendResponse({ ok: false, error: 'QSM_WEB_FETCH deprecated. Use QSM_SCRAPE_TAB.' });
    return true;
  }

  /* ══════════════════════════════════════
     4. Q10 Auto 연동 핸들러 (향후 연결용 스텁)
        QLens → Q10 Auto 메시지 라우팅 없음
        Q10 Auto 측에서 onMessageExternal로 응답
  ══════════════════════════════════════ */
  // (Q10 Auto와의 연동은 dashboard.js importFromQ10Auto()에서 직접 sendMessage 처리)

});
