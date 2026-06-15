'use strict';

const DP_KEY = 'Q10AutoSecKey2024';
function safeB64Encode(s) { return btoa(unescape(encodeURIComponent(s))); }
function safeB64Decode(s) { try { return decodeURIComponent(escape(atob(s))); } catch { return ''; } }
function encrypt(t) {
  let r = '';
  for (let i = 0; i < t.length; i++)
    r += String.fromCharCode(t.charCodeAt(i) ^ DP_KEY.charCodeAt(i % DP_KEY.length));
  return safeB64Encode(r);
}
function decrypt(e) {
  if (!e) return '';
  try {
    const raw = safeB64Decode(e); let r = '';
    for (let i = 0; i < raw.length; i++)
      r += String.fromCharCode(raw.charCodeAt(i) ^ DP_KEY.charCodeAt(i % DP_KEY.length));
    return r;
  } catch { return ''; }
}

function storageGet(k) { return new Promise(r => chrome.storage.local.get(k, r)); }
function storageSet(o) { return new Promise(r => chrome.storage.local.set(o, r)); }
function sendBg(msg) {
  return new Promise(r => chrome.runtime.sendMessage(msg, res => {
    if (chrome.runtime.lastError) r({ ok: false, error: chrome.runtime.lastError.message });
    else r(res || { ok: false, error: '응답 없음' });
  }));
}
let _tt;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show ' + type;
  clearTimeout(_tt); _tt = setTimeout(() => el.classList.remove('show'), 2800);
}
function setResult(id, msg, ok) {
  const el = document.getElementById(id);
  el.innerHTML = msg; el.className = 'test-result ' + (ok ? 'ok' : 'err');
  el.style.display = 'block';
}

document.addEventListener('DOMContentLoaded', async () => {
  const d = await storageGet([
    'lensQsmApiKey','lensQsmUserId','lensQsmPassword',
    'lensQ10AutoExtId','lensAnalyticsConfig','lensSheetsWebhookUrl',
    'lensApiKeyGemini','lensApiKeyGroq','lensApiKeyClaude','lensApiKeyChatgpt','lensAiProvider','lensSellerContext',
    'lensNewOrderPollEnabled'
  ]);

  if (d.lensQsmApiKey)  document.getElementById('apiKey').value   = decrypt(d.lensQsmApiKey) || d.lensQsmApiKey;
  if (d.lensQsmUserId)  document.getElementById('userId').value   = d.lensQsmUserId;
  if (d.lensQsmPassword) document.getElementById('password').value = decrypt(d.lensQsmPassword) || d.lensQsmPassword;
  if (d.lensQ10AutoExtId) document.getElementById('q10AutoExtId').value = d.lensQ10AutoExtId;
  if (d.lensSheetsWebhookUrl) document.getElementById('lensSheetsWebhookUrl').value = d.lensSheetsWebhookUrl;
  if (d.lensApiKeyGemini)  document.getElementById('lensApiKeyGemini').value  = decrypt(d.lensApiKeyGemini) || d.lensApiKeyGemini;
  if (d.lensApiKeyGroq)    document.getElementById('lensApiKeyGroq').value    = decrypt(d.lensApiKeyGroq) || d.lensApiKeyGroq;
  if (d.lensApiKeyClaude)  document.getElementById('lensApiKeyClaude').value  = decrypt(d.lensApiKeyClaude) || d.lensApiKeyClaude;
  if (d.lensApiKeyChatgpt) document.getElementById('lensApiKeyChatgpt').value = decrypt(d.lensApiKeyChatgpt) || d.lensApiKeyChatgpt;
  if (d.lensAiProvider)    document.getElementById('lensAiProvider').value    = d.lensAiProvider;
  if (d.lensSellerContext) document.getElementById('lensSellerContext').value = d.lensSellerContext;

  const ret = (d.lensAnalyticsConfig?.retentionPeriod) || '1month';
  document.querySelectorAll('input[name="retention"]').forEach(r => { r.checked = r.value === ret; });

  // 신규주문 알림 토글 (기본 ON — 명시적으로 false일 때만 해제)
  const pollEl = document.getElementById('lensNewOrderPollEnabled');
  if (pollEl) pollEl.checked = d.lensNewOrderPollEnabled !== false;

  /* 비밀번호 토글 */
  document.getElementById('pwToggle').addEventListener('click', () => {
    const inp = document.getElementById('password');
    const tog = document.getElementById('pwToggle');
    if (inp.type === 'password') { inp.type = 'text'; tog.textContent = '🙈'; }
    else { inp.type = 'password'; tog.textContent = '👁️'; }
  });

  /* 저장 */
  document.getElementById('btnSave').addEventListener('click', async () => {
    const apiKey   = document.getElementById('apiKey').value.trim();
    const userId   = document.getElementById('userId').value.trim();
    const password = document.getElementById('password').value.trim();
    const extId    = document.getElementById('q10AutoExtId').value.trim();
    const webhookUrl = document.getElementById('lensSheetsWebhookUrl').value.trim();
    const geminiKey  = document.getElementById('lensApiKeyGemini').value.trim();
    const groqKey    = document.getElementById('lensApiKeyGroq').value.trim();
    const claudeKey  = document.getElementById('lensApiKeyClaude').value.trim();
    const chatgptKey = document.getElementById('lensApiKeyChatgpt').value.trim();
    const aiProvider = document.getElementById('lensAiProvider').value;
    const sellerCtx  = document.getElementById('lensSellerContext').value.trim();
    const ret      = document.querySelector('input[name="retention"]:checked')?.value || '1month';

    const upd = { lensQsmUserId: userId, lensAiProvider: aiProvider, lensSellerContext: sellerCtx };
    if (apiKey)   upd.lensQsmApiKey   = encrypt(apiKey);
    if (password) upd.lensQsmPassword = encrypt(password);
    if (extId)    upd.lensQ10AutoExtId = extId;
    if (webhookUrl) upd.lensSheetsWebhookUrl = webhookUrl;
    else upd.lensSheetsWebhookUrl = '';  // 빈 값이면 제거
    upd.lensApiKeyGemini  = geminiKey  ? encrypt(geminiKey)  : '';
    upd.lensApiKeyGroq    = groqKey    ? encrypt(groqKey)    : '';
    upd.lensApiKeyClaude  = claudeKey  ? encrypt(claudeKey)  : '';
    upd.lensApiKeyChatgpt = chatgptKey ? encrypt(chatgptKey) : '';
    upd.lensNewOrderPollEnabled = document.getElementById('lensNewOrderPollEnabled')?.checked !== false;

    const cur = await storageGet(['lensAnalyticsConfig']);
    const cfg = Object.assign({ retentionPeriod: '1month', lastCleanupNotice: 0 }, cur.lensAnalyticsConfig || {});
    cfg.retentionPeriod = ret;
    upd.lensAnalyticsConfig = cfg;

    await storageSet(upd);
    toast('✅ 저장 완료', 'ok');
  });

  /* 셀러 컨텍스트 예시 불러오기 */
  document.getElementById('btnLoadExample')?.addEventListener('click', () => {
    const example = `나는 한국에서 일본 큐텐재팬(Qoo10 Japan)에 한국 화장품을 판매하는 셀러입니다.

[소싱 정보]
- 주요 소싱처: 올리브영, 네이버 스마트스토어, 쿠팡
- 배송대행지: KSE (일반배송 추적X), 가끔 MIR 사용
- 포장대행지: KSE 동일

[판매 현황]
- 등록 상품 수: 약 430개
- 주요 카테고리: 스킨케어(세럼/앰플), 클렌징, 마스크팩
- 베스트 브랜드: SKIN1004, 아누아, 에스트라

[마진 목표]
- 목표 마진율: 15% 이상
- 평균 수수료율: 약 10~11%
- 환율 기준: 100엔 = 약 960원

[운영 방식]
- 기획세트(번들) 상품 위주로 단가 높이는 전략 사용
- 일본어 상품명에 키워드를 많이 넣어 검색 노출 극대화
- 메가포인트(메가할인) 프로모션에 주기적으로 참여

이 정보를 바탕으로 내 상황에 맞는 실용적인 조언을 해줘.`;
    document.getElementById('lensSellerContext').value = example;
    toast('예시 프롬프트가 입력됐습니다. 내용을 수정 후 저장하세요.', 'ok');
  });

  /* 연결 테스트 */
  document.getElementById('btnTest').addEventListener('click', async () => {
    const apiKey   = document.getElementById('apiKey').value.trim();
    const userId   = document.getElementById('userId').value.trim();
    const password = document.getElementById('password').value.trim();
    if (!apiKey || !userId || !password) {
      setResult('testResult', '❌ API 키, ID, 비밀번호를 모두 입력해주세요', false); return;
    }
    setResult('testResult', '⏳ 연결 테스트 중...', true);
    const res = await sendBg({ type: 'QSM_CREATE_CERT', apiKey, userId, password });
    if (res.ok && res.certKey) {
      setResult('testResult', `✅ 연결 성공 — 인증서 발급 완료 (${res.endpoint || 'REST'})`, true);
    } else {
      setResult('testResult', '❌ 연결 실패: ' + (res.error || '알 수 없는 오류'), false);
    }
  });

  /* Q10 Auto 자동 감지 */
  document.getElementById('btnAutoDetect').addEventListener('click', async () => {
    setResult('q10TestResult', '⏳ Q10 Auto 감지 중...', true);
    // 알려진 개발 ID들 시도 (설치된 확장 ID는 개발 중 동적으로 할당됨)
    // 실제 배포 후에는 스토어 ID로 고정
    const testIds = [document.getElementById('q10AutoExtId').value.trim()].filter(Boolean);
    if (!testIds.length) {
      setResult('q10TestResult', '💡 Q10 Auto 확장 ID를 위 입력란에 붙여넣은 후 자동 감지를 클릭하세요.<br>ID 확인: chrome://extensions → Q10 Auto', false);
      return;
    }
    let found = false;
    for (const id of testIds) {
      try {
        const res = await new Promise(r =>
          chrome.runtime.sendMessage(id, { type: 'Q10_PING' }, res => {
            if (chrome.runtime.lastError) r(null);
            else r(res);
          })
        );
        if (res?.ok || res?.pong) {
          document.getElementById('q10AutoExtId').value = id;
          setResult('q10TestResult', `✅ Q10 Auto 연결 성공 (ID: ${id.slice(0,8)}...)`, true);
          found = true; break;
        }
      } catch { /* 무시 */ }
    }
    if (!found) setResult('q10TestResult', '❌ Q10 Auto를 찾을 수 없습니다. 확장 ID를 직접 입력하고 저장 후 대시보드에서 가져오기를 시도하세요.', false);
  });

  /* ── 스프레드시트 연결 테스트 ─────────────────────────────── */
  document.getElementById('btnTestSheets')?.addEventListener('click', async () => {
    const url = document.getElementById('lensSheetsWebhookUrl').value.trim();
    if (!url) {
      setResult('sheetsTestResult', '❌ webhook URL을 먼저 입력하세요', false);
      return;
    }
    if (!url.startsWith('https://script.google.com/macros/s/')) {
      setResult('sheetsTestResult', '❌ Apps Script 배포 URL이 아닙니다.<br>형식: https://script.google.com/macros/s/{ID}/exec', false);
      return;
    }
    setResult('sheetsTestResult', '⏳ 연결 테스트 중 (10초 정도 걸릴 수 있음)...', true);

    try {
      // service_worker 경유로 fetch (CORS/redirect 문제 회피)
      const res = await new Promise((resolve) => {
        const timeoutId = setTimeout(() => resolve({ ok: false, error: '타임아웃 (15초)' }), 15000);
        chrome.runtime.sendMessage(
          { type: 'LENS_TEST_SHEETS_WEBHOOK', url },
          (r) => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(r || { ok: false, error: '응답 없음' });
          }
        );
      });

      if (res.ok) {
        setResult('sheetsTestResult', `✅ Apps Script 연결 성공! (${res.msg || 'pong'})`, true);
      } else {
        // 상세 에러 진단
        let hint = '';
        const errStr = String(res.error || '').toLowerCase();
        if (errStr.includes('403') || errStr.includes('forbidden')) {
          hint = '<br><small>👉 배포 시 "액세스: <strong>모든 사용자</strong>"로 설정했는지 확인하세요</small>';
        } else if (errStr.includes('404')) {
          hint = '<br><small>👉 URL 끝이 <code>/exec</code> 인지 확인하세요 (개발 URL <code>/dev</code> 아님)</small>';
        } else if (errStr.includes('redirect')) {
          hint = '<br><small>👉 Apps Script가 로그인을 요구합니다. 배포 권한을 "모든 사용자"로 다시 설정하세요</small>';
        } else if (errStr.includes('cors') || errStr.includes('fetch')) {
          hint = '<br><small>👉 확장을 새로고침해주세요 (chrome://extensions → 새로고침 버튼)</small>';
        } else if (errStr.includes('unknown action') || errStr.includes('lens_ping')) {
          hint = '<br><small>👉 Apps Script에 v1.5b 코드가 아직 안 들어갔어요. .gs 파일을 다운로드해서 코드 전체 교체 후 다시 배포해주세요</small>';
        }
        setResult('sheetsTestResult', `❌ ${res.error || '응답 오류'}${hint}`, false);
      }
    } catch (e) {
      setResult('sheetsTestResult', `❌ ${e.message}`, false);
    }
  });

  /* ── .gs 파일 다운로드 (확장 내장) ────────────────────────── */
  document.getElementById('btnDownloadGs')?.addEventListener('click', (e) => {
    e.preventDefault();
    const a = document.createElement('a');
    a.href = chrome.runtime.getURL('Q10Auto_QSMLens_v1.5b.gs');
    a.download = 'Q10Auto_QSMLens_v1.5b.gs';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  /* ── 소싱 양식 CSV 다운로드 ────────────────────────────────── */
  document.getElementById('btnDownloadSourcingTemplate')?.addEventListener('click', () => {
    const csv = [
      'ItemCode (선택),상품명 ★,소싱처,소싱처 URL ★,소싱가(₩),무게(kg),배대지비용(₩),배송사,마진율(%),메모',
      '# 필수: 상품명 + 소싱처URL (또는 ItemCode). 매칭 우선순위: ①URL > ②상품명+브랜드 > ③ItemCode',
      ',[리뉴얼/투명도2배] 온그리디언스 스킨 베리어 카밍 로션 이엑스 220ml,올리브영,https://www.oliveyoung.co.kr/...,33900,0.7,7018,MIR REG,30,예시1',
      ',어노브 딥 데미지 리페어 단백질 샴푸 500ml,올리브영,https://www.oliveyoung.co.kr/...,13400,1.0,4479,MIR REG,30,예시2 (ItemCode 없어도 OK)',
    ].join('\n');
    const BOM = '\uFEFF';
    const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'QSM_Lens_Sourcing_template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  /* ── Apps Script 설정 가이드 ─────────────────────────────── */
  document.getElementById('btnOpenGsGuide')?.addEventListener('click', () => {
    alert(
      '📘 Apps Script 설정 가이드\n\n' +
      '1️⃣ 위 "📥 .gs 파일 다운로드" 클릭\n' +
      '2️⃣ Google Sheets 새로 만들기 (sheets.google.com/spreadsheet)\n' +
      '3️⃣ 확장 프로그램 → Apps Script\n' +
      '4️⃣ 에디터 코드 전체 선택(Ctrl+A) → 삭제\n' +
      '5️⃣ 다운로드한 .gs 파일 내용 전체 붙여넣기\n' +
      '6️⃣ 저장 (Ctrl+S)\n' +
      '7️⃣ 상단 "배포" → "새 배포" → 유형: 웹 앱\n' +
      '8️⃣ 액세스: "모든 사용자" → 배포\n' +
      '9️⃣ 표시된 URL을 위 입력칸에 붙여넣고 저장\n' +
      '🔟 "🧪 연결 테스트" → ✅ 확인\n' +
      '\n' +
      '11. 상품관리 탭으로 가서 "🔧 시트 자동 세팅" 클릭\n' +
      '12. QSM_Lens_Config + QSM_Lens_Items + QSM_Lens_Keywords 시트가 자동 생성됨'
    );
  });
});
