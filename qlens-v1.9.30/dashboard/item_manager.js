'use strict';
/**
 * QLens — dashboard/item_manager.js  v1.8.0
 *
 * 기능 흐름:
 *  1. 상품 불러오기: QSM API + seller.qoo10.jp 스크래핑으로 상품/가격 수집
 *  2. 시트 불러오기: 기존 Google Sheets의 QSM_Lens_Items 시트에서 소싱처/마진 데이터 머지
 *  3. 인라인 편집: 소싱처 URL, 소싱가(₩), 배송비(¥), 마진율 — 3초 후 시트 자동저장
 *  4. 자동 계산:   소싱가 → 평상시가(¥) → 메가포/메가와리 자동 계산
 *  5. QSM 적용:    ItemsOrder.SetGoodsPriceQty (가격/수량/종료일)
 *                  ItemsBasic.EditGoodsStatus (1=거래대기/2=거래가능/3=거래폐지)
 *  6. 시트 저장:   QSM_Lens_Items 시트로 백업 (양방향 동기화)
 *
 * v1.8.0 변경사항:
 *  - 배송비 단위: ₩(원화) → ¥(엔화)로 전면 통일 (SHIP_RATES 포함)
 *  - 이벤트 모드(메가포/메가와리) 실제 마진율 계산 함수 추가 (calcEventMarginPct)
 *  - 품절/단종/재입고 처리 API: ItemsBasic.EditGoodsStatus (Status 1/2/3)
 *  - 가격+수량+종료일 직접 수정: ItemsOrder.SetGoodsPriceQty
 *  - 인라인 수정 후 3초 debounce 자동 시트 저장 (양방향 동기화)
 *  - 무게 기본값 0.5kg, 소싱처 URL 변경 시 소싱처 자동 감지
 *  - 시트 ↔ 렌즈 배송비 단위 자동 변환 (1000 이상 = ₩ → ¥)
 *  - saveToSheet: shipFeeJpy, marginPct, megaponPriceJpy, megawariPriceJpy 포함
 */

/* ── 암호화 ── */
const DP_KEY = 'Q10AutoSecKey2024';
function safeB64Decode(s) { try { return decodeURIComponent(escape(atob(s))); } catch { return ''; } }
function decryptKey(enc) {
  if (!enc) return '';
  const raw = safeB64Decode(enc);
  let r = '';
  for (let i = 0; i < raw.length; i++)
    r += String.fromCharCode(raw.charCodeAt(i) ^ DP_KEY.charCodeAt(i % DP_KEY.length));
  return r;
}

/* ── 유틸 ── */
const storageGet = k => new Promise(r => chrome.storage.local.get(k, r));
const storageSet = o => new Promise(r => chrome.storage.local.set(o, r));
const sendBg = msg => new Promise(r =>
  chrome.runtime.sendMessage(msg, res => {
    if (chrome.runtime.lastError) r({ ok: false, error: chrome.runtime.lastError.message });
    else r(res || { ok: false, error: '응답 없음' });
  })
);
const fmtP = n => (n && n > 0) ? '¥' + n.toLocaleString('ja-JP') : '-';
const fmtW = n => (n && n > 0) ? '₩' + n.toLocaleString('ko-KR') : '-';

// ★ QSM 응답에서 재고수량 추출 (엔드포인트마다 필드명이 달라 후보를 순서대로 탐색)
function _pickQty(o) {
  if (!o) return null;
  for (const k of ['ItemQty', 'Qty', 'SellableQty', 'ItemSellableQty', 'StockQty', 'GoodsQty']) {
    const v = o[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

let _toastT;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show ' + type;
  clearTimeout(_toastT); _toastT = setTimeout(() => el.classList.remove('show'), 3000);
}
function showOv(title, sub = '', pct = 0) {
  document.getElementById('ovTitle').textContent = title;
  document.getElementById('ovSub').textContent   = sub;
  document.getElementById('ovBar').style.width   = pct + '%';
  document.getElementById('overlay').classList.add('show');
}
function setOv(sub, pct) {
  document.getElementById('ovSub').textContent = sub;
  document.getElementById('ovBar').style.width = pct + '%';
}
const hideOv = () => document.getElementById('overlay').classList.remove('show');

function log(msg, type = '') {
  const el = document.getElementById('resultLog');
  el.classList.add('show');
  const line = document.createElement('div');
  line.className = type === 'ok' ? 'log-ok' : type === 'err' ? 'log-err' : type === 'warn' ? 'log-warn' : '';
  line.textContent = new Date().toLocaleTimeString('ko-KR') + '  ' + msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

/* ── QSM 인증 ── */
let _certKey = null, _certTs = 0;
const CERT_TTL = 4 * 60 * 60 * 1000;

async function getCertKey(force = false) {
  if (!force && _certKey && Date.now() - _certTs < CERT_TTL) return _certKey;
  const d = await storageGet(['lensQsmApiKey','lensQsmUserId','lensQsmPassword']);
  if (!d.lensQsmApiKey) throw new Error('설정에서 QSM API 키를 입력해주세요');
  const apiKey = decryptKey(d.lensQsmApiKey) || d.lensQsmApiKey;
  const pw     = decryptKey(d.lensQsmPassword) || d.lensQsmPassword;
  const res = await sendBg({ type: 'QSM_CREATE_CERT', apiKey, userId: d.lensQsmUserId, password: pw });
  if (!res.ok) throw new Error('인증서 발급 실패: ' + (res.error || ''));
  _certKey = res.certKey; _certTs = Date.now();
  return _certKey;
}
async function qsmCall(method, params = {}, ver = '1.0') {
  let ck = await getCertKey();
  let res = await sendBg({ type: 'QSM_API_CALL', method, certKey: ck, params, version: ver });
  if (!res.ok && (res.code === -110 || res.code === -130)) {
    ck = await getCertKey(true);
    res = await sendBg({ type: 'QSM_API_CALL', method, certKey: ck, params, version: ver });
  }
  return res;
}

/* ── executeScript 헬퍼 ── */
async function scrapeTab(targetUrl, fn) {
  // 이미 열린 QSM 탭 탐색
  const tabs = await chrome.tabs.query({
    url: ['https://qsm.qoo10.jp/*','https://seller.qoo10.jp/*']
  });
  let tabId;
  let openedNewTab = false;

  if (tabs.length > 0) {
    const key = new URL(targetUrl).pathname.split('/').pop();
    tabId = (tabs.find(t => t.url?.includes(key)) || tabs[0]).id;
  } else {
    const tab = await chrome.tabs.create({ url: targetUrl, active: false });
    tabId = tab.id;
    openedNewTab = true;
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('로드 타임아웃')), 12000);
      const cb = (id, info) => {
        if (id !== tabId || info.status !== 'complete') return;
        clearTimeout(t); chrome.tabs.onUpdated.removeListener(cb);
        setTimeout(res, 2000);
      };
      chrome.tabs.onUpdated.addListener(cb);
    });
  }

  try {
    // ★ 에러 페이지 감지 (もう一度ご確認ください / 404 등)
    const pageCheck = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const body = document.body?.innerText || '';
        const title = document.title || '';
        const isError = body.includes('もう一度ご確認') || body.includes('ページが見つかりません')
                     || title.includes('404') || title.includes('エラー')
                     || body.includes('Cannot access') || body.includes('ログイン');
        return { isError, title, bodyLen: body.length };
      }
    });
    const chk = pageCheck?.[0]?.result;
    if (chk?.isError) {
      throw new Error(`페이지 로드 실패: "${chk.title}" — seller.qoo10.jp 로그인 상태를 확인하세요`);
    }

    const results = await chrome.scripting.executeScript({ target: { tabId }, func: fn });
    return results?.[0]?.result;
  } finally {
    // ★ 새로 열었던 탭은 반드시 닫기 (에러 시도 포함)
    if (openedNewTab) {
      chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) { /* 이미 닫혔으면 무시 */ }
      });
    }
  }
}

/* ══════════════════════════════════════════════════════
   가격 계산
   - 평상시가: 소싱가 → 환율 환산 → 배송비(¥) + 마진 → 큐텐가
   - 메가포/메가와리: 평상시가 → 행사 공식으로 인상가 역산
   ★ 배송비(shipFee)는 엔화(¥) 단위로 통일
      소싱가(sourcePrice)는 원화(₩) 단위
══════════════════════════════════════════════════════ */
function getRates() {
  return {
    exchangeRate:       +document.getElementById('rExchangeRate').value       || 9.5,
    shipFeeJpy:         +document.getElementById('rShipFee').value            || 0,   // ★ 엔화
    marginRate:         +document.getElementById('rMarginRate').value         || 10,   // ★ 평상시 기본 마진율 10%
    qFeeRate:           +document.getElementById('rQFeeRate').value           || 13,
    megaponRate:        +document.getElementById('rMegaponRate').value        || 10,
    megawariRate:       +document.getElementById('rMegawariRate').value       || 20,
    megawariEventFee:   +document.getElementById('rMegawariEventFee').value   || 13,
    megawariSellerRate: +document.getElementById('rMegawariSellerRate').value || 10,
  };
}

// ★ v1.9.29: 상품별 수수료율(it.qFeeRate)이 있으면 그 값으로 r을 오버라이드, 없으면 전역 r 그대로
//   marginRate가 상품별로 동작하는 것과 동일한 패턴. 정산 CSV 매핑/수동 입력으로 it.qFeeRate 설정됨.
function rateFor(it, r) {
  return (it && +it.qFeeRate > 0) ? { ...r, qFeeRate: +it.qFeeRate } : r;
}

// 소싱가(₩) + 국제배송비(¥) + 마진율 → 평상시 큐텐 추천 판매가(¥)
// ★ shipFeeJpy : 엔화 단위 (국제배송비 — QSM 셀러 부담분)
// ★ custShipJpy: 엔화 단위 (고객배송비 — 구매자 부담분, 매출에 포함)
function calcBasePrice(sourcePriceKrw, shipFeeJpy, marginRate, r, custShipJpy) {
  if (!sourcePriceKrw || sourcePriceKrw <= 0) return 0;
  // 비용(¥) = (소싱가 + 포장·국내비 500)/환율 + 국제배송비
  const costJpy = (sourcePriceKrw + 500) / r.exchangeRate + (shipFeeJpy || r.shipFeeJpy || 0);
  const m   = (marginRate || r.marginRate) / 100;
  const fee = r.qFeeRate / 100;
  // ★ v1.9.29: 매출대비 마진율로 역산 (표시 마진율 calcEventEconomics와 정의 일치)
  //   마진율 = 이익/매출, 이익 = 매출×(1-수수료) - 비용  ⇒  매출 = 비용 / (1 - 수수료 - 마진율)
  //   판매가 = 매출 - 고객배송비  (고객배송비도 매출이므로 그만큼 상품가를 낮춤)
  const denom = 1 - fee - m;
  if (denom <= 0) return 0;  // 수수료율 + 마진율 ≥ 100% → 달성 불가
  const grossJpy = costJpy / denom;                  // 목표 매출 = 판매가 + 고객배송비
  const saleJpy  = grossJpy - (custShipJpy || 0);    // 추천 판매가
  return Math.ceil(Math.max(0, saleJpy) / 10) * 10;  // 10엔 단위 올림
}

function calcMegaponPrice(basePriceJpy, r) {
  if (!basePriceJpy) return 0;
  const targetSettle = Math.floor(basePriceJpy * (1 - r.qFeeRate / 100));
  const denom = 1 - r.qFeeRate/100 - r.megaponRate/100;
  if (denom <= 0) return basePriceJpy;
  return Math.ceil(targetSettle / denom / 10) * 10;
}

function calcMegawariPrice(basePriceJpy, r) {
  if (!basePriceJpy) return 0;
  const targetSettle = Math.floor(basePriceJpy * (1 - r.qFeeRate / 100));
  const cr = 1 - r.megawariRate / 100;
  const denom = cr * (1 - r.megawariEventFee / 100) - r.megawariSellerRate / 100;
  if (denom <= 0) return basePriceJpy;
  return Math.ceil(targetSettle / denom / 10) * 10;
}

// 행사가 (모드별로 선택)
function getEventPrice(item, mode, r) {
  const ri = rateFor(item, r);  // ★ 상품별 수수료율 반영
  if (mode === 'normal')   return item.basePrice || calcBasePrice(item.sourcePrice, item.shipFee, item.marginRate, ri, item.customerShipJpy);
  if (mode === 'megapon')  return calcMegaponPrice(item.basePrice || calcBasePrice(item.sourcePrice, item.shipFee, item.marginRate, ri, item.customerShipJpy), ri);
  if (mode === 'megawari') return calcMegawariPrice(item.basePrice || calcBasePrice(item.sourcePrice, item.shipFee, item.marginRate, ri, item.customerShipJpy), ri);
  return 0;
}

// ★ v1.9.29: 행사 모드 이익(¥) + 마진율(%)을 한 번에 계산 (이익/마진율 컬럼 불일치 버그 해결)
//   핵심: 큐텐 수수료는 매출(판매가 + 고객배송비) 전체에 부과 — 큐토 정본과 일치
//   - 평상시: 정산금 = 매출 × (1 - 수수료)
//   - 메가포: 정산금 = 매출 × (1 - 수수료 - 포인트율)
//   - 메가와리: 고객 할인가 × (1 - 행사수수료) - 판매가 × 셀러부담 + 고객배송비 × (1 - 수수료)
//   마진율 분모 = 매출(판매가 + 고객배송비) — CLAUDE.md 규정(큐렌즈는 매출대비)
function calcEventEconomics(sourcePriceKrw, shipFeeJpy, custShipJpy, eventPrice, mode, r) {
  if (!eventPrice || eventPrice <= 0 || !sourcePriceKrw) return { profitJpy: null, marginPct: null };
  const costJpy   = sourcePriceKrw / r.exchangeRate + (shipFeeJpy || r.shipFeeJpy || 0);
  const packJpy   = 500 / r.exchangeRate;                       // 국내 포장·배송비 ₩500
  const custShip  = custShipJpy || 0;
  const grossJpy  = eventPrice + custShip;                      // 매출 = 판매가 + 고객배송비

  let settleJpy;  // 큐텐에서 받는 정산금 (수수료는 매출 전체 기준 차감)
  if (mode === 'megapon') {
    settleJpy = grossJpy * (1 - r.qFeeRate/100 - r.megaponRate/100);
  } else if (mode === 'megawari') {
    const custPays = eventPrice * (1 - r.megawariRate/100);     // 고객 실지불 상품가
    settleJpy = custPays * (1 - r.megawariEventFee/100)
              - eventPrice * (r.megawariSellerRate/100)
              + custShip * (1 - r.qFeeRate/100);                // 고객배송비도 수수료 차감 후 정산
  } else {
    settleJpy = grossJpy * (1 - r.qFeeRate/100);
  }
  // ★ v1.9.29: 이익 = 매출 - 총비용(원가+국제배송+수수료+포장). 부가세환급은 미포함 (시트 정본 "이익(부가세불포함)"과 일치)
  const profitJpy = settleJpy - costJpy - packJpy;
  const marginPct = grossJpy > 0 ? (profitJpy / grossJpy) * 100 : null;
  return { profitJpy, marginPct };
}

// 호환 wrapper — 기존 호출처(마진율만 필요)는 그대로 사용
function calcEventMarginPct(sourcePriceKrw, shipFeeJpy, custShipJpy, eventPrice, mode, r) {
  return calcEventEconomics(sourcePriceKrw, shipFeeJpy, custShipJpy, eventPrice, mode, r).marginPct;
}

/* ══════════════════════════════════════════════════════
   상태
══════════════════════════════════════════════════════ */
let allProducts = [];         // 통합 상품 배열
let filtered    = [];
let currentMode = 'normal';
let page        = 1;
const PER_PAGE  = 30;
let _checked    = new Set();
let _dirty      = new Set();  // 미저장 변경된 상품 코드들
let _deliveryGroups = [];     // ★ v1.9.29: QSM 셀러 배송 그룹 목록 (고객배송비 드롭다운용)
// ★ v1.9.29: 로컬 캐시 저장 — _dirty도 함께 영속화 (새로고침/확장 리로드 시 변경분 유지 → 저장+QSM반영 가능)
function _saveLocalCache() {
  // ★ 기획세트 구성품 목록(_bundlesMap)도 함께 캐시 — 캐시 복원 시 목록이 사라지지 않게
  return storageSet({ lensItemManagerCache: { ts: Date.now(), items: allProducts, dirty: [..._dirty], bundles: _bundlesMap } });
}
let _webhookUrl = null;
let _autoSaveTimer = null;    // ★ 양방향 동기화: 변경 후 자동저장 타이머

/* ══════════════════════════════════════════════════════
   ★ 기획세트(번들) 상태 (v1.9.11)
   - _bundlesMap: { '1154945768': [{name, url, price, weight, qty, isFree}, ...], ... }
   - _expandedBundles: Set of QSM codes currently expanded
══════════════════════════════════════════════════════ */
let _bundlesMap = {};       // 시트에서 로드한 모든 세트의 구성품 매핑
let _expandedBundles = new Set();  // 펼쳐진 세트 코드 집합
let _bundlesLoaded = false; // 한 번 로드했는지 플래그

async function loadBundlesFromSheet() {
  if (!_webhookUrl) return;
  try {
    const res = await postToWebhook('LENS_BUNDLE_LOAD');
    if (res.ok && res.bundles) {
      _bundlesMap = res.bundles;
      _bundlesLoaded = true;
      // allProducts에 itemType 동기화 (Z열 기준 + 매핑표 기준)
      allProducts.forEach(p => {
        const comps = _bundlesMap[p.code];
        if (comps && comps.length) {
          p.itemType = 'bundle';
          p.componentCount = comps.length;
          // 합계 자동 계산 (소싱가/무게가 비어있는 세트만 — 사용자가 수동 입력한 경우 덮어쓰지 않음)
          const sumPrice = comps.filter(c => !c.isFree).reduce((s,c) => s + (+c.price||0)*(+c.qty||1), 0);
          const sumWeight = comps.reduce((s,c) => s + (+c.weight||0)*(+c.qty||1), 0);
          if (!p.sourcePrice || p._bundleSyncedPrice) {
            p.sourcePrice = sumPrice;
            p._bundleSyncedPrice = true;
          }
          if (!p.weight || p._bundleSyncedWeight) {
            p.weight = +sumWeight.toFixed(2) || 0.5;
            p._bundleSyncedWeight = true;
          }
        }
      });
      log(`📦 기획세트 ${res.totalCodes || 0}개 로드`, 'ok');
    }
  } catch (e) {
    console.log('[QLens] 번들 로드 스킵:', e.message);
  }
}

async function saveBundleToSheet(qsmCode, components) {
  if (!_webhookUrl) { toast('webhook 설정 필요', 'err'); return false; }
  try {
    const res = await postToWebhook('LENS_BUNDLE_SAVE', { qsmCode, components });
    if (res.ok) {
      _bundlesMap[qsmCode] = components;
      // Items 측 메타 동기화
      const p = allProducts.find(x => x.code === qsmCode);
      if (p) {
        p.itemType = components.length > 0 ? 'bundle' : 'single';
        p.componentCount = components.length;
        if (components.length > 0) {
          const sumPrice = components.filter(c => !c.isFree).reduce((s,c) => s + (+c.price||0)*(+c.qty||1), 0);
          const sumWeight = components.reduce((s,c) => s + (+c.weight||0)*(+c.qty||1), 0);
          p.sourcePrice = sumPrice;
          p.weight = +sumWeight.toFixed(2) || 0.5;
          p._bundleSyncedPrice = true;
          p._bundleSyncedWeight = true;
        }
        _dirty.add(qsmCode);
      }
      _saveLocalCache().catch(() => {});  // ★ 구성품 목록을 캐시에도 반영
      return true;
    } else {
      toast('❌ 저장 실패: ' + (res.error || ''), 'err');
      return false;
    }
  } catch (e) {
    toast('❌ ' + e.message, 'err');
    return false;
  }
}

async function deleteBundleFromSheet(qsmCode) {
  if (!_webhookUrl) return false;
  const res = await postToWebhook('LENS_BUNDLE_DELETE', { qsmCode });
  if (res.ok) {
    delete _bundlesMap[qsmCode];
    const p = allProducts.find(x => x.code === qsmCode);
    if (p) { p.itemType = 'single'; p.componentCount = 0; }
    return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════
   ★ 번들 자식 행 렌더링 (펼침 시 표시)
══════════════════════════════════════════════════════ */
function renderBundleChildRows(qsmCode, components) {
  if (!components || !components.length) {
    return `<tr class="bundle-child-empty" data-parent="${qsmCode}">
      <td></td>
      <td colspan="13" style="padding:14px 20px;color:var(--text3);font-size:12px;background:rgba(31,41,55,.3)">
        <span style="margin-right:10px">📦 구성품이 없습니다</span>
        <button class="bundle-add-component" data-code="${qsmCode}" style="padding:5px 12px;border-radius:5px;background:var(--blue);border:none;color:#fff;font-size:11px;font-weight:700;cursor:pointer">+ 구성품 추가</button>
        <button class="bundle-convert-single" data-code="${qsmCode}" style="padding:5px 12px;border-radius:5px;background:transparent;border:1px solid var(--border);color:var(--text2);font-size:11px;font-weight:600;cursor:pointer;margin-left:6px">단품으로 변환</button>
      </td>
    </tr>`;
  }

  const totalPrice = components.filter(c => !c.isFree).reduce((s,c) => s + (+c.price||0)*(+c.qty||1), 0);
  const totalWeight = components.reduce((s,c) => s + (+c.weight||0)*(+c.qty||1), 0);

  const childRows = components.map((c, idx) => {
    const subtotal = (+c.price||0) * (+c.qty||1);
    const siteIcon = (c.site||'').includes('올리브영') ? '🌿'
                   : (c.site||'').includes('네이버')  ? '🟢'
                   : (c.site||'').includes('쿠팡')   ? '🛒'
                   : (c.site||'').includes('컬리')   ? '🟣'
                   : '🔗';
    return `<tr class="bundle-child-row" data-parent="${qsmCode}" data-idx="${idx}">
      <td></td>
      <td style="padding:8px 12px 8px 32px;background:rgba(31,41,55,.25)">
        <div style="font-size:9px;color:var(--text3);font-weight:700;margin-bottom:2px">└ 구성품 #${idx+1}${c.isFree?' · 증정':''}</div>
        <div style="font-size:12px;color:var(--text);font-weight:600;line-height:1.3">${c.name||'(이름 없음)'}</div>
        ${c.memo ? `<div style="font-size:10px;color:var(--text3);margin-top:2px">${c.memo}</div>` : ''}
      </td>
      <td style="background:rgba(31,41,55,.25)">
        <div style="font-size:11px">${siteIcon} ${c.site||'-'}</div>
        ${c.url ? `<a href="${c.url}" target="_blank" style="font-size:10px;color:var(--blue);text-decoration:none">↗ 원본보기</a>` : ''}
      </td>
      <td class="td-right" style="background:rgba(31,41,55,.25)">
        <div style="font-family:var(--mono);font-size:12px;font-weight:700;color:${c.isFree?'var(--text3)':'var(--text)'}">₩${Math.round(c.price||0).toLocaleString()}</div>
        ${c.qty > 1 ? `<div style="font-size:9px;color:var(--text3)">× ${c.qty} = ₩${subtotal.toLocaleString()}</div>` : ''}
        ${c.isFree ? '<div style="font-size:9px;color:var(--orange);font-weight:600">증정 (제외)</div>' : ''}
      </td>
      <td class="td-center" style="background:rgba(31,41,55,.25)">
        <div style="font-family:var(--mono);font-size:11px">${(+c.weight||0).toFixed(2)}<span style="font-size:9px;color:var(--text3)">kg</span></div>
      </td>
      <td colspan="8" style="background:rgba(31,41,55,.25);padding:8px 12px">
        <div style="display:flex;gap:6px;align-items:center;justify-content:flex-end">
          <button class="bundle-child-edit" data-code="${qsmCode}" data-idx="${idx}" style="padding:5px 10px;border-radius:5px;background:var(--bg3);border:1px solid var(--border);color:var(--text);font-size:11px;font-weight:600;cursor:pointer">✏️ 편집</button>
          <button class="bundle-child-delete" data-code="${qsmCode}" data-idx="${idx}" style="padding:5px 10px;border-radius:5px;background:transparent;border:1px solid var(--red);color:var(--red);font-size:11px;font-weight:600;cursor:pointer">🗑️</button>
        </div>
      </td>
      <td colspan="2" style="background:rgba(31,41,55,.25)"></td>
    </tr>`;
  }).join('');

  // 마지막 합계 + 추가 버튼 행
  const footerRow = `<tr class="bundle-child-footer" data-parent="${qsmCode}">
    <td></td>
    <td colspan="2" style="padding:10px 12px 12px 32px;background:rgba(31,41,55,.4);font-size:11px;color:var(--text2);font-weight:700">
      📦 ${components.length}개 구성품 · 합계
    </td>
    <td class="td-right" style="background:rgba(31,41,55,.4);padding:10px 8px">
      <div style="font-family:var(--mono);font-size:13px;font-weight:800;color:var(--green)">₩${totalPrice.toLocaleString()}</div>
      <div style="font-size:9px;color:var(--text3)">(증정 제외)</div>
    </td>
    <td class="td-center" style="background:rgba(31,41,55,.4)">
      <div style="font-family:var(--mono);font-size:12px;font-weight:700">${totalWeight.toFixed(2)}<span style="font-size:9px;color:var(--text3)">kg</span></div>
    </td>
    <td colspan="7" style="background:rgba(31,41,55,.4);padding:10px 12px">
      <div style="display:flex;gap:6px;align-items:center;justify-content:flex-end">
        <button class="bundle-add-component" data-code="${qsmCode}" style="padding:6px 14px;border-radius:5px;background:var(--blue);border:none;color:#fff;font-size:11px;font-weight:700;cursor:pointer">+ 구성품 추가</button>
        <button class="bundle-convert-single" data-code="${qsmCode}" style="padding:6px 14px;border-radius:5px;background:transparent;border:1px solid var(--border);color:var(--text2);font-size:11px;font-weight:600;cursor:pointer">단품으로 변환</button>
      </div>
    </td>
    <td colspan="2" style="background:rgba(31,41,55,.4)"></td>
  </tr>`;

  return childRows + footerRow;
}

/* ══════════════════════════════════════════════════════
   ★ 구성품 편집 모달 (추가/수정 공용)
══════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════
   ★ 일괄 기획 전환 모달 (v1.9.12)
   - 여러 상품을 한 번에 기획세트로 변경 (기본 1개 구성품, 메인 상품 정보 자동)
   - 사용자는 각 행별로 펼쳐서 추가 구성품 입력 가능
══════════════════════════════════════════════════════ */
function openBulkBundleConvertModal(targets) {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = `📦 ${targets.length}개 상품을 기획세트로 전환`;
  document.getElementById('modalBody').innerHTML = `
    <div style="font-size:12px;color:var(--text2);margin-bottom:12px;padding:10px 14px;background:rgba(124,58,237,.1);border-left:3px solid #a855f7;border-radius:5px;line-height:1.6">
      💡 선택된 <strong style="color:var(--text)">${targets.length}개</strong> 상품을 일괄로 기획세트로 전환합니다.<br>
      각 상품의 기존 소싱 정보(상품명/URL/가격/무게)가 <strong style="color:#a855f7">구성품 #1</strong>로 자동 등록됩니다.<br>
      추가 구성품은 전환 완료 후 각 상품의 행을 펼쳐 입력하세요.
    </div>
    <div style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg2)">
      ${targets.map((t, i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-bottom:1px solid var(--border);font-size:12px">
          <div style="font-size:10px;color:var(--text3);min-width:30px">${i+1}.</div>
          <div style="flex:1">
            <div style="font-weight:700;color:var(--text)">${(t.sellerCode || t.name || '').slice(0,60)}</div>
            <div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-top:2px">${t.code}</div>
          </div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--text2)">₩${(t.sourcePrice||0).toLocaleString()}</div>
        </div>
      `).join('')}
    </div>
    <div style="margin-top:12px;padding:10px 14px;background:var(--bg3);border-radius:6px;font-size:11.5px;color:var(--text2);line-height:1.6">
      ⚠️ 전환 후엔 각 상품이 <strong style="color:#a855f7">기획세트</strong>로 표시되며, 펼쳐서 추가 구성품을 입력할 수 있습니다.<br>
      되돌리려면 [단품으로 변환] 버튼을 사용하세요.
    </div>
  `;
  document.getElementById('modalPreview').style.display = 'none';

  const okBtn = document.getElementById('modalOk');
  okBtn.className = 'modal-btn confirm';
  okBtn.style.background = 'linear-gradient(135deg,#7c3aed,#a855f7)';
  okBtn.textContent = `✅ ${targets.length}개 전환`;
  modal.classList.add('show');

  okBtn.onclick = async () => {
    okBtn.disabled = true;
    let ok = 0, fail = 0;
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      okBtn.textContent = `⏳ ${i+1}/${targets.length} 처리 중...`;
      const components = [{
        name: p.sellerCode || p.name || p.code,
        site: p.sourcingSite || '',
        url:  p.sourceUrl || '',
        price: +p.sourcePrice || 0,
        weight: +p.weight || 0,
        qty: 1,
        isFree: false,
        memo: '메인 상품 (일괄 전환)',
      }];
      try {
        const success = await saveBundleToSheet(p.code, components);
        if (success) {
          ok++;
          _expandedBundles.add(p.code);  // 자동 펼침으로 추가 입력 유도
        } else fail++;
      } catch (e) { fail++; }
      // 부담 줄이기
      if (i % 5 === 4) await new Promise(r => setTimeout(r, 100));
    }
    okBtn.disabled = false;
    okBtn.textContent = `✅ ${targets.length}개 전환`;
    modal.classList.remove('show');
    toast(`✅ ${ok}개 전환 완료${fail ? ` (실패 ${fail})` : ''}`, fail ? 'warn' : 'ok');
    log(`📦 일괄 기획 전환: 성공 ${ok}개 / 실패 ${fail}개`, 'ok');
    renderTable(); updateSummary();
  };
  document.getElementById('modalCancel').onclick = () => modal.classList.remove('show');
}

/* ══════════════════════════════════════════════════════
   ★ 단품 → 기획세트 전환 모달 (v1.9.12)
   - 여러 구성품을 한 번에 입력 (행 추가/삭제 가능)
   - 첫 번째 구성품에 기존 상품의 소싱처/URL/가격 자동 채움
══════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════
   ★ v1.9.19 — 소싱 URL 수정 모달 (컴팩트 컬럼화)
══════════════════════════════════════════════════════ */
function openUrlEditModal(qsmCode, currentUrl) {
  const p = allProducts.find(x => x.code === qsmCode);
  if (!p) return;

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '🔗 소싱 URL 수정';
  document.getElementById('modalBody').innerHTML = `
    <div style="font-size:12px;color:var(--text2);margin-bottom:12px;line-height:1.6">
      <div style="margin-bottom:6px"><strong style="color:var(--text)">${p.sellerCode || p.name || qsmCode}</strong></div>
      <div style="font-size:11px;color:var(--text3);font-family:var(--mono)">${qsmCode}</div>
    </div>
    <label style="display:block;font-size:11px;color:var(--text2);font-weight:600;margin-bottom:6px">소싱 URL</label>
    <input id="urlEditInput" type="text" value="${(currentUrl || '').replace(/"/g, '&quot;')}"
           placeholder="https://www.oliveyoung.co.kr/..."
           style="width:100%;padding:10px 12px;background:var(--bg);border:1.5px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;font-family:var(--mono)">
    <div style="margin-top:10px;padding:10px 14px;background:var(--bg3);border-radius:6px;font-size:11px;color:var(--text2);line-height:1.6">
      💡 URL 변경 시 자동으로 소싱처(올리브영/네이버/쿠팡 등)가 감지됩니다.<br>
      비워두고 저장하면 URL이 삭제됩니다.
    </div>
  `;
  document.getElementById('modalPreview').style.display = 'none';

  const okBtn = document.getElementById('modalOk');
  okBtn.className = 'modal-btn confirm';
  okBtn.style.background = 'linear-gradient(135deg,#1a73e8,#4f9eff)';
  okBtn.textContent = '✅ 저장';
  modal.classList.add('show');

  setTimeout(() => {
    const inp = document.getElementById('urlEditInput');
    inp?.focus();
    inp?.select();
  }, 50);

  // Enter 키로 저장
  document.getElementById('urlEditInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
  });

  okBtn.onclick = () => {
    const newUrl = document.getElementById('urlEditInput').value.trim();
    const oldUrl = p.sourceUrl || '';
    if (newUrl === oldUrl) { modal.classList.remove('show'); return; }
    pushUndo(qsmCode, 'sourceUrl', oldUrl, newUrl, '소싱 URL 수정');
    p.sourceUrl = newUrl;
    // 소싱처 자동 감지
    if (newUrl) {
      const host = (() => { try { return new URL(newUrl).hostname; } catch { return ''; } })().replace('www.', '');
      if (host.includes('oliveyoung'))      p.sourcingSite = '올리브영';
      else if (host.includes('naver'))      p.sourcingSite = '네이버';
      else if (host.includes('coupang'))    p.sourcingSite = '쿠팡';
      else if (host.includes('kurly'))      p.sourcingSite = '마켓컬리';
      else if (host.includes('musinsa'))    p.sourcingSite = '무신사';
      else if (host.includes('daiso'))      p.sourcingSite = '다이소';
      else if (host.includes('themedicube')) p.sourcingSite = '메디큐브';
    }
    _dirty.add(qsmCode);
    modal.classList.remove('show');
    toast('✅ URL 저장됨 (시트 저장 필요)', 'ok');
    renderTable(); updateSummary();
  };
  document.getElementById('modalCancel').onclick = () => modal.classList.remove('show');
}

// ★ 소싱페이지 ↗ — 분할 보기(Split View) 만드는 법 안내 모달
//   반환: true=소싱페이지 열기 진행 / false=취소
function showSplitGuideModal() {
  return new Promise(resolve => {
    const modal = document.getElementById('modal');
    document.getElementById('modalTitle').textContent = '🪟 소싱페이지를 큐렌즈 옆에 나란히 보기';
    document.getElementById('modalBody').innerHTML = `
      <div style="font-size:13px;line-height:1.7;color:var(--text)">
        크롬 <b>분할 보기(Split View)</b>로 한 번만 묶어두면, 이후 ↗ 버튼이
        <b>옆칸을 자동으로 갈아끼워서</b> 새 탭/창 없이 큐렌즈 옆에서 바로 확인할 수 있어요.
        <div style="margin-top:12px;padding:12px 14px;background:var(--bg3);border-radius:8px;font-size:12.5px;line-height:1.95">
          <b>방법 A — 탭 우클릭</b><br>
          잠시 후 열릴 <b>소싱 탭을 우클릭 → "새 분할 보기에 탭 추가"</b><br>
          <span style="color:var(--text3)">(또는 메뉴명이 "분할 화면" / "Split view"일 수 있어요)</span><br><br>
          <b>방법 B — 드래그</b><br>
          소싱 탭을 잡아 화면 <b>오른쪽 끝까지 드래그</b><br><br>
          → 큐렌즈와 <b>좌우로 나란히</b> 배치되면 끝! 사이드패널도 함께 떠 있어요.
        </div>
        <div style="margin-top:10px;font-size:11px;color:var(--text3)">※ 크롬 140 버전 이상에서 지원됩니다. 메뉴가 없으면 크롬을 최신으로 업데이트하세요.</div>
        <label style="display:flex;align-items:center;gap:7px;margin-top:14px;font-size:12px;color:var(--text2);cursor:pointer">
          <input type="checkbox" id="splitGuideHide"> 다시 보지 않기
        </label>
      </div>`;
    document.getElementById('modalPreview').style.display = 'none';
    const okBtn = document.getElementById('modalOk');
    okBtn.className = 'modal-btn confirm';
    okBtn.style.background = 'linear-gradient(135deg,#1a73e8,#4f9eff)';
    okBtn.textContent = '🔗 소싱페이지 열기';
    modal.classList.add('show');
    okBtn.onclick = () => {
      if (document.getElementById('splitGuideHide')?.checked) {
        chrome.storage.local.set({ lensSplitGuideHide: true });
      }
      modal.classList.remove('show');
      resolve(true);
    };
    document.getElementById('modalCancel').onclick = () => {
      modal.classList.remove('show');
      resolve(false);
    };
  });
}

// ★ v1.9.29: 상품명(한국어/일본어) 수정 모달
//   한국어 상품명 = sellerCode(시트 C열), 일본어 상품명 = name(시트 D열)
function openNameEditModal(qsmCode) {
  const p = allProducts.find(x => x.code === qsmCode);
  if (!p) return;

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '✏️ 브랜드·상품명·수수료 수정';
  document.getElementById('modalBody').innerHTML = `
    <div style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-bottom:12px">상품코드 ${qsmCode}</div>
    <label style="display:block;font-size:11px;color:var(--text2);font-weight:600;margin-bottom:6px">🏷️ 브랜드명 <span style="color:var(--text3);font-weight:400">(시트 B열 · 일본어, 필터/검색 기준)</span></label>
    <input id="brandInput" type="text" value="${(p.brand || '').replace(/"/g, '&quot;')}"
           placeholder="例: トリデン / アヌア (큐텐 표기 브랜드명)"
           style="width:100%;padding:10px 12px;background:var(--bg);border:1.5px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;margin-bottom:14px">
    <label style="display:block;font-size:11px;color:var(--text2);font-weight:600;margin-bottom:6px">🇰🇷 한국어 상품명 <span style="color:var(--text3);font-weight:400">(시트 C열)</span></label>
    <input id="nameKoInput" type="text" value="${(p.sellerCode || '').replace(/"/g, '&quot;')}"
           placeholder="예: 토리든 다이브인 저분자 히알루론산 세럼"
           style="width:100%;padding:10px 12px;background:var(--bg);border:1.5px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;margin-bottom:14px">
    <label style="display:block;font-size:11px;color:var(--text2);font-weight:600;margin-bottom:6px">🇯🇵 일본어 상품명 <span style="color:var(--text3);font-weight:400">(시트 D열)</span></label>
    <input id="nameJaInput" type="text" value="${(p.name || '').replace(/"/g, '&quot;')}"
           placeholder="例: トリデン ダイブイン セラム"
           style="width:100%;padding:10px 12px;background:var(--bg);border:1.5px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;margin-bottom:14px">
    <label style="display:block;font-size:11px;color:var(--text2);font-weight:600;margin-bottom:6px">📊 큐텐 수수료율(%) <span style="color:var(--text3);font-weight:400">(비우면 기본 ${getRates().qFeeRate}% · 정산CSV로 자동입력 가능)</span></label>
    <input id="qFeeRateInput" type="number" step="0.1" min="0" max="30" value="${p.qFeeRate || ''}"
           placeholder="${getRates().qFeeRate}"
           style="width:100%;padding:10px 12px;background:var(--bg);border:1.5px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">
    <div style="margin-top:10px;padding:10px 14px;background:var(--bg3);border-radius:6px;font-size:11px;color:var(--text2);line-height:1.6">
      💡 저장 후 <strong>[💾 저장+QSM반영]</strong> 또는 <strong>[📤 시트에 저장]</strong>으로 시트에 반영하세요.
    </div>
  `;
  document.getElementById('modalPreview').style.display = 'none';

  const okBtn = document.getElementById('modalOk');
  okBtn.className = 'modal-btn confirm';
  okBtn.style.background = 'linear-gradient(135deg,#1a73e8,#4f9eff)';
  okBtn.textContent = '✅ 저장';
  modal.classList.add('show');

  setTimeout(() => { const inp = document.getElementById('brandInput'); inp?.focus(); inp?.select(); }, 50);

  okBtn.onclick = () => {
    const newBrand = document.getElementById('brandInput').value.trim();
    const newKo = document.getElementById('nameKoInput').value.trim();
    const newJa = document.getElementById('nameJaInput').value.trim();
    const feeStr = document.getElementById('qFeeRateInput').value.trim();
    const newFee = feeStr === '' ? '' : (+feeStr || '');
    const oldBrand = p.brand || '';
    const oldKo = p.sellerCode || '';
    const oldJa = p.name || '';
    const oldFee = p.qFeeRate || '';
    let changed = false;
    if (newBrand !== oldBrand) { pushUndo(qsmCode, 'brand', oldBrand, newBrand, '브랜드명 수정'); p.brand = newBrand; changed = true; }
    if (newKo !== oldKo) { pushUndo(qsmCode, 'sellerCode', oldKo, newKo, '한국어 상품명 수정'); p.sellerCode = newKo; changed = true; }
    if (newJa !== oldJa) { pushUndo(qsmCode, 'name', oldJa, newJa, '일본어 상품명 수정'); p.name = newJa; changed = true; }
    if (newFee !== oldFee) {
      pushUndo(qsmCode, 'qFeeRate', oldFee, newFee, '수수료율(%) 수정'); p.qFeeRate = newFee; changed = true;
      // ★ 수수료율은 추천가에 반영되므로 basePrice 재계산
      const r = getRates();
      p.basePrice = calcBasePrice(p.sourcePrice, p.shipFee, p.marginRate, rateFor(p, r), p.customerShipJpy);
    }
    modal.classList.remove('show');
    if (changed) {
      _dirty.add(qsmCode);
      toast('✅ 저장됨 (시트 저장 필요)', 'ok');
      applyFilter(); updateSummary();   // ★ 브랜드/수수료 변경 시 필터·계산 갱신
    }
  };
  document.getElementById('modalCancel').onclick = () => modal.classList.remove('show');
}

function openBundleSetupModal(qsmCode) {
  const p = allProducts.find(x => x.code === qsmCode);
  if (!p) return;

  // 기존 데이터로 첫 구성품 prefill
  const initialComponents = [
    {
      name: p.sellerCode || p.name || '',
      site: p.sourcingSite || '',
      url:  p.sourceUrl || '',
      price: +p.sourcePrice || 0,
      weight: +p.weight || 0,
      qty: 1,
      isFree: false,
      memo: '메인 상품 (전환 자동 등록)',
    },
    { name:'', site:'', url:'', price:0, weight:0, qty:1, isFree:false, memo:'' },
  ];

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = `📦 기획세트로 전환 — ${p.sellerCode || p.name || qsmCode}`;

  const renderComponentRow = (c, idx) => `
    <div class="bs-row" data-idx="${idx}" style="display:grid;grid-template-columns:30px 1.6fr 100px 1.4fr 95px 75px 55px 60px 32px;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:11px;color:var(--text3);text-align:center;font-weight:700">#${idx+1}</div>
      <input class="bs-name inline-input" placeholder="구성품명" value="${(c.name||'').replace(/"/g,'&quot;')}" style="font-size:12px;padding:6px">
      <select class="bs-site inline-input" style="font-size:11px;padding:6px">
        <option value="">소싱처</option>
        <option ${c.site==='올리브영'?'selected':''}>올리브영</option>
        <option ${c.site==='네이버'?'selected':''}>네이버</option>
        <option ${c.site==='쿠팡'?'selected':''}>쿠팡</option>
        <option ${c.site==='컬리'?'selected':''}>컬리</option>
        <option ${c.site==='무신사'?'selected':''}>무신사</option>
        <option ${c.site==='다이소'?'selected':''}>다이소</option>
        <option ${c.site && !['올리브영','네이버','쿠팡','컬리','무신사','다이소'].includes(c.site) ? 'selected':''}>${c.site && !['올리브영','네이버','쿠팡','컬리','무신사','다이소'].includes(c.site) ? c.site : '기타'}</option>
      </select>
      <input class="bs-url inline-input" placeholder="https://..." value="${(c.url||'').replace(/"/g,'&quot;')}" style="font-size:11px;padding:6px">
      <input type="number" class="bs-price inline-input" placeholder="가격₩" value="${c.price||''}" min="0" step="100" style="font-size:11px;padding:6px;text-align:right;font-family:var(--mono)">
      <input type="number" class="bs-weight inline-input" placeholder="kg" value="${c.weight||''}" min="0" step="0.1" max="30" style="font-size:11px;padding:6px;text-align:right;font-family:var(--mono)">
      <input type="number" class="bs-qty inline-input" value="${c.qty||1}" min="1" step="1" style="font-size:11px;padding:6px;text-align:center;font-family:var(--mono)">
      <label style="display:flex;align-items:center;justify-content:center;cursor:pointer" title="증정품"><input type="checkbox" class="bs-free" ${c.isFree?'checked':''}></label>
      <button class="bs-delete" type="button" title="삭제" style="background:transparent;border:1px solid var(--border);color:var(--red);font-size:14px;cursor:pointer;border-radius:4px;padding:3px 6px">✕</button>
    </div>
  `;

  let currentComponents = initialComponents.slice();

  const renderAll = () => {
    document.getElementById('modalBody').innerHTML = `
      <div style="font-size:12px;color:var(--text2);margin-bottom:10px;padding:8px 12px;background:rgba(124,58,237,.1);border-left:3px solid #a855f7;border-radius:5px">
        💡 이 상품(<strong style="color:var(--text)">${qsmCode}</strong>)을 <strong style="color:#a855f7">기획세트</strong>로 등록합니다.<br>
        기존 소싱 정보가 <strong>구성품 #1</strong>에 자동으로 들어가 있습니다. 추가 구성품을 입력하세요.
      </div>
      <div style="display:grid;grid-template-columns:30px 1.6fr 100px 1.4fr 95px 75px 55px 60px 32px;gap:6px;padding:8px 0 4px 0;font-size:10px;color:var(--text3);font-weight:700;border-bottom:1.5px solid var(--border);text-align:center">
        <div>#</div><div style="text-align:left;padding-left:6px">구성품명</div><div>소싱처</div><div style="text-align:left;padding-left:6px">URL</div><div>가격(₩)</div><div>무게(kg)</div><div>수량</div><div>증정</div><div></div>
      </div>
      <div id="bsRows" style="max-height:340px;overflow-y:auto">
        ${currentComponents.map((c, i) => renderComponentRow(c, i)).join('')}
      </div>
      <button id="bsAddRow" type="button" style="margin-top:10px;padding:8px 14px;border-radius:6px;background:transparent;border:1px dashed var(--blue);color:var(--blue);font-size:12px;font-weight:600;cursor:pointer;width:100%">+ 구성품 행 추가</button>
      <div style="margin-top:10px;padding:8px 12px;background:var(--bg3);border-radius:6px;font-size:11px;color:var(--text2);display:flex;justify-content:space-between">
        <span>구성품: <strong id="bsCount" style="color:var(--text)">${currentComponents.length}</strong>개</span>
        <span>합계: <strong id="bsTotal" style="color:var(--green);font-family:var(--mono)">₩0</strong> · <strong id="bsTotalWeight" style="color:var(--text);font-family:var(--mono)">0kg</strong></span>
      </div>
    `;

    bindRowEvents();
    updateBsSummary();
  };

  const collectFromDOM = () => {
    const rows = document.querySelectorAll('.bs-row');
    const list = [];
    rows.forEach(row => {
      list.push({
        name:   row.querySelector('.bs-name').value.trim(),
        site:   row.querySelector('.bs-site').value,
        url:    row.querySelector('.bs-url').value.trim(),
        price:  +row.querySelector('.bs-price').value || 0,
        weight: +row.querySelector('.bs-weight').value || 0,
        qty:    +row.querySelector('.bs-qty').value || 1,
        isFree: row.querySelector('.bs-free').checked,
        memo:   '',
      });
    });
    return list;
  };

  const updateBsSummary = () => {
    const list = collectFromDOM();
    const totalPrice  = list.filter(c => !c.isFree).reduce((s,c) => s + c.price * c.qty, 0);
    const totalWeight = list.reduce((s,c) => s + c.weight * c.qty, 0);
    document.getElementById('bsCount').textContent = list.length;
    document.getElementById('bsTotal').textContent = '₩' + totalPrice.toLocaleString();
    document.getElementById('bsTotalWeight').textContent = totalWeight.toFixed(2) + 'kg';
  };

  const bindRowEvents = () => {
    document.querySelectorAll('.bs-row').forEach(row => {
      row.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('input',  updateBsSummary);
        el.addEventListener('change', updateBsSummary);
      });
      row.querySelector('.bs-delete')?.addEventListener('click', () => {
        if (document.querySelectorAll('.bs-row').length <= 1) {
          toast('최소 1개 구성품이 필요합니다', 'err'); return;
        }
        // 현재 상태 수집 → 해당 행 제외 → 재렌더
        const idx = +row.dataset.idx;
        currentComponents = collectFromDOM().filter((_, i) => i !== idx);
        renderAll();
      });
    });
    document.getElementById('bsAddRow')?.addEventListener('click', () => {
      currentComponents = collectFromDOM();
      currentComponents.push({ name:'', site:'', url:'', price:0, weight:0, qty:1, isFree:false, memo:'' });
      renderAll();
    });
  };

  renderAll();
  document.getElementById('modalPreview').style.display = 'none';

  const okBtn = document.getElementById('modalOk');
  okBtn.className = 'modal-btn confirm';
  okBtn.style.background = 'linear-gradient(135deg,#7c3aed,#a855f7)';
  okBtn.textContent = '✅ 기획세트로 저장';
  modal.classList.add('show');

  okBtn.onclick = async () => {
    const list = collectFromDOM().filter(c => c.name); // 이름 없는 행 제외
    if (list.length < 1) {
      toast('구성품을 최소 1개 입력하세요', 'err'); return;
    }
    okBtn.disabled = true;
    okBtn.textContent = '⏳ 저장 중...';
    const ok = await saveBundleToSheet(qsmCode, list);
    okBtn.disabled = false;
    okBtn.textContent = '✅ 기획세트로 저장';
    if (ok) {
      modal.classList.remove('show');
      _expandedBundles.add(qsmCode);  // 펼침 상태 유지
      toast(`✅ ${qsmCode} 기획세트 등록 완료 (구성품 ${list.length}개)`, 'ok');
      log(`📦 ${qsmCode} 기획세트 전환: ${list.length}개 구성품`, 'ok');
      renderTable(); updateSummary();
    }
  };
  document.getElementById('modalCancel').onclick = () => modal.classList.remove('show');
}

function openBundleComponentEditor(qsmCode, idx) {
  const isNew = idx < 0;
  const comps = _bundlesMap[qsmCode] || [];
  const c = isNew ? { name:'', site:'', url:'', price:0, weight:0, qty:1, isFree:false, memo:'' } : { ...comps[idx] };
  if (!c) return;

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = `📦 구성품 ${isNew ? '추가' : '편집'}`;
  document.getElementById('modalBody').innerHTML = `
    <div style="display:grid;grid-template-columns:auto 1fr;gap:10px 14px;align-items:center;font-size:12.5px">
      <label style="color:var(--text2);font-weight:600">구성품명</label>
      <input id="bcInpName" type="text" value="${(c.name||'').replace(/"/g,'&quot;')}" placeholder="예: 독도 토너 200ml" class="inline-input" style="padding:8px;font-size:13px;text-align:left">
      <label style="color:var(--text2);font-weight:600">소싱처</label>
      <select id="bcInpSite" class="inline-input" style="padding:8px;font-size:13px;text-align:left">
        <option value="">선택...</option>
        <option ${c.site==='올리브영'?'selected':''}>올리브영</option>
        <option ${c.site==='네이버'?'selected':''}>네이버</option>
        <option ${c.site==='쿠팡'?'selected':''}>쿠팡</option>
        <option ${c.site==='컬리'?'selected':''}>컬리</option>
        <option ${c.site==='무신사'?'selected':''}>무신사</option>
        <option ${c.site==='다이소'?'selected':''}>다이소</option>
        <option ${c.site && !['올리브영','네이버','쿠팡','컬리','무신사','다이소'].includes(c.site) ? 'selected' : ''}>${c.site && !['올리브영','네이버','쿠팡','컬리','무신사','다이소'].includes(c.site) ? c.site : '기타'}</option>
      </select>
      <label style="color:var(--text2);font-weight:600">소싱 URL</label>
      <input id="bcInpUrl" type="text" value="${(c.url||'').replace(/"/g,'&quot;')}" placeholder="https://..." class="inline-input" style="padding:8px;font-size:13px;text-align:left">
      <label style="color:var(--text2);font-weight:600">가격(₩)</label>
      <input id="bcInpPrice" type="number" value="${c.price||0}" min="0" step="100" class="inline-input" style="padding:8px;font-size:13px;text-align:right;font-family:var(--mono)">
      <label style="color:var(--text2);font-weight:600">무게(kg)</label>
      <input id="bcInpWeight" type="number" value="${c.weight||0}" min="0" step="0.1" max="30" class="inline-input" style="padding:8px;font-size:13px;text-align:right;font-family:var(--mono)">
      <label style="color:var(--text2);font-weight:600">수량</label>
      <input id="bcInpQty" type="number" value="${c.qty||1}" min="1" step="1" class="inline-input" style="padding:8px;font-size:13px;text-align:right;font-family:var(--mono)">
      <label style="color:var(--text2);font-weight:600">증정품</label>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input id="bcInpFree" type="checkbox" ${c.isFree?'checked':''}> <span style="font-size:12px;color:var(--text2)">가격 합산에서 제외 (증정/사은품)</span></label>
      <label style="color:var(--text2);font-weight:600">메모</label>
      <input id="bcInpMemo" type="text" value="${(c.memo||'').replace(/"/g,'&quot;')}" placeholder="선택" class="inline-input" style="padding:8px;font-size:13px;text-align:left">
    </div>
  `;
  document.getElementById('modalPreview').style.display = 'none';

  const okBtn = document.getElementById('modalOk');
  okBtn.className = 'modal-btn confirm';
  okBtn.style.background = 'linear-gradient(135deg,#1a73e8,#4f9eff)';
  okBtn.textContent = isNew ? '✅ 추가' : '✅ 저장';
  modal.classList.add('show');

  okBtn.onclick = async () => {
    const newComp = {
      name:   document.getElementById('bcInpName').value.trim(),
      site:   document.getElementById('bcInpSite').value,
      url:    document.getElementById('bcInpUrl').value.trim(),
      price:  +document.getElementById('bcInpPrice').value || 0,
      weight: +document.getElementById('bcInpWeight').value || 0,
      qty:    +document.getElementById('bcInpQty').value || 1,
      isFree: document.getElementById('bcInpFree').checked,
      memo:   document.getElementById('bcInpMemo').value.trim(),
    };
    if (!newComp.name) { toast('구성품명을 입력하세요', 'err'); return; }
    const updated = comps.slice();
    if (isNew) updated.push(newComp);
    else updated[idx] = newComp;
    const ok = await saveBundleToSheet(qsmCode, updated);
    if (ok) {
      modal.classList.remove('show');
      toast(`✅ 구성품 ${isNew?'추가':'수정'} 완료`, 'ok');
      _expandedBundles.add(qsmCode);  // 펼친 상태 유지
      renderTable(); updateSummary();
    }
  };
  document.getElementById('modalCancel').onclick = () => modal.classList.remove('show');
}

/* ══════════════════════════════════════════════════════
   ★ Undo/Redo 시스템 (v1.8.9)
   - 인라인 편집 시 이전 값을 스택에 저장
   - Ctrl+Z / Cmd+Z 단축키, [↶ 되돌리기] 버튼 지원
   - 최대 50개 기록 유지 (오래된 것부터 제거)
══════════════════════════════════════════════════════ */
const UNDO_MAX = 50;
let _undoStack = [];  // [{code, field, oldValue, newValue, ts, label}]
let _redoStack = [];  // 되돌린 항목 (다시하기 가능)

function pushUndo(code, field, oldValue, newValue, label) {
  // ★ 같은 셀의 연속 편집은 마지막 항목만 갱신 (디바운스 1초)
  const last = _undoStack[_undoStack.length - 1];
  if (last && last.code === code && last.field === field && (Date.now() - last.ts) < 1000) {
    last.newValue = newValue;
    last.ts = Date.now();
  } else {
    _undoStack.push({ code, field, oldValue, newValue, ts: Date.now(), label });
    if (_undoStack.length > UNDO_MAX) _undoStack.shift();
  }
  _redoStack.length = 0;  // 새 변경 시 redo 히스토리 초기화
  updateUndoButton();
}

function applyUndo(entry) {
  const it = allProducts.find(x => x.code === entry.code);
  if (!it) return false;
  it[entry.field] = entry.oldValue;
  if (['sourcePrice','shipFee','marginRate','curPrice','weight','customerShipJpy','qFeeRate'].includes(entry.field)) {
    const r = getRates();
    it.basePrice = calcBasePrice(it.sourcePrice, it.shipFee, it.marginRate, rateFor(it, r), it.customerShipJpy);
  }
  return true;
}

function applyRedo(entry) {
  const it = allProducts.find(x => x.code === entry.code);
  if (!it) return false;
  it[entry.field] = entry.newValue;
  if (['sourcePrice','shipFee','marginRate','curPrice','weight','customerShipJpy','qFeeRate'].includes(entry.field)) {
    const r = getRates();
    it.basePrice = calcBasePrice(it.sourcePrice, it.shipFee, it.marginRate, rateFor(it, r), it.customerShipJpy);
  }
  return true;
}

function doUndo() {
  if (_undoStack.length === 0) {
    toast('되돌릴 변경사항이 없습니다', 'info');
    return;
  }
  const entry = _undoStack.pop();
  if (applyUndo(entry)) {
    _redoStack.push(entry);
    renderTable();
    updateSummary();
    updateUndoButton();
    const it = allProducts.find(x => x.code === entry.code);
    const shortName = it ? (it.brand ? it.brand + ' ' : '') + (it.name || '').slice(0, 20) : entry.code;
    const oldDisp = typeof entry.oldValue === 'number' ? entry.oldValue.toLocaleString() : entry.oldValue;
    toast(`↶ ${shortName}: ${entry.label} → ${oldDisp}`, 'ok');
  }
}

function doRedo() {
  if (_redoStack.length === 0) {
    toast('다시 적용할 항목이 없습니다', 'info');
    return;
  }
  const entry = _redoStack.pop();
  if (applyRedo(entry)) {
    _undoStack.push(entry);
    renderTable();
    updateSummary();
    updateUndoButton();
    const it = allProducts.find(x => x.code === entry.code);
    const shortName = it ? (it.brand ? it.brand + ' ' : '') + (it.name || '').slice(0, 20) : entry.code;
    const newDisp = typeof entry.newValue === 'number' ? entry.newValue.toLocaleString() : entry.newValue;
    toast(`↷ ${shortName}: ${entry.label} → ${newDisp}`, 'ok');
  }
}

function updateUndoButton() {
  const btnU = document.getElementById('btnUndo');
  const btnR = document.getElementById('btnRedo');
  if (btnU) {
    btnU.disabled = _undoStack.length === 0;
    btnU.title = _undoStack.length === 0
      ? '되돌릴 항목 없음'
      : `↶ 되돌리기 (${_undoStack.length}개) — Ctrl+Z`;
    const countEl = btnU.querySelector('.undo-count');
    if (countEl) countEl.textContent = _undoStack.length || '';
  }
  if (btnR) {
    btnR.disabled = _redoStack.length === 0;
    btnR.title = _redoStack.length === 0
      ? '다시 적용할 항목 없음'
      : `↷ 다시하기 (${_redoStack.length}개) — Ctrl+Shift+Z`;
  }
}

/* ══════════════════════════════════════════════════════
   Google Sheets 연동
══════════════════════════════════════════════════════ */
async function loadWebhookUrl() {
  // 우선순위: lensSheetsWebhookUrl → Q10 Auto에서 가져오기
  const local = await storageGet(['lensSheetsWebhookUrl']);
  if (local.lensSheetsWebhookUrl) {
    _webhookUrl = local.lensSheetsWebhookUrl;
    return _webhookUrl;
  }

  // Q10 Auto에 webhook URL 요청 (externally_connectable)
  const ext = await storageGet(['lensQ10AutoExtId']);
  if (ext.lensQ10AutoExtId) {
    try {
      const res = await new Promise(r =>
        chrome.runtime.sendMessage(ext.lensQ10AutoExtId, { type: 'Q10_GET_WEBHOOK_URL' }, res => {
          if (chrome.runtime.lastError) r(null);
          else r(res);
        })
      );
      if (res?.ok && res.sheetsWebhookUrl) {
        _webhookUrl = res.sheetsWebhookUrl;
        await storageSet({ lensSheetsWebhookUrl: _webhookUrl, lensSheetsId: res.sheetsId });
        return _webhookUrl;
      }
    } catch (e) {
      console.warn('[QLens] Q10 Auto webhook 가져오기 실패:', e.message);
    }
  }
  return null;
}

async function updateSheetStatus() {
  const lbl = document.getElementById('sheetLabel');
  const sub = document.getElementById('sheetSub');
  const link = document.getElementById('sheetLink');
  const btnConn = document.getElementById('btnSheetConnect');
  const ssBar  = document.getElementById('sheetStatus');

  const url = await loadWebhookUrl();
  if (url) {
    lbl.textContent  = '✅ Google Sheets 연결됨';
    sub.textContent  = 'Q10 Auto 시트의 [QSM_Lens_Items] 탭에 자동 동기화';
    btnConn.style.display = 'none';
    ssBar.style.background = 'linear-gradient(90deg, var(--sheet-lt) 0%, var(--bg2) 100%)';
    const d = await storageGet(['lensSheetsId']);
    if (d.lensSheetsId) {
      link.href = `https://docs.google.com/spreadsheets/d/${d.lensSheetsId}/edit`;
      link.style.display = 'inline';
    }
    document.getElementById('btnSheetLoad').disabled = false;
    document.getElementById('btnSheetSave').disabled = false;
  } else {
    lbl.textContent = '⚠️ Google Sheets 미연결';
    sub.textContent = 'Q10 Auto의 webhook을 자동으로 가져오거나, Apps Script 설정이 필요합니다';
    btnConn.style.display = 'inline-flex';
    document.getElementById('btnSheetLoad').disabled = true;
    document.getElementById('btnSheetSave').disabled = true;
  }
}

async function postToWebhook(action, payload = {}) {
  if (!_webhookUrl) throw new Error('Google Sheets webhook 미설정');

  // service_worker 경유로 fetch (CORS/302 리다이렉트 안전 처리)
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error('webhook 응답 타임아웃 (30초)')), 30000);
    chrome.runtime.sendMessage(
      { type: 'LENS_WEBHOOK_PROXY', url: _webhookUrl, body: { action, ...payload } },
      (res) => {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res) {
          reject(new Error('응답 없음 — 확장을 새로고침 후 재시도'));
          return;
        }
        if (res._fetchError) {
          reject(new Error(res._fetchError));
          return;
        }
        resolve(res);
      }
    );
  });
}

/* ════════════════════════════════════════════════════════════
   #4 사람이 읽을 수 있는 에러 + 해결법
   ════════════════════════════════════════════════════════════ */
function friendlyError(msg = '') {
  const m = String(msg || '');
  if (/-10000|Seller Authorization|인증키|cert/i.test(m))
    return { why: 'QSM 판매자 인증키(Cert Key)가 잘못되었습니다.', how: '설정(⚙️)에서 QSM API 인증키를 다시 확인해 등록하세요.' };
  if (/-90004|-90005|expired/i.test(m))
    return { why: 'QSM 인증키가 만료되었습니다.', how: 'QSM 판매자센터에서 새 인증키를 발급받아 설정에 등록하세요.' };
  if (/-90001|API does not exist/i.test(m))
    return { why: '요청한 QSM API가 존재하지 않습니다.', how: '확장프로그램을 최신 버전으로 업데이트하세요.' };
  if (/-90002|-90003|not authorized/i.test(m))
    return { why: '이 API에 대한 권한이 없습니다.', how: 'QSM 판매자센터에서 API 사용 권한을 확인하세요.' };
  if (/webhook|시트 연결|lensSheetsWebhookUrl/i.test(m))
    return { why: 'Google Sheets가 연결되지 않았습니다.', how: '상단 [🔗 시트 연결]에 Apps Script 배포 URL(/exec)을 등록하세요.' };
  if (/Failed to fetch|NetworkError|network|timeout|시간 초과/i.test(m))
    return { why: 'Apps Script 서버에 연결하지 못했습니다.', how: '① 인터넷 연결 확인 ② Apps Script 배포가 "액세스: 모든 사용자"인지 확인 ③ /exec URL이 맞는지 확인하세요.' };
  if (/데이터 없음|데이터가 없|시트를 찾을 수 없|0개|empty/i.test(m))
    return { why: '시트에서 데이터를 찾지 못했습니다.', how: 'Apps Script를 [배포 관리 → 새 버전]으로 재배포했는지, 시트 탭 이름이 맞는지 확인하세요. (코드 저장만으로는 반영되지 않습니다)' };
  if (/SHEET_ID|openById/i.test(m))
    return { why: 'Apps Script가 가리키는 스프레드시트 ID가 잘못되었습니다.', how: 'Apps Script의 SHEET_ID 값을 현재 시트 URL의 ID로 맞추고 재배포하세요.' };
  return { why: m || '알 수 없는 오류가 발생했습니다.', how: '잠시 후 다시 시도하거나, F12 콘솔의 [QLens] 로그를 확인하세요.' };
}
function showError(title, rawMsg) {
  const f = friendlyError(rawMsg);
  log(`${title} — ${rawMsg || f.why}`, 'err');
  alert(`❌ ${title}\n\n● 원인: ${f.why}\n\n● 해결방법: ${f.how}`);
}

/* ════════════════════════════════════════════════════════════
   #1 브랜드명 조회 — GetItemDetailInfo의 BrandNo를
      CommonInfoLookup.SearchBrand 결과(M_B_NO→M_B_NM)와 매칭
   ════════════════════════════════════════════════════════════ */
function _brandKeyword(name) {
  if (!name) return '';
  let s = String(name).replace(/^\s*[\[【][^\]】]*[\]】]\s*/, '').trim();  // 앞 [태그] 제거
  const tok = (s.split(/[\s,\/·・]/)[0] || '').trim();
  return tok.length >= 2 ? tok.slice(0, 20) : '';
}
async function resolveBrandNames(silent = true) {
  const need = allProducts.filter(p => p.brandNo && !p.brand);
  if (!need.length) return 0;
  const byNo = {}, byKw = {};
  let filled = 0;
  for (let i = 0; i < need.length; i++) {
    const p = need[i];
    if (byNo[p.brandNo] !== undefined) { if (byNo[p.brandNo]) { p.brand = byNo[p.brandNo]; filled++; } continue; }
    const kw = _brandKeyword(p.seller || p.sellerCode || p.name);
    if (!kw) { byNo[p.brandNo] = ''; continue; }
    if (!silent) setOv(`브랜드명 조회 ${i + 1}/${need.length}`, 60 + (i / Math.max(need.length, 1)) * 15);
    let results = byKw[kw];
    if (!results) {
      try {
        const res = await qsmCall('CommonInfoLookup.SearchBrand', { keyword: kw });
        results = (res && res.ok && res.result) ? (Array.isArray(res.result) ? res.result : [res.result]) : [];
      } catch { results = []; }
      byKw[kw] = results;
      await new Promise(r => setTimeout(r, 50));
    }
    const hit = results.find(b => String(b.M_B_NO || '').trim() === p.brandNo);
    const nm = hit ? (hit.M_B_NM || hit.M_B_NM_EN || '') : '';
    byNo[p.brandNo] = nm;
    if (nm) { p.brand = nm; filled++; }
  }
  return filled;
}

/* ════════════════════════════════════════════════════════════
   #3 원클릭 전체 자동 동기화
      상품 불러오기 → 소싱 병합 → 브랜드 조회 → 배송비 → 요율체크 → 저장
   ════════════════════════════════════════════════════════════ */
// 웹훅이 실제로 보는 시트 상태 진단 → 콘솔/로그로 노출 (#2 원인 추적)
async function diagnoseSheets() {
  try {
    const d = await postToWebhook('LENS_DIAG');
    if (d && d.ok) {
      const s = d.sheets || {};
      log(`🩺 연결된 시트 "${d.spreadsheetName}" — Items:${s.QSM_Lens_Items} / Config:${s.QSM_Lens_Config} / Bundles:${s.QSM_Lens_Bundles} / ShipRates:${s.QSM_Lens_ShipRates}`, 'ok');
      return d;
    }
    // LENS_DIAG 자체가 실패 = 구버전 배포 가능성
    log('🩺 진단 실패 — Apps Script가 구버전일 수 있습니다(새 버전 재배포 필요)', 'warn');
    return null;
  } catch (e) { return null; }
}

async function autoSyncAll() {
  if (!_webhookUrl) { showError('시트가 연결되지 않았습니다', 'webhook'); return; }
  const btn = document.getElementById('btnAutoSync');
  if (btn) btn.disabled = true;
  try {
    showOv('전체 자동 동기화', '① 상품 → ② 브랜드 → ③ 배송비 → ④ 저장', 2);

    // 0) 연결 진단 — 웹훅이 메인 시트(QSM_Lens_Items)를 보는지 확인
    const diag = await diagnoseSheets();
    if (diag && diag.ok && diag.sheets &&
        (diag.sheets.QSM_Lens_Items === '시트없음')) {
      hideOv();
      alert('⚠️ QSM_Lens_Items 시트가 없습니다\n\n' +
        `현재 연결된 시트: "${diag.spreadsheetName}"\n\n` +
        '● 해결방법: 먼저 상단 [🔧 시트 자동 세팅]을 한 번 실행해 시트를 생성하세요.');
      if (btn) btn.disabled = false;
      return;
    }

    // ① QSM 상품 불러오기 (시트의 기존 수동값은 GAS가 보존)
    await loadProducts();

    // (v1.8.4: 소싱 시트 병합 단계 제거 — 사용자는 Items 시트에 직접 입력)

    // ③ 브랜드명 조회 (SearchBrand)
    try {
      setOv('브랜드명 조회 중...', 62);
      const n = await resolveBrandNames(false);
      log(`브랜드명 ${n}개 채움`, n ? 'ok' : 'warn');
    } catch (e) { log('브랜드 조회 건너뜀: ' + e.message, 'warn'); }

    // ④ 고객 배송비 동기화
    try { setOv('배송비 동기화 중...', 80); await syncCustomerShipFees(true); }
    catch (e) { log('배송비 동기화 건너뜀: ' + e.message, 'warn'); }

    // ⑤ 시트에 저장
    setOv('시트에 저장 중...', 92);
    await saveToSheet();

    // ⑥ 요율 CSV 점검 (손익의 배송비/포장비 계산에 필요)
    await checkAgencyRateCsv();

    applyFilter(); updateSummary();
    hideOv();
    toast('✅ 전체 자동 동기화 완료', 'ok');
  } catch (e) {
    hideOv();
    showError('자동 동기화 중 오류가 발생했습니다', e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 배대지 요율표(QSM_Lens_AgencyRate)가 비어 있으면 업로드 안내 팝업
async function checkAgencyRateCsv() {
  try {
    const res = await postToWebhook('LENS_AGENCY_RATE_LOAD');
    const rates = (res && res.ok && Array.isArray(res.rates)) ? res.rates : [];
    if (!rates.length) {
      alert('⚠️ 배대지 요율표가 비어 있습니다\n\n' +
        '● 영향: 주문별 손익의 "배송비·포장비"가 0원으로 계산됩니다.\n\n' +
        '● 해결방법: 상단 [📋 요율 CSV] 버튼을 눌러 배대지 요율표(무게 구간별 ₩)를 업로드하세요.');
      return false;
    }
    return true;
  } catch (e) { return true; }   // 점검 실패는 막지 않음
}

async function loadFromSheet() {
  if (!_webhookUrl) { toast('시트 webhook 설정 필요', 'err'); return; }
  showOv('시트에서 불러오는 중...', 'QSM_Lens_Items 시트 조회', 30);
  try {
    const res = await postToWebhook('LENS_LOAD');
    if (!res.ok) throw new Error(res.error || '시트 조회 실패');
    const sheetItems = res.items || [];
    if (allProducts.length === 0) {
      allProducts = sheetItems.map(s => ({
        code: s.code,
        seller: s.seller || s.sellerCode || '',
        sellerCode: s.seller || s.sellerCode || '',
        status: STATUS_CODE[s.status] || s.status || 'S2',
        name: s.name, brand: s.brand || '',
        sourcingSite: s.sourcingSite || detectSourcingSite({ sourceUrl: s.sourceUrl }),
        sourceUrl: s.sourceUrl, sourcePrice: s.sourcePrice,
        weight: s.weight || 0.5,
        carrier: s.carrier, marginRate: s.marginRate,
        qFeeRate: (+s.qFeeRate > 0) ? +s.qFeeRate : '',   // ★ AC열 상품별 수수료율
        basePrice: s.basePrice || s.basePriceJpy || 0,
        curPrice: s.curPrice, customerShipJpy: s.customerShipJpy || 0,
        memo: s.memo,
        // ★ shipFee: 1000 이상이면 구버전 ₩ → ¥ 자동 변환
        shipFee: s.shipFeeJpy > 0 ? s.shipFeeJpy
               : s.shipFee >= 1000 ? Math.round(s.shipFee / 9.5)
               : s.shipFee || 0,
      }));
    } else {
      const map = {};
      sheetItems.forEach(s => { map[s.code] = s; });
      allProducts.forEach(p => {
        const s = map[p.code];
        if (!s) return;
        if (s.name && (p.name?.startsWith('상품코드') || !p.name)) p.name = s.name;
        // ★ 한국어 상품명(sellerCode) 명시적 매핑 — 시트 C열 우선
        if (s.sellerCode || s.seller) p.sellerCode = s.sellerCode || s.seller;
        p.brand    = s.brand    || p.brand    || '';
        p.sourceUrl   = s.sourceUrl   || p.sourceUrl   || '';
        p.sourcePrice = s.sourcePrice || p.sourcePrice || 0;
        // ★ shipFee: 시트에서 ¥ 또는 ₩ 자동 판별
        const rawShip = s.shipFeeJpy || s.shipFee || 0;
        if (rawShip > 0) p.shipFee = rawShip >= 1000 ? Math.round(rawShip / 9.5) : rawShip;
        p.weight      = s.weight      || p.weight      || 0.5;
        p.carrier     = s.carrier     || p.carrier     || '';
        p.marginRate  = s.marginRate  || p.marginRate  || 0;
        // ★ 상품별 수수료율: 시트값 우선, 없으면 기존 화면값 유지
        if (+s.qFeeRate > 0) p.qFeeRate = +s.qFeeRate;
        p.customerShipJpy = s.customerShipJpy || p.customerShipJpy || 0;
        p.memo        = s.memo        || p.memo        || '';
        p.sourcingSite = s.sourcingSite || detectSourcingSite(p);
        if ((s.basePrice || s.basePriceJpy) && !p.basePrice) p.basePrice = s.basePrice || s.basePriceJpy;
      });
    }
    applyFilter(); updateSummary();
    toast(`✅ 시트에서 ${sheetItems.length}개 로드`, 'ok');
    log(`시트 로드: ${sheetItems.length}개`, 'ok');
    // ★ v1.9.11: 번들도 함께 로드
    try { await loadBundlesFromSheet(); applyFilter(); } catch(e) {}
  } catch(e) {
    toast('❌ '+e.message, 'err');
    log('시트 로드 실패: '+e.message, 'err');
  } finally { hideOv(); }
}

/* ══════════════════════════════════════════════════════
   시트 자동 세팅 — LENS_INIT_SHEETS
   QSM_Lens_Config + QSM_Lens_Items 시트를 수식/서식 포함 자동 생성
══════════════════════════════════════════════════════ */
async function initSheets() {
  if (!_webhookUrl) {
    toast('먼저 Apps Script를 설정하고 webhook URL을 연결해주세요', 'err');
    document.getElementById('appsScriptModal').classList.add('show');
    return;
  }
  showOv('시트 자동 세팅 중...', 'QSM_Lens_Config + QSM_Lens_Items 생성', 30);
  try {
    const res = await postToWebhook('LENS_INIT_SHEETS');
    console.log('[QLens] LENS_INIT_SHEETS 응답:', res);

    if (!res.ok) {
      // Apps Script가 lensInitSheets 함수가 없거나 구버전인 경우
      if (res.error?.includes('lensInitSheets is not defined') ||
          res.error?.includes('Unknown action')) {
        throw new Error('Apps Script 구버전입니다. 가이드의 최신 코드를 복사해서 붙여넣고 [새 배포] 해주세요');
      }
      throw new Error(res.error || res.msg || '시트 세팅 실패');
    }

    hideOv();
    // sheets 배열이 있으면 표시, 없어도 에러 안 남
    const sheetsList = Array.isArray(res.sheets) ? res.sheets.join(', ')
                     : 'QSM_Lens_Config, QSM_Lens_Items';
    toast(`✅ ${sheetsList} 세팅 완료`, 'ok');
    log(`시트 세팅 완료: ${sheetsList}`, 'ok');

    // 시트 링크 표시
    const d = await storageGet(['lensSheetsId']);
    if (d.lensSheetsId) {
      window.open(`https://docs.google.com/spreadsheets/d/${d.lensSheetsId}/edit`, '_blank');
    }
  } catch (e) {
    hideOv();
    toast('❌ ' + e.message, 'err');
    log('시트 세팅 실패: ' + e.message, 'err');
    console.error(e);
  }
}

// 📊 연결된 Google 스프레드시트를 새 탭으로 열기
async function openSpreadsheet() {
  // 1) 저장된 시트 ID가 있으면 바로 열기
  const d = await storageGet(['lensSheetsId']);
  if (d.lensSheetsId) {
    window.open(`https://docs.google.com/spreadsheets/d/${d.lensSheetsId}/edit`, '_blank');
    return;
  }
  // 2) 없으면 webhook(LENS_DIAG)으로 시트 ID 조회 후 저장+열기
  if (_webhookUrl) {
    try {
      const res = await postToWebhook('LENS_DIAG');
      const id = res?.sheetId || res?.sheetsId;
      if (id) {
        await storageSet({ lensSheetsId: id });
        window.open(`https://docs.google.com/spreadsheets/d/${id}/edit`, '_blank');
        return;
      }
    } catch (e) { /* 아래 안내로 */ }
  }
  toast('연결된 스프레드시트를 찾지 못했습니다. 설정에서 webhook 연결 후 [🔧 시트 자동 세팅]을 한 번 실행하세요.', 'err');
}

async function saveToSheet() {
  if (!_webhookUrl) { toast('시트 webhook 설정 필요', 'err'); return; }
  if (!allProducts.length) { toast('저장할 상품이 없습니다', 'err'); return; }
  showOv('시트에 저장 중...', `${allProducts.length}개 상품 동기화`, 30);
  try {
    const r = getRates();
    const items = allProducts.map(p => {
      const base  = p.basePrice || calcBasePrice(p.sourcePrice, p.shipFee, p.marginRate, rateFor(p, r), p.customerShipJpy);
      const pon   = base > 0 ? calcMegaponPrice(base, r) : 0;
      const wari  = base > 0 ? calcMegawariPrice(base, r) : 0;
      // ★ 마진율 계산 (평상시 기준)
      const marginPct = calcEventMarginPct(p.sourcePrice, p.shipFee, p.customerShipJpy, p.curPrice || base, 'normal', rateFor(p, r));
      // ★ 소싱처 자동 감지
      const srcSite = p.sourcingSite || detectSourcingSite(p);
      return {
        // ── A~D 상품 기본 ────────────────────────────────
        code:        p.code,
        brand:       p.brand        || '',
        sellerCode:  p.sellerCode   || p.seller || '',   // ★ 한국어 상품명(편집값) 우선 — 시트 C열
        name:        p.name         || '',                // 일본어 상품명 — 시트 D열
        // ── E~J 소싱 입력 ────────────────────────────────
        sourcingSite: srcSite,
        sourceUrl:   p.sourceUrl    || '',
        sourcePrice: p.sourcePrice  || 0,
        weight:      p.weight       || 0.5,
        // ★ I열: 배대지비용(₩) = shipFee(¥) × 환율로 변환하여 ₩ 저장
        // shipFee가 비어있고 무게가 있으면 무게 기반 자동 계산값 사용 (화면 표시값과 일치)
        shipFee:     (() => {
          const jpy = p.shipFee > 0
            ? p.shipFee
            : (p.weight > 0 ? calcShipFromWeight(p.weight, p.carrier || 'MIR REG') : 0);
          return jpy > 0 ? Math.round(jpy * r.exchangeRate) : 0;
        })(),
        carrier:     p.carrier      || '',
        // ★ K열: 개별 마진율만 (비면 Config B10 사용)
        marginRate:  p.marginRate   || '',
        // ★ AC열: 상품별 큐텐 수수료율(%) — 비면 Config B3 기본값 (v1.9.30)
        qFeeRate:    (+p.qFeeRate > 0) ? +p.qFeeRate : '',
        // ── N~O QSM 현재 설정 ────────────────────────────
        curPrice:        p.curPrice        || 0,
        // ★ O열: 고객배송비(¥) = QSM에 등록된 고객 부담 배송비
        customerShipJpy: p.customerShipJpy || 0,
        // ── W~X 상태/메모 ────────────────────────────────
        status: STATUS_KR[p.status] || p.status || '판매중',
        memo:   p.memo || '',
        // ── Z~AA 상품종류 (v1.9.11) ───────────────────────
        itemType: (p.itemType === 'bundle' || (_bundlesMap[p.code] && _bundlesMap[p.code].length > 0)) ? 'bundle' : 'single',
        componentCount: (_bundlesMap[p.code] || []).length || +p.componentCount || 0,
      };
    });
    const res = await postToWebhook('LENS_SAVE', { items });
    if (!res.ok) throw new Error(res.error || '시트 저장 실패');
    _dirty.clear(); updateSummary();
    toast(`✅ 시트에 ${res.saved}개 저장`, 'ok');
    log(`시트 저장: ${res.saved}개`, 'ok');
  } catch(e) {
    toast('❌ '+e.message, 'err');
    log('시트 저장 실패: '+e.message, 'err');
  } finally { hideOv(); }
}

/* ══════════════════════════════════════════════════════
   ★ 셀러 배송비 그룹 조회 (v1.9.3)
   QSM API: ItemsLookup.GetSellerDeliveryGroupInfo
   - 셀러가 등록한 모든 배송비 그룹의 ShippingNo/ShippingFee/Type 조회
   - 사용자가 그룹을 선택하면 선택된 / 모든 상품에 ShippingFee 일괄 적용
══════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════
   ★ 상품별 고객배송비 자동 동기화 (v1.9.6)
   1단계: GetSellerDeliveryGroupInfo → {ShippingNo: ShippingFee} 매핑표 생성
   2단계: 각 상품의 ShippingNo 조회 (GetItemDetailInfo 또는 RequestFileDownload)
   3단계: 매핑표에서 배송비 찾아 customerShipJpy에 저장
   → 각 상품에 등록된 실제 배송비가 정확히 들어감
══════════════════════════════════════════════════════ */
async function syncCustomerShipFees(silent = false) {
  if (!allProducts.length) {
    if (!silent) toast('먼저 QSM 상품을 불러와주세요', 'err');
    return;
  }

  const targets = _checked.size > 0
    ? allProducts.filter(p => _checked.has(p.code))
    : allProducts;

  if (!silent) {
    if (!confirm(`${targets.length}개 상품의 고객배송비를 QSM에서 자동 조회합니다.\n\n` +
                 `각 상품의 ShippingNo를 읽어 배송비 그룹 매핑표에서 실제 배송비를 가져옵니다.\n\n` +
                 `(약 ${Math.ceil(targets.length * 0.15)}초 소요 예상)`)) return;
  }

  showOv('고객배송비 동기화', '배송비 그룹 매핑표 생성 중...', 5);
  try {
    // ── 1단계: 배송비 그룹 매핑표 ────────────────────────────
    const groupRes = await qsmCall('ItemsLookup.GetSellerDeliveryGroupInfo', {}, '1.0');
    console.log('[QLens] 📮 그룹 응답:', groupRes);
    const ro = groupRes.result ?? groupRes.data?.ResultObject ?? groupRes.full?.ResultObject;
    let groups = Array.isArray(ro) ? ro : (ro && (ro.ShippingNo !== undefined) ? [ro] : []);
    if (!groups.length) {
      hideOv();
      toast('배송비 그룹이 없습니다', 'err');
      return;
    }

    // ShippingNo → {fee, type, transcName} 매핑
    const shipMap = {};
    groups.forEach(g => {
      const no = String(g.ShippingNo || '').trim();
      if (no) shipMap[no] = {
        fee: Math.round(g.ShippingFee || 0),
        type: g.ShippingType || '',
        carrier: g.transcName || '',
      };
    });
    log(`📮 배송비 그룹 매핑표 생성: ${Object.keys(shipMap).length}개`, 'ok');

    // ── 2단계: 각 상품의 ShippingNo 조회 (GetItemDetailInfo) ──
    let okN = 0, fail = 0, changed = 0;
    const undoBatch = [];

    for (let i = 0; i < targets.length; i++) {
      const it = targets[i];
      setOv(`${it.name.slice(0, 30)} (${i+1}/${targets.length})`, 10 + (i / targets.length) * 88);

      try {
        const res = await qsmCall('ItemsLookup.GetItemDetailInfo', { ItemCode: String(it.code) }, '1.2');
        if (res.ok) {
          const d = Array.isArray(res.result) ? res.result[0] : (res.result || res.full?.ResultObject);
          if (d) {
            { const q = _pickQty(d); if (q !== null) it.qty = q; }  // ★ 재고도 함께 동기화
            // ShippingNo 또는 ShippingNo 유사 필드 추출
            const shipNo = String(
              d.ShippingNo ?? d.shippingNo ?? d.ShippingFeeNo ?? d.DeliveryGroupNo ?? d.shippingFeeCode ?? ''
            ).trim();

            if (shipNo && shipMap[shipNo]) {
              const newFee = shipMap[shipNo].fee;
              const newCarrier = shipMap[shipNo].carrier || '';
              const oldFee = it.customerShipJpy || 0;
              const oldCarrier = it.carrier || '';
              let rowChanged = false;
              if (oldFee !== newFee) {
                undoBatch.push({ code: it.code, field: 'customerShipJpy', oldValue: oldFee, newValue: newFee });
                it.customerShipJpy = newFee;
                rowChanged = true;
              }
              // ★ v1.9.14: 배송사도 함께 동기화 (KSE, MIR REG 등 QSM 실제 등록값)
              if (newCarrier && oldCarrier !== newCarrier) {
                undoBatch.push({ code: it.code, field: 'carrier', oldValue: oldCarrier, newValue: newCarrier });
                it.carrier = newCarrier;
                rowChanged = true;
              }
              if (rowChanged) {
                it.shippingNo = shipNo;  // 참고용
                _dirty.add(it.code);
                changed++;
              }
              okN++;
            } else if (shipNo) {
              fail++;
              log(`⚠️ ${it.name.slice(0,25)}: ShippingNo #${shipNo} → 매핑표에 없음`, 'warn');
            } else {
              // ShippingNo 직접 없어도 ShippingFee 필드가 있을 수 있음
              const directFee = Math.round(parseFloat(d.ShippingFee || d.shippingFee || 0) || 0);
              if (directFee >= 0 && (d.ShippingFee !== undefined || d.shippingFee !== undefined)) {
                const oldFee = it.customerShipJpy || 0;
                if (oldFee !== directFee) {
                  undoBatch.push({ code: it.code, field: 'customerShipJpy', oldValue: oldFee, newValue: directFee });
                  it.customerShipJpy = directFee;
                  _dirty.add(it.code);
                  changed++;
                }
                okN++;
              } else {
                fail++;
                if (i < 3) log(`⚠️ ${it.name.slice(0,25)}: 응답에 ShippingNo/ShippingFee 없음`, 'warn');
              }
            }
          } else {
            fail++;
          }
        } else {
          fail++;
          if (i < 3) log(`⚠️ ${it.name.slice(0,25)}: [${res.code}] ${res.msg||res.error||'실패'}`, 'warn');
        }
      } catch (e) {
        fail++;
        if (i < 3) log(`❌ ${it.name.slice(0,25)}: ${e.message}`, 'err');
      }

      // 80ms 간격 (QSM 부하 방지)
      if (i % 5 === 4) await new Promise(r => setTimeout(r, 80));
    }

    // Undo 일괄 기록 (한 번에 묶음, 필드별)
    undoBatch.forEach(u => {
      const label = u.field === 'carrier' ? '배송사 자동 동기화' : '고객배송비 자동 동기화';
      pushUndo(u.code, u.field, u.oldValue, u.newValue, label);
    });

    hideOv();
    renderTable();
    updateSummary();
    await _saveLocalCache();
    toast(`✅ 고객배송비 동기화: ${okN}개 성공 (${changed}개 변경) / ${fail}개 실패`, fail > 0 ? 'warn' : 'ok');
    log(`📮 고객배송비 동기화 완료: ${okN}/${targets.length} (변경 ${changed}개)`, 'ok');
  } catch (e) {
    hideOv();
    toast(`❌ 동기화 오류: ${e.message}`, 'err');
    log(`📮 고객배송비 동기화 오류: ${e.message}`, 'err');
  }
}

/* ══════════════════════════════════════════════════════
   가격 일괄 동기화 — ItemsLookup.RequestFileDownload (apply_type='item')
   QSM에 등록된 모든 상품의 가격/배송비를 CSV로 한 번에 받음 (하루 10회 제한)
══════════════════════════════════════════════════════ */
async function loadAllPricesViaCSV() {
  if (!allProducts.length) {
    toast('먼저 QSM 상품을 불러와주세요', 'err'); return;
  }

  showOv('가격 일괄 동기화', 'RequestFileDownload 요청 중...', 10);
  try {
    const today = new Date();
    const to    = today.toISOString().slice(0,10).replace(/-/g,'/');
    const from  = new Date(today.getTime() - 365*86400000).toISOString().slice(0,10).replace(/-/g,'/');

    const res = await qsmCall('ItemsLookup.RequestFileDownload', {
      apply_type:     'item',
      target_from_dt: from,
      target_to_dt:   to
    }, '1.0');

    if (!res.ok) {
      const m = res.msg || res.error || '';
      if (m.includes('Limit') || m.includes('초과') || res.code === -1001) {
        throw new Error('하루 10회 다운로드 한도 초과. 내일 다시 시도해주세요.');
      }
      throw new Error('CSV 요청 실패: ' + m);
    }

    const downloadUrl = res.result?.DownloadURL || res.result?.url || res.result;
    if (!downloadUrl || typeof downloadUrl !== 'string') {
      throw new Error('다운로드 URL을 받지 못했습니다');
    }

    setOv('CSV 다운로드 중...', 40);
    const csvRes = await fetch(downloadUrl);
    if (!csvRes.ok) throw new Error(`HTTP ${csvRes.status}`);
    const arrayBuf = await csvRes.arrayBuffer();

    // UTF-8/EUC-KR 자동 디코딩
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(arrayBuf); }
    catch { text = new TextDecoder('euc-kr').decode(arrayBuf); }

    setOv('CSV 파싱 중...', 70);
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error('CSV 데이터가 비어있습니다');

    // 헤더 분석 (탭 또는 콤마 구분)
    const sep = lines[0].includes('\t') ? '\t' : ',';
    const header = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ''));
    console.log('[QLens] CSV 헤더:', header);
    log(`CSV 컬럼: ${header.slice(0,8).join(', ')}...`, 'ok');

    // 컬럼 자동 감지
    const findCol = (...keys) => {
      for (const k of keys) {
        const idx = header.findIndex(h => h && (h.includes(k) || h.toLowerCase().includes(k.toLowerCase())));
        if (idx >= 0) return idx;
      }
      return -1;
    };
    const codeIdx  = findCol('상품번호','ItemCode','item_code','상품코드','GoodsCode');
    const nameIdx  = findCol('상품명','ItemTitle','title','GoodsName');
    const priceIdx = findCol('판매가','price','ItemPrice','가격','금액');
    // ★ QSM CSV의 "배송비"는 고객이 내는 배송비 (customerShipJpy) — 셀러 국제배송비(shipFee) 아님
    const custShipIdx = findCol('배송비','shipping','배송료','ShippingFee');

    if (codeIdx < 0) throw new Error('상품번호 컬럼을 찾을 수 없습니다');

    // 데이터 매칭
    let matched = 0;
    const codeMap = {};
    allProducts.forEach(p => { codeMap[p.code] = p; });

    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(sep).map(c => c.replace(/^"|"$/g, '').trim());
      const code  = cells[codeIdx]?.replace(/[^\d]/g, '');
      if (!code) continue;
      const product = codeMap[code];
      if (!product) continue;

      if (nameIdx >= 0 && cells[nameIdx] && (!product.name || product.name.startsWith('상품코드'))) {
        product.name = cells[nameIdx];
      }
      if (priceIdx >= 0) {
        const p = parseFloat((cells[priceIdx] || '').replace(/[^\d.]/g, ''));
        if (p > 0) product.curPrice = Math.round(p);
      }
      // ★ QSM 배송비 → customerShipJpy (고객이 큐텐에서 내는 배송비, ¥단위)
      if (custShipIdx >= 0) {
        const s = parseFloat((cells[custShipIdx] || '').replace(/[^\d.]/g, ''));
        if (s >= 0) product.customerShipJpy = Math.round(s);
      }
      matched++;
    }

    await _saveLocalCache();
    applyFilter(); updateSummary();

    hideOv();
    toast(`✅ 가격 동기화: ${matched}개 업데이트`, 'ok');
    log(`CSV 매칭: ${matched}/${lines.length - 1} 행`, 'ok');
  } catch (e) {
    hideOv();
    toast('❌ ' + e.message, 'err');
    log('가격 동기화 실패: ' + e.message, 'err');
    console.error(e);
  }
}

/* ══════════════════════════════════════════════════════
   한국어 단어 유사도 (공통 2음절+ 한글 단어 수 반환)
══════════════════════════════════════════════════════ */
function koreanWordSim(a, b) {
  const getW = s => new Set((String(s||'').match(/[가-힣]{2,}/g)||[]));
  const wa = getW(a), wb = getW(b);
  let common = 0;
  wa.forEach(w => { if (wb.has(w)) common++; });
  return common;
}

/* ══════════════════════════════════════════════════════
   마진계산기ver3 자동 매칭 (무음 — 로드 시 자동 실행)
   확정 컬럼: B=1(ItemCode), D=3(브랜드), G=6(상품명),
              I=8(URL), K=10(할인판매가), N=13(고객배송비¥),
              Q=16(배송사), S=18(국제배송비₩), Y=24(마진율)
══════════════════════════════════════════════════════ */
function autoApplyMarginCalcSilent(items, rows) {
  if (!rows || rows.length < 2) return 0;

  // 자동 감지 컬럼 (확정 기본값 + 헤더 키워드 보정)
  const cols = autoDetectMarginCols(rows);
  const IDX = {
    itemCode: 1,                    // B열: QSM 상품번호
    brand:    3,                    // D열: 브랜드명
    prodName: cols.prodName ?? 6,   // G열: 상품명
    url:      cols.url      ?? 8,   // I열: 소싱처 링크
    price:    cols.price    ?? 10,  // K열: 할인판매가
    custShip: 13,                   // N열: 고객배송비_엔
    carrier:  16,                   // Q열: 배송사
    intlShip: cols.ship     ?? 18,  // S열: 국제배송비_원
    margin:   cols.margin   ?? 24,  // Y열: 마진율
  };

  // ── 매칭 맵 구성 ──────────────────────────────────────────
  const byCode = {};  // ItemCode → row (완전 매칭)
  const byUrl  = {};  // URL      → row (완전 매칭)
  const byName = [];  // { row, name } (퍼지 — 배송비 제외)

  rows.slice(1).forEach(row => {
    const mcCode = String(row[IDX.itemCode]||'').replace(/[^\d]/g,'');
    const mcUrl  = String(row[IDX.url]     ||'').trim();
    const mcName = String(row[IDX.prodName]||'').trim();
    if (mcCode) byCode[mcCode] = row;
    if (mcUrl && mcUrl.startsWith('http')) byUrl[mcUrl] = row;
    if (mcName) byName.push({ row, name: mcName });
  });

  let matched = 0;
  items.forEach(it => {
    let row = null, matchType = 0;

    // 전략 1: QSM ItemCode 완전 매칭 (가장 신뢰)
    if (byCode[it.code]) { row = byCode[it.code]; matchType = 1; }

    // 전략 2: 소싱처 URL 완전 매칭 (신뢰)
    if (!row && it.sourceUrl && byUrl[it.sourceUrl]) {
      row = byUrl[it.sourceUrl]; matchType = 2;
    }

    // 전략 3: 한글 단어 유사도 — ★임계값 3개로 상향 (배송비 미적용)
    if (!row) {
      const target = it.seller || it.name || '';
      let best = { row: null, score: 2 }; // 최소 3개 단어 일치
      byName.forEach(({ row: r, name }) => {
        const s = koreanWordSim(target, name);
        if (s > best.score) best = { row: r, score: s };
      });
      if (best.row) { row = best.row; matchType = 3; }
    }

    if (!row) return;

    // ── 데이터 파싱 ──────────────────────────────────────────
    const brand   = String(row[IDX.brand]   ||'').trim();
    const url     = String(row[IDX.url]     ||'').trim();
    const price   = parseFloat(String(row[IDX.price]   ||'').replace(/[^\d.]/g,''));
    const custShp = parseFloat(String(row[IDX.custShip]||'').replace(/[^\d.]/g,''));
    const carrier = String(row[IDX.carrier] ||'').trim();
    const intlShp = parseFloat(String(row[IDX.intlShip]||'').replace(/[^\d.]/g,''));
    const margin  = parseFloat(String(row[IDX.margin]  ||'').replace(/[^0-9.]/g,''));
    const prodName= String(row[IDX.prodName]||'').trim();

    // 모든 매칭 타입에서 적용 (틀려도 큰 영향 없는 항목들)
    if (brand && !it.brand) it.brand = brand;
    if (url && url.startsWith('http') && !it.sourceUrl) it.sourceUrl = url;
    if (price > 0 && !it.sourcePrice) it.sourcePrice = Math.round(price);
    if (margin > 0 && margin < 100 && !it.marginRate) it.marginRate = Math.round(margin * 100) / 100;
    if (carrier) it.carrier = carrier;
    if (custShp > 0) it.customerShipJpy = Math.round(custShp);
    if (it.name?.startsWith('상품코드') && prodName) it.name = prodName;

    // ★ 배송비: 시트 S열은 국제배송비₩ → ¥ 변환하여 저장
    // 이유: 내부 shipFee는 ¥ 단위, 시트는 ₩ 단위로 저장되어 있을 수 있음
    if (matchType <= 2 && intlShp > 0) {
      // 값이 1000 이상이면 ₩(원화), 미만이면 이미 ¥(엔화)로 간주
      const shipJpy = intlShp >= 1000 ? Math.round(intlShp / 9.5) : Math.round(intlShp);
      if (!it.shipFee) it.shipFee = shipJpy;
    } else if (matchType === 3 && intlShp > 0) {
      // 퍼지 매칭: 참고값만 저장
      if (!it.shipFee) {
        const shipJpy = intlShp >= 1000 ? Math.round(intlShp / 9.5) : Math.round(intlShp);
        it.shipFee = shipJpy;
      }
    }

    matched++;
  });
  return matched;
}

/* ═══════════════════════════════════════════════════════
   마진계산기ver3 시트 가져오기 → 자동 매칭 + 미리보기
═══════════════════════════════════════════════════════ */
let _mcRows = null;     // 시트 raw rows
let _mcHeader = null;   // 헤더 행

async function loadMarginCalcSheet() {
  if (!_webhookUrl) { toast('시트 webhook 미연결', 'err'); return; }
  if (!allProducts.length) { toast('먼저 QSM 상품을 불러와주세요', 'err'); return; }

  showOv('마진계산기ver3 시트 불러오는 중...', '', 30);
  try {
    const res = await postToWebhook('LENS_LOAD_MARGIN_CALC');
    if (!res.ok) {
      if (res.error?.includes('찾을 수 없음') || res.error?.includes('없음')) {
        hideOv();
        // 친절한 안내: 마진계산기 시트가 없는 경우 (대부분의 사용자)
        const msg =
          '💡 "마진계산기ver3" 시트가 없네요!\n\n' +
          '이 기능은 기존에 마진계산기ver3 양식을 쓰던 분들이 일괄 임포트할 때만 사용합니다.\n\n' +
          '없어도 괜찮습니다. 다음 방법으로 사용하세요:\n\n' +
          '【방법 1】 Q10 Auto 사용자\n' +
          '   → Q10 Auto로 올리브영/쿠팡 스캔 → "QLens로 보내기" 클릭\n' +
          '   → 소싱가, 배송비, 브랜드가 자동으로 채워집니다\n\n' +
          '【방법 2】 직접 입력\n' +
          '   → 화면의 소싱가/배송비 입력란에 값을 입력하면 자동 계산됩니다\n\n' +
          '【방법 3】 시트에서 직접 편집\n' +
          '   → Google Sheets의 QSM_Lens_Items 시트를 열어 행마다 입력';
        alert(msg);
        return;
      }
      throw new Error(res.error || '시트 로드 실패');
    }

    const rows = res.rows || [];
    if (rows.length < 2) throw new Error('시트가 비어있습니다');

    _mcRows = rows;
    _mcHeader = rows[0].map(c => String(c || '').trim());

    // 자동 컬럼 감지
    const detect = autoDetectMarginCols(rows);
    showMarginCalcModal(detect);
    hideOv();
  } catch (e) {
    hideOv();
    toast('❌ ' + e.message, 'err');
    log('마진계산기 로드 실패: ' + e.message, 'err');
  }
}

/* ─────────────────────────────────────────────────────────────
   자동 컬럼 감지 — 마진계산기ver3 CSV 분석(2025-05-18)으로 확정된 인덱스 기반
   confirmed defaults: code=1, url=8, price=10(할인판매가), ship=18(국제배송비), margin=24
   ───────────────────────────────────────────────────────────── */
function autoDetectMarginCols(rows) {
  const header   = rows[0].map(c => String(c || '').replace(/\s+/g,' ').trim());
  const dataRows = rows.slice(1, Math.min(rows.length, 30));
  const numCols  = header.length;

  // 1단계: CSV 분석으로 확정된 기본값
  const result = { code: 1, url: 8, price: 10, ship: 18, margin: 24 };
  const found  = {};

  // 2단계: 헤더 키워드 보정 (구체적인 키워드가 앞 = 우선순위 높음, first-match-wins)
  const KEYWORDS = {
    code:   ['상품번호', '상품코드', 'itemcode', 'goodscode'],
    url:    ['소싱처링크', '소싱처 링크', '소싱처url', '소싱처주소'],
    price:  ['할인판매가', '소싱가', '소싱금액', '구입가', '매입가'],  // '원가' 제외 (상품원가_원 충돌)
    ship:   ['국제배송비', '국제배송'],                                // '배송비' 제외 (국내배송비 충돌)
    margin: ['마진율'],                                                // '마진' 제외 (목표마진 충돌)
  };
  header.forEach((h, i) => {
    const hl = h.replace(/\s/g,'').toLowerCase();
    for (const [field, kws] of Object.entries(KEYWORDS)) {
      if (found[field]) continue;
      if (kws.some(kw => hl.includes(kw.replace(/\s/g,'').toLowerCase()))) {
        result[field] = i; found[field] = true;
      }
    }
  });

  // 3단계: 데이터 패턴 보완 (헤더에서 못 찾은 필드만)
  for (let c = 0; c < numCols; c++) {
    const samples = dataRows.map(r => String(r[c] || '').trim()).filter(v => v);
    if (!samples.length) continue;
    if (!found.code && samples.filter(v => /^11\d{8}$/.test(v.replace(/[^\d]/g,''))).length / samples.length > 0.5) {
      result.code = c; found.code = true;
    }
    if (!found.url && samples.filter(v => /^https?:\/\//.test(v)).length / samples.length > 0.3) {
      result.url = c; found.url = true;
    }
    if (!found.price && samples.filter(v => { const n = parseFloat(v.replace(/[^\d.]/g,'')); return n >= 1000 && n <= 999999; }).length / samples.length > 0.5) {
      result.price = c; found.price = true;
    }
  }

  return result;  // { code, url, price, ship, margin }
}

function showMarginCalcModal(detected) {
  const modal = document.getElementById('marginCalcModal');
  const rows = _mcRows;

  // 자동 감지 결과 표시
  const det = document.getElementById('autoDetectInfo');
  const txt = document.getElementById('autoDetectText');
  const detectedFields = [];
  if (detected.code  >= 0) detectedFields.push(`상품코드 = "${_mcHeader[detected.code]  || `(${detected.code +1}열)`}"`);
  if (detected.url   >= 0) detectedFields.push(`URL = "${_mcHeader[detected.url]   || `(${detected.url  +1}열)`}"`);
  if (detected.price >= 0) detectedFields.push(`소싱가 = "${_mcHeader[detected.price] || `(${detected.price+1}열)`}" ★할인판매가`);
  if (detected.ship  >= 0) detectedFields.push(`배송비 = "${_mcHeader[detected.ship]  || `(${detected.ship +1}열)`}" ★국제배송비`);
  if (detected.margin>= 0) detectedFields.push(`마진율 = "${_mcHeader[detected.margin]|| `(${detected.margin+1}열)`}"`);
  if (detectedFields.length) {
    det.style.display = 'block';
    txt.innerHTML = detectedFields.join(' · ');
  }

  // 컬럼 select 옵션 채우기
  const fillSelect = (selectId, selectedIdx) => {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '<option value="-1">— 선택 —</option>' +
      _mcHeader.map((h, i) => `<option value="${i}" ${i === selectedIdx ? 'selected' : ''}>${i+1}열: ${h || '(빈 헤더)'}</option>`).join('');
  };
  fillSelect('mcColCode',   detected.code);
  fillSelect('mcColUrl',    detected.url);
  fillSelect('mcColPrice',  detected.price);
  fillSelect('mcColShip',   detected.ship);
  fillSelect('mcColMargin', detected.margin);

  // 미리보기 테이블 (상위 5행)
  const head = document.getElementById('marginCalcHead');
  const body = document.getElementById('marginCalcBody');
  head.innerHTML = '<tr>' + _mcHeader.map((h, i) =>
    `<th style="padding:6px 8px;text-align:left;background:var(--bg2);border-bottom:1.5px solid var(--border);font-weight:700;color:var(--text2);font-size:10px;white-space:nowrap">${i+1}: ${h || '-'}</th>`
  ).join('') + '</tr>';
  body.innerHTML = rows.slice(1, 6).map(r =>
    '<tr>' + r.map(c => {
      const s = String(c || '').slice(0, 40);
      return `<td style="padding:5px 8px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text);white-space:nowrap">${s || '<span style="color:var(--text3)">-</span>'}</td>`;
    }).join('') + '</tr>'
  ).join('');

  // 실시간 매칭 결과 미리보기
  const updateMatchResult = () => {
    const codeIdx = +document.getElementById('mcColCode').value;
    const urlIdx  = +document.getElementById('mcColUrl').value;
    if (codeIdx < 0 && urlIdx < 0) {
      document.getElementById('matchResult').style.display = 'none';
      return;
    }
    const codeMap = {}; allProducts.forEach(p => { codeMap[p.code] = true; });
    const urlMap  = {}; allProducts.forEach(p => { if (p.sourceUrl) urlMap[p.sourceUrl] = true; });
    let matched = 0;
    for (let i = 1; i < rows.length; i++) {
      const code = codeIdx >= 0 ? String(rows[i][codeIdx] || '').replace(/[^\d]/g, '') : '';
      const url  = urlIdx  >= 0 ? String(rows[i][urlIdx]  || '').trim() : '';
      if ((code && codeMap[code]) || (url && urlMap[url])) matched++;
    }
    const byCode = codeIdx >= 0 ? '코드' : '';
    const byUrl  = urlIdx  >= 0 ? 'URL' : '';
    const matchBy = [byCode, byUrl].filter(Boolean).join('+');
    document.getElementById('matchResult').style.display = 'block';
    document.getElementById('matchResultText').innerHTML =
      `✅ <b>${matched}개</b> 매칭 가능 (${matchBy} 기준) / 시트 ${rows.length-1}행 / QSM ${allProducts.length}개`;
  };
  document.getElementById('mcColCode').onchange = updateMatchResult;
  document.getElementById('mcColUrl').onchange  = updateMatchResult;
  updateMatchResult();

  modal.classList.add('show');
}

function applyMarginCalcMatching() {
  const codeIdx   = +document.getElementById('mcColCode').value;
  const urlIdx    = +document.getElementById('mcColUrl').value;
  const priceIdx  = +document.getElementById('mcColPrice').value;
  const shipIdx   = +document.getElementById('mcColShip').value;
  const marginIdx = +document.getElementById('mcColMargin').value;

  if (codeIdx < 0 && urlIdx < 0) {
    toast('상품코드 또는 URL 컬럼 중 하나는 선택해주세요', 'err'); return;
  }
  if (urlIdx < 0 && priceIdx < 0) {
    toast('URL 또는 소싱가 컬럼 중 하나는 선택해주세요', 'err'); return;
  }

  // 매칭 맵 구성 (코드 우선, URL 폴백)
  const codeMap = {};
  const urlMap  = {};
  allProducts.forEach(p => {
    if (p.code)      codeMap[p.code] = p;
    if (p.sourceUrl) urlMap[p.sourceUrl] = p;
  });

  let matched = 0, updated = 0, byUrl = 0;
  const r = getRates();

  for (let i = 1; i < _mcRows.length; i++) {
    const row = _mcRows[i];

    // 1) 코드로 매칭 → 2) URL로 폴백
    let product = null;
    if (codeIdx >= 0) {
      const code = String(row[codeIdx] || '').replace(/[^\d]/g, '');
      if (code) product = codeMap[code] || null;
    }
    if (!product && urlIdx >= 0) {
      const url = String(row[urlIdx] || '').trim();
      if (url) { product = urlMap[url] || null; if (product) byUrl++; }
    }
    if (!product) continue;
    matched++;

    let changed = false;

    // URL 업데이트
    if (urlIdx >= 0) {
      const url = String(row[urlIdx] || '').trim();
      if (url && url.startsWith('http')) { product.sourceUrl = url; changed = true; }
    }
    // 소싱가(₩) = 할인판매가 [열10 확정]
    if (priceIdx >= 0) {
      const p = parseFloat(String(row[priceIdx] || '').replace(/[^\d.]/g,''));
      if (p > 0) { product.sourcePrice = Math.round(p); changed = true; }
    }
    // 배송비(₩) = 국제배송비 [열18 확정]
    if (shipIdx >= 0) {
      const s = parseFloat(String(row[shipIdx] || '').replace(/[^\d.]/g,''));
      if (s > 0) { product.shipFee = Math.round(s); changed = true; }
    }
    // 마진율(%) = [열24 확정] — %문자 제거 후 숫자 파싱
    if (marginIdx >= 0) {
      const m = parseFloat(String(row[marginIdx] || '').replace(/[^0-9.]/g,''));
      if (m > 0 && m < 100) { product.marginRate = Math.round(m * 100) / 100; changed = true; }
    }

    if (changed) {
      _dirty.add(product.code);
      // 평상시가 자동 재계산
      product.basePrice = calcBasePrice(product.sourcePrice, product.shipFee, product.marginRate, rateFor(product, r), product.customerShipJpy);
      updated++;
    }
  }

  document.getElementById('marginCalcModal').classList.remove('show');
  _saveLocalCache();
  applyFilter(); updateSummary();

  const urlNote = byUrl > 0 ? ` (URL폴백 ${byUrl}개 포함)` : '';
  toast(`✅ 매칭 ${matched}개 / 업데이트 ${updated}개${urlNote}`, 'ok');
  log(`마진계산기 매칭: ${matched}개, 업데이트: ${updated}개${urlNote}`, 'ok');
}

/* ── 상태 코드 → 한글 매핑 ── */
const STATUS_KR = { S2: '판매중', S1: '품절/대기', S0: '판매대기', S3: '단종(폐지)' };
const STATUS_CODE = { '판매중': 'S2', '일시중지': 'S1', '판매대기': 'S0', '단종': 'S3' };

/* ── 배대지 요율표 (무게 구간별 ₩) ──────────────────────────────
   CSV 마진계산기ver3 분석값 기반 (2025-05-18)
   ─────────────────────────────────────────────────────────────── */
// ★ SHIP_RATES: 배송사별 무게구간 요율표 (단위: ¥ 엔화)
// 기준 환율 약 9.5원/엔 적용 (₩ 원화 ÷ 9.5)
// CSV 업로드로 실제 견적서 기준으로 덮어쓸 수 있습니다
const SHIP_RATES = {
  'MIR REG': [
    [0.30,  530], [0.50,  600], [0.70,  650], [1.00,  705],
    [1.50,  755], [2.00,  835], [3.00,  910], [5.00, 1150],
    [7.00, 1445], [10.00, 1945], [20.00, 3370],
  ],
  'KSE': [
    [0.50,  475], [1.00,  685], [2.00, 1000], [3.00, 1315],
    [5.00, 1895], [10.00, 3160],
  ],
  'KSE 선편': [
    [0.50,  125], [1.00,  190], [2.00,  295], [3.00,  400],
    [5.00,  580], [10.00,  945],
  ],
  'MIR ECO': [
    [0.50,  445], [1.00,  580], [2.00,  790], [3.00, 1000],
    [5.00, 1475],
  ],
  'EMS': [
    [0.50,  735], [1.00, 1000], [2.00, 1580], [3.00, 2105],
    [5.00, 2945],
  ],
};

// 무게(kg) + 배송사 → 예상 국제배송비(¥ 엔화)
function calcShipFromWeight(weightKg, carrier) {
  const rates = SHIP_RATES[carrier]
             || SHIP_RATES[carrier?.toLowerCase().replace('kse','KSE').replace('mir','MIR')]
             || SHIP_RATES['MIR REG'];
  const w = parseFloat(weightKg) || 0;
  if (w <= 0) return 0;
  for (const [maxW, fee] of rates) {
    if (w <= maxW) return fee;
  }
  return rates[rates.length - 1][1]; // 최대 구간 초과
}

/* ══════════════════════════════════════════════════════
   QSM 상품 불러오기
══════════════════════════════════════════════════════ */
async function loadProducts() {
  showOv('상품 불러오는 중...', 'QSM API 조회', 5);
  try {
    const items = [];
    for (const status of ['S2','S1','S0']) {
      let pg = 1, totalPg = 1;
      while (pg <= totalPg && pg <= 10) {
        const res = await qsmCall('ItemsLookup.GetAllGoodsInfo', { ItemStatus: status, Page: String(pg) });
        if (!res.ok || !res.result) break;
        totalPg = res.result.TotalPages || 1;
        (res.result.Items || []).forEach(it => items.push({
          code: it.ItemCode || '', seller: it.SellerCode || '',
          status: it.ItemStatus || status,
          name: '', brand: '', sourceUrl: '', sourcePrice: 0, shipFee: 0, marginRate: 0,
          basePrice: 0, curPrice: 0, memo: '',
          carrier: '', customerShipJpy: 0, intlShipKrw: 0,
          weight: 0.5,  // ★ 기본 무게 0.5kg — 요율표 자동 계산용
          qty: _pickQty(it),   // ★ QSM 재고수량 (없으면 null → 상세조회/배송비동기화 시 보완)
        }));
        pg++;
        setOv(`${status} ${items.length}개 (${pg-1}/${totalPg})`, 5 + items.length / 5);
      }
    }

    setOv('상품명 스크래핑 중...', 30);

    // seller.qoo10.jp 상품목록 스크래핑 (이름+가격)
    try {
      const nameMap = await scrapeTab('https://seller.qoo10.jp/ko/item/list', function scrapeItems() {
        const map = {};
        // seller.qoo10.jp/ko/item/list — 테이블 행 기반 추출
        const rows = document.querySelectorAll('table tbody tr, .item-list tr, [class*="listRow"], [class*="list-row"]');
        rows.forEach(row => {
          const text = row.innerText || '';
          const codeM = text.match(/\b(11\d{8})\b/);
          if (!codeM) return;
          const code = codeM[1];

          // 상품명: a 태그 텍스트 우선, 없으면 가장 긴 td 텍스트
          let name = '';
          const links = row.querySelectorAll('a');
          links.forEach(a => {
            const t = (a.innerText || '').trim();
            if (t.length > name.length && t.length > 3 && !/^\d/.test(t)) name = t;
          });
          if (!name) {
            const cells = Array.from(row.querySelectorAll('td'));
            const cands = cells.map(c => (c.innerText || '').trim())
              .filter(t => t.length > 3 && !/^[\d,¥₩\s]+$/.test(t));
            name = cands.sort((a, b) => b.length - a.length)[0] || '';
          }

          // 가격
          const priceEl = row.querySelector('[class*="price"],[class*="Price"],[class*="amount"],[class*="Amount"]');
          const price = parseInt((priceEl?.innerText || '').replace(/[^\d]/g, '')) || 0;

          if (name) map[code] = { name: name.slice(0, 120), price };
        });

        // 혹시 rows가 비었으면 전체 페이지 텍스트에서 11자리 코드+이름 쌍 추출
        if (!Object.keys(map).length) {
          const allLinks = document.querySelectorAll('a[href*="ItemCode"], a[href*="goodsNo"], a[href*="item_no"]');
          allLinks.forEach(a => {
            const href = a.href || '';
            const cM = href.match(/(?:ItemCode|goodsNo|item_no)[=_](\d{10,12})/i);
            if (!cM) return;
            const name = (a.innerText || a.title || '').trim();
            if (name.length > 2) map[cM[1]] = { name: name.slice(0, 120), price: 0 };
          });
        }
        return map;
      });
      if (nameMap && typeof nameMap === 'object') {
        items.forEach(it => {
          if (nameMap[it.code]) {
            if (!it.name || it.name.startsWith('상품코드')) it.name = nameMap[it.code].name;
            if (!it.curPrice && nameMap[it.code].price) it.curPrice = nameMap[it.code].price;
          }
        });
        log(`상품명 스크래핑: ${Object.keys(nameMap).length}개`, 'ok');
      }
    } catch (e) {
      // executeScript는 활성 탭에서만 작동. 백그라운드에서 호출 시 권한 에러는 정상이므로 콘솔만
      console.warn('[QLens] seller.qoo10 자동 이름 보완 스킵:', e.message);
    }

    // GetItemDetailInfo 보완 (이름 없는 항목 전체, 100ms 딜레이)
    const unnamed = items.filter(it => !it.name);
    for (let i = 0; i < unnamed.length; i++) {
      setOv(`이름 보완 ${i+1}/${unnamed.length}`, 50 + (i/Math.max(unnamed.length,1))*25);
      try {
        const res = await qsmCall('ItemsLookup.GetItemDetailInfo', { ItemCode: unnamed[i].code }, '1.2');
        if (res.ok && res.result) {
          const d = Array.isArray(res.result) ? res.result[0] : res.result;
          if (d) {
            unnamed[i].name     = d.ItemTitle || d.PromotionName || d.ModelNM || '';
            unnamed[i].curPrice = parseFloat(d.ItemPrice || d.RetailPrice || 0) || 0;
            unnamed[i].brand    = d.BrandName || d.BrandNM || unnamed[i].brand || '';
            { const q = _pickQty(d); if (q !== null) unnamed[i].qty = q; }  // ★ 재고 보완
            // BrandNo(브랜드 번호) 캡처 — 이름이 없으면 SearchBrand로 후속 매칭
            unnamed[i].brandNo  = String(d.BrandNo || d.BrandNM_NO || d.M_B_NO || '').trim();
          }
        }
      } catch { /* skip */ }
      if (i % 5 === 4) await new Promise(r => setTimeout(r, 80)); // 5개마다 80ms 쉼
    }

    // 아직 이름 없는 항목 → 플레이스홀더 (시트 머지 후 덮어쓸 예정)
    items.forEach(it => { if (!it.name) it.name = `상품코드 ${it.code}`; });

    allProducts = items;
    await _saveLocalCache();

    // 마진계산기ver3 자동 매칭 (있는 경우만 — 없어도 정상)
    if (_webhookUrl) {
      setOv('마진계산기 매칭 시도 중... (선택)', 78);
      try {
        const mcRes = await postToWebhook('LENS_LOAD_MARGIN_CALC');
        if (mcRes.ok && mcRes.rows?.length > 1) {
          _mcRows   = mcRes.rows;
          _mcHeader = mcRes.rows[0].map(c => String(c||'').trim());
          const matched = autoApplyMarginCalcSilent(items, mcRes.rows);
          if (matched > 0) log(`마진계산기 자동 매칭: ${matched}개`, 'ok');
        }
        // 시트가 없거나 비어있어도 조용히 패스 (대부분 사용자에게 정상)
      } catch(e) {
        // 콘솔에만 기록
        console.log('[QLens] 마진계산기ver3 시트 없음 — 직접 입력 모드로 진행');
      }
    }

    // 시트가 연결되어 있으면 자동으로 시트 데이터 머지 + 신규 상품 자동 저장
    if (_webhookUrl) {
      setOv('시트 데이터 머지 중...', 85);
      try { await loadFromSheet(); } catch {}

      // ★ 시트에 없는 상품은 자동으로 저장 (사용자 편의)
      setOv('신규 상품 시트에 자동 저장 중...', 92);
      try {
        await saveToSheet();
        log('💡 신규 상품이 QSM_Lens_Items 시트에 자동 저장되었습니다. 소싱가/배대지비용을 입력하면 마진이 자동 계산됩니다.', 'ok');
      } catch(e) {
        log('자동 시트 저장 실패: ' + e.message, 'warn');
      }
    }

    applyFilter(); updateSummary();
    toast(`✅ 상품 ${items.length}개 로드${_webhookUrl ? ' + 시트 동기화' : ''}`, 'ok');
    log(`총 ${items.length}개 로드 완료`, 'ok');

    // ★ v1.9.11: 기획세트 자동 로드
    if (_webhookUrl) {
      setOv('기획세트 구성품 로드 중...', 93);
      try { await loadBundlesFromSheet(); applyFilter(); } catch(e) { log('번들 로드 실패: ' + e.message, 'warn'); }
    }

    // ★ 자동 배송비 동기화 (v1.9.8) — 사용자가 버튼 안 눌러도 자동 실행
    // 단, 상품이 너무 많으면 시간이 오래 걸리니 사용자 동의 필요
    if (items.length > 0 && items.length <= 100) {
      // 100개 이하면 자동 실행 (15초 이내)
      setOv('고객배송비 자동 동기화 중...', 95);
      try { await syncCustomerShipFees(true); } catch(e) { log('배송비 자동 동기화 실패: ' + e.message, 'warn'); }
    } else if (items.length > 100) {
      // 100개 초과시 안내만 (수동 실행 권유)
      log(`💡 ${items.length}개 상품 → [📮 배송비 동기화] 버튼을 눌러 고객배송비를 일괄 가져오세요 (약 ${Math.ceil(items.length*0.15)}초)`, 'info');
    }
  } catch (e) {
    toast('❌ ' + e.message, 'err');
    log('로드 실패: ' + e.message, 'err');
    console.error(e);
  } finally { hideOv(); }
}

/* ══════════════════════════════════════════════════════
   테이블 필터링 + 렌더링
══════════════════════════════════════════════════════ */
function applyFilter() {
  const q  = document.getElementById('searchInput').value.toLowerCase();
  const sf = document.getElementById('statusFilter').value;
  const xf = document.getElementById('srcFilter').value;
  const bf = document.getElementById('brandFilter')?.value || 'all';   // ★ 브랜드 필터
  const mf = document.getElementById('marginFilter')?.value || 'all';
  const tf = document.getElementById('typeFilter')?.value || 'all';
  const r  = getRates();

  // ⚠️ 마진율 계산 — renderTable 계산식과 동일해야 함
  const calcMargin = (it) => {
    if (!it.sourcePrice || it.sourcePrice <= 0) return null;
    const base  = it.basePrice || calcBasePrice(it.sourcePrice, it.shipFee, it.marginRate, rateFor(it, r), it.customerShipJpy);
    const modePrice = currentMode === 'normal'  ? base
                    : currentMode === 'megapon' ? calcMegaponPrice(base, r)
                    : calcMegawariPrice(base, r);
    const event = it.curPrice > 0 ? it.curPrice : modePrice;
    if (event <= 0) return null;
    return calcEventMarginPct(it.sourcePrice, it.shipFee, it.customerShipJpy, event, currentMode, rateFor(it, r));
  };

  filtered = allProducts.filter(it => {
    // 검색어 — 한국어 상품명(sellerCode), 일본어, QSM코드, URL, 브랜드 전체에서 검색
    if (q && !(
      it.name?.toLowerCase().includes(q) ||
      it.sellerCode?.toLowerCase().includes(q) ||
      it.brand?.toLowerCase().includes(q) ||
      it.code.includes(q) ||
      (it.sourceUrl||'').toLowerCase().includes(q)
    )) return false;
    // 상태
    if (sf !== 'all' && it.status !== sf) return false;
    // ★ v1.9.11: 상품 유형 (단품/기획)
    if (tf !== 'all') {
      const isBundle = it.itemType === 'bundle' || (_bundlesMap[it.code] && _bundlesMap[it.code].length > 0);
      if (tf === 'bundle' && !isBundle) return false;
      if (tf === 'single' && isBundle) return false;
    }
    // 소싱처 (URL/이름으로 판단)
    if (xf !== 'all') {
      const site = detectSourcingSite(it);
      if (site !== xf) return false;
    }
    // ★ 브랜드 필터 — 선택한 브랜드만 표시 ('none' = 브랜드 미입력 행)
    if (bf !== 'all') {
      const b = (it.brand || '').trim();
      if (bf === 'none') { if (b) return false; }
      else if (b !== bf) return false;
    }
    // 마진 상태
    if (mf !== 'all') {
      const m = calcMargin(it);
      if (mf === 'empty') {
        if (it.sourcePrice > 0) return false;
      } else if (m === null) {
        return false;  // 마진 계산 불가 행은 마진 필터에서 제외
      } else {
        if (mf === 'loss' && m >= 0) return false;
        if (mf === 'low'  && (m < 0 || m >= 5)) return false;
        if (mf === 'mid'  && (m < 5 || m >= 20)) return false;
        if (mf === 'high' && m < 20) return false;
      }
    }
    return true;
  });

  // 소싱처 드롭다운 자동 채우기 (실제 데이터 기반)
  updateSourcingSiteFilter();
  // ★ 브랜드 드롭다운 자동 채우기
  updateBrandFilter();

  document.getElementById('tbCount').textContent = filtered.length + '개';
  page = 1;
  renderTable();
}

/* ── 소싱 URL → 소싱처 이름 매핑 ─────────────────────────────── */
function detectSourcingSite(it) {
  const url = (it.sourceUrl || '').toLowerCase();
  if (!url) return 'none';
  if (url.includes('oliveyoung'))            return '올리브영';
  if (url.includes('smartstore.naver') || url.includes('brand.naver') || url.includes('search.shopping.naver')) return '네이버';
  if (url.includes('coupang'))               return '쿠팡';
  if (url.includes('musinsa'))               return '무신사';
  if (url.includes('kurly') || url.includes('kakaomakers')) return '컬리';
  if (url.includes('daiso'))                 return '다이소';
  if (url.includes('11st'))                  return '11번가';
  if (url.includes('gmarket'))               return 'G마켓';
  if (url.includes('themedicube') || url.includes('vt-cosmetics') || url.includes('anua')) return '브랜드 공식몰';
  return '기타';
}

/* ── 소싱처 드롭다운 옵션 자동 채우기 ────────────────────────── */
function updateSourcingSiteFilter() {
  const sel = document.getElementById('srcFilter');
  if (!sel) return;
  const current = sel.value;
  // 실제 사용 중인 소싱처만 추출
  const counts = {};
  allProducts.forEach(it => {
    const site = detectSourcingSite(it);
    if (site === 'none') return;
    counts[site] = (counts[site] || 0) + 1;
  });
  const sortedSites = Object.entries(counts).sort((a,b) => b[1] - a[1]);
  const noneCount = allProducts.filter(it => detectSourcingSite(it) === 'none').length;

  let html = '<option value="all">🛒 소싱처 전체</option>';
  sortedSites.forEach(([site, n]) => {
    html += `<option value="${site}">${site} (${n})</option>`;
  });
  if (noneCount > 0) {
    html += `<option value="none">⚪ 미지정 (${noneCount})</option>`;
  }
  // 옵션이 바뀌었을 때만 갱신 (성능)
  if (sel.innerHTML !== html) {
    sel.innerHTML = html;
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
  }
}

/* ── 브랜드 드롭다운 옵션 자동 채우기 ────────────────────────── */
function updateBrandFilter() {
  const sel = document.getElementById('brandFilter');
  if (!sel) return;
  const current = sel.value;
  // 실제 데이터의 브랜드별 개수 집계
  const counts = {};
  let noneCount = 0;
  allProducts.forEach(it => {
    const b = (it.brand || '').trim();
    if (!b) { noneCount++; return; }
    counts[b] = (counts[b] || 0) + 1;
  });
  // 이름 가나다/오십음 순 정렬 (브랜드 찾기 쉽게)
  const sorted = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0], 'ja'));

  let html = `<option value="all">🏷️ 브랜드 전체 (${allProducts.length})</option>`;
  sorted.forEach(([brand, n]) => {
    html += `<option value="${brand.replace(/"/g, '&quot;')}">${brand} (${n})</option>`;
  });
  if (noneCount > 0) {
    html += `<option value="none">⚪ 브랜드 없음 (${noneCount})</option>`;
  }
  // 옵션이 바뀌었을 때만 갱신 (성능)
  if (sel.innerHTML !== html) {
    sel.innerHTML = html;
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
  }
}

/* ══════════════════════════════════════════════════════
   행 계산 셀 부분 갱신 — 입력 변경 시 DOM 직접 업데이트
   (전체 재렌더 없이 계산 결과만 갱신)
══════════════════════════════════════════════════════ */
function rerenderRowCells(it, tr, r) {
  if (!it || !tr) return;
  if (!r) r = getRates();  // fallback
  const ri = rateFor(it, r);  // ★ v1.9.29: 상품별 수수료율 반영

  const base     = calcBasePrice(it.sourcePrice, it.shipFee, it.marginRate, ri, it.customerShipJpy);
  const recPrice = calcBasePrice(it.sourcePrice, it.shipFee, ri.marginRate, ri, it.customerShipJpy);

  const modePrice = currentMode === 'normal'  ? base
                  : currentMode === 'megapon' ? calcMegaponPrice(base, ri)
                  : calcMegawariPrice(base, ri);
  const event    = it.curPrice > 0 ? it.curPrice : modePrice;

  // ★ 배송비: it.shipFee는 ¥ 단위 (국제배송비 셀러부담)
  const shipFeeJpy   = it.shipFee || r.shipFeeJpy || 0;
  const custShipJpy  = it.customerShipJpy || 0;

  // ★ 총판매액 = 판매가¥ + 고객배송비¥
  const totalSaleJpy = event > 0 ? event + custShipJpy : 0;

  // ★ 비용 계산 (전부 ¥ 단위) — 표시용 총비용
  const costJpy      = event > 0 ? (it.sourcePrice || 0) / r.exchangeRate + shipFeeJpy : 0;
  const qsmFeeJpy    = event > 0 ? totalSaleJpy * ri.qFeeRate / 100 : 0;  // 매출 전체 기준 수수료 (상품별 율)
  const packJpy      = 500 / r.exchangeRate;
  const vatRefJpy    = (it.sourcePrice || 0) * 0.09 / r.exchangeRate;
  const totalCostJpy = costJpy + qsmFeeJpy + packJpy;
  // ★ v1.9.29: 이익·마진율을 통합 함수로 동시 산출 (두 컬럼 영구 일치, 상품별 수수료율)
  const _econ        = calcEventEconomics(it.sourcePrice, shipFeeJpy, custShipJpy, event, currentMode, ri);
  const profitJpy    = _econ.profitJpy || 0;
  const marginPct    = _econ.marginPct;

  const isLoss = marginPct !== null && marginPct < 0;
  const isLow  = marginPct !== null && marginPct >= 0 && marginPct < 5;
  const isHigh = marginPct !== null && marginPct >= 20;
  tr.classList.remove('margin-loss', 'margin-low', 'margin-high');
  if (isLoss) tr.classList.add('margin-loss');
  else if (isLow) tr.classList.add('margin-low');
  else if (isHigh) tr.classList.add('margin-high');

  const fmtJ = n => n > 0 ? `¥${Math.round(n).toLocaleString()}` : '-';

  // ① 무게 셀
  const weightedShip = it.weight > 0 ? calcShipFromWeight(it.weight, it.carrier || 'MIR REG') : shipFeeJpy;
  const shipAutoEl = tr.querySelector('.ship-auto');
  if (shipAutoEl && weightedShip > 0) {
    shipAutoEl.textContent = `≈¥${Math.round(weightedShip).toLocaleString()}`;
    shipAutoEl.className   = 'ship-auto';
  }

  // ② 총비용 내역
  const costEl = tr.querySelector('.cost-breakdown');
  if (costEl) costEl.innerHTML = `
    <div class="cost-row"><span class="lbl">소싱가</span><span class="val">¥${Math.round((it.sourcePrice||0)/r.exchangeRate).toLocaleString()}</span></div>
    <div class="cost-row"><span class="lbl">국제배송</span><span class="val">${fmtJ(shipFeeJpy)}</span></div>
    <div class="cost-row"><span class="lbl">수수료</span><span class="val">${fmtJ(qsmFeeJpy)}</span></div>
    <div class="cost-row"><span class="lbl">포장·국내</span><span class="val">¥${Math.round(packJpy).toLocaleString()}</span></div>
    <div class="cost-row total"><span class="lbl" style="font-weight:700">합계</span><span class="val">${fmtJ(totalCostJpy)}</span></div>`;

  // ③ ★ v1.9.29: 총비용 메인·원화 + 툴팁 + 추천가 힌트 + placeholder 실시간 갱신
  //    (기존엔 cost-breakdown(hover)만 갱신해서 소싱가 변경 시 총비용·추천가가 안 바뀌던 버그)
  const actualShipJpy2 = shipFeeJpy > 0 ? shipFeeJpy : weightedShip;
  const costMainEl = tr.querySelector('.cost-main');
  if (costMainEl) costMainEl.textContent = totalCostJpy > 0 ? `¥${Math.round(totalCostJpy).toLocaleString()}` : '-';
  const costKrwEl = tr.querySelector('.cost-krw');
  if (costKrwEl) costKrwEl.innerHTML = `₩${Math.round(totalCostJpy * r.exchangeRate).toLocaleString()} <span style="opacity:.5">↑hover</span>`;
  const costCellEl = tr.querySelector('.cost-cell');
  if (costCellEl) costCellEl.title = [
    `소싱가 ¥${Math.round((it.sourcePrice||0)/r.exchangeRate).toLocaleString()} (₩${(it.sourcePrice||0).toLocaleString()})`,
    `국제배송 ¥${Math.round(actualShipJpy2).toLocaleString()}`,
    `수수료(${ri.qFeeRate}%) ¥${Math.round(qsmFeeJpy).toLocaleString()}`,
    `포장·국내 ¥${Math.round(packJpy).toLocaleString()}`,
    `합계 ¥${Math.round(totalCostJpy).toLocaleString()}`,
  ].join('\n');

  // QSM 판매가 — 사용자 입력값(input)은 보존, 추천가 힌트와 placeholder만 갱신
  const recHintEl = tr.querySelector('.rec-hint');
  if (recHintEl) {
    recHintEl.style.color = it.curPrice > 0 ? 'var(--text3)' : 'var(--orange)';
    recHintEl.textContent = (it.curPrice > 0 && recPrice > 0 && Math.abs(recPrice - it.curPrice) > 50)
      ? `추천 ¥${recPrice.toLocaleString()}`
      : (!it.curPrice && event > 0) ? `추천 ¥${event.toLocaleString()}` : '';
  }
  const qsmInput = tr.querySelector('.qsm-price-input');
  if (qsmInput && document.activeElement !== qsmInput) qsmInput.placeholder = String(event || '0');

  // ④ 총판매액 = 판매가 + 고객배송비
  const revEl = tr.querySelector('.revenue-cell');
  if (revEl) revEl.innerHTML = `
    <div class="rev-num">${totalSaleJpy > 0 ? '¥'+Math.round(totalSaleJpy).toLocaleString() : '-'}</div>
    ${totalSaleJpy > 0 && custShipJpy > 0 ? `<div style="font-size:9px;color:var(--orange)">판매¥${event.toLocaleString()}+배송¥${custShipJpy.toLocaleString()}</div>` : ''}
    ${totalSaleJpy > 0 ? `<div class="vat-small">VAT환급 ¥${Math.round(vatRefJpy).toLocaleString()}</div>` : ''}`;

  // ⑤ 이익
  const profEl = tr.querySelector('.profit-num');
  if (profEl) {
    profEl.className = `profit-num ${profitJpy >= 0 ? 'pos' : 'neg'}`;
    profEl.textContent = totalSaleJpy > 0 ? (profitJpy >= 0 ? '+¥' : '-¥') + Math.abs(Math.round(profitJpy)).toLocaleString() : '-';
  }

  // ⑥ 마진율 배지 (이벤트 모드 표시)
  const badgeEl = tr.querySelector('.margin-badge');
  if (badgeEl && marginPct !== null) {
    const cls = isLoss ? 'mbadge-loss' : isLow ? 'mbadge-low' : isHigh ? 'mbadge-high' : 'mbadge-ok';
    const lbl = isLoss ? '역마진' : isLow ? '저마진' : isHigh ? '고마진' : '';
    const modeTag = currentMode === 'megapon' ? '<span style="font-size:8.5px;opacity:.85;margin-left:3px;padding:1px 4px;background:rgba(61,158,255,.2);border-radius:3px;font-weight:700">MP</span>'
                  : currentMode === 'megawari' ? '<span style="font-size:8.5px;opacity:.85;margin-left:3px;padding:1px 4px;background:rgba(255,59,59,.2);border-radius:3px;font-weight:700">MW</span>' : '';
    badgeEl.className = `margin-badge ${cls}`;
    badgeEl.innerHTML = `${lbl ? lbl+' ' : ''}${marginPct.toFixed(1)}%${modeTag}`;
  }

  // ⑦ 추천가 컬럼은 v1.9.1에서 제거됨 (QSM 판매가 아래에 추천가 표시되므로 중복)

  // ⑧ 마진율 입력 라벨
  const marginLabelEl = tr.querySelector('.margin-rate-label');
  if (marginLabelEl) {
    marginLabelEl.innerHTML = it.marginRate > 0
      ? `<span style="color:var(--blue);font-weight:700">개별 ${it.marginRate}%</span>`
      : `<span style="color:var(--text3)">기본 ${r.marginRate}% 적용</span>`;
  }
}

function renderTable() {
  const r    = getRates();
  const tp   = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const sl   = filtered.slice((page-1)*PER_PAGE, page*PER_PAGE);
  const tbody = document.getElementById('mainTbody');

  if (!sl.length) {
    tbody.innerHTML = `<tr class="tbl-empty-row"><td colspan="14">
      <div class="tbl-empty-icon">📭</div>
      ${allProducts.length ? `
        <div style="font-weight:700;color:var(--text);margin-bottom:6px">검색 결과 없음</div>
        <div style="color:var(--text2);font-size:12px">필터를 해제하거나 검색어를 변경해보세요</div>
      ` : `
        <div style="font-weight:700;color:var(--text);font-size:14px;margin-bottom:10px">시작하려면 상품 데이터를 불러오세요</div>
        <div style="display:flex;flex-direction:column;gap:8px;max-width:500px;margin:0 auto 8px;font-size:12px;color:var(--text2);text-align:left;line-height:1.7">
          <div><b style="color:var(--blue)">①</b> 상단 <b>"📥 QSM 상품 불러오기"</b> 클릭 — QSM에 등록된 본인 상품 목록 가져오기</div>
          <div><b style="color:var(--blue)">②</b> 또는 <b>"📂 시트 불러오기"</b> — 기존에 입력한 시트 데이터 가져오기</div>
          <div><b style="color:var(--blue)">③</b> Q10 Auto 사용자라면 — 스캔 후 "🔗 QLens로 보내기"로 자동 등록</div>
        </div>
        <div style="margin-top:10px;font-size:11px;color:var(--text3)">
          💡 소싱가·배송비만 입력하면 마진/추천가가 자동 계산됩니다
        </div>
      `}
    </td></tr>`;
    document.getElementById('pagination').style.display = 'none';
    return;
  }

  // 헤더 모드 라벨 (추천가 헤더는 항상 고정)
  const modeLbl = { normal:'평상시가(¥)', megapon:'🟦 메가포가', megawari:'🟥 메가와리가' };
  const thEvt = document.getElementById('thEventPrice');
  if (thEvt) thEvt.textContent = modeLbl[currentMode];

  tbody.innerHTML = sl.map(it => {
    const ri       = rateFor(it, r);  // ★ v1.9.29: 상품별 수수료율 반영
    const base     = it.basePrice || calcBasePrice(it.sourcePrice, it.shipFee, it.marginRate, ri, it.customerShipJpy);
    const recPrice = calcBasePrice(it.sourcePrice, it.shipFee, ri.marginRate, ri, it.customerShipJpy);
    // ⚠️ event(마진 계산용 판매가) — 현재 QSM 등록가 우선
    const modePrice = currentMode === 'normal'  ? base
                    : currentMode === 'megapon' ? calcMegaponPrice(base, ri)
                    : calcMegawariPrice(base, ri);
    const event    = it.curPrice > 0 ? it.curPrice : modePrice;
    const chk  = _checked.has(it.code);
    const dirty = _dirty.has(it.code);

    const qooUrl = it.code ? `https://www.qoo10.jp/g/${it.code}` : '#';
    const srcHost = it.sourceUrl ? (() => { try { return new URL(it.sourceUrl).hostname.replace('www.',''); } catch { return ''; } })() : '';
    const siteTag = srcHost.includes('oliveyoung') ? '🌿 올리브영'
                  : srcHost.includes('naver')  ? '🟢 네이버'
                  : srcHost.includes('coupang') ? '🛒 쿠팡'
                  : srcHost.includes('kurly')  ? '🟣 마켓컬리'
                  : srcHost ? `🔗 ${srcHost}` : '';

    // ★ 배송비 단위: ¥(엔화)
    const shipFeeJpy   = it.shipFee || r.shipFeeJpy || 0;
    const custShipJpy  = it.customerShipJpy || 0;

    // 무게 기반 예상 배송비(¥) — 요율표 기반
    const weightedShip = it.weight > 0 ? calcShipFromWeight(it.weight, it.carrier || 'MIR REG') : shipFeeJpy;
    const actualShipJpy = shipFeeJpy > 0 ? shipFeeJpy : weightedShip;

    // ★ 총판매액(¥) = 판매가¥ + 고객배송비¥
    const totalSaleJpy = event > 0 ? event + custShipJpy : 0;

    // ★ 비용 계산 (전부 ¥ 단위) — 표시용 총비용
    const srcJpy       = (it.sourcePrice || 0) / r.exchangeRate;
    const qsmFeeJpy    = event > 0 ? totalSaleJpy * ri.qFeeRate / 100 : 0;  // 매출 전체 기준 수수료 (상품별 율)
    const packJpy      = 500 / r.exchangeRate;
    const vatRefJpy    = (it.sourcePrice || 0) * 0.09 / r.exchangeRate;
    const totalCostJpy = srcJpy + actualShipJpy + qsmFeeJpy + packJpy;

    // ★ v1.9.29: 이익·마진율을 통합 함수로 동시 산출 (두 컬럼 영구 일치, 상품별 수수료율)
    const _econ     = calcEventEconomics(it.sourcePrice, actualShipJpy, custShipJpy, event, currentMode, ri);
    const marginPct = _econ.marginPct;
    const profitJpy = _econ.profitJpy || 0;

    const isLoss = marginPct !== null && marginPct < 0;
    const isLow  = marginPct !== null && marginPct >= 0 && marginPct < 5;
    const isHigh = marginPct !== null && marginPct >= 20;
    const marginRowCls = isLoss ? 'margin-loss' : isLow ? 'margin-low' : isHigh ? 'margin-high' : '';
    const fromQ10Cls   = it._fromQ10 ? 'from-q10' : '';

    let marginBadge = '';
    if (marginPct !== null) {
      const cls = isLoss ? 'mbadge-loss' : isLow ? 'mbadge-low' : isHigh ? 'mbadge-high' : 'mbadge-ok';
      const lbl = isLoss ? '역마진' : isLow ? '저마진' : isHigh ? '고마진' : '';
      const modeTag = currentMode === 'megapon' ? '<span style="font-size:8.5px;opacity:.85;margin-left:3px;padding:1px 4px;background:rgba(61,158,255,.2);border-radius:3px;font-weight:700">MP</span>'
                    : currentMode === 'megawari' ? '<span style="font-size:8.5px;opacity:.85;margin-left:3px;padding:1px 4px;background:rgba(255,59,59,.2);border-radius:3px;font-weight:700">MW</span>' : '';
      marginBadge = `<span class="margin-badge ${cls}">${lbl ? lbl+' ' : ''}${marginPct.toFixed(1)}%${modeTag}</span>`;
    }

    const recDiff = recPrice > 0 && event > 0 ? recPrice - event : 0;
    const recDiffHtml = recDiff !== 0 ? `<div class="rec-diff ${recDiff > 0 ? 'up' : 'down'}">${recDiff > 0 ? '▲' : '▼'}¥${Math.abs(recDiff).toLocaleString()}</div>` : '';

    const stockQty = (it.qty === undefined || it.qty === null || it.qty === '') ? null : +it.qty;
    const isSoldOut = it.status === 'S2' && stockQty === 0;
    const sbadge = isSoldOut          ? '<span class="badge badge-soldout">품절</span>'
                 : it.status === 'S2' ? '<span class="badge badge-s2">판매</span>'
                 : it.status === 'S1' ? '<span class="badge badge-s1">중지</span>'
                 : it.status === 'S3' ? '<span class="badge badge-s3">단종</span>'
                 : '<span class="badge badge-s0">대기</span>';

    const carriers = ['', 'MIR REG', 'KSE', 'KSE 선편', 'MIR ECO', 'EMS'];
    const carrierOpts = carriers.map(c =>
      `<option value="${c}" ${it.carrier === c ? 'selected':''}>${c || '— 선택 —'}</option>`).join('');
    const extraOpt = it.carrier && !carriers.includes(it.carrier)
      ? `<option value="${it.carrier}" selected>${it.carrier}</option>` : '';

    // 총비용 툴팁
    const costTooltip = [
      `소싱가 ¥${Math.round(srcJpy).toLocaleString()} (₩${(it.sourcePrice||0).toLocaleString()})`,
      `국제배송 ¥${Math.round(actualShipJpy).toLocaleString()}`,
      `수수료(${ri.qFeeRate}%) ¥${Math.round(qsmFeeJpy).toLocaleString()}`,
      `포장·국내 ¥${Math.round(packJpy).toLocaleString()}`,
      `합계 ¥${Math.round(totalCostJpy).toLocaleString()}`,
    ].join('\n');
    const openDisabled = it.sourceUrl ? '' : 'disabled';

    const isBundle = it.itemType === 'bundle' || (_bundlesMap[it.code] && _bundlesMap[it.code].length > 0);
    const componentCount = isBundle ? (_bundlesMap[it.code]?.length || it.componentCount || 0) : 0;
    const isExpanded = _expandedBundles.has(it.code);

    return `<tr class="${chk?'selected-row ':''}${dirty?'dirty-row ':''}${marginRowCls} ${fromQ10Cls} ${isBundle?'bundle-row ':''}${isExpanded?'bundle-expanded ':''}" data-code="${it.code}">
      <td class="td-check"><input type="checkbox" class="row-chk" data-code="${it.code}" ${chk?'checked':''}></td>
      <td>
        ${it._fromQ10 ? '<span class="q10-badge">Q10 수신</span>' : ''}
        ${it.brand ? `<div class="brand-label">${it.brand}</div>` : '<div class="brand-none">· 브랜드 미지정</div>'}
        <div class="item-name">
          ${isBundle ? `<button class="bundle-toggle" data-code="${it.code}" title="${componentCount}개 구성품 ${isExpanded?'접기':'펼치기'}">${isExpanded?'▼':'▶'} <span class="bundle-badge">📦 ${componentCount}</span></button>` : ''}
          <a class="item-link" href="${qooUrl}" target="_blank"
             title="${(it.sellerCode || it.name || '').replace(/"/g, '&quot;')}${it.name && it.sellerCode && it.name !== it.sellerCode ? '\n[JP] ' + it.name.replace(/"/g, '&quot;') : ''}">${it.sellerCode || it.name || ''}</a>
          <button class="btn-edit-name" data-code="${it.code}" title="브랜드·상품명·수수료율 수정" style="margin-left:4px;padding:1px 5px;border-radius:4px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);font-size:10px;cursor:pointer;vertical-align:middle">✏️</button>
        </div>
        <div class="item-code">
          <span class="item-code-num" title="QSM 상품코드">${it.code}</span>
          ${isBundle ? '<span class="bundle-tag">기획세트</span>' : ''}
        </div>
      </td>
      <td class="td-center">
        ${siteTag ? `<div style="font-size:10.5px;font-weight:700;color:var(--blue-dk);margin-bottom:4px">${siteTag}</div>` : '<div style="font-size:10px;color:var(--text3);margin-bottom:4px">미설정</div>'}
        <div style="display:flex;align-items:center;justify-content:center;gap:3px">
          <button class="btn-edit-url" data-code="${it.code}" data-url="${(it.sourceUrl||'').replace(/"/g,'&quot;')}" title="${it.sourceUrl || '소싱URL 입력'}\n클릭하여 수정" style="padding:4px 8px;border-radius:5px;background:var(--bg3);border:1px solid var(--border);color:var(--text);font-size:11px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:3px">
            ${it.sourceUrl ? '✏️' : '➕'}<span style="font-size:10px">${it.sourceUrl ? '수정' : 'URL'}</span>
          </button>
          <button class="btn-open-url" data-url="${it.sourceUrl||''}" title="소싱페이지 열기 + 사이드패널. 큐렌즈를 '분할 보기'로 묶어두면 새 탭 없이 옆칸에서 바로 열립니다" ${openDisabled} style="padding:4px 8px;border-radius:5px;background:var(--blue-lt);border:1px solid var(--blue);color:var(--blue-dk);font-size:12px;font-weight:700;cursor:pointer;line-height:1">↗</button>
        </div>
      </td>
      <td class="td-right">
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:2px">
          <span style="font-size:13px;color:var(--text2);font-weight:700">₩</span>
          <input type="number" class="inline-input" data-field="sourcePrice" data-code="${it.code}" value="${it.sourcePrice||''}" placeholder="0" step="100" style="width:78px;font-weight:700;text-align:right">
        </div>
        ${it.sourcePrice > 0 ? `<div class="conv-jpy">≈ ¥${Math.round(it.sourcePrice/r.exchangeRate).toLocaleString()}</div>` : ''}
      </td>
      <!-- ★ 무게: 기본 0.5kg 힌트 표시 -->
      <td class="td-center">
        <div class="weight-cell">
          <div class="weight-input-row">
            <input type="number" class="inline-input" style="width:46px;text-align:center;padding:6px 4px" data-field="weight" data-code="${it.code}" value="${it.weight||''}" placeholder="0.5" step="0.1" min="0" max="30">
            <span class="weight-unit">kg</span>
          </div>
          ${weightedShip > 0 ? `<div class="ship-auto">≈¥${Math.round(weightedShip).toLocaleString()}</div>` : ''}
        </div>
      </td>
      <!-- 총비용(¥) — hover로 상세 내역 -->
      <td class="td-right cost-cell" style="cursor:help" title="${costTooltip}">
        <div class="cost-main" style="font-family:var(--mono);font-size:13.5px;font-weight:700;color:var(--text)">${totalCostJpy > 0 ? `¥${Math.round(totalCostJpy).toLocaleString()}` : '-'}</div>
        <div class="cost-breakdown" style="display:none"></div>
        <div class="cost-krw" style="font-size:9.5px;color:var(--text3);margin-top:1px">₩${Math.round(totalCostJpy * r.exchangeRate).toLocaleString()} <span style="opacity:.5">↑hover</span></div>
      </td>
      <!-- QSM 판매가(¥) — 인라인 편집 가능 (Enter로 QSM 즉시 반영) -->
      <td class="qsm-price-cell td-right">
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:2px">
          <span style="font-size:13px;color:var(--text2);font-weight:700">¥</span>
          <input type="number" class="inline-input qsm-price-input" data-field="curPrice" data-code="${it.code}"
                 value="${it.curPrice || ''}" placeholder="${event || '0'}" step="10" min="0"
                 style="width:90px;text-align:right;font-weight:800;font-size:13px;padding:7px 5px"
                 title="판매가(¥) 입력 → Enter = QSM 즉시 반영, Tab/포커스해제 = 시트만 저장">
        </div>
        ${custShipJpy > 0 ? `<div class="qsm-ship-fee">+¥${custShipJpy.toLocaleString()} 고객배송</div>` : ''}
        <div class="rec-hint" style="font-size:9px;margin-top:1px;${it.curPrice > 0 ? 'color:var(--text3)' : 'color:var(--orange)'}">${
          it.curPrice > 0 && recPrice > 0 && Math.abs(recPrice - it.curPrice) > 50
            ? `추천 ¥${recPrice.toLocaleString()}`
            : (!it.curPrice && event > 0) ? `추천 ¥${event.toLocaleString()}` : ''
        }</div>
      </td>
      <td class="td-center">
        <select class="carrier-select" data-field="carrier" data-code="${it.code}">
          ${carrierOpts}${extraOpt}
        </select>
      </td>
      <!-- ★ 고객배송비(¥) — 배송 그룹 드롭다운(있으면) 또는 숫자 입력 -->
      <td class="td-right">
        ${_deliveryGroups.length ? `
          <select class="carrier-select cust-ship-select" data-code="${it.code}" style="width:100%;font-size:11px" title="QSM 배송 그룹 선택 → 저장+QSM반영 시 ShippingNo 적용">
            <option value="">— 배송비 —</option>
            ${_deliveryGroups.slice().sort((a,b)=>(+a.ShippingFee||0)-(+b.ShippingFee||0)).map(g => {
              const fee = Math.round(+g.ShippingFee||0);
              const isSel = (it.shippingNo && String(it.shippingNo) === String(g.ShippingNo))
                         || (!it.shippingNo && Math.round(+it.customerShipJpy||0) === fee);
              return `<option value="${g.ShippingNo}" data-fee="${fee}" ${isSel?'selected':''}>${fee===0?'무료':'¥'+fee.toLocaleString()} · ${(g.transcName||g.ShippingName||'').slice(0,8)}</option>`;
            }).join('')}
          </select>
        ` : `
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:2px">
            <span style="font-size:13px;color:var(--text2);font-weight:700">¥</span>
            <input type="number" class="inline-input" data-field="customerShipJpy" data-code="${it.code}"
                   value="${it.customerShipJpy||''}" placeholder="0" step="10"
                   style="width:62px;font-weight:700;text-align:right"
                   title="고객배송비(¥). [🚚 배송비 조회]로 배송 그룹을 불러오면 드롭다운으로 선택 가능">
          </div>
        `}
      </td>
      <!-- ★ 총판매액(¥) = 판매가¥ + 고객배송비¥ -->
      <td class="td-right revenue-cell">
        <div class="rev-num">${totalSaleJpy > 0 ? `¥${Math.round(totalSaleJpy).toLocaleString()}` : '-'}</div>
        ${vatRefJpy > 0 ? `<div class="vat-small">VAT환급 ¥${Math.round(vatRefJpy).toLocaleString()}</div>` : ''}
      </td>
      <!-- 이익(¥) -->
      <td class="td-right">
        <div class="profit-num ${profitJpy >= 0 ? 'pos' : 'neg'}">${totalSaleJpy > 0 ? (profitJpy >= 0 ? '+¥' : '-¥') + Math.abs(Math.round(profitJpy)).toLocaleString() : '-'}</div>
      </td>
      <!-- ★ 마진율 — 현재 모드(평상시/메가포/메가와리) 기준 실제 마진율 + 상품별 수수료율 -->
      <td class="td-center">
        ${marginBadge}
      </td>
      <td class="td-center status-cell">
        ${sbadge}
        <div class="stock-edit ${isSoldOut ? 'zero' : ''}" data-code="${it.code}" title="재고수량 ${stockQty !== null ? stockQty : '미확인'} · 클릭하여 수정">📦 ${stockQty !== null ? stockQty.toLocaleString() : '–'}</div>
      </td>
      <td class="td-center">
        <div class="row-action-wrap">
          ${event > 0 && event !== it.curPrice
            ? `<button class="row-action-primary row-btn-apply" data-code="${it.code}" data-price="${event}" title="QSM에 ¥${event.toLocaleString()} 적용">
                 <span class="action-icon">●</span>
                 <span class="action-label">적용</span>
               </button>`
            : `<button class="row-action-primary disabled" disabled title="${it.curPrice > 0 ? '이미 적용된 가격' : '소싱가/마진을 입력하세요'}">
                 <span class="action-icon">○</span>
                 <span class="action-label">${it.curPrice > 0 ? '동일' : '대기'}</span>
               </button>`}
          <button class="row-action-more" data-code="${it.code}" title="더 보기">▼</button>
          <div class="row-action-menu" data-code="${it.code}">
            <button class="row-action-item row-btn-stock" data-code="${it.code}">
              <span class="mi">✏️</span> <span>가격/재고/종료일 수정</span>
            </button>
            ${!isBundle
              ? `<button class="row-action-item row-btn-convert-bundle" data-code="${it.code}" style="color:#a855f7">
                   <span class="mi">📦</span> <span>기획세트로 전환</span>
                 </button>`
              : `<button class="row-action-item row-btn-add-component" data-code="${it.code}" style="color:#3d9eff">
                   <span class="mi">➕</span> <span>구성품 추가</span>
                 </button>`}
            <div class="row-action-divider"></div>
            ${it.status === 'S2'
              ? `<button class="row-action-item warn row-btn-outofstock" data-code="${it.code}">
                   <span class="mi">📭</span> <span>품절 처리 (재고 0)</span>
                 </button>
                 <button class="row-action-item danger row-btn-discontinued" data-code="${it.code}">
                   <span class="mi">🚫</span> <span>단종 (거래폐지)</span>
                 </button>`
              : it.status === 'S3'
                ? `<button class="row-action-item ok row-btn-restock" data-code="${it.code}">
                     <span class="mi">📦</span> <span>재입고 (수량 설정)</span>
                   </button>`
                : `<button class="row-action-item ok row-btn-activate" data-code="${it.code}">
                     <span class="mi">✅</span> <span>활성화 (판매 재개)</span>
                   </button>
                   <button class="row-action-item ok row-btn-restock" data-code="${it.code}">
                     <span class="mi">📦</span> <span>재입고</span>
                   </button>
                   <button class="row-action-item danger row-btn-discontinued" data-code="${it.code}">
                     <span class="mi">🚫</span> <span>단종</span>
                   </button>`
            }
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');

  // ★ v1.9.11: 펼쳐진 세트의 구성품 행을 부모 행 아래에 삽입
  _expandedBundles.forEach(code => {
    const parentTr = tbody.querySelector(`tr[data-code="${code}"].bundle-row`);
    if (!parentTr) return;
    const comps = _bundlesMap[code] || [];
    const childHtml = renderBundleChildRows(code, comps);
    parentTr.insertAdjacentHTML('afterend', childHtml);
  });

  // 번들 토글 클릭 이벤트
  tbody.querySelectorAll('.bundle-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = btn.dataset.code;
      if (_expandedBundles.has(code)) _expandedBundles.delete(code);
      else _expandedBundles.add(code);
      renderTable();  // 재렌더
    });
  });

  // 자식 행 액션 (편집/삭제/추가)
  tbody.querySelectorAll('.bundle-child-edit').forEach(btn => {
    btn.addEventListener('click', () => openBundleComponentEditor(btn.dataset.code, +btn.dataset.idx));
  });
  tbody.querySelectorAll('.bundle-child-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const code = btn.dataset.code;
      const idx = +btn.dataset.idx;
      if (!confirm(`이 구성품을 삭제하시겠습니까?\n\n(자동으로 시트에 저장됩니다)`)) return;
      const comps = (_bundlesMap[code] || []).slice();
      comps.splice(idx, 1);
      const ok = await saveBundleToSheet(code, comps);
      if (ok) {
        toast('✅ 구성품 삭제 완료', 'ok');
        renderTable(); updateSummary();
      }
    });
  });
  tbody.querySelectorAll('.bundle-add-component').forEach(btn => {
    btn.addEventListener('click', () => openBundleComponentEditor(btn.dataset.code, -1));
  });
  tbody.querySelectorAll('.bundle-convert-single').forEach(btn => {
    btn.addEventListener('click', async () => {
      const code = btn.dataset.code;
      if (!confirm(`이 상품을 단품으로 변환합니다.\n\n구성품 정보는 모두 삭제됩니다. 계속하시겠습니까?`)) return;
      const ok = await deleteBundleFromSheet(code);
      if (ok) {
        _expandedBundles.delete(code);
        toast('✅ 단품으로 변환 완료', 'ok');
        renderTable(); updateSummary();
      }
    });
  });

  // ★ v1.9.12: 단품 → 기획세트로 전환 (드롭다운 메뉴)
  tbody.querySelectorAll('.row-btn-convert-bundle').forEach(btn => {
    btn.addEventListener('click', () => openBundleSetupModal(btn.dataset.code));
  });

  // ★ v1.9.12: 이미 세트인 상품에 구성품 추가 (드롭다운 메뉴)
  tbody.querySelectorAll('.row-btn-add-component').forEach(btn => {
    btn.addEventListener('click', () => {
      _expandedBundles.add(btn.dataset.code);
      renderTable();
      // 펼침 후 모달 열기
      setTimeout(() => openBundleComponentEditor(btn.dataset.code, -1), 100);
    });
  });

  // 페이지네이션
  const pg = document.getElementById('pagination');
  pg.style.display = tp > 1 ? 'flex' : 'none';
  document.getElementById('pgInfo').textContent = `${page} / ${tp}`;
  document.getElementById('pgPrev').disabled = page <= 1;
  document.getElementById('pgNext').disabled = page >= tp;

  // ★ v1.9.18 디버그: 컬럼 정합성 검증 (한 번만 출력)
  if (!window._tableColCheckDone) {
    window._tableColCheckDone = true;
    setTimeout(() => {
      const cols = document.querySelectorAll('#mainTable colgroup col').length;
      const headerTds = document.querySelectorAll('#mainTable thead th').length;
      const firstRow = document.querySelector('#mainTable tbody tr:not(.bundle-child-row):not(.bundle-child-footer):not(.bundle-child-empty):not(.tbl-empty-row)');
      const firstRowTds = firstRow ? firstRow.querySelectorAll('td').length : 0;
      console.log(`[QLens] 📐 컬럼 정합성: colgroup=${cols}, thead=${headerTds}, 첫 행 td=${firstRowTds}`);
      // 모든 부모 행 검증
      const allParentRows = document.querySelectorAll('#mainTable tbody tr:not(.bundle-child-row):not(.bundle-child-footer):not(.bundle-child-empty):not(.tbl-empty-row)');
      let badRows = 0;
      allParentRows.forEach(tr => {
        const tdCount = tr.querySelectorAll(':scope > td').length;
        if (tdCount !== cols) {
          badRows++;
          if (badRows < 5) console.warn(`[QLens] ⚠️ ${tr.dataset.code}: td=${tdCount} (예상 ${cols})`);
        }
      });
      if (badRows > 0) console.warn(`[QLens] ❌ ${badRows}개 행에서 td 수 불일치`);
      else console.log(`[QLens] ✅ 모든 ${allParentRows.length}개 부모 행 td 정합`);
    }, 200);
  }

  // 인라인 입력 이벤트
  tbody.querySelectorAll('.inline-input').forEach(inp => {
    // ★ focus 시점에 이전 값을 저장 (undo용)
    inp.addEventListener('focus', () => {
      inp.dataset.prevValue = inp.value;
    });

    inp.addEventListener('input', () => {
      const code = inp.dataset.code, field = inp.dataset.field;
      const it = allProducts.find(x => x.code === code);
      if (!it) return;
      const val = inp.type === 'number' ? (+inp.value || 0) : inp.value.trim();
      const oldVal = inp.dataset.prevValue !== undefined
        ? (inp.type === 'number' ? (+inp.dataset.prevValue || 0) : inp.dataset.prevValue)
        : it[field];

      // ★ Undo 기록 (값이 실제로 변했을 때만)
      if (oldVal !== val) {
        const labelMap = {
          sourcePrice: '소싱가(₩)', shipFee: '셀러배송비(¥)', curPrice: 'QSM판매가(¥)',
          customerShipJpy: '고객배송비(¥)',
          marginRate: '마진율(%)', weight: '무게(kg)', sourceUrl: '소싱URL',
          carrier: '배송사', memo: '메모', qFeeRate: '수수료율(%)'
        };
        pushUndo(code, field, oldVal, val, labelMap[field] || field);
      }
      it[field] = val;

      // 계산 필드 재계산 (qFeeRate 포함 — 상품별 수수료율 변경 시 추천가/마진 재산출)
      if (['sourcePrice','shipFee','marginRate','curPrice','customerShipJpy','qFeeRate'].includes(field)) {
        it.basePrice = calcBasePrice(it.sourcePrice, it.shipFee, it.marginRate, rateFor(it, r), it.customerShipJpy);
      }
      if (field === 'weight') {
        const newShip = calcShipFromWeight(val, it.carrier || 'MIR REG');
        if (!it.shipFee) it.shipFee = newShip;
        it.basePrice = calcBasePrice(it.sourcePrice, it.shipFee, it.marginRate, rateFor(it, r), it.customerShipJpy);
      }
      // URL 변경 시 새탭 버튼 활성화
      if (field === 'sourceUrl') {
        const btn = inp.closest('.source-url-row')?.querySelector('.btn-open-url');
        if (btn) { btn.dataset.url = val; btn.disabled = !val; }
        // ★ URL에서 소싱처 자동 감지
        if (val) {
          it.sourcingSite = detectSourcingSite(it);
          // 소싱처 태그 업데이트
          const siteDiv = inp.closest('td')?.querySelector('div[style*="blue-dk"]');
          if (siteDiv) {
            const srcHost = val ? (() => { try { return new URL(val).hostname.replace('www.',''); } catch { return ''; } })() : '';
            const siteTag = srcHost.includes('oliveyoung') ? '🌿 올리브영'
                          : srcHost.includes('naver')  ? '🟢 네이버'
                          : srcHost.includes('coupang') ? '🛒 쿠팡'
                          : srcHost.includes('kurly')  ? '🟣 마켓컬리'
                          : srcHost ? `🔗 ${srcHost}` : '';
            siteDiv.textContent = siteTag;
          }
        }
      }

      _dirty.add(code);
      inp.classList.add('dirty');
      updateSummary();
      const row = inp.closest('tr');
      if (row) {
        row.classList.add('dirty-row');
        // ★ 계산 결과 셀 즉시 갱신 (curPrice·qFeeRate 포함 — 마진율/총판매액 재계산)
        if (['weight','sourcePrice','shipFee','marginRate','curPrice','customerShipJpy','qFeeRate'].includes(field)) {
          rerenderRowCells(it, row, r);
        }
      }
      // ★ v1.9.29: 시트/QSM 자동저장 제거 — 로컬 캐시(새로고침 복원용)만 갱신.
      //   실제 시트 저장 + QSM 가격 반영은 [💾 변경사항 저장+QSM반영] 버튼에서 일괄 처리.
      clearTimeout(_autoSaveTimer);
      _autoSaveTimer = setTimeout(() => {
        _saveLocalCache().catch(() => {});
      }, 1000);
    });

    // ★ Enter 키 — curPrice 변경 시 QSM에 즉시 적용
    inp.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const field = inp.dataset.field;
      if (field !== 'curPrice') return;  // 판매가만 즉시 적용 가능
      e.preventDefault();
      const code = inp.dataset.code;
      const it = allProducts.find(x => x.code === code);
      if (!it || !it.curPrice || it.curPrice <= 0) return;
      // 확인 다이얼로그
      if (!confirm(`${it.name.slice(0,30)}\n\nQSM에 판매가 ¥${it.curPrice.toLocaleString()} 즉시 적용?`)) return;
      inp.disabled = true;
      try {
        await applyPriceToItems([it], it.curPrice);
        inp.classList.remove('dirty');
      } finally {
        inp.disabled = false;
      }
    });
  });

  // 판매자코드 인라인 편집
  tbody.querySelectorAll('.seller-code-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const code = inp.dataset.code;
      const it = allProducts.find(x => x.code === code);
      if (!it) return;
      it.seller = inp.value.trim();
      _dirty.add(code);
      inp.classList.add('dirty');
      inp.closest('tr')?.classList.add('dirty-row');
      updateSummary();
    });
  });

  // 배송사 셀렉터 이벤트
  tbody.querySelectorAll('.carrier-select').forEach(sel => {
    if (sel.classList.contains('cust-ship-select')) return;  // 배송 그룹 셀렉트는 아래 전용 핸들러
    sel.addEventListener('change', () => {
      const code = sel.dataset.code;
      const it = allProducts.find(x => x.code === code);
      if (!it) return;
      it.carrier = sel.value;
      _dirty.add(code);
      sel.classList.add('dirty');
      const row = sel.closest('tr');
      row?.classList.add('dirty-row');
      // 배송사 변경 → 요율표 재계산
      if (it.weight > 0) {
        it.shipFee = calcShipFromWeight(it.weight, it.carrier || 'MIR REG');
        it.basePrice = calcBasePrice(it.sourcePrice, it.shipFee, it.marginRate, rateFor(it, r), it.customerShipJpy);
        rerenderRowCells(it, row, r);
      }
      updateSummary();
    });
  });

  // ★ v1.9.29: 고객배송비 = 배송 그룹 드롭다운 선택 → ShippingNo + 배송비(¥) 설정
  tbody.querySelectorAll('.cust-ship-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const it = allProducts.find(x => x.code === sel.dataset.code);
      if (!it) return;
      const opt = sel.selectedOptions[0];
      it.shippingNo = sel.value || '';
      it.customerShipJpy = +opt?.dataset.fee || 0;
      _dirty.add(it.code);
      _saveLocalCache();
      sel.classList.add('dirty');
      const row = sel.closest('tr');
      row?.classList.add('dirty-row');
      if (row) rerenderRowCells(it, row, getRates());
      updateSummary();
    });
  });

  // ★ v1.9.19: URL 수정 버튼 (모달로 편집)
  tbody.querySelectorAll('.btn-edit-url').forEach(btn => {
    btn.addEventListener('click', () => openUrlEditModal(btn.dataset.code, btn.dataset.url || ''));
  });

  // ★ v1.9.29: 상품명(한국어/일본어) 수정 버튼
  tbody.querySelectorAll('.btn-edit-name').forEach(btn => {
    btn.addEventListener('click', () => openNameEditModal(btn.dataset.code));
  });

  // 소싱처 사이드패널 열기 버튼 (메인 창 옆에 부착 + Side Panel 자동 오픈)
  tbody.querySelectorAll('.btn-open-url').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.dataset.url;
      if (!u || !u.startsWith('http')) return;

      try {
        // 1) 사이드패널 열기 (현재 창에)
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (currentTab) {
          try {
            await chrome.sidePanel.open({ windowId: currentTab.windowId });
          } catch(e) { console.warn('SidePanel open 실패:', e); }
        }

        // 2) ★ 분할 보기(Split View, 크롬 140+) 인식
        //    큐렌즈 탭이 이미 분할 상태면 → 새 탭을 만들지 않고 "옆칸(파트너 탭)" 주소만
        //    소싱페이지로 교체 → 분할 레이아웃이 그대로 유지됨. (사용자가 가장 원하는 동작)
        //    분할이 아니면 새 탭으로 폴백.
        const SPLIT_NONE = (chrome.tabs.SPLIT_VIEW_ID_NONE !== undefined) ? chrome.tabs.SPLIT_VIEW_ID_NONE : -1;
        const sid = currentTab ? currentTab.splitViewId : undefined;
        let swapped = false;
        if (sid !== undefined && sid !== null && sid !== SPLIT_NONE) {
          const sameWin = await chrome.tabs.query({ windowId: currentTab.windowId });
          const partner = sameWin.find(t => t.splitViewId === sid && t.id !== currentTab.id);
          if (partner) {
            await chrome.tabs.update(partner.id, { url: u, active: true });
            log(`🔗 분할 보기 옆칸에 소싱페이지 교체 (split 유지): ${u.slice(0, 50)}...`, 'ok');
            swapped = true;
          }
        }
        if (!swapped) {
          // 분할 상태 아님 → (스플릿뷰 안내 모달) → 같은 창의 새 탭으로 열기
          const { lensSplitGuideHide } = await chrome.storage.local.get('lensSplitGuideHide');
          if (!lensSplitGuideHide) {
            const go = await showSplitGuideModal();
            if (!go) return;  // 취소하면 페이지도 안 열림
          }
          await chrome.tabs.create({ url: u, active: true, windowId: currentTab?.windowId });
          log(`🔗 새 탭으로 열림. 💡 소싱 탭을 큐렌즈와 "분할 보기"로 묶으면 다음부터 옆칸에서 바로 갱신됩니다.`, 'ok');
        }
      } catch (err) {
        // 폴백: 새 탭
        window.open(u, '_blank', 'noopener');
      }
    });
  });

  // 체크박스
  tbody.querySelectorAll('.row-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) _checked.add(chk.dataset.code); else _checked.delete(chk.dataset.code);
      updateBulkBar();
      chk.closest('tr').classList.toggle('selected-row', chk.checked);
    });
  });

  // ★ 더보기 메뉴 토글 (v1.9.9)
  tbody.querySelectorAll('.row-action-more').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = btn.dataset.code;
      const menu = tbody.querySelector(`.row-action-menu[data-code="${code}"]`);
      // 다른 열린 메뉴 닫기
      document.querySelectorAll('.row-action-menu.show').forEach(m => {
        if (m !== menu) m.classList.remove('show');
      });
      menu?.classList.toggle('show');
    });
  });
  // 메뉴 항목 클릭 시 자동 닫기 (각 액션 핸들러는 별도)
  tbody.querySelectorAll('.row-action-item').forEach(item => {
    item.addEventListener('click', () => {
      item.closest('.row-action-menu')?.classList.remove('show');
    });
  });

  // 가격 적용 버튼
  tbody.querySelectorAll('.row-btn-apply').forEach(btn => {
    btn.addEventListener('click', async () => {
      const it = allProducts.find(x => x.code === btn.dataset.code);
      if (!it) return;
      await applyPriceToItems([it], +btn.dataset.price);
    });
  });

  // 품절 처리 버튼 (Qty=0 → Status=1)
  tbody.querySelectorAll('.row-btn-outofstock').forEach(btn => {
    btn.addEventListener('click', async () => {
      const it = allProducts.find(x => x.code === btn.dataset.code);
      if (!it) return;
      await handleOutOfStock([it]);
    });
  });

  // 단종 처리 버튼 (Status=3)
  tbody.querySelectorAll('.row-btn-discontinued').forEach(btn => {
    btn.addEventListener('click', async () => {
      const it = allProducts.find(x => x.code === btn.dataset.code);
      if (!it) return;
      await handleDiscontinued([it]);
    });
  });

  // 재입고 처리 버튼 (Status=2 + Qty 입력)
  tbody.querySelectorAll('.row-btn-restock').forEach(btn => {
    btn.addEventListener('click', async () => {
      const it = allProducts.find(x => x.code === btn.dataset.code);
      if (!it) return;
      await handleRestock([it]);
    });
  });

  // 판매 활성화 버튼 (Status=2, 수량 변경 없음)
  tbody.querySelectorAll('.row-btn-activate').forEach(btn => {
    btn.addEventListener('click', async () => {
      const it = allProducts.find(x => x.code === btn.dataset.code);
      if (!it) return;
      await setGoodsStatus([it], '2', '판매 활성화');
    });
  });

  // ✏️ 가격/수량/종료일 직접 수정 버튼
  tbody.querySelectorAll('.row-btn-stock').forEach(btn => {
    btn.addEventListener('click', async () => {
      const it = allProducts.find(x => x.code === btn.dataset.code);
      if (!it) return;
      await showPriceQtyModal([it]);
    });
  });

  // 📦 재고수량 표시 클릭 → 가격/수량 수정 모달
  tbody.querySelectorAll('.stock-edit').forEach(el => {
    el.addEventListener('click', async () => {
      const it = allProducts.find(x => x.code === el.dataset.code);
      if (!it) return;
      await showPriceQtyModal([it]);
    });
  });
}

function updateSummary() {
  document.getElementById('sumOnSale').textContent  = allProducts.filter(x=>x.status==='S2').length;
  document.getElementById('sumStopped').textContent = allProducts.filter(x=>x.status!=='S2').length;
  document.getElementById('sumDirty').textContent   = _dirty.size;
}

function updateBulkBar() {
  const n = _checked.size;
  document.getElementById('sumSelected').textContent = n;
  document.getElementById('bulkInfo').textContent = n + '개 선택됨';
  document.getElementById('bulkBar').classList.toggle('show', n > 0);
}

/* ══════════════════════════════════════════════════════
   QSM 가격 적용 — ItemsOrder.SetGoodsPriceQty (가격만 수정)
══════════════════════════════════════════════════════ */
async function applyPriceToItems(items, fixedPrice = null, forceMode = null) {
  const r = getRates();
  // ★ forceMode 지정 시 현재 화면 모드와 무관하게 해당 모드 가격 적용 (예: 메가와리 종료 후 평상시가 일괄 복귀)
  const mode = forceMode || currentMode;
  const previews = items.map(it => {
    const base = it.basePrice || calcBasePrice(it.sourcePrice, it.shipFee, it.marginRate, rateFor(it, r), it.customerShipJpy);
    const ev   = fixedPrice !== null ? fixedPrice
               : mode === 'normal'  ? base
               : mode === 'megapon' ? calcMegaponPrice(base, r)
               : calcMegawariPrice(base, r);
    return { it, newPrice: ev };
  }).filter(x => x.newPrice > 0 && x.newPrice !== x.it.curPrice);

  if (!previews.length) { toast('변경할 가격이 없습니다', 'err'); return; }

  const modeName = { normal:'평상시', megapon:'🟦 메가포', megawari:'🟥 메가와리' }[mode];
  const modeClass = mode === 'megapon' ? 'pon' : mode === 'megawari' ? 'wari' : 'normal';

  document.getElementById('modalTitle').textContent = `${modeName} 가격 적용 (${previews.length}개)`;
  document.getElementById('modalBody').innerHTML = '아래 상품의 판매가를 QSM에 직접 수정합니다.<br><small style="color:var(--text3)">API: ItemsOrder.SetGoodsPriceQty</small>';
  document.getElementById('modalPreview').style.display = 'block';
  document.getElementById('modalPreview').innerHTML = previews.slice(0, 15).map(({ it, newPrice }) =>
    `<div class="preview-row">
      <div class="preview-name" title="${it.name}">${it.name}</div>
      <span class="preview-price">${fmtP(it.curPrice)}</span>
      <span class="preview-arrow">→</span>
      <span class="preview-new ${modeClass}">${fmtP(newPrice)}</span>
    </div>`).join('') + (previews.length > 15 ? `<div style="color:var(--text3);padding:5px">…외 ${previews.length-15}개</div>` : '');

  const okBtn = document.getElementById('modalOk');
  okBtn.className = `modal-btn confirm ${modeClass}`;
  okBtn.style.background = '';
  okBtn.textContent = `✅ ${previews.length}개 변경`;
  document.getElementById('modal').classList.add('show');

  const ok = await new Promise(res => {
    okBtn.onclick = () => { document.getElementById('modal').classList.remove('show'); res(true); };
    document.getElementById('modalCancel').onclick = () => { document.getElementById('modal').classList.remove('show'); res(false); };
  });
  if (!ok) return;

  showOv('QSM에 가격 변경 중...', `0 / ${previews.length}`, 0);
  let okN = 0, fail = 0;
  for (let i = 0; i < previews.length; i++) {
    const { it, newPrice } = previews[i];
    setOv(`${it.name.slice(0,30)}... (${i+1}/${previews.length})`, (i/previews.length)*100);
    try {
      // 1차: 새 API
      let res = await qsmCall('ItemsOrder.SetGoodsPriceQty', {
        ItemCode: String(it.code),
        Price: String(Math.round(newPrice)),
        SellerCode: it.seller || ''
      }, '1.0');

      // 2차 폴백: 검증된 구 API
      if (!res?.ok) {
        const isInvalidApi = res?.code === undefined || res?.code === -90001 ||
                             /Can't find|HTML|DOCTYPE/i.test(String(res?._raw || res?.msg || ''));
        if (isInvalidApi) {
          log(`⚠️ SetGoodsPriceQty 미작동 → EditGoodsPrice 폴백`, 'warn');
          res = await qsmCall('ItemsBasic.EditGoodsPrice', {
            ItemCode: String(it.code),
            Price: String(Math.round(newPrice)),
            SellerCode: it.seller || ''
          }, '1.0');
        }
      }

      if (res?.ok) {
        // ★ Undo 기록 (이전 가격 → 새 가격)
        const oldPrice = it.curPrice || 0;
        pushUndo(it.code, 'curPrice', oldPrice, Math.round(newPrice), `일괄 가격 적용 (${modeName || '평상시'})`);
        it.curPrice = Math.round(newPrice);
        if (mode === 'normal') it.basePrice = Math.round(newPrice);
        okN++; log(`✅ ${it.name.slice(0,25)} → ¥${Math.round(newPrice).toLocaleString()}`, 'ok');
      } else {
        fail++;
        const raw = res?._raw ? ` (raw: ${String(res._raw).slice(0,60)})` : '';
        log(`⚠️ ${it.name.slice(0,25)}: [${res?.code}] ${res?.msg || res?.error || '실패'}${raw}`, 'warn');
      }
    } catch (e) { fail++; log(`❌ ${it.name.slice(0,25)}: ${e.message}`, 'err'); }
    await new Promise(r => setTimeout(r, 200));
  }

  hideOv();
  renderTable();
  await _saveLocalCache();

  // 시트에 자동 동기화 (연결된 경우)
  if (_webhookUrl && okN > 0) {
    try { await saveToSheet(); } catch {}
  }

  toast(`✅ ${okN}개 완료${fail>0?` / ❌ ${fail}개 실패`:''}`, fail > 0 ? 'err' : 'ok');
}

/* ══════════════════════════════════════════════════════
   ★ NEW: ItemsOrder.SetGoodsPriceQty — 가격/수량/종료일 수정
   Required: ItemCode
   Optional: SellerCode, Price, TaxRate, Qty, ExpireDate
══════════════════════════════════════════════════════ */
async function setPriceAndQty(items, { price, qty, expireDate, perItemPrice = false } = {}) {
  // ★ perItemPrice=true: price 인자 대신 각 상품의 curPrice(화면 등록가)를 그대로 QSM에 푸시
  if (!price && qty === undefined && !expireDate && !perItemPrice) {
    toast('변경할 값이 없습니다 (가격/수량/종료일 중 하나를 입력하세요)', 'err');
    return { ok: false };
  }

  showOv('가격/수량 수정 중...', `0 / ${items.length}`, 0);
  let okN = 0, fail = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.code) { fail++; log(`❌ 상품코드 없음: ${it.name?.slice(0,20)}`, 'err'); continue; }
    setOv(`${it.name.slice(0, 30)} (${i + 1}/${items.length})`, (i / items.length) * 100);

    const itemPrice = perItemPrice ? (it.curPrice || 0) : price;  // ★ 상품별 가격
    const params = { ItemCode: String(it.code) };
    if (it.seller) params.SellerCode = it.seller;
    if (itemPrice && itemPrice > 0) params.Price = String(Math.round(itemPrice));
    if (qty !== undefined && qty >= 0) params.Qty = String(qty);
    if (expireDate) params.ExpireDate = expireDate;

    try {
      // 1차: 새 API ItemsOrder.SetGoodsPriceQty
      let res = await qsmCall('ItemsOrder.SetGoodsPriceQty', params, '1.0');
      console.log(`[QLens-Price] ${it.code} SetGoodsPriceQty 요청:`, JSON.stringify(params), '→ 응답:', JSON.stringify(res)?.slice(0, 400));

      // 2차 폴백: 구 API 조합 (가격/수량 분리 호출)
      if (!res?.ok) {
        const isInvalidApi = res?.code === undefined || res?.code === -90001 ||
                             /Can't find|HTML|DOCTYPE/i.test(String(res?._raw || res?.msg || ''));
        if (isInvalidApi) {
          log(`⚠️ SetGoodsPriceQty 미작동 [${res?.code}] → 구 API 폴백 시도`, 'warn');
          let priceOk = true, qtyOk = true;

          // 가격 변경
          if (itemPrice && itemPrice > 0) {
            const r1 = await qsmCall('ItemsBasic.EditGoodsPrice', {
              ItemCode: String(it.code), Price: String(Math.round(itemPrice)),
              SellerCode: it.seller || ''
            }, '1.0');
            console.log(`[QLens-Price] ${it.code} EditGoodsPrice 폴백 → 응답:`, JSON.stringify(r1)?.slice(0, 400));
            priceOk = r1?.ok || false;
            if (!priceOk) log(`⚠️ EditGoodsPrice 실패: [${r1?.code}] ${r1?.msg || r1?.error}`, 'warn');
          }
          // 수량 변경
          if (qty !== undefined && qty >= 0) {
            const r2 = await qsmCall('ItemsBasic.EditGoodsInventory', {
              ItemCode: String(it.code), Qty: String(qty),
              SellerCode: it.seller || ''
            }, '1.0');
            qtyOk = r2?.ok || false;
            if (!qtyOk) log(`⚠️ EditGoodsInventory 실패: [${r2?.code}] ${r2?.msg}`, 'warn');
          }
          // 둘 다 성공 (또는 안 보냄)이면 OK
          if (priceOk && qtyOk) res = { ok: true, _fallback: true };
        }
      }

      if (res?.ok) {
        if (itemPrice && itemPrice > 0) it.curPrice = Math.round(itemPrice);
        if (qty !== undefined) it._inventory = qty;
        okN++;
        const parts = [];
        if (itemPrice && itemPrice > 0) parts.push(`¥${Math.round(itemPrice).toLocaleString()}`);
        if (qty !== undefined) parts.push(`재고 ${qty}개`);
        if (expireDate) parts.push(`종료 ${expireDate}`);
        log(`✅ ${it.name.slice(0, 25)} → ${parts.join(' / ')}${res._fallback ? ' (구API)' : ''}`, 'ok');
        _dirty.add(it.code);
      } else {
        fail++;
        const raw = res?._raw ? ` (raw: ${String(res._raw).slice(0,80)})` : '';
        log(`⚠️ ${it.name.slice(0, 25)}: [${res?.code}] ${res?.msg || res?.error || '수정 실패'} ${res?.code === undefined ? '(응답코드없음)' : ''}${raw}`, 'warn');
      }
    } catch (e) {
      fail++;
      log(`❌ ${it.name.slice(0, 25)}: ${e.message}`, 'err');
    }
    await new Promise(r => setTimeout(r, 200));
  }

  hideOv();
  renderTable();
  await _saveLocalCache();
  toast(`✅ ${okN}개 완료${fail > 0 ? ` / ❌ ${fail}개 실패` : ''}`, fail > 0 ? 'err' : 'ok');
  return { ok: okN > 0, okN, fail };
}

/* ══════════════════════════════════════════════════════
   ★ v1.9.29: QSM 배송비(배송 그룹) 반영
   - 메소드: ItemsBasic.SetGoodsSubDeliveryGroup (공식 — 옵션 배송비 추가 설정)
   - AddSRcode1 = 구매자가 선택 가능한 추가 배송비 코드(ShippingNo)
══════════════════════════════════════════════════════ */
async function _callShippingEdit(it, shippingNo) {
  // ItemCode(필수)만 사용 — SellerCode는 큐렌즈에선 한국어 상품명이라 -10001 위험
  const params = {
    ItemCode: String(it.code),
    AddSRcode1: String(shippingNo),
  };
  const res = await qsmCall('ItemsBasic.SetGoodsSubDeliveryGroup', params, '1.0');
  console.log(`[QLens-Ship] SetGoodsSubDeliveryGroup ${it.code} (AddSRcode1=${shippingNo}) →`, JSON.stringify(res)?.slice(0, 300));
  return res;
}

async function pushShippingForItems(items) {
  const targets = items.filter(it => it.code && (it.shippingNo || +it.customerShipJpy >= 0));
  if (!targets.length) return { ok: false, reason: 'no-target' };

  const groups = _deliveryGroups.length ? _deliveryGroups : await fetchDeliveryGroups();

  let okN = 0, fail = 0;
  for (const it of targets) {
    // ★ 드롭다운으로 선택한 ShippingNo 우선, 없으면 배송비(¥) 일치 그룹 자동 매칭
    let shippingNo = it.shippingNo;
    let feeLabel = it.customerShipJpy;
    if (!shippingNo) {
      const want = Math.round(+it.customerShipJpy || 0);
      const match = groups.find(g => Math.round(+g.ShippingFee || 0) === want);
      if (!match) {
        console.warn(`[QLens-Ship] ${it.code} 배송비 ¥${want}에 맞는 배송 그룹 없음 → [🚚 배송비 조회] 후 드롭다운에서 직접 선택하세요`);
        fail++; continue;
      }
      shippingNo = match.ShippingNo; feeLabel = match.ShippingFee;
    }
    const res = await _callShippingEdit(it, shippingNo);
    console.log(`[QLens-Ship] ${it.code} → ShippingNo ${shippingNo}(¥${feeLabel}) 최종 응답:`, JSON.stringify(res)?.slice(0, 400));
    if (res?.ok) { okN++; it.shippingNo = shippingNo; }
    else { fail++; log(`⚠️ 배송비 반영 실패 ${it.code}: ${res?.msg || res?.error || res?._raw}`, 'warn'); }
    await new Promise(r => setTimeout(r, 200));
  }
  if (okN) log(`📮 QSM 배송비 반영 ${okN}개 성공${fail ? ` / ${fail}개 실패` : ''}`, 'ok');
  return { ok: okN > 0, okN, fail };
}

// ★ v1.9.29: 셀러 배송 그룹(배송비 템플릿) 목록 조회 — 공용. 조회 성공 시 캐시 + 드롭다운 갱신
async function fetchDeliveryGroups() {
  let groups = [];
  try {
    const gr = await qsmCall('ItemsLookup.GetSellerDeliveryGroupInfo', {}, '1.0');
    const ro = gr?.result || gr?.full?.ResultObject || gr?.ResultObject;
    groups = Array.isArray(ro) ? ro : (ro && ro.ShippingNo !== undefined ? [ro] : []);
  } catch (e) { console.warn('[QLens-Ship] 배송 그룹 조회 실패:', e.message); }
  console.log('[QLens-Ship] 배송 그룹:', groups.map(g => ({ no: g.ShippingNo, fee: g.ShippingFee, type: g.ShippingType, name: g.transcName || g.ShippingName })));
  if (groups.length) {
    _deliveryGroups = groups;
    storageSet({ lensDeliveryGroups: groups });
    renderTable();  // 고객배송비 칸을 드롭다운으로 갱신
  }
  return groups;
}

// ★ v1.9.29: 배송비 조회 — 셀러 배송 그룹 목록을 모달로 표시
async function showDeliveryGroups() {
  setOv?.('배송비 그룹 조회 중...', 30);
  showOv?.('배송비 조회', 'QSM 셀러 배송 그룹 조회 중...', 30);
  const groups = await fetchDeliveryGroups();
  hideOv?.();
  if (!groups.length) { showError?.('배송 그룹을 조회하지 못했습니다 (QSM 인증/권한 확인)', 'qsm'); return; }

  const rows = groups
    .sort((a, b) => (+a.ShippingFee || 0) - (+b.ShippingFee || 0))
    .map(g => {
      const fee = +g.ShippingFee || 0;
      const free = g.ShippingType === 'M' || fee === 0;
      return `<div class="preview-row">
        <div class="preview-name">${g.transcName || g.ShippingName || '-'} <span style="color:var(--text3);font-size:10px">/ ${g.ShippingType || ''}${g.Oversea === 'Y' ? ' · 해외' : ''}</span></div>
        <span class="preview-price" style="color:var(--text3);font-size:11px">No.${g.ShippingNo}</span>
        <span class="preview-arrow"></span>
        <span class="preview-new ${free ? 'normal' : ''}">${free ? '무료' : '¥' + fee.toLocaleString()}</span>
      </div>`;
    }).join('');

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = `🚚 QSM 배송비 그룹 (${groups.length}개)`;
  document.getElementById('modalBody').innerHTML = '셀러센터에 등록된 배송비 템플릿입니다. 상품 배송비는 이 그룹(ShippingNo) 단위로만 지정됩니다.';
  document.getElementById('modalPreview').style.display = 'block';
  document.getElementById('modalPreview').innerHTML = rows;
  const okBtn = document.getElementById('modalOk');
  okBtn.className = 'modal-btn confirm'; okBtn.style.background = ''; okBtn.textContent = '닫기';
  okBtn.onclick = () => modal.classList.remove('show');
  document.getElementById('modalCancel').onclick = () => modal.classList.remove('show');
  modal.classList.add('show');
}

/* ══════════════════════════════════════════════════════
   ★ v1.9.29: 변경사항 저장 + QSM 가격 반영 (수동 일괄)
   - 인라인 수정은 더 이상 자동저장 안 됨 → 이 버튼으로 일괄 처리
   - dirty 상품의 curPrice(화면 등록가)를 QSM에 푸시 + 시트 저장
   - loadProducts(가져오기) 안 함 → 내 수정값이 QSM 기존값으로 덮어써지지 않음
══════════════════════════════════════════════════════ */
async function saveAndPushDirty() {
  const dirtyItems = allProducts.filter(it => _dirty.has(it.code));
  console.log('[QLens-Save] 변경(dirty) 상품:', dirtyItems.length, '개 →',
    dirtyItems.map(i => ({ code: i.code, curPrice: i.curPrice, seller: i.seller, shipFee: i.shipFee, custShip: i.customerShipJpy })));
  if (!dirtyItems.length) { toast('변경된 상품이 없습니다 (먼저 가격 등을 수정하세요)', 'info'); return; }

  const priceItems = dirtyItems.filter(it => it.code && it.curPrice > 0);
  console.log('[QLens-Save] QSM 가격 푸시 대상(curPrice>0):', priceItems.length, '개 / 제외:', dirtyItems.length - priceItems.length, '개(등록가 없음)');

  const shipItems = dirtyItems.filter(it => it.code && (it.shippingNo || +it.customerShipJpy > 0));
  console.log('[QLens-Save] QSM 배송비 반영 대상(ShippingNo/custShip):', shipItems.length, '개');

  // ① QSM 가격 + 배송비(옵션 배송 그룹) 푸시 (확인 후)
  //   ★ 취소해도 시트 저장(②)은 항상 진행 — 소싱가·URL·메모 등은 시트 전용 값이라
  //     QSM 푸시를 안 해도 시트엔 반드시 저장돼야 함 (과거: 취소 시 시트 저장까지 누락되던 버그)
  let qsmPushed = false;
  if (priceItems.length || shipItems.length) {
    const ok = confirm(
      `변경된 상품 ${dirtyItems.length}개\n\n` +
      `• QSM 가격 반영: ${priceItems.length}개 (화면 판매가 ¥)\n` +
      `• QSM 배송비 반영: ${shipItems.length}개 (선택한 배송 그룹)\n\n` +
      `[확인] QSM 반영 + 시트 저장\n[취소] 시트 저장만 (QSM 미반영)`
    );
    if (ok) {
      if (priceItems.length) {
        const pushRes = await setPriceAndQty(priceItems, { perItemPrice: true });
        console.log('[QLens-Save] QSM 가격 푸시 결과:', JSON.stringify(pushRes));
      }
      if (shipItems.length) {
        const shipRes = await pushShippingForItems(shipItems);
        console.log('[QLens-Save] QSM 배송비 푸시 결과:', JSON.stringify(shipRes));
      }
      qsmPushed = true;
    } else {
      console.log('[QLens-Save] QSM 푸시 취소 — 시트 저장만 진행');
    }
  } else {
    console.warn('[QLens-Save] ⚠️ QSM 반영 대상 없음 — 소싱가/URL 등 시트 전용 변경만 저장');
  }

  // ② 시트 저장 — ★ QSM 푸시 여부와 무관하게 항상 실행
  if (!_webhookUrl) {
    toast('⚠️ 시트가 연결되지 않아 저장 못함 (설정에서 webhook 연결 필요)', 'err');
    return;  // _dirty 유지 → 연결 후 재시도 가능
  }
  try {
    await saveToSheet();   // 성공 시 saveToSheet 내부에서 _dirty.clear() 처리
    log('📤 변경사항 시트 저장 완료', 'ok');
    document.querySelectorAll('.inline-input.dirty').forEach(el => el.classList.remove('dirty'));
    document.querySelectorAll('.dirty-row').forEach(el => el.classList.remove('dirty-row'));
    if (qsmPushed) toast('✅ 시트 저장 + QSM 반영 완료', 'ok');
  } catch (e) {
    // ★ 실패 시 _dirty 유지(재시도 가능) + 명확한 에러 표시 (가짜 성공 토스트 제거)
    log('⚠️ 시트 저장 실패: ' + e.message, 'warn');
    toast('❌ 시트 저장 실패: ' + e.message + ' — 변경분 유지됨, 다시 시도하세요', 'err');
  }
}

/* ══════════════════════════════════════════════════════
   ★ v1.9.29: 정산 CSV(sellingreport)로 상품별 수수료율 자동 매핑
   - 평상시(메가할인 N) 주문에서 실효 수수료율 = Qoo10서비스수수료 ÷ 상품결제금
   - 상품코드별 중앙값을 0.5% 단위로 반올림하여 it.qFeeRate에 반영
   - 메가할인(Y) 주문은 수수료율이 왜곡되므로 제외
══════════════════════════════════════════════════════ */
function _parseSettlementCSV(text) {
  const rows = []; let row = [], cur = '', inQ = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (inQ && text[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { row.push(cur); cur = ''; }
    else if ((c === '\n' || c === '\r') && !inQ) { if (cur !== '' || row.length) { row.push(cur); rows.push(row); row = []; cur = ''; } if (c === '\r' && text[i+1] === '\n') i++; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/* ══════════════════════════════════════════════════════
   📤 CSV 가져오기 — 기존 마진계산기/상품관리 데이터를
   한국어 상품명으로 매칭해 소싱처·링크·소싱가 채우기 (없으면 신규 행 추가)
══════════════════════════════════════════════════════ */
// 매칭용 정규화 (공백/특수문자 제거 + 소문자 — 표기 차이 흡수, 그래도 '정확 일치'만)
function _csvNorm(s) {
  return String(s || '').toLowerCase().replace(/[\s\[\]()（）【】·,./_\-]/g, '').trim();
}
// 헤더 키워드로 열 자동 추측 (없으면 -1)
function _guessCol(header, keywords) {
  for (let i = 0; i < header.length; i++) {
    const h = _csvNorm(header[i]);
    if (h && keywords.some(k => h.includes(k))) return i;
  }
  return -1;
}

async function handleCsvImportFile(file) {
  try {
    const text = await file.text();
    const rows = _parseSettlementCSV(text);
    const header = (rows[0] || []).map(h => String(h || '').trim());
    const dataRows = rows.slice(1).filter(r => r.some(c => String(c).trim() !== ''));
    if (!header.length || !dataRows.length) { toast('CSV에 데이터가 없습니다', 'err'); return; }
    showCsvImportModal(header, dataRows);
  } catch (e) {
    toast('❌ CSV 읽기 실패: ' + e.message, 'err');
  }
}

function showCsvImportModal(header, dataRows) {
  document.getElementById('csvImportBackdrop')?.remove();

  const opts = (guess, withNone) =>
    (withNone ? '<option value="-1">(없음)</option>' : '') +
    header.map((h, i) => `<option value="${i}" ${i === guess ? 'selected' : ''}>${i + 1}열: ${(h || '(빈 헤더)').replace(/</g, '&lt;')}</option>`).join('');

  const gName  = _guessCol(header, ['상품명', '품명', '제품명', '상품', '이름', 'name', '한국어', '품목']);
  const gSite  = _guessCol(header, ['소싱처', '판매처', '매입처', '구매처', '사이트', '쇼핑몰', 'site', '출처', '채널']);
  const gUrl   = _guessCol(header, ['url', 'link', '링크', '주소', '소싱url', '소싱링크', '페이지']);
  const gPrice = _guessCol(header, ['소싱가', '매입가', '구매가', '원가', '사입가', '단가', 'price', 'cost', '금액', '가격']);
  const gWeight= _guessCol(header, ['무게', '중량', 'weight', 'kg']);
  const gMargin= _guessCol(header, ['마진', 'margin']);

  const bd = document.createElement('div');
  bd.id = 'csvImportBackdrop';
  bd.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  bd.innerHTML = `
    <div style="background:var(--bg2,#14141f);border:1px solid var(--border,#2e2e45);border-radius:12px;max-width:560px;width:100%;max-height:90vh;overflow:auto;padding:22px;color:var(--text,#eee)">
      <div style="font-size:16px;font-weight:800;margin-bottom:4px">📤 CSV 가져오기 — 열 지정</div>
      <div style="font-size:12px;color:var(--text2,#8aa);margin-bottom:14px">CSV ${dataRows.length}행. 각 항목이 CSV의 <b>어느 열</b>인지 골라주세요. (한국어 상품명으로 매칭됩니다)</div>
      ${[
        ['매칭 기준 — 한국어 상품명 ★', 'csvMapName', gName, false],
        ['소싱처 (올리브영 등)', 'csvMapSite', gSite, true],
        ['소싱처 링크(URL)', 'csvMapUrl', gUrl, true],
        ['소싱가(₩) ★', 'csvMapPrice', gPrice, true],
        ['무게(kg) — 선택', 'csvMapWeight', gWeight, true],
        ['마진율(%) — 선택', 'csvMapMargin', gMargin, true],
      ].map(([label, id, g, none]) => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
          <div style="flex:0 0 175px;font-size:12px;font-weight:600;color:var(--text2,#8aa)">${label}</div>
          <select id="${id}" style="flex:1;padding:8px;border-radius:7px;border:1px solid var(--border,#2e2e45);background:var(--bg3,#1c1c2e);color:var(--text,#eee);font-size:12px">${opts(g, none)}</select>
        </div>`).join('')}
      <div id="csvImportPreview" style="margin-top:12px;padding:11px 13px;background:var(--bg3,#1c1c2e);border-radius:8px;font-size:12px;line-height:1.7;color:var(--text2,#8aa);min-height:20px">아래 [미리보기]를 눌러 매칭 결과를 확인하세요.</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button id="csvImportCancel" style="padding:9px 16px;border-radius:8px;border:1px solid var(--border,#2e2e45);background:transparent;color:var(--text2,#8aa);font-weight:700;cursor:pointer">취소</button>
        <button id="csvImportPreviewBtn" style="padding:9px 16px;border-radius:8px;border:1px solid var(--blue,#3d9eff);background:transparent;color:var(--blue,#3d9eff);font-weight:700;cursor:pointer">🔍 미리보기</button>
        <button id="csvImportApply" style="padding:9px 16px;border-radius:8px;border:none;background:linear-gradient(135deg,#1a73e8,#4f9eff);color:#fff;font-weight:800;cursor:pointer">✅ 가져오기</button>
      </div>
    </div>`;
  document.body.appendChild(bd);

  const readMap = () => ({
    name:   +document.getElementById('csvMapName').value,
    site:   +document.getElementById('csvMapSite').value,
    url:    +document.getElementById('csvMapUrl').value,
    price:  +document.getElementById('csvMapPrice').value,
    weight: +document.getElementById('csvMapWeight').value,
    margin: +document.getElementById('csvMapMargin').value,
  });
  // 매칭 계산
  const computeImport = (m) => {
    const idx = {};
    allProducts.forEach(p => { const k = _csvNorm(p.sellerCode || p.seller || ''); if (k) idx[k] = p; });
    let matched = 0, added = 0, skipped = 0;
    const plan = [];
    dataRows.forEach(r => {
      const nm = (r[m.name] || '').trim();
      const key = _csvNorm(nm);
      if (!key) { skipped++; return; }
      const price = m.price >= 0 ? parseInt(String(r[m.price]).replace(/[^\d]/g, '')) || 0 : 0;
      const site  = m.site  >= 0 ? (r[m.site] || '').trim() : '';
      const url   = m.url   >= 0 ? (r[m.url] || '').trim()  : '';
      const wt    = m.weight>= 0 ? parseFloat(String(r[m.weight]).replace(/[^\d.]/g, '')) || 0 : 0;
      const mg    = m.margin>= 0 ? parseFloat(String(r[m.margin]).replace(/[^\d.]/g, '')) || 0 : 0;
      const hit = idx[key];
      if (hit) matched++; else added++;
      plan.push({ nm, key, price, site, url, wt, mg, hit });
    });
    return { matched, added, skipped, plan };
  };

  document.getElementById('csvImportCancel').onclick = () => bd.remove();
  document.getElementById('csvImportPreviewBtn').onclick = () => {
    const m = readMap();
    if (m.name < 0) { toast('매칭 기준(한국어 상품명) 열을 골라주세요', 'err'); return; }
    const { matched, added, skipped, plan } = computeImport(m);
    const sample = plan.slice(0, 4).map(p =>
      `${p.hit ? '✅ 매칭' : '➕ 신규'} · ${p.nm.slice(0, 22)} ${p.price ? '₩' + p.price.toLocaleString() : ''}`).join('<br>');
    document.getElementById('csvImportPreview').innerHTML =
      `<b style="color:var(--text,#eee)">매칭 ${matched}개 · 신규추가 ${added}개</b>${skipped ? ` · 건너뜀 ${skipped}개(상품명 없음)` : ''}<br>` +
      `<span style="color:var(--text3,#667)">${sample || '대상 없음'}${plan.length > 4 ? '<br>…' : ''}</span>`;
  };
  document.getElementById('csvImportApply').onclick = () => {
    const m = readMap();
    if (m.name < 0)  { toast('매칭 기준(한국어 상품명) 열을 골라주세요', 'err'); return; }
    if (m.price < 0 && m.site < 0 && m.url < 0) { toast('가져올 값(소싱가/소싱처/링크) 중 하나는 골라주세요', 'err'); return; }
    applyCsvImport(computeImport(m).plan);
    bd.remove();
  };
}

function applyCsvImport(plan) {
  const r = getRates();
  let matched = 0, added = 0;
  plan.forEach(p => {
    if (p.hit) {
      const it = p.hit;
      if (p.site)  it.sourcingSite = p.site;
      if (p.url)   { it.sourceUrl = p.url; if (!it.sourcingSite) it.sourcingSite = detectSourcingSite(it); }
      if (p.price) it.sourcePrice = p.price;
      if (p.wt)    it.weight = p.wt;
      if (p.mg)    it.marginRate = p.mg;
      it.basePrice = calcBasePrice(it.sourcePrice, it.shipFee, it.marginRate, rateFor(it, r), it.customerShipJpy);
      if (it.code) _dirty.add(it.code);
      matched++;
    } else {
      const np = {
        code: '', seller: p.nm, sellerCode: p.nm, name: '', brand: '',
        status: 'S2', sourcingSite: p.site || (p.url ? detectSourcingSite({ sourceUrl: p.url }) : ''),
        sourceUrl: p.url || '', sourcePrice: p.price || 0,
        weight: p.wt || 0.5, carrier: '', marginRate: p.mg || '',
        curPrice: 0, customerShipJpy: 0, basePrice: 0, memo: 'CSV 가져오기',
        itemType: 'single', componentCount: 0, qFeeRate: '',
      };
      np.basePrice = calcBasePrice(np.sourcePrice, np.shipFee, np.marginRate, rateFor(np, r), np.customerShipJpy);
      allProducts.push(np);
      added++;
    }
  });
  _saveLocalCache().catch(() => {});
  applyFilter(); updateSummary();
  toast(`✅ 가져오기 완료 — 매칭 ${matched}개, 신규 ${added}개. [📤 시트에 저장]으로 반영하세요`, 'ok');
  log(`CSV 가져오기: 매칭 ${matched}, 신규 ${added}`, 'ok');
}

async function syncFeeRatesFromSettlement(file) {
  try {
    const text = await file.text();
    const rows = _parseSettlementCSV(text);
    if (rows.length < 2) { toast('정산 CSV에 데이터가 없습니다', 'err'); return; }
    const header = rows[0].map(h => h.trim());
    const idx = {};
    header.forEach((h, i) => idx[h] = i);
    const need = ['상품코드', '상품결제금', 'Qoo10서비스수수료'];
    const missing = need.filter(n => idx[n] === undefined);
    if (missing.length) { toast(`정산 CSV 형식 오류 — 누락 컬럼: ${missing.join(', ')}`, 'err'); return; }
    const numOf = (r, name) => { const v = (r[idx[name]] || '').replace(/[",¥\s]/g, ''); return parseFloat(v) || 0; };

    // 상품코드별 평상시(N) 수수료율 수집
    const byCode = {};
    rows.slice(1).forEach(r => {
      if (r.length < header.length - 2) return;
      const mega = (r[idx['메가할인상품']] || '').trim();
      if (mega === 'Y') return;  // 메가 제외
      const code = (r[idx['상품코드']] || '').trim();
      const pay = numOf(r, '상품결제금'), fee = numOf(r, 'Qoo10서비스수수료');
      if (!code || pay <= 0 || fee < 0) return;
      (byCode[code] = byCode[code] || []).push(fee / pay * 100);
    });

    // 각 상품에 중앙값 반영 (0.5% 단위)
    let applied = 0; const detail = [];
    allProducts.forEach(it => {
      const rates = byCode[String(it.code)];
      if (rates && rates.length) {
        const sorted = rates.slice().sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        const rounded = Math.round(med * 2) / 2;  // 0.5% 단위
        if (it.qFeeRate !== rounded) {
          pushUndo(it.code, 'qFeeRate', it.qFeeRate || '', rounded, '수수료율(%) ← 정산CSV');
          it.qFeeRate = rounded;
          _dirty.add(it.code);
        }
        applied++;
        if (detail.length < 8) detail.push(`${(it.brand?it.brand+' ':'')}${(it.name||it.code).slice(0,18)} → ${rounded}% (${rates.length}건)`);
      }
    });

    if (!applied) { toast('매칭되는 상품이 없습니다 (상품코드 불일치)', 'err'); return; }
    renderTable();
    await _saveLocalCache();
    log(`📊 정산 CSV 수수료율 반영 ${applied}개:\n  ${detail.join('\n  ')}${applied>detail.length?`\n  …외 ${applied-detail.length}개`:''}`, 'ok');
    toast(`✅ ${applied}개 상품 수수료율 자동 반영 (정산 실측). 💾 저장+QSM반영으로 시트 저장`, 'ok');
  } catch (e) {
    toast('정산 CSV 처리 실패: ' + e.message, 'err');
    console.error(e);
  }
}

/* ══════════════════════════════════════════════════════
   ★ NEW: ItemsBasic.EditGoodsStatus — 거래상태 변경
   Required: ItemCode, Status
   Status: 1=거래대기(On Queue), 2=거래가능(Available), 3=거래폐지(Deleted)
══════════════════════════════════════════════════════ */
async function setGoodsStatus(items, status, label) {
  const statusMap = { '1': '거래대기', '2': '거래가능', '3': '거래폐지' };
  const statusLabel = label || statusMap[status] || status;
  showOv(`${statusLabel} 처리 중...`, `0 / ${items.length}`, 0);
  let okN = 0, fail = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.code) { fail++; log(`❌ 상품코드 없음: ${it.name?.slice(0,20)}`, 'err'); continue; }
    setOv(`${it.name.slice(0, 30)} (${i + 1}/${items.length})`, (i / items.length) * 100);

    try {
      // 1차: ItemsBasic.EditGoodsStatus (Status=1/2/3)
      let res = await qsmCall('ItemsBasic.EditGoodsStatus', {
        ItemCode: String(it.code),
        Status:   String(status),
        SellerCode: it.seller || ''
      }, '1.0');

      // 2차 폴백: 구 API들 순차 시도 (S1=거래대기, S2=거래가능)
      if (!res?.ok && (status === '1' || status === '2')) {
        const legacyStatus = status === '2' ? 'S2' : 'S1';
        // 시도 1: ItemsBasic.EditGoodsSaleStatus
        log(`⚠️ EditGoodsStatus 실패 [${res?.code}] → EditGoodsSaleStatus 시도`, 'warn');
        res = await qsmCall('ItemsBasic.EditGoodsSaleStatus', {
          ItemCode: String(it.code),
          SaleStatus: legacyStatus,
          SellerCode: it.seller || ''
        }, '1.0');

        // 시도 2: ItemsBasic.EditGoodsInventory (수량 0/1로 우회)
        if (!res?.ok) {
          log(`⚠️ EditGoodsSaleStatus 실패 [${res?.code}] → EditGoodsInventory 우회 시도`, 'warn');
          const qtyVal = status === '1' ? '0' : '999';
          res = await qsmCall('ItemsBasic.EditGoodsInventory', {
            ItemCode: String(it.code), Qty: qtyVal,
            SellerCode: it.seller || ''
          }, '1.0');
        }
      }

      // 단종(3)일 때만 별도 폴백
      if (!res?.ok && status === '3') {
        log(`⚠️ EditGoodsStatus 실패 [${res?.code}] → EditGoodsExpireDate 우회 시도`, 'warn');
        // 판매종료일을 과거로 설정 → 단종 효과
        res = await qsmCall('ItemsBasic.EditGoodsExpireDate', {
          ItemCode: String(it.code),
          ExpireDate: '2020-01-01',
          SellerCode: it.seller || ''
        }, '1.0');
      }

      if (res?.ok) {
        it.status = status === '1' ? 'S1' : status === '2' ? 'S2' : 'S3';
        okN++;
        log(`✅ ${it.name.slice(0, 25)} → ${statusLabel}`, 'ok');
        _dirty.add(it.code);
      } else {
        fail++;
        const errMsg = res?.msg || res?.error || '상태 변경 실패';
        const raw    = res?._raw ? ` (raw: ${String(res._raw).slice(0,80)})` : '';
        const codeHint = res?.code === -10002 ? '(심사중)' : res?.code === -10003 ? '(판매정지)'
                       : res?.code === -10004 ? '(제한)' : res?.code === -10005 ? '(반려)'
                       : res?.code === -10006 ? '(잘못된Status값)' : res?.code === undefined ? '(응답코드없음-API확인필요)' : '';
        log(`❌ ${it.name.slice(0, 25)}: [${res?.code}] ${errMsg} ${codeHint}${raw}`, 'err');
      }
    } catch (e) {
      fail++;
      log(`❌ ${it.name.slice(0, 25)}: ${e.message}`, 'err');
    }
    await new Promise(r => setTimeout(r, 150));
  }

  hideOv();
  renderTable();
  updateSummary();
  await _saveLocalCache();
  toast(`✅ ${okN}개 ${statusLabel} 완료${fail > 0 ? ` / ❌ ${fail}개 실패` : ''}`, fail > 0 ? 'err' : 'ok');
  return { ok: okN > 0, okN, fail };
}

/* ══════════════════════════════════════════════════════
   품절 처리: 수량 0으로만 설정 (상태는 S2 거래가능 유지)
   → QSM에서 "품절"로 표시 (수량 0이면 자동)
   → 상태를 S1(거래대기)로 바꾸면 "판매중지"로 표시되므로 안 함
══════════════════════════════════════════════════════ */
async function handleOutOfStock(items) {
  const names = items.map(x => (x.brand ? x.brand + ' ' : '') + x.name).slice(0, 5);
  const extra = items.length > 5 ? `\n…외 ${items.length - 5}개` : '';

  document.getElementById('modalTitle').textContent = `📭 품절 처리 (${items.length}개)`;
  document.getElementById('modalBody').innerHTML =
    `재고수량을 <strong>0</strong>으로 설정합니다. 거래상태는 <strong>판매중(S2)</strong> 그대로 유지됩니다.<br>` +
    `→ QSM에서 <strong style="color:var(--orange)">"품절"</strong>로 표시됩니다. (재입고 시 수량만 채우면 즉시 판매 재개)`;
  document.getElementById('modalPreview').style.display = 'block';
  document.getElementById('modalPreview').innerHTML =
    names.map(n => `<div class="preview-row"><div class="preview-name">${n}</div><span class="preview-new" style="color:var(--orange)">→ 품절(재고0)</span></div>`).join('') + extra;

  const okBtn = document.getElementById('modalOk');
  okBtn.className = 'modal-btn confirm';
  okBtn.style.background = 'linear-gradient(135deg,#d97706,#f59e0b)';
  okBtn.textContent = `📭 ${items.length}개 품절 처리`;
  document.getElementById('modal').classList.add('show');

  const confirmed = await new Promise(res => {
    okBtn.onclick = () => { document.getElementById('modal').classList.remove('show'); res(true); };
    document.getElementById('modalCancel').onclick = () => { document.getElementById('modal').classList.remove('show'); res(false); };
  });
  if (!confirmed) return;

  // 수량 0으로만 설정 — 상태 변경 안 함
  log('📭 품절: 수량 0 설정 중... (상태는 S2 유지)', 'info');
  await setPriceAndQty(items, { qty: 0 });
  items.forEach(it => { it.qty = 0; });  // ★ 화면 재고 즉시 0 반영 (품절 배지)
  applyFilter();
  // ★ setGoodsStatus 호출 안 함 → QSM에서 "품절"로 표시됨
}

/* ══════════════════════════════════════════════════════
   판매중지: Status=1(거래대기) 변경
   → QSM에서 "판매중지(판매자)"로 표시
══════════════════════════════════════════════════════ */
async function handleSuspend(items) {
  const names = items.map(x => (x.brand ? x.brand + ' ' : '') + x.name).slice(0, 5);
  const extra = items.length > 5 ? `\n…외 ${items.length - 5}개` : '';

  document.getElementById('modalTitle').textContent = `🛑 판매중지 처리 (${items.length}개)`;
  document.getElementById('modalBody').innerHTML =
    `거래상태를 <strong>거래대기(S1)</strong>로 변경합니다.<br>` +
    `→ QSM에서 <strong style="color:var(--text2)">"판매중지(판매자)"</strong>로 표시됩니다. (검색 노출 차단)`;
  document.getElementById('modalPreview').style.display = 'block';
  document.getElementById('modalPreview').innerHTML =
    names.map(n => `<div class="preview-row"><div class="preview-name">${n}</div><span class="preview-new" style="color:var(--text2)">→ 판매중지</span></div>`).join('') + extra;

  const okBtn = document.getElementById('modalOk');
  okBtn.className = 'modal-btn confirm';
  okBtn.style.background = 'linear-gradient(135deg,#6b7280,#9ca3af)';
  okBtn.textContent = `🛑 ${items.length}개 판매중지`;
  document.getElementById('modal').classList.add('show');

  const confirmed = await new Promise(res => {
    okBtn.onclick = () => { document.getElementById('modal').classList.remove('show'); res(true); };
    document.getElementById('modalCancel').onclick = () => { document.getElementById('modal').classList.remove('show'); res(false); };
  });
  if (!confirmed) return;

  await setGoodsStatus(items, '1', '판매중지');
}

/* ══════════════════════════════════════════════════════
   단종 처리: Status=3(거래폐지)
══════════════════════════════════════════════════════ */
async function handleDiscontinued(items) {
  const names = items.map(x => (x.brand ? x.brand + ' ' : '') + x.name).slice(0, 5);
  const extra = items.length > 5 ? `\n…외 ${items.length - 5}개` : '';

  document.getElementById('modalTitle').textContent = `🚫 단종 처리 (${items.length}개)`;
  document.getElementById('modalBody').innerHTML =
    `<strong style="color:var(--red)">거래폐지(3)</strong> 상태로 변경합니다.<br>` +
    `⚠️ 단종 처리된 상품은 큐텐에서 검색되지 않으며, 재입고 처리로 복구할 수 있습니다.`;
  document.getElementById('modalPreview').style.display = 'block';
  document.getElementById('modalPreview').innerHTML =
    names.map(n => `<div class="preview-row"><div class="preview-name">${n}</div><span class="preview-new" style="color:var(--red)">→ 단종(거래폐지)</span></div>`).join('') + extra;

  const okBtn = document.getElementById('modalOk');
  okBtn.className = 'modal-btn confirm';
  okBtn.style.background = 'linear-gradient(135deg,#dc2626,#ef4444)';
  okBtn.textContent = `🚫 ${items.length}개 단종 처리`;
  document.getElementById('modal').classList.add('show');

  const confirmed = await new Promise(res => {
    okBtn.onclick = () => { document.getElementById('modal').classList.remove('show'); res(true); };
    document.getElementById('modalCancel').onclick = () => { document.getElementById('modal').classList.remove('show'); res(false); };
  });
  if (!confirmed) return;

  await setGoodsStatus(items, '3', '단종(거래폐지)');
}

/* ══════════════════════════════════════════════════════
   재입고 처리: Status=2(거래가능) → SetGoodsPriceQty(Qty=N)
══════════════════════════════════════════════════════ */
async function handleRestock(items) {
  // 재입고 수량 모달
  const modal = document.getElementById('qtyModal');
  document.getElementById('qtyModalTitle').textContent = `재입고 처리 (${items.length}개)`;
  document.getElementById('qtyModalDesc').textContent =
    '재고수량을 입력하면 거래가능(2) 상태로 자동 변경됩니다.';
  document.getElementById('qtyModalItems').innerHTML =
    items.slice(0, 8).map(it =>
      `<div class="qty-modal-item">📦 ${it.code} | ${(it.brand ? it.brand + ' ' : '') + it.name.slice(0, 35)}</div>`
    ).join('') + (items.length > 8 ? `<div class="qty-modal-item" style="color:var(--text3)">…외 ${items.length - 8}개</div>` : '');

  document.getElementById('qtyInput').value = '100';
  modal.classList.add('show');
  document.getElementById('qtyInput').focus();

  const qty = await new Promise(res => {
    document.getElementById('qtyModalOk').onclick = () => {
      const v = parseInt(document.getElementById('qtyInput').value);
      if (isNaN(v) || v < 1) { toast('1 이상의 수량을 입력하세요', 'err'); return; }
      modal.classList.remove('show');
      res(v);
    };
    document.getElementById('qtyModalCancel').onclick = () => {
      modal.classList.remove('show');
      res(null);
    };
  });
  if (qty === null) return;

  // Step 1: 거래가능(2) 상태 변경
  log(`📦 재입고: 거래가능(2) 상태 변경 중...`, 'info');
  const r1 = await setGoodsStatus(items, '2', '재입고(거래가능)');

  // Step 2: 수량 설정 (상태 변경 성공한 항목만)
  const successItems = r1.ok ? items : [];
  if (successItems.length > 0) {
    log(`📦 재입고: 수량 ${qty}개 설정 중...`, 'info');
    await setPriceAndQty(successItems, { qty });
    successItems.forEach(it => { it.qty = qty; });  // ★ 화면 재고 즉시 반영
    applyFilter();
  }
}

/* ══════════════════════════════════════════════════════
   가격/수량/종료일 직접 수정 모달
══════════════════════════════════════════════════════ */
async function showPriceQtyModal(items) {
  const modal = document.getElementById('priceQtyModal');
  document.getElementById('priceQtyItems').innerHTML =
    items.slice(0, 6).map(it =>
      `<div class="qty-modal-item">🏷️ ${it.code} | ${(it.brand ? it.brand + ' ' : '') + it.name.slice(0, 35)} — 현재 ¥${(it.curPrice || 0).toLocaleString()}</div>`
    ).join('') + (items.length > 6 ? `<div class="qty-modal-item" style="color:var(--text3)">…외 ${items.length - 6}개</div>` : '');

  document.getElementById('pqPrice').value = '';
  // ★ 단일 상품이고 현재 재고를 알면 그 값으로, 모르면 기본 99 (품절 복구용)
  const curQty = (items.length === 1 && items[0].qty !== undefined && items[0].qty !== null) ? +items[0].qty : null;
  document.getElementById('pqQty').value = curQty !== null ? String(curQty) : '99';
  document.getElementById('pqExpire').value = '';
  modal.classList.add('show');
  document.getElementById('pqPrice').focus();

  const result = await new Promise(res => {
    document.getElementById('priceQtyOk').onclick = () => {
      const price  = parseInt(document.getElementById('pqPrice').value) || 0;
      const qtyStr = document.getElementById('pqQty').value.trim();
      const qty    = qtyStr !== '' ? parseInt(qtyStr) : undefined;
      const exp    = document.getElementById('pqExpire').value || '';
      if (!price && qty === undefined && !exp) {
        toast('가격, 수량, 종료일 중 하나를 입력하세요', 'err');
        return;
      }
      modal.classList.remove('show');
      res({ price, qty, expireDate: exp });
    };
    document.getElementById('priceQtyCancel').onclick = () => {
      modal.classList.remove('show');
      res(null);
    };
  });
  if (!result) return;

  await setPriceAndQty(items, result);
  // ★ 화면 재고 즉시 갱신 (수량을 입력한 경우)
  if (result.qty !== undefined) {
    items.forEach(it => { it.qty = result.qty; });
    applyFilter();
  }
}

/* ══════════════════════════════════════════════════════
   상태 변경 (구 changeStatus — 내부 호환 브리지)
══════════════════════════════════════════════════════ */
async function changeStatus(items, internalStatus) {
  // 구 코드 호환: S1 → '1', S2 → '2'
  const apiStatus = internalStatus === 'S2' ? '2' : internalStatus === 'S3' ? '3' : '1';
  return await setGoodsStatus(items, apiStatus);
}

/* ══════════════════════════════════════════════════════
   모드 전환
══════════════════════════════════════════════════════ */
function setMode(mode) {
  currentMode = mode;
  ['cardPon','cardWari','cardNormal'].forEach(id => document.getElementById(id).classList.remove('active-pon','active-wari','active-normal'));
  // ★ v1.9.13: 모드 chip 갱신
  const chips = {
    cardNormal: { el: document.getElementById('chipNormal'), activeText: '현재 모드',  idleText: '비활성' },
    cardPon:    { el: document.getElementById('chipPon'),    activeText: '현재 모드',  idleText: '비활성' },
    cardWari:   { el: document.getElementById('chipWari'),   activeText: '현재 모드',  idleText: '비활성' },
  };
  Object.entries(chips).forEach(([id, c]) => {
    if (!c.el) return;
    const isActive = (mode === 'normal' && id === 'cardNormal') || (mode === 'megapon' && id === 'cardPon') || (mode === 'megawari' && id === 'cardWari');
    c.el.className = 'event-mode-chip ' + (isActive ? 'active' : 'idle');
    c.el.textContent = isActive ? c.activeText : c.idleText;
  });
  const lbl = document.getElementById('modeLabel');
  const modeHint = document.getElementById('marginModeHint');
  if (mode === 'megapon') {
    document.getElementById('cardPon').classList.add('active-pon');
    lbl.className = 'mode-indicator mode-pon'; lbl.textContent = '🟦 메가포 모드';
    if (modeHint) { modeHint.textContent = '🟦 메가포'; modeHint.style.color = 'var(--mega-pon)'; }
  } else if (mode === 'megawari') {
    document.getElementById('cardWari').classList.add('active-wari');
    lbl.className = 'mode-indicator mode-wari'; lbl.textContent = '🟥 메가와리 모드';
    if (modeHint) { modeHint.textContent = '🟥 메가와리'; modeHint.style.color = 'var(--mega-wari)'; }
  } else {
    document.getElementById('cardNormal').classList.add('active-normal');
    lbl.className = 'mode-indicator mode-none'; lbl.textContent = '✅ 평상시 모드';
    if (modeHint) { modeHint.textContent = '평상시'; modeHint.style.color = 'var(--green)'; }
  }
  renderTable();
}

/* ══════════════════════════════════════════════════════
   초기화
══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  await updateSheetStatus();
  updateUndoButton();  // ★ 초기 undo 버튼 상태 설정

  // ★ v1.9.13: 모드 카드 펼치기/접기 토글 (헤드 클릭 또는 ▼ 버튼)
  document.querySelectorAll('.event-card-head').forEach(head => {
    head.addEventListener('click', (e) => {
      // input 클릭 시 토글 안 함 (input은 헤드에 없지만 안전장치)
      if (e.target.tagName === 'INPUT') return;
      const card = head.closest('.event-card');
      card.classList.toggle('expanded');
      const toggle = head.querySelector('.event-toggle');
      if (toggle) toggle.textContent = card.classList.contains('expanded') ? '▲' : '▼';
    });
  });

  // ★ 행 액션 드롭다운 메뉴 — 바깥 클릭 시 닫기 (v1.9.9)
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.row-action-wrap')) {
      document.querySelectorAll('.row-action-menu.show').forEach(m => m.classList.remove('show'));
    }
  });

  // 캐시 로드
  const d = await storageGet(['lensItemManagerCache', 'lensDeliveryGroups']);
  if (Array.isArray(d.lensDeliveryGroups) && d.lensDeliveryGroups.length) {
    _deliveryGroups = d.lensDeliveryGroups;  // 배송 그룹 복원 → 고객배송비 드롭다운 활성화
  }
  if (d.lensItemManagerCache?.items?.length && Date.now() - d.lensItemManagerCache.ts < 60*60*1000) {
    allProducts = d.lensItemManagerCache.items;
    // ★ 기획세트 구성품 목록도 캐시에서 복원 (없으면 빈 객체)
    if (d.lensItemManagerCache.bundles && typeof d.lensItemManagerCache.bundles === 'object') {
      _bundlesMap = d.lensItemManagerCache.bundles;
    }
    // ★ v1.9.29: 미저장 변경분(dirty) 복원 → 새로고침/확장 리로드 후에도 [저장+QSM반영] 가능
    if (Array.isArray(d.lensItemManagerCache.dirty) && d.lensItemManagerCache.dirty.length) {
      _dirty = new Set(d.lensItemManagerCache.dirty);
      console.log('[QLens] 미저장 변경분 복원:', _dirty.size, '개', [..._dirty]);
    }
    applyFilter(); updateSummary();
    toast(`캐시된 상품 목록 로드${_dirty.size ? ` (미저장 변경 ${_dirty.size}개)` : ''}`, 'info');

    // ★ 기획세트가 있는데 구성품 목록(_bundlesMap)이 비어 있으면 시트에서 다시 로드
    //   (개수만 뜨고 구성품 목록이 사라지던 문제 방지)
    const hasBundleItems = allProducts.some(p => p.itemType === 'bundle' || +p.componentCount > 0);
    const bundlesEmpty = !_bundlesMap || Object.keys(_bundlesMap).length === 0;
    if (_webhookUrl && hasBundleItems && bundlesEmpty) {
      try { await loadBundlesFromSheet(); applyFilter(); } catch (e) { console.warn('[QLens] 번들 복원 실패:', e); }
    }
  }

  // 환율 + 기본 배송비(¥) 자동 로드
  const cfg = await storageGet(['calcSettings']);
  if (cfg.calcSettings?.exchangeRate) document.getElementById('rExchangeRate').value = cfg.calcSettings.exchangeRate;
  if (cfg.calcSettings?.shipFeeJpy > 0) {
    document.getElementById('rShipFee').value = cfg.calcSettings.shipFeeJpy;
  } else if (cfg.calcSettings?.shippingCost > 0) {
    // ★ 구버전 ₩ 단위 → ¥ 자동 변환
    const legacyJpy = Math.round(cfg.calcSettings.shippingCost / 9.5);
    document.getElementById('rShipFee').value = legacyJpy;
  }
  if (cfg.calcSettings?.marginRate) document.getElementById('rMarginRate').value = cfg.calcSettings.marginRate;
  if (cfg.calcSettings?.qFeeRate)   document.getElementById('rQFeeRate').value   = cfg.calcSettings.qFeeRate;

  // 메가포 카드의 수수료는 평상시 카드와 연동 (읽기 전용)
  document.getElementById('rQFeeRate').addEventListener('input', e => {
    document.getElementById('rQFeeRateP').value = e.target.value;
  });

  // 버튼들
  document.getElementById('btnAutoSync')?.addEventListener('click', autoSyncAll);
  document.getElementById('btnLoad').addEventListener('click', loadProducts);
  document.getElementById('btnLoadPrices').addEventListener('click', loadAllPricesViaCSV);
  document.getElementById('btnSyncShipFees')?.addEventListener('click', syncCustomerShipFees);
  // (v1.8.4: 소싱 데이터 가져오기 버튼/기능 제거)
  document.getElementById('btnSheetLoad').addEventListener('click', loadFromSheet);
  document.getElementById('btnSheetSave').addEventListener('click', saveToSheet);
  document.getElementById('btnSavePush')?.addEventListener('click', saveAndPushDirty);
  document.getElementById('btnOpenSheet')?.addEventListener('click', openSpreadsheet);
  document.getElementById('btnShipGroups')?.addEventListener('click', showDeliveryGroups);
  // ★ v1.9.29: 정산 CSV로 상품별 수수료율 자동 매핑
  document.getElementById('btnSyncFeeRate')?.addEventListener('click', () => document.getElementById('feeRateFileInput')?.click());
  document.getElementById('feeRateFileInput')?.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) syncFeeRatesFromSettlement(f);
    e.target.value = '';
  });

  // 📤 CSV 가져오기 (기존 마진계산기/상품관리 데이터 → 소싱처·링크·소싱가 매칭/추가)
  document.getElementById('btnImportCsv')?.addEventListener('click', () => document.getElementById('csvImportInput')?.click());
  document.getElementById('csvImportInput')?.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) handleCsvImportFile(f);
    e.target.value = '';
  });

  // ★ Undo/Redo 버튼 + 단축키 (v1.8.9)
  document.getElementById('btnUndo')?.addEventListener('click', doUndo);
  document.getElementById('btnRedo')?.addEventListener('click', doRedo);
  document.addEventListener('keydown', (e) => {
    // input/textarea 안에서는 단축키 무시 (브라우저 기본 undo 동작 보존)
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const isMod = e.ctrlKey || e.metaKey;
    if (!isMod) return;
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      doRedo();
    }
  });
  document.getElementById('btnSheetInit')?.addEventListener('click', initSheets);
  document.getElementById('btnFixHeaders')?.addEventListener('click', async () => {
    if (!_webhookUrl) { toast('Webhook URL 설정 필요', 'err'); return; }
    const btn = document.getElementById('btnFixHeaders');
    btn.disabled = true; btn.textContent = '⏳ 헤더 갱신 중...';
    try {
      const res = await postToWebhook('LENS_FIX_HEADERS', {});
      if (!res.ok) throw new Error(res.error);
      toast('✅ 헤더 25컬럼으로 갱신 완료! 데이터는 유지됩니다.', 'ok');
      log('헤더 갱신 완료 (25컬럼 A~Y)', 'ok');
    } catch(e) {
      toast('❌ ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '🔧 헤더 갱신';
    }
  });
  document.getElementById('btnModePon').addEventListener('click', () => setMode('megapon'));
  document.getElementById('btnModeWari').addEventListener('click', () => setMode('megawari'));
  document.getElementById('btnModeNormal').addEventListener('click', () => setMode('normal'));

  // ── 배송비 요율 CSV 업로드 ──────────────────────────────────────
  // CSV 형식: 배송사,무게상한(kg),요금(¥)  — 헤더 1행 + 데이터
  // 예: MIR REG,0.5,600  ← ¥ 엔화 단위
  // ※ 요금이 1000 이상이면 ₩(원화)로 간주, 자동으로 ¥ 변환 (÷9.5)
  document.getElementById('shipRateCsv')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = text.split('\n').map(r => r.trim()).filter(Boolean);
      const newRates = {};
      let parsed = 0, converted = 0;
      rows.slice(1).forEach(row => {  // 헤더 건너뜀
        const cols = row.split(',').map(s => s.trim().replace(/["']/g, ''));
        if (cols.length < 3) return;
        const carrier = cols[0];
        const maxKg   = parseFloat(cols[1]);
        let fee       = parseFloat(cols[2].replace(/[^\d.]/g, ''));
        if (!carrier || isNaN(maxKg) || isNaN(fee)) return;
        // ★ 1000 이상이면 ₩ → ¥ 자동 변환
        if (fee >= 1000) { fee = Math.round(fee / 9.5); converted++; }
        if (!newRates[carrier]) newRates[carrier] = [];
        newRates[carrier].push([maxKg, fee]);
        parsed++;
      });
      // 무게 오름차순 정렬
      Object.keys(newRates).forEach(k => newRates[k].sort((a, b) => a[0] - b[0]));
      // 기존 요율표에 머지
      Object.assign(SHIP_RATES, newRates);
      await storageSet({ lensShipRates: newRates });
      toast(`✅ 요율표 업데이트: ${Object.keys(newRates).join(', ')} (${parsed}행${converted > 0 ? ` / ₩→¥ ${converted}건 자동변환` : ''})`, 'ok');
      log(`요율 CSV 로드: ${parsed}개 구간`, 'ok');
      if (allProducts.length) renderTable();
    } catch (err) {
      toast('❌ CSV 파싱 오류: ' + err.message, 'err');
    } finally {
      e.target.value = '';  // 동일 파일 재업로드 허용
    }
  });

  // 저장된 커스텀 요율 로드
  const rateData = await storageGet(['lensShipRates']);
  if (rateData.lensShipRates) {
    Object.assign(SHIP_RATES, rateData.lensShipRates);
    log('저장된 커스텀 요율표 로드됨', 'ok');
  }

  // 마진계산기 모달 버튼
  document.getElementById('btnMarginCalcCancel')?.addEventListener('click', () => {
    document.getElementById('marginCalcModal').classList.remove('show');
  });
  document.getElementById('btnMarginCalcApply')?.addEventListener('click', applyMarginCalcMatching);
  document.getElementById('marginCalcModal')?.addEventListener('click', e => {
    if (e.target.id === 'marginCalcModal') e.target.classList.remove('show');
  });

  // 시트 연결 도움말
  document.getElementById('btnSheetConnect').addEventListener('click', () => {
    document.getElementById('appsScriptModal').classList.add('show');
  });
  document.getElementById('btnSheetHelp').addEventListener('click', () => {
    document.getElementById('appsScriptModal').classList.add('show');
  });

  // ── 대시보드로 돌아가기
  document.getElementById('btnBackToDashboard')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
  });

  // ── Apps Script 코드 복사 (인라인 onclick 대체)
  function copyAppsScript() {
    const code = document.getElementById('appsScriptCode').textContent;
    navigator.clipboard.writeText(code).then(() => {
      const btn = document.getElementById('btnCopyAppsScript');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✅ 복사됨!';
        setTimeout(() => btn.textContent = orig, 1500);
      }
      toast('✅ Apps Script 코드 복사됨', 'ok');
    }).catch(() => toast('❌ 복사 실패', 'err'));
  }
  document.getElementById('btnCopyAppsScript')?.addEventListener('click', copyAppsScript);

  // ── 코드 복사 + 시트 열기
  document.getElementById('btnCopyAndOpen')?.addEventListener('click', () => {
    copyAppsScript();
    window.open('https://sheets.google.com/', '_blank');
  });

  // ── 도움말 모달 닫기
  document.getElementById('btnCloseAppsScript')?.addEventListener('click', () => {
    document.getElementById('appsScriptModal').classList.remove('show');
  });

  // 필터
  ['searchInput','statusFilter','srcFilter','brandFilter','marginFilter','typeFilter'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', applyFilter));
  ['statusFilter','srcFilter','brandFilter','marginFilter','typeFilter'].forEach(id =>
    document.getElementById(id)?.addEventListener('change', applyFilter));

  // 선택 버튼
  document.getElementById('chkAll').addEventListener('change', e => {
    const sl = filtered.slice((page-1)*PER_PAGE, page*PER_PAGE);
    sl.forEach(it => e.target.checked ? _checked.add(it.code) : _checked.delete(it.code));
    updateBulkBar(); renderTable();
  });
  document.getElementById('btnSelectAll').addEventListener('click', () => {
    filtered.forEach(it => _checked.add(it.code)); updateBulkBar(); renderTable();
  });
  document.getElementById('btnSelectNone').addEventListener('click', () => {
    _checked.clear(); updateBulkBar(); renderTable();
  });

  // ★ v1.9.12: 선택 상품 일괄 기획세트 전환
  document.getElementById('btnBulkConvertBundle')?.addEventListener('click', () => {
    const sel = allProducts.filter(it => _checked.has(it.code));
    if (!sel.length) return toast('전환할 상품을 선택하세요', 'err');
    // 이미 기획인 것은 제외
    const targets = sel.filter(it => {
      const isB = it.itemType === 'bundle' || (_bundlesMap[it.code] && _bundlesMap[it.code].length > 0);
      return !isB;
    });
    if (!targets.length) return toast('선택된 상품이 모두 이미 기획세트입니다', 'err');
    openBulkBundleConvertModal(targets);
  });

  // 벌크 액션
  document.getElementById('bulkApplyPrice').addEventListener('click', () => {
    const sel = allProducts.filter(it => _checked.has(it.code));
    applyPriceToItems(sel);
  });
  // ★ 평상시가 일괄 복귀 (화면 모드 무관, 항상 평상시 추천가) — 메가와리 종료 후 사용
  document.getElementById('bulkApplyNormal')?.addEventListener('click', () => {
    const sel = allProducts.filter(it => _checked.has(it.code));
    if (!sel.length) return toast('상품을 선택하세요', 'err');
    applyPriceToItems(sel, null, 'normal');
  });
  document.getElementById('bulkActivate').addEventListener('click', () => {
    const sel = allProducts.filter(it => _checked.has(it.code) && it.status !== 'S2');
    if (!sel.length) return toast('이미 모두 판매 중', 'err');
    setGoodsStatus(sel, '2', '판매 활성화');
  });
  document.getElementById('bulkDeactivate').addEventListener('click', () => {
    const sel = allProducts.filter(it => _checked.has(it.code) && it.status === 'S2');
    if (!sel.length) return toast('이미 모두 중지 상태', 'err');
    handleSuspend(sel);
  });
  document.getElementById('bulkOutOfStock').addEventListener('click', () => {
    const sel = allProducts.filter(it => _checked.has(it.code));
    if (!sel.length) return toast('선택된 상품이 없습니다', 'err');
    handleOutOfStock(sel);
  });
  document.getElementById('bulkDiscontinue').addEventListener('click', () => {
    const sel = allProducts.filter(it => _checked.has(it.code));
    if (!sel.length) return toast('선택된 상품이 없습니다', 'err');
    handleDiscontinued(sel);
  });
  document.getElementById('bulkRestock').addEventListener('click', () => {
    const sel = allProducts.filter(it => _checked.has(it.code));
    if (!sel.length) return toast('선택된 상품이 없습니다', 'err');
    handleRestock(sel);
  });

  // 페이지네이션
  document.getElementById('pgPrev').addEventListener('click', () => { page--; renderTable(); });
  document.getElementById('pgNext').addEventListener('click', () => {
    const tp = Math.ceil(filtered.length/PER_PAGE);
    if (page < tp) { page++; renderTable(); }
  });

  // 요율 변경 즉시 갱신
  ['rExchangeRate','rShipFee','rMarginRate','rQFeeRate','rMegaponRate','rMegawariRate','rMegawariEventFee','rMegawariSellerRate'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', () => { if (allProducts.length) renderTable(); }));

  // 모달 닫기 (배경 클릭)
  document.getElementById('appsScriptModal').addEventListener('click', e => {
    if (e.target.id === 'appsScriptModal') e.target.classList.remove('show');
  });

  // ── Q10 Auto에서 받은 상품 수신 처리 ──────────────────────────
  // 1) 이미 큐에 쌓인 상품 로드
  const queueData = await storageGet(['lensIncomingQueue']);
  if (queueData.lensIncomingQueue?.length) {
    _processQ10Queue(queueData.lensIncomingQueue);
  }

  // 2) 실시간 수신 리스너 (Q10 Auto가 보내는 즉시)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'LENS_NEW_PRODUCT_FROM_Q10' && msg.product) {
      _processQ10Queue([msg.product]);
      return;
    }
    // 사이드패널에서 가격 업데이트 요청
    if (msg.type === 'LENS_UPDATE_PRICE_FROM_PANEL') {
      const item = allProducts.find(p => p.code === msg.code);
      if (!item) {
        sendResponse({ ok: false, error: 'ItemCode를 시트에서 찾을 수 없음' });
        return true;
      }
      const oldPrice = item.sourcePrice || 0;
      item.sourcePrice = msg.newSourcePrice;
      if (msg.sourceUrl && !item.sourceUrl) item.sourceUrl = msg.sourceUrl;
      _dirty.add(item.code);
      applyFilter();
      updateSummary();
      log(`🔄 [사이드패널] 가격 업데이트: ${item.name} ₩${oldPrice.toLocaleString()} → ₩${msg.newSourcePrice.toLocaleString()}`, 'ok');
      toast(`💰 가격 업데이트: ₩${oldPrice.toLocaleString()} → ₩${msg.newSourcePrice.toLocaleString()}`, 'ok');

      // 시트에 자동 저장
      saveToSheet().catch(e => console.warn('자동 저장 실패:', e));
      sendResponse({ ok: true, oldPrice, newPrice: msg.newSourcePrice });
      return true;
    }
  });
});

/* ── Q10 Auto 상품 큐 처리 ─────────────────────────────────────── */
function _processQ10Queue(queue) {
  if (!queue?.length) return;
  let added = 0;

  queue.forEach(p => {
    // 이미 있는 소싱 URL이면 업데이트만
    const existing = allProducts.find(it => it.sourceUrl && it.sourceUrl === p.sourceUrl);
    if (existing) {
      if (p.sourcePrice && !existing.sourcePrice) existing.sourcePrice = p.sourcePrice;
      if (p.brand && !existing.brand) existing.brand = p.brand;
      return;
    }

    // 신규 상품 추가 (code 없이 소싱 데이터로만 구성)
    allProducts.unshift({
      code: '',           // QSM 미등록 상태
      seller: '',
      status: 'S0',       // 등록 대기
      name: p.name || '',
      brand: p.brand || '',
      sourceUrl: p.sourceUrl || '',
      sourcePrice: p.sourcePrice || 0,
      shipFee: 0,
      weight: 0,
      carrier: '',
      marginRate: 0,
      basePrice: 0,
      curPrice: 0,
      customerShipJpy: 0,
      intlShipKrw: 0,
      memo: `Q10 Auto 수신 ${new Date(p.receivedAt || Date.now()).toLocaleString('ko-KR')}`,
      _fromQ10: true,     // 강조 표시용
    });
    added++;
  });

  if (added > 0) {
    // 큐 비우기
    chrome.storage.local.set({ lensIncomingQueue: [] });
    applyFilter();
    updateSummary();
    toast(`📥 Q10 Auto에서 ${added}개 상품 수신`, 'ok');
    log(`Q10 Auto 수신: ${added}개 추가`, 'ok');
  }
}
