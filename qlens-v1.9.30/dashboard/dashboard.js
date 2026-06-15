'use strict';
/**
 * QLens — dashboard/dashboard.js  v1.0.2
 *
 * 스토리지 키 (lens prefix — Q10 Auto와 완전 분리)
 *   lensQsmApiKey, lensQsmUserId, lensQsmPassword  — QSM 자격증명 (XOR+base64 암호화)
 *   lensQsmCertKey / lensQsmCertKeyTime             — 인증서 캐시 4h
 *   lensAnalyticsConfig      — { retentionPeriod, lastCleanupNotice }
 *   lensAnalyticsSnapshots   — 일별 스냅샷 배열
 *   lensAnalyticsProductCache — { ts, items }   TTL 1h
 *   lensAnalyticsOrderCache   — { ts, orders }  TTL 1h
 *
 * Q10 Auto 연동 (향후 연결용 — 현재 스텁)
 *   설정 페이지의 lensQ10AutoExtId 에 Q10 Auto 확장 ID 저장
 *   importFromQ10Auto() 함수에서 chrome.runtime.sendMessage로 자격증명 공유
 */

const CACHE_TTL      = 60 * 60 * 1000;
const RETENTION_DAYS = { '1month': 30, '6months': 180, '1year': 365 };
const PER_PAGE       = 15;
const QSM_CERT_TTL   = 4 * 60 * 60 * 1000;

/* ── 암호화 (settings.js 동일) ── */
const DP_KEY = 'Q10AutoSecKey2024';
function safeB64Decode(s) { try { return decodeURIComponent(escape(atob(s))); } catch { return ''; } }
function decryptKey(enc) {
  if (!enc) return '';
  try {
    const raw = safeB64Decode(enc);
    let r = '';
    for (let i = 0; i < raw.length; i++)
      r += String.fromCharCode(raw.charCodeAt(i) ^ DP_KEY.charCodeAt(i % DP_KEY.length));
    return r;
  } catch { return ''; }
}

/* ── 유틸 ── */
function storageGet(k) { return new Promise(r => chrome.storage.local.get(k, r)); }
function storageSet(o) { return new Promise(r => chrome.storage.local.set(o, r)); }
function storageRm(k)  { return new Promise(r => chrome.storage.local.remove(k, r)); }
function sendBg(msg) {
  return new Promise(r => chrome.runtime.sendMessage(msg, res => {
    if (chrome.runtime.lastError) r({ ok: false, error: chrome.runtime.lastError.message });
    else r(res || { ok: false, error: '응답 없음' });
  }));
}
function today() { return new Date().toISOString().slice(0, 10); }

/* ════════════════════════════════════════
   소싱처 매칭 — 주문현황 → 올리브영 바로가기
   QSM_Lens_Items 시트(LENS_LOAD)에서
   code/일본어명/한국어명 → 소싱URL 맵 구성
   ════════════════════════════════════════ */
let _sourcingMap = null;       // { byCode:{}, byName:{} }
let _sourcingLoading = null;

// URL/상품명 정규화 (소싱 시트 ↔ 상품 매칭용)
function _normUrl(u) {
  if (!u) return '';
  return String(u).trim().toLowerCase().split(/[?#]/)[0]
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}
function _normName(s) {
  return String(s || '').replace(/\s+/g, '')
    .replace(/[\[\]()【】（）·・,，.~/+\-_*]/g, '').toLowerCase();
}

async function loadSourcingMap(force = false) {
  if (_sourcingMap && !force) return _sourcingMap;
  if (_sourcingLoading) return _sourcingLoading;

  _sourcingLoading = (async () => {
    const map = { byCode: {}, byName: {}, infoByCode: {}, infoByName: {} };
    try {
      const local = await storageGet(['lensSheetsWebhookUrl']);
      const url = local.lensSheetsWebhookUrl;
      if (!url) { _sourcingMap = map; return map; }

      const res = await sendBg({
        type: 'LENS_WEBHOOK_PROXY',
        url,
        body: { action: 'LENS_LOAD' },
      });

      const items = (res && res.ok && Array.isArray(res.items)) ? res.items
                  : (res && Array.isArray(res.result)) ? res.result : [];

      const infoList = [];   // 소싱시트 병합용 (info + 매칭키)
      for (const it of items) {
        const info = {
          sourcePrice: +it.sourcePrice || 0,
          weight:      +it.weight || 0,
          shipFee:     +it.shipFee || 0,
          marginRate:  +it.marginRate || 0,
          curPriceJpy: +it.curPrice || 0,
          name:        it.name || '',
          sellerCode:  it.sellerCode || '',
          brand:       it.brand || '',     // 브랜드명
          sourceUrl:   it.sourceUrl || '',
        };
        const jaName = (it.name || '').replace(/\s+/g, '');
        const koName = (it.sellerCode || it.seller || '').replace(/\s+/g, '');
        if (it.code) {
          const codeRaw    = String(it.code).trim();
          const codeDigits = codeRaw.replace(/\D/g, '');  // 숫자만 (QSM GoodsCode 형식 대응)
          map.infoByCode[codeRaw] = info;
          if (codeDigits && codeDigits !== codeRaw) map.infoByCode[codeDigits] = info;
          const srcUrl = it.sourceUrl || it.소싱처URL || '';
          if (srcUrl) {
            map.byCode[codeRaw] = srcUrl;
            if (codeDigits && codeDigits !== codeRaw) map.byCode[codeDigits] = srcUrl;
          }
        }
        if (jaName) { map.infoByName[jaName] = info; if (it.sourceUrl) map.byName[jaName] = it.sourceUrl; }
        if (koName) { map.infoByName[koName] = info; if (it.sourceUrl) map.byName[koName] = it.sourceUrl; }
        infoList.push({ info, code: String(it.code || '').trim(), koName: it.sellerCode || it.seller || '' });
      }
      console.log('[QLens] 소싱맵 로드:', Object.keys(map.byCode).length, '코드(URL),',
                  Object.keys(map.infoByCode).length, '코드(정보)');

      // ── QSM_Lens_Sourcing 시트 병합 — 소싱가/배송비는 여기에 입력돼 있음 ──
      //    Items 시트엔 소싱가가 비어 있어, Sourcing 시트를 URL→한국어명→코드로 매칭해 채운다
      try {
        const sr = await sendBg({ type: 'LENS_WEBHOOK_PROXY', url, body: { action: 'LENS_LOAD_SOURCING' } });
        const srcRows = (sr && Array.isArray(sr.items)) ? sr.items : [];
        if (srcRows.length) {
          const byUrl = {}, byKo = {}, byCodeS = {};
          srcRows.forEach(s => {
            if (s.sourceUrl) { const u = _normUrl(s.sourceUrl); if (u) byUrl[u] = s; }
            [s.sourceUrl2, s.sourceUrl3].forEach(u2 => { const u = _normUrl(u2); if (u) byUrl[u] = s; });
            const kn = _normName(s.name); if (kn) byKo[kn] = s;
            if (s.code) byCodeS[String(s.code).trim()] = s;
          });
          let merged = 0;
          for (const { info, code, koName } of infoList) {
            if (info.sourcePrice > 0) continue;     // 이미 값 있으면 유지
            let s = null;
            const u = _normUrl(info.sourceUrl);
            if (u && byUrl[u]) s = byUrl[u];
            if (!s) { const kn = _normName(koName); if (kn && byKo[kn]) s = byKo[kn]; }
            if (!s && code && byCodeS[code]) s = byCodeS[code];
            if (!s) continue;
            if (s.sourcePrice > 0) info.sourcePrice = s.sourcePrice;
            if (s.shipFee > 0)    info.shipFee = s.shipFee >= 1000 ? Math.round(s.shipFee / 9.5) : s.shipFee;
            if (s.weight > 0)     info.weight = s.weight;
            if (s.marginRate > 0) info.marginRate = s.marginRate;
            if (s.sourceUrl && !info.sourceUrl) info.sourceUrl = s.sourceUrl;
            merged++;
          }
          // 소싱시트 행을 한국어명/코드로 직접 색인(상품이 Items에 없을 때 폴백)
          srcRows.forEach(s => {
            if (!(s.sourcePrice > 0)) return;
            const sInfo = { sourcePrice: s.sourcePrice, weight: +s.weight || 0,
              shipFee: s.shipFee >= 1000 ? Math.round(s.shipFee/9.5) : (+s.shipFee||0),
              marginRate: +s.marginRate || 0, name: s.name || '', sellerCode: s.name || '',
              brand: '', sourceUrl: s.sourceUrl || '' };
            const kn = _normName(s.name);
            if (kn && !map.infoByName[kn]) map.infoByName[kn] = sInfo;
            if (s.code) { const c = String(s.code).trim(); if (!map.infoByCode[c]) map.infoByCode[c] = sInfo; }
          });
          console.log('[QLens] 소싱시트 병합:', merged, '/', infoList.length, '개 상품에 소싱가 적용 (소싱행', srcRows.length, ')');
        }
      } catch (e) { console.warn('[QLens] 소싱시트 병합 실패:', e.message); }
    } catch (e) {
      console.warn('[QLens] 소싱맵 로드 실패:', e.message);
    }
    _sourcingMap = map;
    return map;
  })();

  return _sourcingLoading;
}

// 주문 1건 → 소싱 URL 찾기 (코드 우선, 없으면 상품명)
function findSourcingUrl(order) {
  if (!_sourcingMap) return null;
  // 주문 데이터의 상품코드 후보들
  const codeKeys = [order.SellerItemCode, order.sellerItemCode, order.GoodsNo,
                    order.ItemCode, order.itemCode, order.GoodsCode];
  for (const c of codeKeys) {
    if (c && _sourcingMap.byCode[String(c).trim()]) {
      return _sourcingMap.byCode[String(c).trim()];
    }
  }
  // 상품명 매칭 (공백 제거)
  const nm = (order.GoodsName || order.ItemName || '').replace(/\s+/g, '');
  if (nm && _sourcingMap.byName[nm]) return _sourcingMap.byName[nm];
  return null;
}

// 소싱처 열기 (URL 있으면 바로, 없으면 올리브영 검색)
function openSourcing(order) {
  const url = findSourcingUrl(order);
  if (url) {
    chrome.tabs.create({ url });
    return;
  }
  // 폴백: 상품명으로 올리브영 검색
  const name = order.GoodsName || order.ItemName || '';
  // 일본어 상품명에서 한글/영문 브랜드만 추려 검색 (없으면 전체)
  const q = encodeURIComponent(name.slice(0, 40));
  const searchUrl = `https://www.oliveyoung.co.kr/store/search/getSearchMain.do?query=${q}`;
  chrome.tabs.create({ url: searchUrl });
}
window.__openSourcing = openSourcing;  // 행 클릭 핸들러에서 접근

// 브랜드 태그 표시 여부 (설정에서 on/off, 기본 ON)
let _showBrandTags = true;
// 브랜드 배지 헬퍼 — "[브랜드] 상품명" 형식으로 렌더
function brandTag(brand) {
  if (!brand) return '';
  return `<span style="display:inline-block;padding:1px 6px;border-radius:4px;background:rgba(61,158,255,.12);border:1px solid rgba(61,158,255,.3);color:var(--blue,#3d9eff);font-size:10px;font-weight:700;margin-right:5px;white-space:nowrap">${brand}</span>`;
}
function nameWithBrand(brand, name) {
  return (_showBrandTags && brand) ? `${brandTag(brand)}${name}` : name;
}

/* ════════════════════════════════════════
   주문별 손익 계산 (2차)
   주문 → 소싱가 자동매칭 → 수수료·대행비 차감 → 순익
   ════════════════════════════════════════ */
let profitRows = [];
let _csvProfitRows = null;   // CSV 정산 기반 손익 스냅샷 (실시간 계산 후 되돌리기용)

// 주문의 소싱 정보 찾기 (코드 우선, 상품명 폴백)
function findSourcingInfo(order) {
  if (!_sourcingMap) return null;
  const codeKeys = [order.SellerItemCode, order.sellerItemCode, order.GoodsNo,
                    order.ItemCode, order.itemCode, order.GoodsCode];
  for (const c of codeKeys) {
    if (c && _sourcingMap.infoByCode?.[String(c).trim()]) return _sourcingMap.infoByCode[String(c).trim()];
  }
  const nm = (order.GoodsName || order.ItemName || '').replace(/\s+/g, '');
  if (nm && _sourcingMap.infoByName?.[nm]) return _sourcingMap.infoByName[nm];
  return null;
}

async function calcProfit() {
  const btn = document.getElementById('btnCalcProfit');
  if (btn) btn.disabled = true;
  showOv('손익 계산 중...', '소싱가 매칭 + 대행비 구간요금 적용');
  try {
    // 소싱맵 + 대행지 요율 로드
    await loadSourcingMap();
    const local = await storageGet(['lensSheetsWebhookUrl', 'lensExchRate', 'lensFeeRate']);
    const url = local.lensSheetsWebhookUrl;
    const exchRate = +local.lensExchRate || 9.6;   // 100엔당 원 (기본 9.6 → 환율설정 반영)
    const feeRate  = +local.lensFeeRate  || 0.10;   // 큐텐 수수료율 (기본 10%)

    // 대행지 구간요율
    let rates = [];
    if (url) {
      const rr = await sendBg({ type: 'LENS_WEBHOOK_PROXY', url, body: { action: 'LENS_AGENCY_RATE_LOAD' } });
      if (rr && rr.ok) rates = rr.rates || [];
    }
    const findFee = (type, weight) => {
      const cand = rates.filter(r => r.type === type).sort((a,b)=>a.maxWeight-b.maxWeight);
      for (const r of cand) if (weight <= r.maxWeight) return r.fee;
      return cand.length ? cand[cand.length-1].fee : 0;
    };

    const real = cachedOrders.filter(o => !o._synthetic);
    if (!real.length) { toast('계산할 주문이 없습니다. 먼저 새로고침하세요.', 'warn'); return; }

    profitRows = real.map(o => {
      const info = findSourcingInfo(o) || {};
      const priceJpy = +o.OrderPrice || 0;
      const priceKrw = Math.round(priceJpy * exchRate);   // 엔→원 (판매가)
      const feeKrw   = Math.round(priceKrw * feeRate);     // 큐텐 수수료
      const sourcingKrw = +info.sourcePrice || 0;          // 소싱가(시트값)
      const weight   = +info.weight || 0.5;
      const shipKrw  = findFee('배송', weight);            // 배송 구간요금
      const packKrw  = findFee('포장', weight);            // 포장 건당
      // 부가세 환급 = 소싱가의 10/110 (매입 부가세)
      const vatRefund = Math.round(sourcingKrw * 10 / 110);
      const profitKrw = priceKrw - feeKrw - sourcingKrw - shipKrw - packKrw + vatRefund;
      const marginPct = priceKrw > 0 ? (profitKrw / priceKrw * 100) : 0;
      return {
        orderNo: o.OrderNo || o.orderNo || '', orderDate: (o.OrderDate||'').slice(0,10),
        goodsName: o.GoodsName || o.ItemName || '-',
        itemCode: o.ItemCode || o.SellerItemCode || '',
        sellerCode: info.sellerCode || '',
        priceJpy, priceKrw, feeKrw, sourcingKrw,
        shipAgencyKrw: shipKrw, packAgencyKrw: packKrw,
        vatRefundKrw: vatRefund, profitKrw, marginPct,
        matched: !!info.sourcePrice,
      };
    });

    renderProfitTable();
    document.getElementById('btnSaveProfit').style.display = '';
    // CSV 스냅샷이 있으면 "되돌아가기" 버튼 노출
    if (_csvProfitRows && _csvProfitRows.length) {
      const backBtn = document.getElementById('btnBackToCsv');
      if (backBtn) backBtn.style.display = '';
    }
    toast(`✅ ${profitRows.length}건 손익 계산 완료`, 'ok');
  } catch (e) {
    console.error('[QLens] 손익 계산 오류:', e);
    toast('손익 계산 실패: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
    hideOv();
  }
}

function renderProfitTable() {
  const empty = document.getElementById('profitEmpty');
  const table = document.getElementById('profitTable');
  const summ  = document.getElementById('profitSummary');
  if (!profitRows.length) { empty.style.display = ''; table.style.display = 'none'; summ.style.display = 'none'; return; }
  empty.style.display = 'none'; table.style.display = ''; summ.style.display = '';

  const krw = n => '₩' + Math.round(n).toLocaleString('ko-KR');
  document.getElementById('profitTbody').innerHTML = profitRows.map(r => {
    const profitColor = r.profitKrw >= 0 ? 'var(--green,#1fd96a)' : 'var(--red,#ff5252)';
    const warn = r.matched ? '' : ' <span title="소싱가 미매칭 — 시트에 소싱가 입력 필요" style="color:var(--orange,#ff7a2f)">⚠</span>';
    const profitBrand = (_sourcingMap?.infoByCode?.[String(r.itemCode).trim()]?.brand) || '';
    // 한국어명 우선: 상품캐시 → 소싱맵 sellerCode → 저장된 이름(일본어)
    const code = String(r.itemCode || '').trim();
    const koName = _koByCode[code] || _koByCode[code.replace(/\D/g,'')]
                 || r.sellerCode || _sourcingMap?.infoByCode?.[code]?.sellerCode || '';
    const dispName = (koName || r.goodsName || '-');
    return `<tr>
      <td class="td-name" title="${r.goodsName}">${nameWithBrand(profitBrand, dispName.slice(0,28))}${warn}</td>
      <td class="td-mono">¥${r.priceJpy.toLocaleString()}</td>
      <td class="td-mono">${r.sourcingKrw ? krw(r.sourcingKrw) : '-'}</td>
      <td class="td-mono">${krw(r.feeKrw)}</td>
      <td class="td-mono">${krw(r.shipAgencyKrw)}</td>
      <td class="td-mono">${krw(r.packAgencyKrw)}</td>
      <td class="td-mono" style="font-weight:800;color:${profitColor}">${krw(r.profitKrw)}</td>
      <td class="td-mono" style="color:${profitColor}">${r.marginPct.toFixed(1)}%</td>
    </tr>`;
  }).join('');

  // 요약
  const sum = k => profitRows.reduce((a,r)=>a+(+r[k]||0),0);
  document.getElementById('psRevenue').textContent  = krw(sum('priceKrw'));
  document.getElementById('psSourcing').textContent = krw(sum('sourcingKrw'));
  document.getElementById('psCost').textContent     = krw(sum('feeKrw')+sum('shipAgencyKrw')+sum('packAgencyKrw'));
  const totalProfit = sum('profitKrw');
  const psP = document.getElementById('psProfit');
  psP.textContent = krw(totalProfit);
  psP.style.color = totalProfit >= 0 ? 'var(--green,#1fd96a)' : 'var(--red,#ff5252)';
}

async function saveProfit() {
  if (!profitRows.length) return;
  const local = await storageGet(['lensSheetsWebhookUrl']);
  if (!local.lensSheetsWebhookUrl) { toast('시트 연동 URL이 없습니다 (설정에서 연결)', 'err'); return; }
  const btn = document.getElementById('btnSaveProfit');
  if (btn) btn.disabled = true;
  showOv('시트 저장 중...', `${profitRows.length}건 손익 데이터`);
  try {
    const res = await sendBg({
      type: 'LENS_WEBHOOK_PROXY', url: local.lensSheetsWebhookUrl,
      body: { action: 'LENS_SETTLE_SAVE_ORDER', orders: profitRows },
    });
    if (res && res.ok) toast(`✅ 시트 저장 완료 (추가 ${res.added||0}, 수정 ${res.updated||0})`, 'ok');
    else throw new Error(res?.error || '저장 실패');
  } catch (e) {
    toast('저장 실패: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
    hideOv();
  }
}

/* ════════════════════════════════════════
   정산 CSV 업로드 분석
   ════════════════════════════════════════ */
function parseSettlementCsv(text) {
  // BOM 제거
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  const lines = text.split(/\r?\n/);
  // 간단 CSV 파서 (따옴표 안 콤마 처리)
  function splitCsv(line) {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i+1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  const header = splitCsv(lines[0]).map(h => h.trim());
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsv(lines[i]);
    const obj = {};
    header.forEach((h, j) => obj[h] = (cells[j] || '').trim());
    rows.push(obj);
  }
  return { header, rows };
}

function analyzeSettlement(rows) {
  const num = s => parseInt(String(s).replace(/,/g, '').trim() || 0, 10) || 0;
  const srcOf = r => {
    const m = String(r['판매자코드'] || '').match(/\(([^)]+)\)\s*$/);
    if (m) return m[1];
    return '미지정';
  };
  let totalSettle = 0, totalFee = 0, totalPay = 0;
  const byMonth = {}, byMonthSettle = {}, bySource = {}, byBrand = {}, byProduct = {}, byCategory = {};
  let minDate = '', maxDate = '';

  // 정산일 컬럼 자동 감지 ('정산'+'일' 포함, 결제일 제외) — 정산완료일/정산일/정산예정일 등
  let settleDateCol = '';
  if (rows.length) {
    settleDateCol = Object.keys(rows[0]).find(k =>
      k.includes('정산') && k.includes('일') && !k.includes('결제')) || '';
  }

  // 상품명 → 카테고리 자동분류 키워드
  function guessCategory(name) {
    const n = (name || '').toLowerCase();
    if (/セラム|アンプル|エッセンス|serum|ampoule|essence|앰플|세럼|에센스/.test(n))  return '세럼/앰플';
    if (/クリーム|cream|크림/.test(n))                                                  return '크림';
    if (/トナー|ローション|toner|lotion|토너|로션/.test(n))                             return '토너/로션';
    if (/マスク|パック|mask|pack|팩|마스크/.test(n))                                    return '마스크팩';
    if (/クレンジング|洗顔|クレンザー|cleansing|cleanser|클렌징|클렌저|세안/.test(n))   return '클렌징';
    if (/サンスクリーン|日焼け|spf|sun|선크림|선케어/.test(n))                          return '선케어';
    if (/シャンプー|トリートメント|ヘア|shampoo|hair|샴푸|헤어/.test(n))               return '헤어케어';
    if (/ボディ|body|바디/.test(n))                                                     return '바디케어';
    if (/セット|set|세트/.test(n))                                                      return '기획세트';
    if (/パッド|pad|패드/.test(n))                                                      return '패드/티셔트';
    return '기타';
  }

  rows.forEach(r => {
    const settle = num(r['정산금액']);
    const fee = num(r['Qoo10서비스수수료']);
    const pay = num(r['상품결제금'] || r['체결가격']);
    totalSettle += settle; totalFee += fee; totalPay += pay;
    const payDate = (r['구매자결제일'] || '').trim().slice(0, 10);
    if (payDate) {
      if (!minDate || payDate < minDate) minDate = payDate;
      if (!maxDate || payDate > maxDate) maxDate = payDate;
    }
    const mon = payDate.slice(0, 7);
    if (mon) byMonth[mon] = (byMonth[mon] || 0) + settle;
    // 정산완료일 기준 월별 집계 (정산 관점)
    if (settleDateCol) {
      const sMon = (r[settleDateCol] || '').trim().slice(0, 7);
      if (sMon && /^20\d{2}[-/]\d{2}/.test(sMon)) byMonthSettle[sMon] = (byMonthSettle[sMon] || 0) + settle;
    }
    const src = srcOf(r);
    bySource[src] = (bySource[src] || 0) + settle;
    const br = r['브랜드'] || '미지정';
    byBrand[br] = (byBrand[br] || 0) + settle;
    const cat = guessCategory(r['상품명']);
    byCategory[cat] = (byCategory[cat] || 0) + settle;
    const pn = (r['상품명'] || '-').slice(0, 40);
    if (!byProduct[pn]) byProduct[pn] = { amt: 0, cnt: 0, qty: 0 };
    byProduct[pn].amt += settle; byProduct[pn].cnt += 1; byProduct[pn].qty += num(r['수량'])||1;
  });
  return {
    count: rows.length, totalSettle, totalFee, totalPay,
    feeRate: totalPay ? (totalFee / totalPay * 100) : 0,
    minDate, maxDate,
    byMonth, byMonthSettle, settleDateCol,
    hasSettleDate: Object.keys(byMonthSettle).length > 0,
    bySource, byBrand,
    topProducts: Object.entries(byProduct).sort((a,b)=>b[1].amt-a[1].amt).slice(0, 8),
    rankByQty:   Object.entries(byProduct).sort((a,b)=>b[1].qty-a[1].qty).slice(0, 10),
    byCategory,
    rawRows: rows,
  };
}

let _csvAnalysis = null;

/* CSV 정산데이터 → 상품코드/판매자코드/상품명 기준 브랜드·소싱처 맵
   (구글시트 미연동 시 상품·주문 테이블 브랜드 폴백으로 사용) */
let _csvBrandMap = { byCode: {}, byName: {}, bySeller: {} };
function buildCsvBrandMap(rows) {
  const map = { byCode: {}, byName: {}, bySeller: {} };
  const srcOf = sc => {
    const m = String(sc || '').match(/\(([^)]+)\)\s*$/);
    return m ? m[1] : '';
  };
  rows.forEach(r => {
    const brand   = (r['브랜드'] || '').trim();
    const code    = String(r['상품코드'] || '').replace(/\D/g, '').trim();
    const jaName  = (r['상품명'] || '').replace(/\s+/g, '');
    const seller  = (r['판매자코드'] || '').replace(/\s+/g, '');
    const src     = srcOf(r['판매자코드']);
    const info = { brand, source: src, sellerCode: (r['판매자코드'] || '').trim() };
    if (code)   map.byCode[code] = info;
    if (jaName) map.byName[jaName] = info;
    if (seller) map.bySeller[seller] = info;
  });
  _csvBrandMap = map;
  console.log('[QLens] CSV 브랜드맵:', Object.keys(map.byCode).length, '코드');
  return map;
}

/* CSV 맵에서 브랜드/소싱 정보 조회 (코드 → 일본어명 → 판매자코드 순) */
function csvInfoFor(p) {
  const code = String(p.GoodsCode || p.ItemCode || p.SellerItemCode || p['상품코드'] || '').replace(/\D/g, '').trim();
  if (code && _csvBrandMap.byCode[code]) return _csvBrandMap.byCode[code];
  const ja = (p.GoodsName || p.ItemName || '').replace(/\s+/g, '');
  if (ja && _csvBrandMap.byName[ja]) return _csvBrandMap.byName[ja];
  const sc = (p.SellerCode || '').replace(/\s+/g, '');
  if (sc && _csvBrandMap.bySeller[sc]) return _csvBrandMap.bySeller[sc];
  return null;
}

function renderCsvAnalysis(a) {
  _csvAnalysis = a;
  const jpy = n => '¥' + Math.round(n).toLocaleString();
  const el = document.getElementById('csvAnalysis');
  el.style.display = '';
  document.getElementById('revenueEmpty')?.style.setProperty('display', 'none');

  const months = Object.entries(a.byMonth).sort();
  const maxM = Math.max(...months.map(m=>m[1]), 1);
  const sources = Object.entries(a.bySource).sort((x,y)=>y[1]-x[1]);
  const maxS = Math.max(...sources.map(s=>s[1]), 1);

  el.innerHTML = `
    <div style="margin:8px 0 14px;padding:8px 14px;border-radius:8px;background:var(--bg3);font-size:12px;color:var(--text2)">
      📅 데이터 기간: <strong style="color:var(--text)">${a.minDate || '?'} ~ ${a.maxDate || '?'}</strong>
      · 총 <strong style="color:var(--text)">${a.count}건</strong>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:14px 0">
      <div style="padding:12px 14px;border-radius:10px;background:var(--bg3);border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text2)">총 정산금액</div>
        <div style="font-size:18px;font-weight:800;color:var(--green,#1fd96a)">${jpy(a.totalSettle)}</div>
      </div>
      <div style="padding:12px 14px;border-radius:10px;background:var(--bg3);border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text2)">총 수수료</div>
        <div style="font-size:18px;font-weight:800;color:var(--red,#ff5252)">${jpy(a.totalFee)}</div>
      </div>
      <div style="padding:12px 14px;border-radius:10px;background:var(--bg3);border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text2)">평균 수수료율</div>
        <div style="font-size:18px;font-weight:800;color:var(--orange,#ff7a2f)">${a.feeRate.toFixed(1)}%</div>
      </div>
      <div style="padding:12px 14px;border-radius:10px;background:var(--bg3);border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text2)">정산 건수</div>
        <div style="font-size:18px;font-weight:800;color:var(--text)">${a.count}건</div>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;margin:18px 0 8px">
      <span style="font-weight:700;font-size:13px">📅 월별 정산금액</span>
      ${a.hasSettleDate ? `
      <div style="margin-left:auto;display:inline-flex;border:1px solid var(--border);border-radius:7px;overflow:hidden;font-size:11px">
        <button class="month-basis-btn" data-basis="pay"    style="padding:4px 10px;background:var(--blue,#3d9eff);color:#fff;border:none;cursor:pointer;font-weight:700">구매자결제일</button>
        <button class="month-basis-btn" data-basis="settle" style="padding:4px 10px;background:var(--bg3);color:var(--text2);border:none;cursor:pointer;font-weight:700">정산완료일</button>
      </div>` : ''}
    </div>
    <div id="monthlyBars"></div>
    ${a.hasSettleDate ? `<div style="font-size:10px;color:var(--text3);margin-top:4px">※ 결제일=주문이 들어온 달 기준 / 정산완료일=실제 정산금이 입금된 달 기준</div>` : ''}

    <div style="margin:18px 0 8px;font-weight:700;font-size:13px">🏆 상품별 정산액 TOP 8</div>
    <table class="rank-table"><thead><tr><th style="width:40px">순위</th><th style="text-align:left">상품명</th><th style="text-align:right;width:60px">건수</th><th style="text-align:right;width:110px">정산액</th></tr></thead>
      <tbody>${a.topProducts.map(([n,d],i)=>`
        <tr><td style="font-weight:700;color:var(--blue)">${i+1}</td>
        <td class="td-name" style="text-align:left" title="${n}">${n}</td>
        <td class="td-right">${d.cnt}건</td>
        <td class="td-mono td-right" style="font-weight:700">${jpy(d.amt)}</td></tr>`).join('')}
      </tbody>
    </table>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;margin-top:18px">
      <div>
        <div style="margin:0 0 8px;font-weight:700;font-size:13px">🛒 소싱처별 매출</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${sources.map(([s,v]) => `
            <div style="display:flex;align-items:center;gap:8px;font-size:12px">
              <div style="width:72px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${s}">${s}</div>
              <div style="flex:1;background:var(--bg3);border-radius:6px;overflow:hidden;height:22px;position:relative">
                <div style="width:${v/maxS*100}%;height:100%;background:var(--purple,#7c3aed);min-width:2px"></div>
                <span style="position:absolute;right:6px;top:3px;font-weight:700;font-size:11px">${jpy(v)}</span>
              </div>
            </div>`).join('')}
        </div>
      </div>

      <div>
        <div style="margin:0 0 8px;font-weight:700;font-size:13px">🏷️ 브랜드별 매출 (TOP 8)</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${Object.entries(a.byBrand).sort((x,y)=>y[1]-x[1]).slice(0,8).map(([br,v]) => `
            <div style="display:flex;align-items:center;gap:8px;font-size:12px">
              <div style="width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)" title="${br}">${br}</div>
              <div style="flex:1;background:var(--bg3);border-radius:6px;overflow:hidden;height:22px;position:relative">
                <div style="width:${v/Math.max(...Object.values(a.byBrand))*100}%;height:100%;background:var(--orange,#ff7a2f);min-width:2px"></div>
                <span style="position:absolute;right:6px;top:3px;font-weight:700;font-size:11px">${jpy(v)}</span>
              </div>
            </div>`).join('')}
        </div>
      </div>

      <div>
        <div style="margin:0 0 8px;font-weight:700;font-size:13px">📦 카테고리별 매출</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${Object.entries(a.byCategory).sort((x,y)=>y[1]-x[1]).map(([cat,v]) => `
            <div style="display:flex;align-items:center;gap:8px;font-size:12px">
              <div style="width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)">${cat}</div>
              <div style="flex:1;background:var(--bg3);border-radius:6px;overflow:hidden;height:22px;position:relative">
                <div style="width:${v/Math.max(...Object.values(a.byCategory))*100}%;height:100%;background:var(--green,#1fd96a);min-width:2px"></div>
                <span style="position:absolute;right:6px;top:3px;font-weight:700;font-size:11px">${jpy(v)}</span>
              </div>
              <div style="width:30px;text-align:right;font-size:10px;color:var(--text3)">${(v/a.totalSettle*100).toFixed(0)}%</div>
            </div>`).join('')}
        </div>
      </div>
    </div>

    <button class="chart-fetch-btn" id="btnAiAdvice" style="margin-top:16px;background:var(--purple,#7c3aed)">🤖 AI 매출 분석 조언 받기</button>
    <div id="aiAdviceBox" style="display:none;margin-top:12px;padding:14px 18px;border-radius:12px;background:rgba(124,58,237,.08);border:1px solid rgba(124,58,237,.25);font-size:13px;line-height:1.7;white-space:pre-wrap"></div>
  `;

  document.getElementById('btnAiAdvice')?.addEventListener('click', () => getAiAdvice(a));

  // 월별 막대: 결제일/정산완료일 기준 전환
  renderMonthlyBars('pay');
  el.querySelectorAll('.month-basis-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.month-basis-btn').forEach(b => {
        const on = b === btn;
        b.style.background = on ? 'var(--blue,#3d9eff)' : 'var(--bg3)';
        b.style.color      = on ? '#fff' : 'var(--text2)';
      });
      renderMonthlyBars(btn.dataset.basis);
    });
  });
}

/* 월별 정산금액 막대 — basis: 'pay'(구매자결제일) | 'settle'(정산완료일) */
function renderMonthlyBars(basis) {
  const box = document.getElementById('monthlyBars');
  if (!box || !_csvAnalysis) return;
  const jpy = n => '¥' + Math.round(n).toLocaleString();
  const src = (basis === 'settle' && _csvAnalysis.hasSettleDate)
    ? _csvAnalysis.byMonthSettle : _csvAnalysis.byMonth;
  const months = Object.entries(src).sort();
  if (!months.length) { box.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:8px 0">표시할 월별 데이터가 없습니다</div>'; return; }
  const maxM = Math.max(...months.map(m=>m[1]), 1);
  box.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px">
    ${months.map(([m,v]) => `
      <div style="display:flex;align-items:center;gap:10px;font-size:12px">
        <div style="width:60px;color:var(--text2)">${m}</div>
        <div style="flex:1;background:var(--bg3);border-radius:6px;overflow:hidden;height:22px;position:relative">
          <div style="width:${v/maxM*100}%;height:100%;background:var(--blue,#3d9eff);min-width:2px"></div>
          <span style="position:absolute;right:8px;top:3px;font-weight:700">${jpy(v)}</span>
        </div>
      </div>`).join('')}
  </div>`;
}

// 간단 마크다운 → HTML (AI 조언 가독성: **굵게**, 헤더, 불릿, 줄바꿈)
function mdToHtml(md) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines = String(md || '').split('\n');
  let html = '', inList = false;
  const inline = t => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')   // **굵게**
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>'); // *기울임*
  for (let raw of lines) {
    const line = raw.replace(/\s+$/,'');
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) { html += '<ul style="margin:4px 0 8px;padding-left:18px">'; inList = true; }
      html += `<li style="margin:2px 0">${inline(bullet[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (!line.trim()) { html += '<div style="height:6px"></div>'; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { html += `<div style="font-weight:800;font-size:14px;margin:10px 0 4px;color:var(--text)">${inline(h[2])}</div>`; continue; }
    html += `<div>${inline(line)}</div>`;
  }
  if (inList) html += '</ul>';
  return html;
}

async function getAiAdvice(a) {
  const box = document.getElementById('aiAdviceBox');
  const btn = document.getElementById('btnAiAdvice');
  box.style.display = '';
  box.textContent = '🤖 분석 중...';
  if (btn) btn.disabled = true;

  // 분석 요약을 프롬프트로
  const jpy = n => '¥' + Math.round(n).toLocaleString();
  const months = Object.entries(a.byMonth).sort();
  const sources = Object.entries(a.bySource).sort((x,y)=>y[1]-x[1]);
  const brands = Object.entries(a.byBrand).sort((x,y)=>y[1]-x[1]).slice(0,8);
  const cats   = Object.entries(a.byCategory).sort((x,y)=>y[1]-x[1]);
  // 월별 증감률 계산
  const monthTrend = months.map((m, i) => {
    if (i === 0) return `${m[0]} ${jpy(m[1])}`;
    const prev = months[i-1][1];
    const chg = prev ? ((m[1]-prev)/prev*100).toFixed(0) : 0;
    return `${m[0]} ${jpy(m[1])}(${chg>=0?'+':''}${chg}%)`;
  });
  const topSrcRatio = sources.length ? (sources[0][1]/a.totalSettle*100).toFixed(0) : 0;
  const summary = `큐텐재팬(Qoo10 Japan) 셀러 정산 데이터 분석:

[전체 요약]
- 총 정산금액: ${jpy(a.totalSettle)} / 총 수수료: ${jpy(a.totalFee)} (평균 수수료율 ${a.feeRate.toFixed(1)}%)
- 정산 건수: ${a.count}건 / 데이터 기간: ${a.minDate} ~ ${a.maxDate}

[월별 매출 추이 (증감률 포함)]
${monthTrend.join('\n')}

[소싱처별 매출 — 1위 집중도 ${topSrcRatio}%]
${sources.map(s=>`${s[0]}: ${jpy(s[1])} (${(s[1]/a.totalSettle*100).toFixed(0)}%)`).join('\n')}

[브랜드별 매출 TOP8]
${brands.map(b=>`${b[0]}: ${jpy(b[1])}`).join('\n')}

[카테고리별 매출]
${cats.map(c=>`${c[0]}: ${jpy(c[1])} (${(c[1]/a.totalSettle*100).toFixed(0)}%)`).join('\n')}

[베스트셀러 상품 TOP5]
${a.topProducts.slice(0,5).map((p,i)=>`${i+1}. ${p[0].slice(0,30)} — ${p[1].cnt}건, ${jpy(p[1].amt)}`).join('\n')}

위 실제 데이터를 근거로, 큐텐재팬 셀러에게 실질적으로 도움이 되는 매출 분석과 개선 전략을 한국어로 작성해줘.
다음 4개 항목으로 명확히 구분해서 작성하되, 각 항목마다 위 숫자를 직접 인용하며 구체적으로 조언해줘:
1. 📈 매출 추세 진단 (월별 증감 원인 추정 + 다음 달 전망)
2. 🛒 소싱처·브랜드 전략 (집중도 리스크와 다변화 방향)
3. 📦 카테고리·상품 전략 (잘 팔리는 패턴과 확장 아이디어)
4. 💰 수수료·수익성 개선 포인트
각 항목은 2~3문장으로 간결하게. 일반론이 아니라 이 셀러의 실제 숫자에 기반한 맞춤 조언으로.`;

  try {
    const local = await storageGet(['lensAiProvider', 'lensApiKeyGemini', 'lensApiKeyChatgpt', 'lensApiKeyGroq', 'lensApiKeyClaude', 'lensSellerContext']);
    const hasAnyKey = !!(local.lensApiKeyGemini || local.lensApiKeyChatgpt || local.lensApiKeyGroq || local.lensApiKeyClaude);
    if (!hasAnyKey) {
      // 키가 아예 없으면 규칙 기반 조언 + 명확한 설정 안내
      box.innerHTML = mdToHtml(ruleBasedAdvice(a)) +
        `<br><br><div style="padding:10px 12px;border-radius:8px;background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.3)">
          🤖 <strong>AI 정밀 분석을 받으려면</strong> 설정에서 무료 Gemini API 키를 등록하세요.<br>
          <a href="#" id="aiAdviceOpenSettings" style="color:var(--purple,#7c3aed);font-weight:700">⚙️ 설정 열기 →</a>
        </div>`;
      document.getElementById('aiAdviceOpenSettings')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings.html') });
      });
      if (btn) btn.disabled = false;
      return;
    }
    const settings = {
      lensAiProvider: local.lensAiProvider || 'gemini',
      lensApiKeyGemini:  local.lensApiKeyGemini  ? (decryptKey(local.lensApiKeyGemini)  || local.lensApiKeyGemini)  : '',
      lensApiKeyChatgpt: local.lensApiKeyChatgpt ? (decryptKey(local.lensApiKeyChatgpt) || local.lensApiKeyChatgpt) : '',
      lensApiKeyGroq:    local.lensApiKeyGroq    ? (decryptKey(local.lensApiKeyGroq)    || local.lensApiKeyGroq)    : '',
      lensApiKeyClaude:  local.lensApiKeyClaude  ? (decryptKey(local.lensApiKeyClaude)  || local.lensApiKeyClaude)  : '',
    };
    // 셀러 컨텍스트가 있으면 프롬프트 앞에 추가 (AI가 항상 이 정보를 기반으로 조언)
    const ctx = (local.lensSellerContext || '').trim();
    const fullPrompt = ctx
      ? `[셀러 정보 — 이 내용을 항상 기반으로 조언해줘]\n${ctx}\n\n[이번 분석 데이터]\n${summary}`
      : summary;
    const res = await sendBg({ type: 'LENS_AI_ADVICE', prompt: fullPrompt, settings });
    if (res && res.ok && res.text) {
      box.innerHTML = mdToHtml(res.text);
    } else {
      const errMsg = res?.error || '알 수 없는 오류';
      // API 오류 시: 규칙 기반 조언 + 원인 안내
      box.innerHTML =
        `<div style="padding:8px 12px;border-radius:8px;background:rgba(255,59,59,.1);border:1px solid rgba(255,59,59,.3);margin-bottom:10px;font-size:12px">
          ⚠️ AI 호출 실패: ${errMsg}<br>
          <span style="color:var(--text2)">API 키가 올바른지, 사용량 한도를 초과하지 않았는지 확인하세요. 아래는 규칙 기반 분석입니다.</span>
        </div>` +
        mdToHtml(ruleBasedAdvice(a));
    }
  } catch (e) {
    box.innerHTML = mdToHtml(ruleBasedAdvice(a));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// AI 없을 때 규칙 기반 조언
function ruleBasedAdvice(a) {
  const jpy = n => '¥' + Math.round(n).toLocaleString();
  const sources = Object.entries(a.bySource).sort((x,y)=>y[1]-x[1]);
  const months = Object.entries(a.byMonth).sort();
  const tips = ['📊 매출 분석 요약\n'];
  // 수수료
  tips.push(`• 평균 수수료율은 ${a.feeRate.toFixed(1)}%입니다. ${a.feeRate > 12 ? '다소 높은 편 — 메가할인/광고 수수료가 포함됐는지 확인하세요.' : '적정 수준입니다.'}`);
  // 소싱처 집중도
  if (sources.length) {
    const top = sources[0];
    const ratio = top[1] / a.totalSettle * 100;
    tips.push(`• 매출 1위 소싱처는 "${top[0]}" (${ratio.toFixed(0)}%). ${ratio > 50 ? '한 곳 의존도가 높아요 — 소싱처를 다변화하면 리스크가 줄어듭니다.' : '소싱처가 비교적 분산돼 있어 안정적입니다.'}`);
  }
  // 월 추세
  if (months.length >= 2) {
    const last = months[months.length-1][1], prev = months[months.length-2][1];
    const chg = prev ? ((last-prev)/prev*100) : 0;
    tips.push(`• 최근 월 매출은 직전 대비 ${chg >= 0 ? '+' : ''}${chg.toFixed(0)}% ${chg >= 0 ? '증가' : '감소'}했습니다.`);
  }
  // TOP 상품
  if (a.topProducts.length) {
    const t = a.topProducts[0];
    tips.push(`• 베스트셀러는 "${t[0].slice(0,25)}" (${t[1].cnt}건, ${jpy(t[1].amt)}). 이 상품의 연관/세트 상품을 늘리면 매출 확대에 유리합니다.`);
  }
  tips.push('\n💡 더 정밀한 AI 조언을 원하면 설정에서 Gemini API 키를 등록하세요.');
  return tips.join('\n');
}

// 누적 CSV rows (여러 파일 합산용)
let _mergedCsvRows = [];
let _loadedFileNames = [];

function setupCsvUpload() {
  const btn   = document.getElementById('btnUploadCsv');
  const zone  = document.getElementById('csvDropZone');
  const input = document.getElementById('csvFileInput');
  if (!btn || !zone || !input) return;

  btn.addEventListener('click', () => {
    zone.style.display = zone.style.display === 'none' ? '' : 'none';
  });
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', e => {
    const files = Array.from(e.target.files);
    if (files.length) handleCsvFiles(files);
    input.value = '';   // 같은 파일 재선택 허용
  });
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.style.background = 'rgba(124,58,237,.15)'; });
  zone.addEventListener('dragleave', e => { e.preventDefault(); zone.style.background = 'rgba(124,58,237,.05)'; });
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.style.background = 'rgba(124,58,237,.05)';
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.csv'));
    if (files.length) handleCsvFiles(files);
    else toast('CSV 파일만 업로드 가능합니다', 'warn');
  });
}

// 여러 파일 읽기 → 순차 처리
function handleCsvFiles(files) {
  let done = 0;
  const newRows = [];
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const { rows } = parseSettlementCsv(e.target.result);
        if (rows.length && (rows[0]['정산금액'] || rows[0]['상품명'])) {
          newRows.push(...rows);
          if (!_loadedFileNames.includes(file.name)) _loadedFileNames.push(file.name);
        }
      } catch (err) {
        console.warn('[QLens] CSV 읽기 오류:', file.name, err.message);
      }
      done++;
      if (done === files.length) mergeCsvRows(newRows);
    };
    reader.onerror = () => { done++; if (done === files.length) mergeCsvRows(newRows); };
    reader.readAsText(file, 'UTF-8');
  });
}

// 주문번호 기반 중복 제거 후 합산 분석
function mergeCsvRows(newRows) {
  // 기존 누적 rows에 새 rows 추가
  const beforeTotal = _mergedCsvRows.length;
  _mergedCsvRows = _mergedCsvRows.concat(newRows);
  const afterConcat = _mergedCsvRows.length;

  // 주문번호 기준 중복 제거 (같은 주문번호 → 첫 번째만 유지)
  const seen = new Set();
  const deduped = _mergedCsvRows.filter(r => {
    const key = String(r['주문번호'] || '').trim();
    if (!key) return true;   // 주문번호 없으면 그냥 포함
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const dupCount = afterConcat - deduped.length;   // 이번 합산에서 제거된 중복 수
  _mergedCsvRows = deduped;

  if (!_mergedCsvRows.length) { toast('유효한 데이터가 없습니다', 'warn'); return; }

  // 상태 표시
  const statusEl = document.getElementById('csvMergeStatus');
  if (statusEl) {
    statusEl.style.display = '';
    statusEl.innerHTML = `
      📁 로드된 파일: <strong>${_loadedFileNames.join(', ')}</strong><br>
      📊 총 정산 건수: <strong>${_mergedCsvRows.length}건</strong>
      ${dupCount > 0 ? `<span style="color:var(--text2,#8888aa);font-size:11px"> (중복 ${dupCount}건 자동 제거됨)</span>` : ''}
      <button id="btnClearCsv" style="margin-left:12px;font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--red,#ff3b3b);background:transparent;color:var(--red,#ff3b3b);cursor:pointer">🗑 초기화</button>
    `;
    document.getElementById('btnClearCsv')?.addEventListener('click', () => {
      _mergedCsvRows = []; _loadedFileNames = [];
      statusEl.style.display = 'none';
      document.getElementById('csvAnalysis').style.display = 'none';
      toast('CSV 데이터가 초기화됐습니다', 'ok');
    });
  }

  const analysis = analyzeSettlement(_mergedCsvRows);
  buildCsvBrandMap(_mergedCsvRows);   // 상품/주문 테이블 브랜드 폴백용
  renderCsvAnalysis(analysis);
  renderRankFromCsv(analysis);
  renderProfitFromCsv(analysis);
  // CSV 브랜드 정보로 상품·주문 테이블 다시 그리기 (브랜드명 반영)
  try { renderProductTable(); renderOrderTable(); } catch (e) { /* 테이블 미초기화 시 무시 */ }
  document.getElementById('csvDropZone').style.display = 'none';
  toast(`✅ ${_mergedCsvRows.length}건 분석 완료 (3개 탭 반영)`, 'ok');
}


// CSV → 판매순위 탭 (수량 기준)
function renderRankFromCsv(a) {
  const empty = document.getElementById('rankingEmpty');
  const table = document.getElementById('rankTable');
  const canvas = document.getElementById('rankCanvas');
  if (empty) empty.style.display = 'none';
  if (canvas) canvas.style.display = 'none';
  if (!table) return;
  table.style.display = '';
  const maxQty = Math.max(...a.rankByQty.map(r=>r[1].qty), 1);
  document.getElementById('rankTbody').innerHTML = a.rankByQty.map(([name,d],i) => `
    <tr>
      <td style="font-weight:700;color:${i<3?'var(--orange,#ff7a2f)':'var(--text2)'}">${i+1}</td>
      <td class="td-name" title="${name}">${name}</td>
      <td style="font-weight:700">${d.qty}개</td>
      <td class="td-mono">¥${d.amt.toLocaleString()}</td>
      <td><div style="background:var(--bg3);border-radius:6px;height:16px;overflow:hidden"><div style="width:${d.qty/maxQty*100}%;height:100%;background:var(--blue,#3d9eff)"></div></div></td>
    </tr>`).join('');
}

// CSV → 주문별 손익 탭 (소싱가는 소싱시트 매칭, 없으면 0)
async function renderProfitFromCsv(a) {
  await loadSourcingMap();
  const num = s => parseInt(String(s).replace(/,/g,'').trim()||0,10)||0;
  const local = await storageGet(['lensExchRate', 'lensSheetsWebhookUrl']);
  const exchRate = +local.lensExchRate || 9.6;

  // 대행지 구간요율 로드 (배송비·포장비 = 무게 기준)
  let rates = [];
  try {
    if (local.lensSheetsWebhookUrl) {
      const rr = await sendBg({ type: 'LENS_WEBHOOK_PROXY', url: local.lensSheetsWebhookUrl, body: { action: 'LENS_AGENCY_RATE_LOAD' } });
      if (rr && rr.ok) rates = rr.rates || [];
    }
  } catch (e) { console.warn('[QLens] 대행요율 로드 실패:', e.message); }
  const findFee = (type, weight) => {
    const cand = rates.filter(r => r.type === type).sort((a,b)=>a.maxWeight-b.maxWeight);
    for (const r of cand) if (weight <= r.maxWeight) return r.fee;
    return cand.length ? cand[cand.length-1].fee : 0;
  };

  profitRows = a.rawRows.map(r => {
    const priceJpy = num(r['정산금액']);    // 실수령 정산액
    const priceKrw = Math.round(priceJpy * exchRate);
    const feeJpy   = num(r['Qoo10서비스수수료']);
    const feeKrw   = Math.round(feeJpy * exchRate);
    // 소싱가: 상품코드 → 일본어상품명 → 판매자코드(한국어명) 순 매칭
    const code   = String(r['상품코드']||'').trim();
    const jaKey  = _normName(r['상품명']||'');
    const scKey  = _normName(r['판매자코드']||'');
    const info = (_sourcingMap?.infoByCode?.[code]) ||
                 (_sourcingMap?.infoByName?.[(r['상품명']||'').replace(/\s+/g,'')]) ||
                 (jaKey && _sourcingMap?.infoByName?.[jaKey]) ||
                 (scKey && _sourcingMap?.infoByName?.[scKey]) || {};
    const sourcingKrw = +info.sourcePrice || 0;
    const weight   = +info.weight || 0.5;
    const shipKrw  = sourcingKrw ? findFee('배송', weight) : 0;   // 배송 대행비
    const packKrw  = sourcingKrw ? findFee('포장', weight) : 0;   // 포장 대행비
    const vatRefund = Math.round(sourcingKrw * 10 / 110);
    // CSV 정산액은 이미 수수료 차감 후 → 순익 = 정산액(원) - 소싱가 - 배송비 - 포장비 + 부가세환급
    const profitKrw = priceKrw - sourcingKrw - shipKrw - packKrw + vatRefund;
    const marginPct = priceKrw > 0 ? (profitKrw/priceKrw*100) : 0;
    return {
      orderNo: r['주문번호']||'', orderDate: (r['구매자결제일']||'').slice(0,10),
      goodsName: r['상품명']||'-', itemCode: code, sellerCode: r['판매자코드']||'',
      priceJpy, priceKrw, feeKrw, sourcingKrw,
      shipAgencyKrw: shipKrw, packAgencyKrw: packKrw, vatRefundKrw: vatRefund,
      profitKrw, marginPct, matched: !!info.sourcePrice,
    };
  });
  renderProfitTable();
  _csvProfitRows = profitRows.slice();   // CSV 기반 스냅샷 보관
  const backBtn = document.getElementById('btnBackToCsv');
  if (backBtn) backBtn.style.display = 'none';
  const btnSave = document.getElementById('btnSaveProfit');
  if (btnSave) btnSave.style.display = '';
}
function tsToDate(ts) { return new Date(ts).toISOString().slice(0, 10); }
function fmtNum(n) { return typeof n === 'number' ? n.toLocaleString('ja-JP') : '-'; }
// KPI·차트용 — 큰 숫자 축약 (¥1.5M, ¥34K)
// KPI 합산용 — 큰 숫자는 단위 축약 (¥1.2M, ¥13K)
function fmtJPY(n) {
  if (typeof n !== 'number') return '-';
  if (n >= 1_000_000) return '¥' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000)    return '¥' + Math.round(n / 1_000) + 'K';
  return '¥' + n.toLocaleString('ja-JP');
}
// 상품 가격용 — 반드시 정확한 금액 표시 (¥13,119 / ¥7,690)
function fmtPrice(n) {
  if (!n || typeof n !== 'number') return '-';
  return '¥' + n.toLocaleString('ja-JP');
}
function fmtBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 ** 2) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

let _toastT;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show ' + type;
  clearTimeout(_toastT); _toastT = setTimeout(() => el.classList.remove('show'), 3000);
}
function showOv(t, s = '') {
  document.getElementById('overlayTitle').textContent = t;
  document.getElementById('overlaySub').textContent   = s;
  document.getElementById('overlay').classList.add('show');
}
function hideOv() { document.getElementById('overlay').classList.remove('show'); }

/* ── 상태 ── */
let config    = { retentionPeriod: '1month', lastCleanupNotice: 0 };
let snapshots = [];
let cachedProducts = [];
let cachedOrders   = [];
let _koByCode      = {};   // ItemCode → 한국어 상품명(SellerCode) — 주문명 한국어 통일용
let currentPeriod  = '1month';

// 상품 캐시로부터 코드→한국어명 맵 구성 (SellerCode = Q10 Auto가 저장한 한국어 상품명)
function buildKoByCode() {
  _koByCode = {};
  for (const p of cachedProducts) {
    const sc = (p.SellerCode || '').trim();
    if (!sc || sc.length < 3 || /^[A-Z0-9_-]+$/.test(sc)) continue;   // 의미있는 한국어명만
    const keys = [p.GoodsCode, p.ItemCode].map(c => String(c || '').trim()).filter(Boolean);
    for (const k of keys) {
      _koByCode[k] = sc;
      const d = k.replace(/\D/g, '');
      if (d && d !== k) _koByCode[d] = sc;
    }
  }
}
let salesSummary  = null; // { orderCount, revenue }
// 날짜 범위 (분석 기간)
let dateRange = {
  start: (() => { const d = new Date(); d.setDate(d.getDate()-30); return d.toISOString().slice(0,10); })(),
  end:   new Date().toISOString().slice(0,10),
  label: '최근30일'
};
let productPage = 1, filteredProducts = [];
let orderPage   = 1, filteredOrders   = [];

/* ── QSM 인증서 ── */
async function getCertKey(force = false) {
  const d = await storageGet(['lensQsmApiKey','lensQsmUserId','lensQsmPassword','lensQsmCertKey','lensQsmCertKeyTime']);

  if (!d.lensQsmApiKey || !d.lensQsmUserId || !d.lensQsmPassword) {
    const err = new Error('QSM 자격증명 없음 — 설정에서 API 키를 입력해주세요');
    err.goSettings = true;
    throw err;
  }

  // 캐시 유효
  if (!force && d.lensQsmCertKey && d.lensQsmCertKeyTime && Date.now() - d.lensQsmCertKeyTime < QSM_CERT_TTL)
    return d.lensQsmCertKey;

  // ⭐ API 키 + 비밀번호 모두 복호화 (암호화된 채로 보내면 인증 실패)
  const apiKey = decryptKey(d.lensQsmApiKey) || d.lensQsmApiKey;
  const pw     = decryptKey(d.lensQsmPassword) || d.lensQsmPassword;

  const res = await sendBg({ type: 'QSM_CREATE_CERT', apiKey, userId: d.lensQsmUserId, password: pw });
  if (!res.ok) {
    const err = new Error('인증서 발급 실패 — 설정의 API 키/비밀번호를 확인해주세요');
    err.goSettings = true;
    throw err;
  }
  await storageSet({ lensQsmCertKey: res.certKey, lensQsmCertKeyTime: Date.now() });
  return res.certKey;
}

async function qsmCall(method, params = {}, ver = '1.0') {
  let ck  = await getCertKey();
  let res = await sendBg({ type: 'QSM_API_CALL', method, certKey: ck, params, version: ver });
  if (!res.ok && (res.code === -110 || res.code === -130 || /key|cert|auth/i.test(res.msg || ''))) {
    ck  = await getCertKey(true);
    res = await sendBg({ type: 'QSM_API_CALL', method, certKey: ck, params, version: ver });
  }
  return res;
}

/* ══════════════════════════════════════════════════════════
   데이터 수집 — 공식 QSM QAPI 사용
   ① ItemsLookup.GetAllGoodsInfo   상품 상태별 목록 (최대 500/페이지)
   ② ItemsLookup.GetItemDetailInfo 상품 상세 (이름/가격 등)
   ③ OrderService.OrderNewslookup  주문 목록 (실패 시 빈 배열)
══════════════════════════════════════════════════════════ */

/* ── 상품 목록 수집 ── */
async function fetchProducts() {
  const allItems = [];

  // Step 1 — GetAllGoodsInfo: 판매상태별 ItemCode + Status 수집
  // S2=거래가능, S1=거래대기, S0=검수대기, S3=거래종지
  for (const status of ['S2', 'S1', 'S0', 'S3']) {
    let page = 1, totalPages = 1;
    while (page <= totalPages && page <= 5) {   // 최대 5페이지 = 2500개
      const res = await qsmCall('ItemsLookup.GetAllGoodsInfo', {
        ItemStatus: status,
        Page: String(page)
      }, '1.0');

      if (!res.ok) {
        console.warn('[QLens] GetAllGoodsInfo 실패:', status, res.code, res.msg, res._raw?.slice(0,100));
        break;
      }

      const result = res.result;
      if (!result) { console.warn('[QLens] GetAllGoodsInfo result 없음:', status); break; }

      totalPages = result.TotalPages || 1;
      const items = result.Items || [];
      console.log(`[QLens] GetAllGoodsInfo ${status} p${page}/${totalPages}: ${items.length}개`);

      items.forEach(item => allItems.push({
        GoodsCode:  item.ItemCode   || '',
        SellerCode: item.SellerCode || '',
        Status:     item.ItemStatus || status,
        GoodsName:  '',   // Step 2에서 채움
        Price:      0,
        _source:    'api'
      }));
      page++;
    }
  }

  console.log('[QLens] 전체 상품 수:', allItems.length);
  if (allItems.length === 0) return [];

  // Step 2 — seller.qoo10.jp 상품목록 페이지 스크래핑 (한 번에 전체 이름 수집)
  // GetItemDetailInfo API는 개당 1회 호출 → 426개면 426번 → 너무 느림
  // seller.qoo10.jp 목록 페이지에서 한 번에 긁어오는 게 훨씬 빠름
  try {
    function scrapeAllItemNames() {
      const items = [];
      // seller.qoo10.jp/ko/item/list — React SPA, 렌더된 DOM 읽기
      document.querySelectorAll(
        'tr[class*="row"], [class*="item-row"], [class*="goods-row"], ' +
        'table tbody tr, [class*="TableRow"], [class*="table-row"]'
      ).forEach(row => {
        const t = row.innerText || '';
        const codeM = t.match(/(11\d{8})/); // 11자리 큐텐 상품코드
        if (!codeM) return;
        // 링크 텍스트 우선
        const link = row.querySelector('a');
        let name = (link?.innerText || '').trim();
        // 없으면 td에서 가장 긴 텍스트
        if (!name || name.length < 3) {
          const cells = Array.from(row.querySelectorAll('td, [class*="cell"], [class*="Col"]'));
          const cand  = cells
            .map(c => (c.innerText || '').trim())
            .filter(t => t.length > 3 && !/^\d[\d,¥]*$/.test(t) && !/^\s*$/.test(t));
          name = cand.sort((a,b) => b.length - a.length)[0] || '';
        }
        const priceEl = row.querySelector('[class*="price"], [class*="Price"], [class*="amount"]');
        const price = parseInt((priceEl?.innerText||'').replace(/[^\d]/g,'')) || 0;
        if (name) items.push({ code: codeM[1], name: name.slice(0,100), price });
      });
      return items;
    }

    // seller.qoo10.jp 시도 → 실패 시 QSM aspx
    let scraped = null;
    // ★ seller.qoo10.jp는 404 Not Found (사용자 접근 불가) → QSM URL만 사용
    for (const url of [
      'https://qsm.qoo10.jp/GMKT.INC.Gsm.Web/Item/ItemListNew.aspx',
    ]) {
      try {
        const r = await qsmScrapeTab(url, scrapeAllItemNames);
        if (Array.isArray(r) && r.length > 0) {
          const map = {};
          r.forEach(s => { map[s.code] = s; });
          allItems.forEach(item => {
            if (map[item.GoodsCode]) {
              item.GoodsName = map[item.GoodsCode].name;
              if (!item.Price) item.Price = map[item.GoodsCode].price;
            }
          });
          console.log('[QLens] 상품명 스크래핑 성공:', url, '→', r.length, '개');
          scraped = r; break;
        }
      } catch(e) { console.warn('[QLens] 상품명 URL 실패:', url, e.message); }
    }
    if (!scraped) console.warn('[QLens] 상품명 스크래핑 실패 → GetItemDetailInfo 폴백');
  } catch(e) {
    console.warn('[QLens] 상품명 스크래핑 오류:', e.message);
  }

  // Step 3 — 이름 없는 상품만 GetItemDetailInfo (최대 20개)
  const activeItems = allItems.filter(i => !i.GoodsName && i.Status === 'S2').slice(0, 20);
  let detailOk = 0;
  for (const item of activeItems) {
    try {
      const res = await qsmCall('ItemsLookup.GetItemDetailInfo', {
        ItemCode: item.GoodsCode
      }, '1.2');
      if (res.ok && res.result) {
        // ★ API 응답이 Array일 수도 Object일 수도 있음 — 둘 다 처리
        const d = Array.isArray(res.result) ? res.result[0] : res.result;
        if (!d) continue;
        // 사용 가능한 모든 이름 필드 시도
        const name = d.ItemTitle || d.PromotionName || d.GoodsName || d.ModelNM || d.Title || '';
        console.log('[QLens] GetItemDetailInfo', item.GoodsCode,
          '→ ItemTitle:', d.ItemTitle, '/ PromotionName:', d.PromotionName, '/ raw keys:', Object.keys(d).slice(0,10).join(','));
        item.GoodsName = name;
        item.Price     = parseFloat(d.ItemPrice || d.RetailPrice || d.StandardPrice || '0');
        item._hasDetail = true;
        item._rawDetail = d; // 디버그용
        detailOk++;
      }
    } catch (e) {
      console.warn('[QLens] GetItemDetailInfo 오류:', item.GoodsCode, e.message);
    }
  }
  console.log(`[QLens] 상세 조회 완료: ${detailOk}/${activeItems.length}개`);

  // 이름이 아직 없는 상품 → QSM 상품목록 탭 스크래핑으로 보완
  const unnamed = allItems.filter(i => !i.GoodsName);
  if (unnamed.length > 0) {
    console.log('[QLens] 이름 없는 상품', unnamed.length, '개 → 상품목록 탭 스크래핑 시도');
    try {
      // seller.qoo10.jp 상품 목록 페이지 우선 시도, QSM 폴백
      function scrapeItemNames() {
        const items = [];
        // seller.qoo10.jp 상품관리 페이지 — React SPA
        // 상품 행: 상품코드(11자리) + 상품명 텍스트
        const rows = document.querySelectorAll(
          'tr, [class*="item-row"], [class*="product-row"], [class*="goods-row"], li[class*="item"]'
        );
        rows.forEach(row => {
          const t = row.innerText || '';
          // 11자리 큐텐 상품코드
          const codeM = t.match(/(11\d{8})/);
          if (!codeM) return;
          const code = codeM[1];
          // 상품명: 코드 주변에서 한국어/일본어 텍스트 추출
          // 링크 텍스트 우선
          const link = row.querySelector('a');
          let name = link?.innerText?.trim() || '';
          // 링크 없으면 td/div 텍스트에서 추출
          if (!name) {
            const cells = Array.from(row.querySelectorAll('td, div[class*="name"], span[class*="title"]'));
            name = cells.find(c => c.innerText && c.innerText.length > 3 && !/^\d+$/.test(c.innerText.trim()))?.innerText?.trim() || '';
          }
          const priceEl = row.querySelector('[class*="price"], [class*="Price"]');
          const price = parseInt((priceEl?.innerText || '').replace(/[^\d]/g,'')) || 0;
          if (name && name.length > 1) items.push({ code, name: name.slice(0,100), price });
        });
        return items;
      }

      // 시도 URL 순서: seller.qoo10.jp → QSM aspx
      let scraped = null;
      for (const url of [
        'https://seller.qoo10.jp/ko/item/list',
        'https://seller.qoo10.jp/ko/items',
        'https://qsm.qoo10.jp/GMKT.INC.Gsm.Web/Item/ItemListNew.aspx'
      ]) {
        try {
          const r = await qsmScrapeTab(url, scrapeItemNames);
          if (Array.isArray(r) && r.length > 0) { scraped = r; break; }
        } catch(e) { console.warn('[QLens] 상품목록 URL 실패:', url, e.message); }
      }
      if (Array.isArray(scraped) && scraped.length > 0) {
        const codeMap = {};
        scraped.forEach(s => { codeMap[s.code] = s; });
        allItems.forEach(item => {
          if (!item.GoodsName && codeMap[item.GoodsCode]) {
            item.GoodsName = codeMap[item.GoodsCode].name;
            if (!item.Price) item.Price = codeMap[item.GoodsCode].price;
          }
        });
        console.log('[QLens] 상품목록 스크래핑으로 이름 보완:', scraped.length, '개');
      }
    } catch (e) {
      console.warn('[QLens] 상품목록 탭 스크래핑 실패:', e.message);
    }
  }
  // ★ 이름 없는 상품: SellerCode(한국어 상품명) 사용 → 그래도 없으면 상품코드
  allItems.forEach(i => {
    if (!i.GoodsName) {
      if (i.SellerCode && i.SellerCode.length > 4 && !/^[A-Z0-9_]+$/.test(i.SellerCode)) {
        // SellerCode가 의미있는 텍스트면 사용 (Q10 Auto는 한국어 상품명을 SellerCode로 저장)
        i.GoodsName = i.SellerCode;
        i._nameFromSeller = true;
      } else {
        i.GoodsName = `상품코드 ${i.GoodsCode}`;
      }
    }
  });
  return allItems;
}

/* ══════════════════════════════════════════════════════
   주문 수집 전략 (3단계 폴백)
   ① OrderService.OrderNewslookup QAPI
   ② QSM 거래 요약 페이지 스크래핑 (거래상품수량/거래금액)
   ③ QSM 주문관리 페이지 스크래핑
══════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════
   거래요약 스크래핑 — executeScript로 렌더된 DOM 읽기
   QSM 판매현황 페이지: 거래상품수량, 거래금액 추출
══════════════════════════════════════════════════ */
async function fetchSalesSummaryPage() {
  // ★ 실제 함수 객체 전달 (문자열 X → eval/new Function X → CSP 통과)
  // Analytics에서 먼저 시도 (더 정확)
  try {
    const analyticsData = await fetchFromAnalytics();
    if (analyticsData && (analyticsData.orderCount > 0 || analyticsData.revenue > 0)) {
      console.log('[QLens] Analytics에서 거래요약 획득:', analyticsData.orderCount, '건');
      return {
        orderCount: analyticsData.orderCount,
        revenue:    analyticsData.revenue,
        orders:     []
      };
    }
  } catch(e) {
    console.warn('[QLens] Analytics 시도 실패, QSM으로 폴백:', e.message);
  }

  function scrapeSalesSummary() {
    const result = { orderCount: 0, revenue: 0, orders: [] };
    try {
      const bodyText = document.body.innerText || '';
      // 거래상품수량
      const cMatch = bodyText.match(/거래상품수량[\s\S]{0,30}?([\d,]+)\s*個/)||
                     bodyText.match(/거래상품수량[\s\S]{0,30}?([\d,]+)\s*개/)||
                     bodyText.match(/거래상품수량[^\d]*([\d,]+)/);
      if (cMatch) result.orderCount = parseInt(cMatch[1].replace(/,/g,'')) || 0;
      // 총 거래금액
      const aMatch = bodyText.match(/총\s*거래금액[\s\S]{0,80}?([\d,]{3,})/)||
                     bodyText.match(/거래금액[\s\S]{0,30}?([\d,]{3,})\s*[円¥]/)||
                     bodyText.match(/거래금액[^\d]*([\d,]{3,})/);
      if (aMatch) {
        const v = parseInt(aMatch[1].replace(/,/g,''));
        if (v > 0 && v < 1_000_000_000) result.revenue = v;
      }
      // 주문 목록 (테이블)
      document.querySelectorAll('table tbody tr').forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td'));
        if (cells.length < 2) return;
        const texts = cells.map(td => td.innerText?.trim() || '');
        const name  = texts.find(t => t.length > 3 && !/^\d+$/.test(t)) || '';
        const price = texts.find(t => /^\d[\d,]+$/.test(t.replace(/[¥円\s]/g,''))) || '0';
        const date  = texts.find(t => /\d{4}[\/\-]\d{2}/.test(t)) || '';
        if (name) result.orders.push({
          GoodsName: name.slice(0,80), OrderPrice: parseInt(price.replace(/[^\d]/g,''))||0,
          OrderDate: (date.match(/\d{4}[\/\-]\d{2}[\/\-]\d{2}/)||[''])[0],
          OrderStatus: 'complete', _source: 'executeScript'
        });
      });
    } catch(e) { /* 페이지 내 오류 무시 */ }
    return result;
  }

  const targetUrl = 'https://qsm.qoo10.jp/GMKT.INC.Gsm.Web/Sale/SaleAnalysis.aspx';
  try {
    const data = await qsmScrapeTab(targetUrl, scrapeSalesSummary);
    if (data) {
      console.log('[QLens] 거래요약 OK:', data.orderCount, '건 /', data.revenue, '円');
      return data;
    }
  } catch (e) {
    // qsmScrapeTab은 throw 안 함 (v1.8.3+)
    console.warn('[QLens] 거래요약 오류:', e.message);
  }
  return null;
}

/* 거래요약 HTML 파싱 — 거래상품수량 / 거래금액 추출 */
function parseSalesSummaryHtml(html) {
  const result = { orderCount: 0, revenue: 0, orders: [] };
  try {
    const doc  = new DOMParser().parseFromString(html, 'text/html');
    const text = doc.body.innerText || doc.body.textContent || '';

    // ① 거래상품수량 파싱 (예: 거래상품수량 5개 또는 거래상품수량 : 5)
    const countPatterns = [
      /거래상품수량[^0-9]*([0-9,]+)/s,
      /거래\s*수량[^0-9]*([0-9,]+)/s,
      /판매수량[^0-9]*([0-9,]+)/s,
      /注文数[^0-9]*([0-9,]+)/s
    ];
    for (const pat of countPatterns) {
      const m = text.match(pat);
      if (m) { result.orderCount = parseInt(m[1].replace(/,/g, '')) || 0; break; }
    }

    // ② 총 거래금액 파싱 (예: "총 거래금액(취소분 반영) 25,178" 또는 "거래금액 25,178円")
    const amtPatterns = [
      /총\s*거래금액[^0-9]*([\d,]+)/s,
      /거래금액[^0-9]*([\d,]+)/s,
      /총\s*매출[^0-9]*([\d,]+)/s,
      /売上金額[^0-9]*([\d,]+)/s
    ];
    for (const pat of amtPatterns) {
      const m = text.match(pat);
      if (m) {
        const val = parseInt(m[1].replace(/,/g, '')) || 0;
        if (val > 0 && val < 1_000_000_000) { result.revenue = val; break; }
      }
    }

    // ③ 주문 목록 테이블 (있으면 파싱)
    doc.querySelectorAll('table tbody tr').forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 2) return;
      const name  = Array.from(tds).find(td => td.textContent.trim().length > 3)?.textContent?.trim() || '';
      const price = Array.from(tds).find(td => /[0-9]{3,}/.test(td.textContent))?.textContent?.replace(/[^0-9]/g,'') || '0';
      const date  = Array.from(tds).map(td => td.textContent.match(/\d{4}[\/\-]\d{2}[\/\-]\d{2}/)?.[0]).find(Boolean) || '';
      if (name && name.length > 2) {
        result.orders.push({
          GoodsName: name, OrderPrice: parseFloat(price),
          OrderDate: date, OrderStatus: 'complete', _source: 'web'
        });
      }
    });

    console.log('[QLens] 거래요약 파싱 결과:', result.orderCount, '건 /', result.revenue, '円 /', result.orders.length, '행');
  } catch (e) { console.error('[QLens] 거래요약 파싱 오류:', e); }
  return result;
}

/* ── 주문 목록 수집 (메인) ── */
async function fetchOrders() {
  // ① QAPI 주문/배송 조회 — 여러 상태(신규+배송준비+배송중) 모두 합산
  //    큐텐 QAPI는 상태별로 나뉘어 있어 한 메서드만 부르면 누락됨
  //    (JQSM "신규주문 2 / 배송요청 4" → 두 상태 다 잡아야 함)
  try {
    const end   = dateRange.end;
    const start = dateRange.start;
    const sd = start.replace(/-/g, '');   // YYYYMMDD
    const ed = end.replace(/-/g, '');

    // 시도할 메서드 + 파라미터 (검증 결과: v2가 정상 동작, v3는 날짜형식 거부)
    // ShippingStat: 1=배송요청(신규), 2=배송준비, 3=발송완료(Seller confirm)
    const attempts = [
      { method: 'ShippingBasic.GetShippingInfo_v2', base: { search_Sdate: sd, search_Edate: ed }, statKey: 'ShippingStat', stats: ['1','2','3'] },
    ];

    for (const at of attempts) {
      let collected = [];
      let anyOk = false;
      for (const st of at.stats) {
        try {
          const params = { ...at.base };
          params[at.statKey] = st;
          const res = await qsmCall(at.method, params, '1.0');
          if (res.ok && Array.isArray(res.result)) {
            anyOk = true;
            // v2 응답 필드 → 표준 필드로 정규화 (렌더/소싱매칭용)
            res.result.forEach(o => {
              o._stat = st;
              if (!o.OrderStatus && !o.StatusCode) o.OrderStatus = o.shippingStatus || st;
              // 날짜: orderDate / PaymentDate
              if (!o.OrderDate) o.OrderDate = o.orderDate || o.PaymentDate || '';
              // 상품명 후보 (v2는 itemTitle/goodsName 등 다양)
              if (!o.GoodsName) o.GoodsName = o.itemTitle || o.goodsName || o.GoodsName || o.ItemTitle || '';
              // 금액 후보
              if (!o.OrderPrice) o.OrderPrice = o.orderPrice || o.paymentAmt || o.settleAmt || o.price || 0;
              // 상품코드 (소싱 매칭용)
              if (!o.SellerItemCode) o.SellerItemCode = o.sellerItemCode || o.sellerCode || o.SellerCode || '';
              if (!o.ItemCode) o.ItemCode = o.itemCode || o.goodsNo || o.GoodsNo || '';
            });
            collected = collected.concat(res.result);
            console.log(`[QLens] ${at.method} stat=${st}: ${res.result.length}건`);
          } else if (res.code) {
            console.warn(`[QLens] ${at.method} stat=${st} 실패:`, res.code, res.msg, res._raw?.slice(0,80));
          }
        } catch (e) {
          console.warn(`[QLens] ${at.method} stat=${st} 오류:`, e.message);
        }
      }
      if (collected.length > 0) {
        // 중복 제거 (주문번호 기준)
        const seen = new Set();
        const uniq = collected.filter(o => {
          const k = o.OrderNo || o.orderNo || o.packNo || JSON.stringify(o).slice(0,60);
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });
        console.log('[QLens] 주문 합산 결과:', uniq.length, '건');
        return uniq;
      }
      if (anyOk) {
        // 호출은 성공했지만 0건 → 다음 attempt 시도 안 하고 종료 (실제 0건)
        console.log('[QLens] QAPI 주문 0건 (정상 응답)');
        break;
      }
    }
    // 구 메서드도 마지막으로 한 번 (혹시 셀러 계정이 구형 API면)
    try {
      const res = await qsmCall('OrderService.OrderNewslookup', {
        start_date: start.replace(/-/g, '/'), end_date: end.replace(/-/g, '/')
      }, '1.0');
      if (res.ok && Array.isArray(res.result) && res.result.length > 0) {
        console.log('[QLens] OrderNewslookup 폴백 성공:', res.result.length, '건');
        return res.result;
      }
    } catch (e) { /* 무시 */ }
  } catch (e) {
    console.warn('[QLens] 주문 QAPI 전체 오류:', e.message);
  }

  // ② QSM 거래요약 페이지 스크래핑 ← 핵심 (screenshot의 그 페이지)
  try {
    const summary = await fetchSalesSummaryPage();
    if (summary) {
      salesSummary = summary; // 전역 저장 → KPI에서 사용
      if (summary.orders.length > 0) return summary.orders;
      if (summary.orderCount > 0) {
        // 개별 목록은 없지만 총 건수는 알고 있음 → 더미 배열로 반환
        console.log('[QLens] 거래요약 페이지: 건수만 파악 =', summary.orderCount);
        return Array.from({ length: summary.orderCount }, (_, i) => ({
          GoodsName: `주문 ${i + 1}`,
          OrderPrice: summary.orderCount > 0 ? Math.round(summary.revenue / summary.orderCount) : 0,
          OrderDate:  today(),
          OrderStatus: 'complete',
          _synthetic: true,
          _source: 'analytics_summary'
        }));
      }
    }
  } catch (e) {
    // qsmScrapeTab은 throw 안 함 (v1.8.3+)
    console.warn('[QLens] 거래요약 스크래핑 오류:', e.message);
  }

  // ③ 주문관리 페이지 폴백 (qsmWebFetch가 정의되지 않아 제거 — v1.8.3)
  // 필요시 qsmScrapeTab으로 직접 페이지 DOM 스크래핑으로 대체

  return [];
}

/* ══════════════════════════════════════════════════════
   QSM 탭 스크래핑 — dashboard.js에서 직접 executeScript
   ★ service_worker 경유 없음 → CSP 우회
   func: 실제 함수 객체 (string 아님 → new Function/eval 없음)
══════════════════════════════════════════════════════ */
// ★ 스크래핑은 보조 데이터 수집용 — 실패해도 dashboard 정상 작동
// QAPI(GetAllGoodsInfo, OrderService)만 있어도 KPI/차트는 정상 표시됨
let _qsmScrapeWarned = false;
function resetQsmLogoutCache() { _qsmScrapeWarned = false; }

/**
 * QSM 탭에서 데이터 스크래핑 — 절대 throw하지 않음
 * - 실패 시 null 반환 (caller에서 폴백 처리)
 * - 로그인 자동 판단 안 함 (QSM 일시 장애와 구분 불가 → 사용자가 직접 판단)
 * - 새 탭은 사용자가 명시적으로 열 때만 (자동 오픈 없음)
 */
async function qsmScrapeTab(targetUrl, func) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://qsm.qoo10.jp/*' });
    // 로그인/에러 페이지 제외
    const isLoginPage = u => u.includes('Notice.aspx') || u.includes('/Login') || u.includes('aspxerrorpath');
    const goodTabs = tabs.filter(t => !isLoginPage(t.url || ''));

    if (goodTabs.length === 0) {
      // 사용 가능한 QSM 탭 없음 → 새 탭 자동 오픈 안 함, 그냥 null 반환
      if (!_qsmScrapeWarned) {
        console.warn('[QLens] QSM 탭이 열려있지 않음 - 스크래핑 스킵 (QAPI만 사용)');
        _qsmScrapeWarned = true;
      }
      return null;
    }

    // 적합한 탭 선택 (targetUrl 경로와 가장 일치)
    const pathKey = new URL(targetUrl).pathname.split('/').pop();
    const best = goodTabs.find(t => t.url?.includes(pathKey)) || goodTabs[0];
    const tabId = best.id;

    // 다른 페이지면 URL 변경 (최대 8초 대기)
    if (!best.url?.includes(pathKey)) {
      try {
        await chrome.tabs.update(tabId, { url: targetUrl });
        await new Promise(resolve => {
          const t = setTimeout(resolve, 8000);
          const listener = (id, info) => {
            if (id !== tabId) return;
            if (info.status === 'complete') {
              clearTimeout(t);
              chrome.tabs.onUpdated.removeListener(listener);
              setTimeout(resolve, 1500);
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      } catch (e) {
        console.warn('[QLens] 탭 URL 변경 실패:', e.message);
        return null;
      }
    }

    // executeScript
    const results = await chrome.scripting.executeScript({ target: { tabId }, func });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn('[QLens] qsmScrapeTab 실패 (무시):', e.message);
    return null;
  }
}

/* ── 주문 페이지 HTML 파싱 ── */
function parseOrdersFromHtml(html) {
  const orders = [];
  try {
    const doc  = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('table tbody tr, .list_tbl tbody tr').forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 3) return;
      const name  = Array.from(tds).find(td => td.textContent.trim().length > 5)?.textContent?.trim() || '';
      const price = Array.from(tds).find(td => /\d{3,}/.test(td.textContent))?.textContent?.replace(/[^0-9]/g,'') || '0';
      const dtMatch = Array.from(tds).map(td => td.textContent.match(/\d{4}[-./]\d{2}[-./]\d{2}/)?.[0]).find(Boolean) || '';
      if (name) orders.push({ GoodsName: name, OrderPrice: parseFloat(price), OrderDate: dtMatch, OrderStatus: '1', _source: 'web' });
    });
  } catch (e) { console.error('[QLens] 주문 파싱 오류:', e); }
  return orders;
}

/* ── 새로고침 ── */
async function doFetch() {
  resetQsmLogoutCache();  // ★ 매 새로고침마다 로그아웃 캐시 초기화
  showOv('QSM 데이터 로드 중...', '📦 상품 목록 수집 중...');
  try {
    const products = await fetchProducts();
    document.getElementById('overlaySub').textContent = '🛒 주문 내역 수집 중...';
    const orders   = await fetchOrders();
    await storageSet({
      lensAnalyticsProductCache: { ts: Date.now(), items: products },
      lensAnalyticsOrderCache:   { ts: Date.now(), orders }
    });
    cachedProducts = products; cachedOrders = orders;
    buildKoByCode();
    await saveSnapshot(products, orders);
    await loadSourcingMap(true);   // 소싱맵 갱신 (주문↔소싱URL 매칭용)
    renderAll();
    renderDonutChart(cachedProducts);
    renderOrderTrendChart();
    await measure();
    document.getElementById('statusDot').classList.add('on');
    const t = new Date();
    document.getElementById('lastUpdate').textContent =
      '업데이트 ' + t.toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    toast('✅ 새로고침 완료', 'ok');
  } catch (e) {
    toast('❌ ' + e.message, 'err');
    // 설정 이동 플래그가 있으면 3초 후 설정 페이지로
    if (e.goSettings) {
      setTimeout(() => chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings.html') }), 2000);
    }
    console.error('[QLens]', e);
  } finally { hideOv(); }
}

/* ── 스냅샷 저장 ── */
async function saveSnapshot(products, orders) {
  const onSale  = products.filter(p => p.Status === 'S2').length;  // 거래가능
  const stopped = products.filter(p => p.Status === 'S1').length;  // 거래대기
  const pending = products.filter(p => p.Status === 'S0').length;  // 검수대기
  // 전체 건수 (synthetic 제외, 없으면 salesSummary에서 보완)
  const newOrd  = orders.filter(o => !o._synthetic).length || (salesSummary?.orderCount || orders.length);
  const revenue = orders.reduce((s, o) => s + parseFloat(o.OrderPrice || o.Price || 0), 0);
  const snap = {
    date: today(), ts: Date.now(),
    products: { total: products.length, onSale, stopped, pending },
    orders:   { newCount: newOrd, total: orders.length },
    revenue:  { monthlyJPY: Math.round(revenue) }
  };
  const idx = snapshots.findIndex(s => s.date === today());
  if (idx >= 0) snapshots[idx] = snap; else snapshots.push(snap);
  snapshots = trimSnaps(snapshots, config.retentionPeriod);
  await storageSet({ lensAnalyticsSnapshots: snapshots });
}

/* ── 캐시 로드 (1h TTL) ── */
async function loadCache() {
  const d = await storageGet(['lensAnalyticsProductCache','lensAnalyticsOrderCache']);
  const now = Date.now(); let has = false;
  if (d.lensAnalyticsProductCache && now - d.lensAnalyticsProductCache.ts < CACHE_TTL) {
    cachedProducts = d.lensAnalyticsProductCache.items || []; has = true;
    buildKoByCode();
  }
  if (d.lensAnalyticsOrderCache && now - d.lensAnalyticsOrderCache.ts < CACHE_TTL) {
    cachedOrders = d.lensAnalyticsOrderCache.orders || []; has = true;
    const t = new Date(d.lensAnalyticsOrderCache.ts);
    document.getElementById('lastUpdate').textContent =
      '업데이트 ' + t.toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    document.getElementById('statusDot').classList.add('on');
  }
  if (has) { loadSourcingMap().then(() => renderAll()); }
  const exp = [];
  if (d.lensAnalyticsProductCache && now - d.lensAnalyticsProductCache.ts >= CACHE_TTL) exp.push('lensAnalyticsProductCache');
  if (d.lensAnalyticsOrderCache   && now - d.lensAnalyticsOrderCache.ts   >= CACHE_TTL) exp.push('lensAnalyticsOrderCache');
  if (exp.length) await storageRm(exp);
}

/* ── 트림 ── */
function trimSnaps(arr, period) {
  const days = RETENTION_DAYS[period] || 30;
  return arr.filter(s => s.ts >= Date.now() - days * 86400_000);
}

/* ── 보존기간 체크 ── */
async function checkRetention() {
  if (!snapshots.length) return;
  const cut = Date.now() - (RETENTION_DAYS[config.retentionPeriod] || 30) * 86400_000;
  const old = snapshots.filter(s => s.ts < cut);
  if (!old.length) return;
  if (Date.now() - config.lastCleanupNotice < 86400_000) return;
  const lbl = { '1month':'1개월','6months':'6개월','1year':'1년' }[config.retentionPeriod];
  document.getElementById('retentionMsg').innerHTML =
    `<strong>데이터 정리 필요</strong> — 보존 기간(${lbl}) 초과 스냅샷 <strong>${old.length}개</strong>`;
  document.getElementById('retentionAlert').classList.add('show');
  config.lastCleanupNotice = Date.now();
  await storageSet({ lensAnalyticsConfig: config });
}

/* ── 전체 렌더 ── */
function renderAll() { renderKPI(); renderProductTable(); renderOrderTable(); renderChart(); }

/* ── KPI ── */
function renderKPI() {
  const p = cachedProducts, o = cachedOrders;
  const onSale  = p.filter(x => x.Status === 'S2' || x.ItemStatus === 'S2').length;
  const stopped = p.filter(x => x.Status === 'S1' || x.ItemStatus === 'S1').length;
  // 주문 건수: synthetic 포함 전체 (StatusCode 필터 제거 — QSM 상태코드 형식이 다양함)
  const newOrd  = o.filter(x => !x._synthetic).length || // 실제 주문만
                  (salesSummary?.orderCount || o.length); // 거래요약에서 보완
  // 매출: 실제 합산 or 거래요약 페이지 금액 사용
  const revenue = o.filter(x => !x._synthetic).reduce((s, x) => s + parseFloat(x.OrderPrice || x.Price || 0), 0) ||
                  (salesSummary?.revenue || 0);

  document.getElementById('kpiOnSale').textContent    = fmtNum(onSale);
  document.getElementById('kpiOnSaleSub').textContent = `전체 ${p.length}개 중`;
  document.getElementById('kpiOrders').textContent    = fmtNum(newOrd);
  const isSynthetic = o.length > 0 && o[0]?._synthetic;
  document.getElementById('kpiOrdersSub').textContent = isSynthetic
    ? `거래요약 집계 (개별 목록 미지원)`
    : `최근 30일 총 ${o.length}건`;
  document.getElementById('kpiRevenue').textContent = fmtPrice(Math.round(revenue));
  const revSubEl = document.getElementById('kpiRevSub'); if(revSubEl) revSubEl.textContent = '최근 30일 주문 합산';
  // 4번째 KPI 카드 = 스냅샷 누적 (HTML에서 kpiSnaps)
  const snapEl = document.getElementById('kpiSnaps');
  if (snapEl) snapEl.textContent = fmtNum(snapshots.length);

  if (snapshots.length >= 2) {
    const prev = snapshots[snapshots.length - 2];
    setTrend('kpiOnSaleTrend', onSale, prev.products?.onSale);
    setTrend('kpiOrderTrend', newOrd, prev.orders?.newCount);
    setTrend('kpiRevTrend', Math.round(revenue), prev.revenue?.monthlyJPY);
    setTrend('kpiStopTrend', stopped, prev.products?.stopped, true);
  }

  // ── 미발송 주문 모니터링 (stat 1=신규, 2=배송준비 → 아직 발송 안 함) ──
  renderUnshippedBanner(o);
}

// 미발송 주문 배너 + 알림
function renderUnshippedBanner(orders) {
  const real = orders.filter(x => !x._synthetic);
  const unshipped = real.filter(x => String(x._stat) === '1' || String(x._stat) === '2');
  const newCnt  = real.filter(x => String(x._stat) === '1').length;
  const prepCnt = real.filter(x => String(x._stat) === '2').length;

  let banner = document.getElementById('unshippedBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'unshippedBanner';
    // KPI 카드 영역 바로 아래에 삽입
    const kpiRow = document.querySelector('.kpi-row') || document.querySelector('.kpi-grid') || document.body;
    kpiRow.parentNode.insertBefore(banner, kpiRow.nextSibling);
  }

  if (unshipped.length === 0) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'flex';
  banner.style.cssText += ';display:flex;align-items:center;gap:14px;margin:14px 0;padding:14px 18px;border-radius:12px;background:linear-gradient(135deg,rgba(255,122,47,.12),rgba(255,59,59,.08));border:1px solid rgba(255,122,47,.35)';
  banner.innerHTML = `
    <div style="font-size:26px">🚚</div>
    <div style="flex:1">
      <div style="font-weight:800;font-size:15px;color:var(--orange,#ff7a2f)">발송 대기 주문 ${unshipped.length}건</div>
      <div style="font-size:12px;color:var(--text2,#8888aa);margin-top:2px">
        ${newCnt > 0 ? `신규주문 ${newCnt}건` : ''}${newCnt > 0 && prepCnt > 0 ? ' · ' : ''}${prepCnt > 0 ? `배송요청 대기 ${prepCnt}건` : ''}
        — JQSM에서 배송요청 처리하세요
      </div>
    </div>
    <button id="unshippedJumpBtn" class="btn-jump" style="font-size:12px;padding:8px 14px;border-radius:8px;border:1px solid var(--orange,#ff7a2f);background:var(--orange,#ff7a2f);color:#fff;cursor:pointer;white-space:nowrap;font-weight:700">주문 보기 ↓</button>
  `;

  // "주문 보기" → 주문 테이블로 스크롤 + 신규 필터
  document.getElementById('unshippedJumpBtn').onclick = () => {
    const sel = document.getElementById('orderFilter');
    if (sel) { sel.value = 'all'; }
    renderOrderTable();
    document.getElementById('orderTbody')?.closest('.card,.panel,section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 데스크톱 알림 (새 미발송 건이 늘었을 때만)
  maybeNotifyUnshipped(unshipped.length, newCnt);
}

// 미발송 건수가 이전보다 늘었을 때만 알림 (중복 알림 방지)
async function maybeNotifyUnshipped(count, newCnt = 0) {
  try {
    const { _lastUnshippedNotice } = await storageGet(['_lastUnshippedNotice']);
    const prev = _lastUnshippedNotice || { count: 0, newCnt: 0, ts: 0 };
    // 신규주문이 늘었으면 우선 알림 / 아니면 미발송 총건수 증가 시 알림
    const newArrived  = newCnt > (prev.newCnt || 0);
    const moreUnship  = count > prev.count;
    if ((newArrived || moreUnship) && Date.now() - prev.ts > 300000) {
      const delta = newArrived ? newCnt - (prev.newCnt || 0) : 0;
      const title = newArrived ? '🛍️ QLens — 새 주문 도착!' : '🚚 QLens — 발송 대기 주문';
      const message = newArrived
        ? `신규 주문 ${delta}건이 들어왔어요! (대기 중 총 ${count}건) — KSE/MIR에서 발송 처리하세요.`
        : `발송하지 않은 주문이 ${count}건 있습니다. KSE/MIR에서 처리하세요.`;
      chrome.notifications?.create('qlens-order-' + Date.now(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('assets/icons/lens-128.png'),
        title, message, priority: 2,
      }, () => { if (chrome.runtime.lastError) {/* 아이콘 없으면 무시 */} });
    }
    await storageSet({ _lastUnshippedNotice: { count, newCnt, ts: Date.now() } });
  } catch (e) {
    console.warn('[QLens] 알림 처리 실패:', e.message);
  }
}
function setTrend(id, now, prev, invertGood = false) {
  const el = document.getElementById(id);
  if (prev == null) { el.textContent = ''; el.className = 'kpi-trend flat'; return; }
  const diff = now - prev;
  if (!diff) { el.textContent = '→'; el.className = 'kpi-trend flat'; return; }
  const pct  = prev > 0 ? Math.round(Math.abs(diff) / prev * 100) : 100;
  const isUp = diff > 0;
  el.textContent = (isUp ? '▲ +' : '▼ -') + pct + '%';
  el.className   = 'kpi-trend ' + ((invertGood ? !isUp : isUp) ? 'up' : 'dn');
}

/* ── 차트 ── */
function renderChart() {
  const canvas = document.getElementById('salesChart');
  const empty  = document.getElementById('chartEmpty');
  const days   = RETENTION_DAYS[currentPeriod] || 30;
  const data   = snapshots.filter(s => s.ts >= Date.now() - days * 86400_000).sort((a,b) => a.ts - b.ts);

  if (data.length < 2) {
    canvas.style.display = 'none'; empty.style.display = 'flex'; return;
  }
  canvas.style.display = 'block'; empty.style.display = 'none';

  const W = canvas.parentElement.clientWidth || 800;
  const H = 240;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const PAD = { t:20, r:20, b:38, l:50 };
  const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;
  const orders  = data.map(d => d.orders?.total || 0);
  const onSales = data.map(d => d.products?.onSale || 0);
  const maxY = Math.max(...orders, ...onSales, 1);
  const n    = data.length;

  // 그리드
  ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.t + (cH / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + cW, y); ctx.stroke();
    ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxY * (1 - i / 4)), PAD.l - 6, y + 4);
  }
  const step = Math.max(1, Math.floor(n / 8));
  ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center';
  data.forEach((d, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    ctx.fillText(d.date.slice(5), PAD.l + (i / (n - 1)) * cW, H - PAD.b + 16);
  });

  function drawLine(vals, color, fillAlpha) {
    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = PAD.l + (i / (n - 1)) * cW;
      const y = PAD.t + cH - (v / maxY) * cH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(PAD.l + cW, PAD.t + cH); ctx.lineTo(PAD.l, PAD.t + cH); ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + cH);
    grad.addColorStop(0, color.replace(')', `,${fillAlpha})`).replace('rgb','rgba'));
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad; ctx.fill();
    if (n <= 30) vals.forEach((v, i) => {
      const x = PAD.l + (i / (n - 1)) * cW, y = PAD.t + cH - (v / maxY) * cH;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    });
  }
  drawLine(onSales, 'rgb(16,185,129)', 0.12);
  drawLine(orders,  'rgb(59,130,246)', 0.12);
}

/* ── 상품 테이블 ── */
function statusBadge(s) {
  // QSM API Status 코드:
  // S2 = 거래가능 (판매 중)
  // S1 = 거래대기 (판매 일시중지)
  // S0 = 검수대기 (등록 대기)
  // S3 = 거래종지 = 판매기간 종료 or Qoo10 측 종료
  // S5 = 거래제한 = 품절/제한
  // S8 = 승인거부
  s = String(s || '');
  if (s === 'S2') return '<span class="badge badge-on">판매 중</span>';
  if (s === 'S1') return '<span class="badge badge-off">일시중지</span>';
  if (s === 'S0') return '<span class="badge badge-pend">등록 대기</span>';
  if (s === 'S3') return '<span class="badge badge-cancel">판매기간 종료</span>';
  if (s === 'S5') return '<span class="badge badge-cancel">품절·제한</span>';
  if (s === 'S8') return '<span class="badge badge-cancel">승인 거부</span>';
  return `<span class="badge badge-off">${s || '-'}</span>`;
}
function renderProductTable() {
  const q = (document.getElementById('productSearch')?.value || '').toLowerCase();
  const f = document.getElementById('productFilter')?.value || 'all';
  filteredProducts = cachedProducts.filter(p => {
    const nm = (p.GoodsName || p.ItemName || '').toLowerCase();
    const st = p.Status || p.ItemStatus || '';
    return (!q || nm.includes(q)) && (f === 'all' || st === f);
  });
  document.getElementById('productBadge').textContent = filteredProducts.length + '개';
  const tp = Math.max(1, Math.ceil(filteredProducts.length / PER_PAGE));
  if (productPage > tp) productPage = 1;
  const sl = filteredProducts.slice((productPage - 1) * PER_PAGE, productPage * PER_PAGE);
  document.getElementById('productTbody').innerHTML = sl.length ? sl.map(p => {
    const codeRaw  = String(p.GoodsCode || p.ItemCode || '').trim();
    const codeDigits = codeRaw.replace(/[^\d]/g, '');
    // 소싱맵: 숫자코드 우선 → 원본코드 → SellerCode(한국어명) → 일본어명 순서로 조회
    const info   = _sourcingMap?.infoByCode?.[codeDigits]
                || _sourcingMap?.infoByCode?.[codeRaw]
                || (p.SellerCode ? _sourcingMap?.infoByName?.[p.SellerCode.replace(/\s+/g,'')] : null)
                || null;
    const csvInfo = csvInfoFor(p);   // CSV 정산데이터 폴백
    const koName = info?.sellerCode || csvInfo?.sellerCode || p.SellerCode || '';
    const brand  = info?.brand || csvInfo?.brand || '';
    const jaName = p.GoodsName || p.ItemName || '-';
    const nm     = (koName && koName !== codeRaw) ? koName : jaName;
    const code   = codeDigits || codeRaw;
    const sellerUrl = code ? `https://seller.qoo10.jp/ko/item/view?gd_no=${code}` : '#';
    const pr   = parseFloat(p.Price || p.StandardPrice || 0);
    const ship = parseFloat(p.DeliveryFee || p.ShippingFee || 0);
    // 헤더(상품명·판매가·상태) 3칸과 정확히 일치 — QSM API가 재고를 안 줘서 항상 '-'로
    // 나오던 재고 칸을 제거(칸 밀림으로 상태 자리에 '-'가 보이던 버그 수정)
    return `<tr>
      <td class="td-name">
        <a href="${sellerUrl}" target="_blank" title="${nm}${koName && jaName !== koName ? '\n🇯🇵 '+jaName : ''}">${nameWithBrand(brand, nm)}</a>
      </td>
      <td class="td-mono td-right">
        ${pr ? fmtPrice(pr) : '-'}
        ${ship > 0 ? `<br><span style="font-size:10px;color:var(--text3)">+¥${ship.toLocaleString()} 배송</span>` : ''}
      </td>
      <td style="text-align:center">${statusBadge(p.Status || p.ItemStatus)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="3" class="tbl-empty"><div class="tbl-empty-icon">📭</div>${q ? '검색 결과 없음' : '상품 없음'}</td></tr>`;
  const pg = document.getElementById('productPg');
  pg.style.display = tp > 1 ? 'flex' : 'none';
  document.getElementById('pInfo').textContent = `${productPage} / ${tp}`;
  document.getElementById('pPrev').disabled = productPage <= 1;
  document.getElementById('pNext').disabled = productPage >= tp;
}

/* ── 주문 테이블 ── */
function orderBadge(s) {
  s = String(s || '');
  const low = s.toLowerCase();
  // 큐텐 배송 흐름: 주문 → (신규주문) → JQSM 배송요청일 입력 → (배송요청)
  //   배송완료/추적은 미구현이라 '배송요청'까지만 표시
  //   _stat 숫자코드: 1=신규주문 / 2~3=배송요청(셀러 확인·발송준비)
  if (s === '1') return '<span class="badge badge-new">신규주문</span>';
  if (s === '2' || s === '3') return '<span class="badge badge-ship">배송요청</span>';
  // v2 텍스트 상태
  if (low.includes('new') || /\(1\)/.test(s))
    return '<span class="badge badge-new">신규주문</span>';
  if (low.includes('seller confirm') || low.includes('preparing') || low.includes('shipping') ||
      low.includes('shipped') || low.includes('delivered') || /\(2\)/.test(s) || /\(3\)/.test(s))
    return '<span class="badge badge-ship">배송요청</span>';
  if (low.includes('cancel') || low.includes('취소'))
    return '<span class="badge badge-cancel">취소</span>';
  if (['11','OrderNew'].includes(s))      return '<span class="badge badge-new">신규주문</span>';
  if (['21','31','done','Done','Complete'].includes(s)) return '<span class="badge badge-ship">배송요청</span>';
  if (['9'].includes(s)) return '<span class="badge badge-cancel">취소</span>';
  return `<span class="badge badge-off">${s || '-'}</span>`;
}
function renderOrderTable() {
  const f  = document.getElementById('orderFilter')?.value || 'all';
  const sm = { new:['1'], shipping:['2','3'], cancel:['9'] };
  // synthetic(건수만 파악된) 주문은 테이블에서 제외
  filteredOrders = cachedOrders.filter(o => {
    if (o._synthetic) return false;
    return f === 'all' || (sm[f] || []).includes(String(o._stat || ''));
  });
  document.getElementById('orderBadge').textContent = filteredOrders.length + '건';
  const tp = Math.max(1, Math.ceil(filteredOrders.length / PER_PAGE));
  if (orderPage > tp) orderPage = 1;
  const sl = filteredOrders.slice((orderPage - 1) * PER_PAGE, orderPage * PER_PAGE);
  document.getElementById('orderTbody').innerHTML = sl.length ? sl.map((o, i) => {
    const jaName = o.GoodsName || o.ItemName || '-';
    // 한국어명 우선순위: ① 상품캐시(SellerCode) → ② 소싱맵 → ③ CSV → 없으면 일본어
    const codeKeys = [o.SellerItemCode, o.sellerItemCode, o.GoodsNo, o.ItemCode, o.itemCode];
    let koName = '';
    for (const c of codeKeys) {
      const cc = c && String(c).trim();
      if (cc && _koByCode[cc]) { koName = _koByCode[cc]; break; }
      const d = cc && cc.replace(/\D/g, '');
      if (d && _koByCode[d]) { koName = _koByCode[d]; break; }
    }
    if (!koName) for (const c of codeKeys) {
      const inf = c && _sourcingMap?.infoByCode?.[String(c).trim()];
      if (inf?.sellerCode) { koName = inf.sellerCode; break; }
    }
    const orderInfo = (() => {
      for (const c of codeKeys) {
        const inf = c && _sourcingMap?.infoByCode?.[String(c).trim()];
        if (inf) return inf;
      }
      return null;
    })();
    const brand = orderInfo?.brand || csvInfoFor(o)?.brand || '';
    if (!koName) {
      const key = jaName.replace(/\s+/g, '');
      koName = _sourcingMap?.infoByName?.[key] ? (_sourcingMap.infoByCode?.[key]?.sellerCode || '') : '';
      if (!koName) koName = csvInfoFor(o)?.sellerCode || '';
    }
    const nm  = koName || jaName;   // 한국어 있으면 한국어, 없으면 일본어
    const pr  = parseFloat(o.OrderPrice || o.Price || 0);
    const dt  = (o.OrderDate || o.RegDate || '').slice(0, 10);
    const gi  = (orderPage - 1) * PER_PAGE + i;
    const hit = !!findSourcingUrl(o);
    const btnLabel = hit ? '🔗 바로가기' : '🔍 검색';
    const btnCls   = hit ? 'src-btn hit' : 'src-btn';
    return `<tr>
      <td class="td-name" title="${nm}${koName && jaName !== koName ? '\n🇯🇵 '+jaName : ''}">${nameWithBrand(brand, nm)}</td>
      <td class="td-mono td-right">${pr ? fmtPrice(pr) : '-'}</td>
      <td class="td-mono" style="text-align:center">${dt}</td>
      <td style="text-align:center">${orderBadge(o._stat || o.OrderStatus || o.StatusCode)}</td>
      <td style="text-align:center"><button class="${btnCls}" data-order-idx="${gi}" title="${hit ? '소싱처 바로가기' : '올리브영 검색'}">${btnLabel}</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="tbl-empty"><div class="tbl-empty-icon">🛒</div>주문 없음</td></tr>`;
  const pg = document.getElementById('orderPg');
  pg.style.display = tp > 1 ? 'flex' : 'none';
  document.getElementById('oInfo').textContent = `${orderPage} / ${tp}`;
  document.getElementById('oPrev').disabled = orderPage <= 1;
  document.getElementById('oNext').disabled = orderPage >= tp;
}

/* ── 저장 용량 ── */
async function measure() {
  try {
    const all  = await storageGet(null);
    const enc  = o => new TextEncoder().encode(JSON.stringify(o)).length;
    const snapB  = enc(all.lensAnalyticsSnapshots || []);
    const cacheB = enc(all.lensAnalyticsProductCache || {}) + enc(all.lensAnalyticsOrderCache || {});
    const totB   = enc(all);
    const MAX = 10 * 1024 * 1024;
    document.getElementById('snapSize').textContent  = fmtBytes(snapB);
    document.getElementById('cacheSize').textContent = fmtBytes(cacheB);
    document.getElementById('totalSize').textContent = fmtBytes(totB);
    document.getElementById('snapCount').textContent = `스냅샷 ${snapshots.length}개`;
    document.getElementById('snapFill').style.width  = Math.min(100, snapB / MAX * 100).toFixed(1) + '%';
    document.getElementById('cacheFill').style.width = Math.min(100, cacheB / MAX * 100).toFixed(1) + '%';
    const pct = totB / MAX * 100;
    const tf  = document.getElementById('totalFill');
    tf.style.width = Math.min(100, pct).toFixed(1) + '%';
    tf.className = 'storage-fill ' + (pct > 70 ? 'red' : pct > 40 ? 'orange' : 'blue');
  } catch (e) { console.warn('[QLens] measure 오류:', e); }
}

/* ── Retention UI ── */
function syncRetUI() {
  document.querySelectorAll('.ret-opt').forEach(el =>
    el.classList.toggle('sel', el.dataset.period === config.retentionPeriod)
  );
}

/* ── 확인 모달 ── */
let _modalResolve = null;
function confirm2({ icon, title, desc, detail, okText = '삭제' }) {
  return new Promise(r => {
    _modalResolve = r;
    document.getElementById('modalIcon').textContent  = icon || '⚠️';
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalDesc').textContent  = desc;
    const det = document.getElementById('modalDetail');
    if (detail) { det.innerHTML = detail; det.style.display = 'block'; }
    else det.style.display = 'none';
    document.getElementById('modalOk').textContent = okText;
    document.getElementById('modal').classList.add('show');
  });
}

/* ════════════════════════════════════════
   Q10 Auto 연동 — 향후 연결용 스텁
   실제 사용 시: 설정에서 lensQ10AutoExtId 입력
   Q10 Auto가 chrome.runtime.onMessageExternal로 응답해야 함
   ════════════════════════════════════════ */
async function importFromQ10Auto() {
  const d = await storageGet(['lensQ10AutoExtId']);
  const extId = d.lensQ10AutoExtId;
  if (!extId) {
    toast('⚙️ 설정에서 Q10 Auto 확장 ID를 먼저 입력해주세요', 'err');
    setTimeout(() => chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings.html') }), 1500);
    return;
  }
  showOv('Q10 Auto 연결 중...', '확장 프로그램에 메시지 전송');
  try {
    const res = await new Promise(r =>
      chrome.runtime.sendMessage(extId, { type: 'Q10_EXPORT_DATA' }, res => {
        if (chrome.runtime.lastError) r({ ok: false, error: chrome.runtime.lastError.message });
        else r(res || { ok: false, error: '응답 없음' });
      })
    );
    if (!res.ok) throw new Error(res.error || 'Q10 Auto 응답 없음');
    const upd = {};
    if (res.qsmApiKey)   upd.lensQsmApiKey   = res.qsmApiKey;   // Q10 Auto는 평문 저장
    if (res.qsmUserId)   upd.lensQsmUserId   = res.qsmUserId;
    if (res.qsmPassword) upd.lensQsmPassword  = res.qsmPassword; // 암호화된 채로 전달
    if (Object.keys(upd).length) {
      await storageSet(upd);
      toast('✅ Q10 Auto 자격증명 가져오기 완료 — 새로고침을 눌러주세요', 'ok');
    } else {
      toast('⚠️ Q10 Auto에서 가져올 자격증명이 없습니다', 'err');
    }
  } catch (e) {
    toast('❌ Q10 Auto 연결 실패: ' + e.message, 'err');
  } finally { hideOv(); }
}

/* ── 초기화 ── */
async function init() {
  const autoRefresh = location.search.includes('refresh=1');
  const d = await storageGet(['lensQsmApiKey','lensQsmUserId','lensQsmPassword','lensAnalyticsConfig','lensAnalyticsSnapshots']);
  // 3가지 자격증명 모두 있어야 대시보드 표시
  const hasKey = !!(d.lensQsmApiKey && d.lensQsmUserId && d.lensQsmPassword);

  document.getElementById('mainPage').style.display  = hasKey ? 'block' : 'none';
  document.getElementById('emptyPage').style.display = hasKey ? 'none'  : 'flex';

  if (!hasKey) {
    document.getElementById('btnEmptySettings')?.addEventListener('click', () =>
      chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings.html') }));
    return;
  }

  config    = Object.assign({ retentionPeriod: '1month', lastCleanupNotice: 0 }, d.lensAnalyticsConfig || {});
  snapshots = Array.isArray(d.lensAnalyticsSnapshots) ? d.lensAnalyticsSnapshots : [];

  syncRetUI();
  await loadCache();
  await checkRetention();
  await measure();
  if (autoRefresh) await doFetch();
}

/* ── 이벤트 ── */

/* ══════════════════════════════════════════════════════
   날짜 범위 관리
══════════════════════════════════════════════════════ */
function updateDateRange(start, end, label) {
  dateRange = { start, end, label };

  // 입력창 동기화
  const dsEl = document.getElementById('dateStart');
  const deEl = document.getElementById('dateEnd');
  if (dsEl) dsEl.value = start;
  if (deEl) deEl.value = end;

  // 라벨
  const dispEl = document.getElementById('dateRangeDisplay');
  if (dispEl) dispEl.textContent = `${label} (${start} ~ ${end})`;

  // QSM Analytics 링크 업데이트
  const aLink = document.getElementById('analyticsLink');
  if (aLink) {
    // Analytics 날짜 파라미터 형식: yyyyMMdd
    const s = start.replace(/-/g,'');
    const e = end.replace(/-/g,'');
    aLink.href = `https://seller.qoo10.jp/ko/?startDt=${s}&endDt=${e}`;
  }

  // 프리셋 버튼 active 상태
  document.querySelectorAll('.date-preset').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.label === label);
  });
}

function initDateBar() {
  const today = new Date();
  const fmt   = d => d.toISOString().slice(0, 10);

  // 입력창 초기값
  const dsEl = document.getElementById('dateStart');
  const deEl = document.getElementById('dateEnd');
  if (dsEl) dsEl.value = dateRange.start;
  if (deEl) deEl.value = dateRange.end;

  // 프리셋 버튼
  document.querySelectorAll('.date-preset').forEach(btn => {
    btn.dataset.label = btn.textContent.trim();
    btn.addEventListener('click', () => {
      let start, end, label = btn.textContent.trim();
      const t = new Date(today);

      if (btn.dataset.days) {
        const days = parseInt(btn.dataset.days);
        t.setDate(t.getDate() - days);
        start = fmt(t); end = fmt(today);
      } else if (btn.dataset.month === 'current') {
        start = fmt(new Date(today.getFullYear(), today.getMonth(), 1));
        end   = fmt(today);
      } else if (btn.dataset.month === 'prev') {
        start = fmt(new Date(today.getFullYear(), today.getMonth() - 1, 1));
        end   = fmt(new Date(today.getFullYear(), today.getMonth(), 0));
      }
      document.querySelectorAll('.date-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateDateRange(start, end, label);
    });
  });

  // 직접 입력 + 적용 버튼
  document.getElementById('dateApply')?.addEventListener('click', () => {
    const s = document.getElementById('dateStart')?.value;
    const e = document.getElementById('dateEnd')?.value;
    if (!s || !e) { toast('날짜를 입력해주세요', 'err'); return; }
    if (s > e) { toast('시작일이 종료일보다 늦습니다', 'err'); return; }
    document.querySelectorAll('.date-preset').forEach(b => b.classList.remove('active'));
    updateDateRange(s, e, '직접 지정');
    toast(`✅ 기간 변경: ${s} ~ ${e}`, 'ok');
  });

  // Analytics 링크 초기화
  updateDateRange(dateRange.start, dateRange.end, dateRange.label);
}

/* ══════════════════════════════════════════════════════
   QSM Analytics 페이지 스크래핑
   qoo10analytics.qoo10.jp — 거래요약, 상품Top10, 고객현황
══════════════════════════════════════════════════════ */
async function fetchFromAnalytics() {
  // QSM Analytics 탭을 열고 dateRange 기간으로 데이터 읽기
  const s = dateRange.start.replace(/-/g,'');
  const e = dateRange.end.replace(/-/g,'');
  const analyticsUrl = `https://seller.qoo10.jp/ko/summary`;

  function scrapeAnalyticsSummary() {
    // QSM Analytics 요약 페이지에서 거래 데이터 읽기
    const result = { orderCount: 0, revenue: 0, shopFollowers: 0 };
    try {
      const body = document.body.innerText || '';
      // 거래상품수량 (예: "7개", "5개")
      const countM = body.match(/거래상품수량[\s\S]{0,50}?([\d,]+)\s*個/)||
                     body.match(/거래상품수량[\s\S]{0,50}?([\d,]+)\s*개/)||
                     body.match(/거래상품수량[^\d]*([\d,]+)/);
      if (countM) result.orderCount = parseInt(countM[1].replace(/,/g,''));

      // 총 거래금액 (예: "34,632円")
      const amtM = body.match(/총\s*거래금액[\s\S]{0,100}?([\d,]+)\s*[円¥]/)||
                   body.match(/거래금액[\s\S]{0,30}?([\d,]+)\s*[円¥]/)||
                   body.match(/거래금액[^\d]*([\d,]+)/);
      if (amtM) {
        const v = parseInt(amtM[1].replace(/,/g,''));
        if (v > 0 && v < 1_000_000_000) result.revenue = v;
      }

      // 샵 팔로워
      const follM = body.match(/팔로워\s*수[^\d]*([\d,]+)/)||body.match(/([\d,]+)\s*\/\s*전일/);
      if (follM) result.shopFollowers = parseInt(follM[1].replace(/,/g,''));

      // 상품Top10 (상품코드 + 거래금액/거래량)
      result.top10 = [];
      document.querySelectorAll('[class*="top"] [class*="item"], [class*="rank"] li, table tbody tr').forEach((el, i) => {
        if (i >= 10) return;
        const text = el.innerText || '';
        const codeM = text.match(/(11\d{8})/); // 11자리 큐텐 상품코드 패턴
        const amtMs = text.match(/[\d,]{4,}/g);
        if (codeM && amtMs) {
          const amt = Math.max(...amtMs.map(a => parseInt(a.replace(/,/g,''))).filter(n => n > 0));
          result.top10.push({ code: codeM[1], revenue: amt });
        }
      });
    } catch(e) { /* 무시 */ }
    return result;
  }

  try {
    const data = await qsmScrapeTab(analyticsUrl, scrapeAnalyticsSummary);
    console.log('[QLens] Analytics 스크래핑:', data);
    return data;
  } catch(e) {
    console.warn('[QLens] Analytics 오류:', e.message);
    return null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch(e => { toast('초기화 오류: ' + e.message, 'err'); console.error(e); });
  initDateBar();

  document.getElementById('btnFetch').addEventListener('click', doFetch);
  document.getElementById('btnSettings').addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings.html') }));
  document.getElementById('btnImportQ10').addEventListener('click', importFromQ10Auto);

  // ★ 상품관리 페이지 열기 (CSP로 인해 인라인 onclick 사용 불가)
  document.getElementById('btnItemManager')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/item_manager.html') });
  });

  // ★ analyticsHint 클릭 시 Analytics 링크 열기
  document.getElementById('analyticsHint')?.addEventListener('click', () => {
    const link = document.getElementById('analyticsLink');
    if (link) window.open(link.href || 'https://seller.qoo10.jp/ko/summary', '_blank');
  });

  // 기간 탭
  document.querySelectorAll('.period-tab').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.period-tab').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); currentPeriod = b.dataset.period; renderChart();
  }));

  // 상품
  document.getElementById('productSearch').addEventListener('input', () => { productPage = 1; renderProductTable(); });
  document.getElementById('productFilter').addEventListener('change', () => { productPage = 1; renderProductTable(); });
  document.getElementById('pPrev').addEventListener('click', () => { productPage--; renderProductTable(); });
  document.getElementById('pNext').addEventListener('click', () => { productPage++; renderProductTable(); });

  // 브랜드 태그 표시 on/off 토글 (상품·주문·손익 테이블에 일괄 적용)
  const brandBtn = document.getElementById('brandTagToggle');
  if (brandBtn) {
    const paintBrandBtn = () => {
      brandBtn.textContent = _showBrandTags ? '🏷️ 브랜드 ON' : '🏷️ 브랜드 OFF';
      brandBtn.style.opacity = _showBrandTags ? '1' : '.55';
    };
    storageGet('lensShowBrandTags').then(d => {
      if (typeof d.lensShowBrandTags === 'boolean') _showBrandTags = d.lensShowBrandTags;
      paintBrandBtn();
      try { renderProductTable(); renderOrderTable(); } catch (e) {}
    });
    brandBtn.addEventListener('click', () => {
      _showBrandTags = !_showBrandTags;
      storageSet({ lensShowBrandTags: _showBrandTags });
      paintBrandBtn();
      try { renderProductTable(); renderOrderTable(); renderProfitTable(); } catch (e) {}
    });
  }

  // 주문
  document.getElementById('orderFilter').addEventListener('change', () => { orderPage = 1; renderOrderTable(); });
  // 소싱처 버튼 (이벤트 위임 — CSP 안전)
  document.getElementById('orderTbody').addEventListener('click', (e) => {
    const btn = e.target.closest('.src-btn');
    if (!btn) return;
    const idx = +btn.dataset.orderIdx;
    const order = filteredOrders[idx];
    if (order) openSourcing(order);
  });
  document.getElementById('oPrev').addEventListener('click', () => { orderPage--; renderOrderTable(); });
  document.getElementById('oNext').addEventListener('click', () => { orderPage++; renderOrderTable(); });

  // 보존 기간
  document.querySelectorAll('.ret-opt').forEach(el => el.addEventListener('click', async () => {
    config.retentionPeriod = el.dataset.period;
    await storageSet({ lensAnalyticsConfig: config });
    syncRetUI();
    toast('✅ 보존 기간 변경됨', 'ok');
    await checkRetention();
  }));

  // 알림 배너
  document.getElementById('btnAlertDismiss').addEventListener('click', () =>
    document.getElementById('retentionAlert').classList.remove('show'));
  document.getElementById('btnAlertClean').addEventListener('click', async () => {
    const cut = Date.now() - (RETENTION_DAYS[config.retentionPeriod] || 30) * 86400_000;
    const old = snapshots.filter(s => s.ts < cut);
    const ok  = await confirm2({ icon:'🧹', title:'기간 초과 데이터 삭제',
      desc:`보존 기간 초과 스냅샷 ${old.length}개를 삭제합니다.`, okText:'삭제하기' });
    if (!ok) return;
    snapshots = trimSnaps(snapshots, config.retentionPeriod);
    await storageSet({ lensAnalyticsSnapshots: snapshots });
    renderChart(); await measure();
    document.getElementById('retentionAlert').classList.remove('show');
    toast(`✅ ${old.length}개 삭제 완료`, 'ok');
  });

  // 데이터 관리
  document.getElementById('btnMeasure').addEventListener('click', async () => { await measure(); toast('용량 측정 완료', 'ok'); });

  document.getElementById('btnCleanPeriod').addEventListener('click', async () => {
    const cut = Date.now() - (RETENTION_DAYS[config.retentionPeriod] || 30) * 86400_000;
    const old = snapshots.filter(s => s.ts < cut);
    if (!old.length) { toast('삭제할 데이터 없음', 'ok'); return; }
    const ok  = await confirm2({ icon:'📅', title:'기간 외 스냅샷 삭제',
      desc:`오래된 스냅샷 ${old.length}개를 삭제합니다. ${snapshots.length - old.length}개가 유지됩니다.` });
    if (!ok) return;
    snapshots = trimSnaps(snapshots, config.retentionPeriod);
    await storageSet({ lensAnalyticsSnapshots: snapshots });
    renderChart(); await measure(); toast(`✅ ${old.length}개 삭제`, 'ok');
  });

  document.getElementById('btnCleanCache').addEventListener('click', async () => {
    const ok = await confirm2({ icon:'🗑️', title:'캐시 삭제',
      desc:'상품/주문 캐시를 삭제합니다. 다음 새로고침 시 다시 받아옵니다.', okText:'삭제' });
    if (!ok) return;
    await storageRm(['lensAnalyticsProductCache','lensAnalyticsOrderCache']);
    cachedProducts = []; cachedOrders = []; await measure();
    toast('✅ 캐시 삭제 완료', 'ok');
  });

  document.getElementById('btnCleanAll').addEventListener('click', async () => {
    const ok = await confirm2({ icon:'⚠️', title:'모든 데이터 삭제',
      desc:'스냅샷 + 캐시 전부를 삭제합니다. 복구할 수 없습니다.',
      detail:`삭제 대상: 스냅샷 <strong>${snapshots.length}개</strong> + 캐시`,
      okText:'⚠️ 전체 삭제' });
    if (!ok) return;
    await storageRm(['lensAnalyticsSnapshots','lensAnalyticsProductCache','lensAnalyticsOrderCache']);
    snapshots = []; cachedProducts = []; cachedOrders = [];
    renderAll(); await measure(); toast('✅ 전체 삭제 완료', 'ok');
  });

  // 모달
  document.getElementById('modalOk').addEventListener('click', () => {
    document.getElementById('modal').classList.remove('show');
    if (_modalResolve) { _modalResolve(true); _modalResolve = null; }
  });
  document.getElementById('modalCancel').addEventListener('click', () => {
    document.getElementById('modal').classList.remove('show');
    if (_modalResolve) { _modalResolve(false); _modalResolve = null; }
  });

  window.addEventListener('resize', () => { if (snapshots.length >= 2) renderChart(); });
});

/* ════════════════════════════════════════════════════
   ★ 분석 기능 추가 (v1.1.0)
   1. renderDonutChart    — 상품 상태 비율 도넛
   2. renderBarChart      — 월별 매출 막대
   3. renderRankChart     — 상품별 판매 순위 수평막대
   4. fetchSettlement     — QSM 정산 페이지 스크래핑
   5. fetchSalesRanking   — CSV 다운로드 + 파싱
   6. 차트 탭 전환
════════════════════════════════════════════════════ */

/* ── 도넛 차트 ── */
function renderDonutChart(products) {
  const canvas = document.getElementById('donutCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = 280, H = 280;
  canvas.width = W; canvas.height = H;
  ctx.clearRect(0, 0, W, H);

  const counts = {
    S2: products.filter(p => p.Status === 'S2').length,
    S1: products.filter(p => p.Status === 'S1').length,
    S0: products.filter(p => p.Status === 'S0').length,
    S3: products.filter(p => ['S3','S5','S8'].includes(p.Status)).length
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return;

  const slices = [
    { label: '판매 중 (S2)',  value: counts.S2, color: '#10b981' },
    { label: '거래 대기 (S1)', value: counts.S1, color: '#f59e0b' },
    { label: '검수 대기 (S0)', value: counts.S0, color: '#3b82f6' },
    { label: '거래 종지 등',   value: counts.S3, color: '#94a3b8' }
  ].filter(s => s.value > 0);

  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) * 0.40;
  const r = R * 0.58;
  let startAngle = -Math.PI / 2;

  slices.forEach(s => {
    const angle = (s.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, startAngle, startAngle + angle);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    startAngle += angle;
  });

  // 내부 원 (도넛 구멍)
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();

  // 중앙 텍스트
  ctx.fillStyle = '#1e293b';
  ctx.font = 'bold 28px "Pretendard Variable", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(total, cx, cy - 8);
  ctx.font = '13px "Pretendard Variable", sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText('전체 상품', cx, cy + 16);

  // 범례
  const legend = document.getElementById('donutLegend');
  if (legend) {
    legend.innerHTML = slices.map(s => `
      <div class="donut-legend-item">
        <div class="donut-legend-dot" style="background:${s.color}"></div>
        <span class="donut-legend-label">${s.label}</span>
        <span class="donut-legend-val">${s.value}</span>
        <span class="donut-legend-pct">${Math.round(s.value/total*100)}%</span>
      </div>`).join('');
  }
}

/* ── 월별 매출 막대 차트 ── */
function renderBarChart(data) {
  // data: [{month:'2024-01', amount:150000}, ...]
  const canvas = document.getElementById('revenueChart');
  const empty  = document.getElementById('revenueEmpty');
  if (!canvas) return;

  if (!data || data.length === 0) {
    canvas.style.display = 'none'; if (empty) empty.style.display = 'flex'; return;
  }
  canvas.style.display = 'block'; if (empty) empty.style.display = 'none';

  const W = canvas.parentElement.clientWidth || 800;
  const H = 280;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const PAD = { t:20, r:20, b:48, l:72 };
  const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;
  const maxVal = Math.max(...data.map(d => d.amount), 1);
  const n = data.length;
  const barW = Math.max(20, (cW / n) * 0.6);
  const gap   = cW / n;

  // 그리드
  ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.t + (cH / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + cW, y); ctx.stroke();
    const val = Math.round(maxVal * (1 - i / 4));
    ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
    ctx.fillText(val >= 10000 ? `¥${Math.round(val/1000)}K` : `¥${val}`, PAD.l - 6, y + 4);
  }

  // 막대
  data.forEach((d, i) => {
    const x = PAD.l + i * gap + gap / 2 - barW / 2;
    const barH = (d.amount / maxVal) * cH;
    const y = PAD.t + cH - barH;

    // 그라데이션
    const grad = ctx.createLinearGradient(0, y, 0, y + barH);
    grad.addColorStop(0, '#3b82f6'); grad.addColorStop(1, '#1d4ed8');
    ctx.fillStyle = grad;
    ctx.beginPath();
    const bR = 4;
    ctx.roundRect(x, y, barW, barH, [bR, bR, 0, 0]);
    ctx.fill();

    // x축 레이블
    ctx.fillStyle = '#64748b'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(d.month.slice(5), PAD.l + i * gap + gap / 2, H - PAD.b + 16);

    // 값
    if (barH > 24) {
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
      const label = d.amount >= 10000 ? `${Math.round(d.amount/1000)}K` : String(d.amount);
      ctx.fillText(label, x + barW / 2, y + 14);
    }
  });
}

/* ── 상품 순위 수평 막대 차트 ── */
function renderRankChart(ranking) {
  // ranking: [{name, count, revenue}, ...]
  const canvas  = document.getElementById('rankCanvas');
  const table   = document.getElementById('rankTable');
  const tbody   = document.getElementById('rankTbody');
  const empty   = document.getElementById('rankingEmpty');
  if (!canvas) return;

  if (!ranking || ranking.length === 0) {
    canvas.style.display = 'none';
    if (table) table.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  canvas.style.display = 'none'; // 테이블 방식 사용

  if (table) {
    table.style.display = 'table';
    const maxCount = Math.max(...ranking.map(r => r.count), 1);
    const medals = ['🥇','🥈','🥉'];
    tbody.innerHTML = ranking.slice(0, 10).map((r, i) => `
      <tr>
        <td class="rank-num" style="color:${i<3?['#d97706','#64748b','#b45309'][i]:'#94a3b8'}">${medals[i] || i+1}</td>
        <td class="td-name" title="${r.name}">${r.name}</td>
        <td class="td-mono td-right">${fmtNum(r.count)}개</td>
        <td class="td-mono td-right">${fmtJPY(r.revenue)}</td>
        <td>
          <div class="rank-bar-bg">
            <div class="rank-bar-fill" style="width:${Math.round(r.count/maxCount*100)}%;background:${i===0?'linear-gradient(90deg,#d97706,#f59e0b)':i===1?'linear-gradient(90deg,#64748b,#94a3b8)':i===2?'linear-gradient(90deg,#b45309,#d97706)':'linear-gradient(90deg,#1d4ed8,#3b82f6)'}"></div>
          </div>
        </td>
      </tr>`).join('');
  }
}

/* ══════════════════════════════════════════════════════
   정산 페이지 스크래핑
   QSM 정산관리 페이지에서 월별 정산금액 추출
══════════════════════════════════════════════════════ */
let settlementData = []; // [{month:'2024-01', amount:150000}]

async function fetchSettlement() {
  const btn = document.getElementById('btnFetchSettlement');
  if (btn) btn.disabled = true;
  showOv('QSM 정산 데이터 로드 중...', '정산관리 페이지 스크래핑');

  // executeScript로 정산관리 페이지 DOM 직접 읽기
  function scrapeSettlement() {
    const results = [];
    try {
      document.querySelectorAll('table tr, tr').forEach(tr => {
        const text = tr.innerText || '';
        const monthM = text.match(/(20\d{2})[\s\/\-](\d{2})/);
        const amtMs  = text.match(/[\d,]{4,}/g);
        if (!monthM || !amtMs) return;
        const month   = monthM[1] + '-' + monthM[2];
        const amounts = amtMs.map(a => parseInt(a.replace(/,/g,''))).filter(n => n > 1000 && n < 100_000_000);
        if (!amounts.length) return;
        const amount = Math.max(...amounts);
        if (!results.find(r => r.month === month)) results.push({ month, amount });
      });
      results.sort((a, b) => a.month.localeCompare(b.month));
    } catch(e) { /* 무시 */ }
    return results;
  }

  let parsed = [];
  try {
    const data = await qsmScrapeTab(
      'https://qsm.qoo10.jp/GMKT.INC.Gsm.Web/Calculate/CalculateList.aspx',
      scrapeSettlement
    );
    parsed = Array.isArray(data) ? data : [];
    console.log('[QLens] 정산:', parsed.length, '개월');
  } catch (e) {
    if (e.qsmNotLoggedIn) {
      toast('❌ QSM에 로그인 후 다시 시도해주세요', 'err');
      hideOv(); if (btn) btn.disabled = false; return;
    }
    console.warn('[QLens] 정산 오류:', e.message);
  }

  hideOv();
  if (btn) btn.disabled = false;

  if (parsed.length === 0) {
    toast('⚠️ 정산 데이터를 파싱할 수 없습니다. QSM 정산관리 탭을 먼저 열어두면 도움이 됩니다.', 'err');
    return;
  }

  settlementData = parsed;
  await storageSet({ lensSettlementData: parsed, lensSettlementTs: Date.now() });
  renderBarChart(parsed);

  // 이달 정산 KPI 업데이트
  const thisMonth = new Date().toISOString().slice(0, 7);
  const thisMonthData = parsed.find(d => d.month === thisMonth) ||
                        parsed.find(d => d.month >= thisMonth.slice(0, 7));
  if (thisMonthData) {
    document.getElementById('kpiRevenue').textContent = fmtPrice(thisMonthData.amount);
    document.getElementById('kpiRevSub').textContent  = `${thisMonthData.month} 정산금액`;
  }

  const info = document.getElementById('settlementInfo');
  const total = document.getElementById('settlementTotal');
  if (info && total) {
    const totalAmt = parsed.reduce((s, d) => s + d.amount, 0);
    total.textContent = `총 ${parsed.length}개월 합계: ${fmtJPY(totalAmt)}`;
    info.classList.add('show');
  }
  toast(`✅ 정산 데이터 ${parsed.length}개월 로드 완료`, 'ok');
}

// parseSettlementHtml 제거됨 (executeScript 방식)

/* ══════════════════════════════════════════════════════
   판매 순위 — ItemsLookup.RequestFileDownload
   apply_type=order → DownloadURL → CSV 파싱
══════════════════════════════════════════════════════ */
let rankingData = [];

async function fetchSalesRanking() {
  const btn = document.getElementById('btnFetchRanking');
  if (btn) btn.disabled = true;
  showOv('판매 순위 분석 중...', 'CSV 다운로드 요청');

  try {
    // Step 1: CSV 다운로드 URL 요청
    const end   = today();
    const start = tsToDate(Date.now() - 30 * 86400_000);
    document.getElementById('overlaySub').textContent = '주문 CSV 다운로드 URL 요청 중...';
    const res = await qsmCall('ItemsLookup.RequestFileDownload', {
      apply_type: 'order',
      target_from_dt: start.replace(/-/g, '/'),
      target_to_dt:   end.replace(/-/g, '/')
    }, '1.0');

    console.log('[QLens] RequestFileDownload 응답:', res.code, res.msg, res.result);

    if (!res.ok) {
      const msg = res.msg || String(res.code || '');
      // "Download request has been signed already" → 이전 요청의 URL을 바로 받아올 수 있음
      if (msg.toLowerCase().includes('signed already') || res.code === '-202') {
        // result에 URL이 포함된 경우 사용, 없으면 재요청 안내
        const existUrl = res.result?.DownloadURL || res.result?.downloadUrl;
        if (existUrl) {
          console.log('[QLens] 기존 서명된 URL 사용:', existUrl);
          // URL이 있으면 그냥 사용
          document.getElementById('overlaySub').textContent = '기존 요청된 CSV 다운로드 중...';
          const csvRes2 = await sendBg({ type: 'QSM_WEB_FETCH', url: existUrl, maxBytes: 1000000 });
          if (!csvRes2.ok) throw new Error('CSV 다운로드 실패 (기존 URL): ' + csvRes2.error);
          const csvText2 = csvRes2.html || '';
          const ranking2 = parseSalesCsv(csvText2);
          rankingData = ranking2;
          await storageSet({ lensRankingData: ranking2, lensRankingTs: Date.now() });
          renderRankChart(ranking2);
          toast(`✅ 상품 순위 분석 완료 (기존 데이터) — Top ${Math.min(ranking2.length, 10)}개`, 'ok');
          return;
        }
        throw new Error('이미 오늘 요청된 CSV가 있습니다. 잠시 후(수 분) 다시 시도하거나, 하루 최대 10회 제한을 확인해주세요. (코드: ' + res.code + ')');
      }
      throw new Error(msg || `CSV 요청 실패 (code: ${res.code})`);
    }

    // ResultObject가 배열 [{DownloadURL, DownloadType, DownloadExplain}] 또는 객체일 수 있음
    const _pickResult = (r) => Array.isArray(r) ? (r[0] || {}) : (r || {});
    const robj = _pickResult(res.result);
    const downloadUrl = robj.DownloadURL || robj.downloadUrl;
    const explain     = robj.DownloadExplain || '';

    if (!downloadUrl) throw new Error('DownloadURL이 없습니다 — 잠시 후 다시 시도해주세요');

    // 큐텐이 "15-30분 후 접근" 안내 → 파일이 아직 생성 안 됐을 수 있음
    if (/15-30 minutes|after about/i.test(explain)) {
      console.log('[QLens] 파일 생성 대기 안내:', explain);
      // URL/안내를 저장해두고, 사용자에게 알림
      await storageSet({ lensRankingPendingUrl: downloadUrl, lensRankingPendingTs: Date.now() });
    }

    // Step 2: CSV 파일 다운로드
    document.getElementById('overlaySub').textContent = 'CSV 파일 다운로드 중...';
    const csvRes = await sendBg({ type: 'QSM_WEB_FETCH', url: downloadUrl, maxBytes: 1000000 });
    if (!csvRes.ok || !(csvRes.html || '').trim()) {
      // 파일이 아직 생성 안 됨 (큐텐은 요청 후 15~30분 소요)
      throw new Error('정산 CSV 파일이 아직 생성되지 않았습니다.\n큐텐이 파일을 만드는 데 15~30분 걸립니다. 잠시 후 다시 [정산 데이터 가져오기]를 눌러주세요.');
    }

    // Step 3: CSV 파싱 → 상품별 집계
    document.getElementById('overlaySub').textContent = '판매 데이터 분석 중...';
    const csvText = csvRes.html || '';
    const ranking = parseSalesCsv(csvText);

    rankingData = ranking;
    await storageSet({ lensRankingData: ranking, lensRankingTs: Date.now() });
    renderRankChart(ranking);
    toast(`✅ 상품 순위 분석 완료 — Top ${Math.min(ranking.length, 10)}개`, 'ok');

  } catch (e) {
    toast('❌ ' + e.message, 'err');
    console.error('[QLens] 순위 분석 오류:', e);
  } finally {
    hideOv();
    if (btn) btn.disabled = false;
  }
}

function parseSalesCsv(csvText) {
  if (!csvText || csvText.length < 10) return [];
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  // 헤더 파싱
  const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const nameIdx    = header.findIndex(h => /상품명|item.?name|goods.?name|product/i.test(h));
  const qtyIdx     = header.findIndex(h => /수량|qty|quantity|count/i.test(h));
  const priceIdx   = header.findIndex(h => /금액|price|amount|revenue/i.test(h));
  const codeIdx    = header.findIndex(h => /상품코드|item.?code|goods.?code/i.test(h));

  console.log('[QLens] CSV 헤더:', header, '→ name:', nameIdx, 'qty:', qtyIdx, 'price:', priceIdx);

  const itemMap = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const name  = nameIdx  >= 0 ? cols[nameIdx]  : `상품 ${cols[codeIdx] || i}`;
    const qty   = qtyIdx   >= 0 ? parseInt(cols[qtyIdx]  || '0') : 1;
    const price = priceIdx >= 0 ? parseInt((cols[priceIdx] || '0').replace(/[^0-9]/g, '')) : 0;
    if (!name || name.length < 2) continue;
    if (!itemMap[name]) itemMap[name] = { name, count: 0, revenue: 0 };
    itemMap[name].count   += qty || 1;
    itemMap[name].revenue += price;
  }

  return Object.values(itemMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

/* ══ 차트 탭 전환 이벤트 ══ */

/* ══════════════════════════════════════════════════════
   날짜 범위 관리
══════════════════════════════════════════════════════ */
function updateDateRange(start, end, label) {
  dateRange = { start, end, label };

  // 입력창 동기화
  const dsEl = document.getElementById('dateStart');
  const deEl = document.getElementById('dateEnd');
  if (dsEl) dsEl.value = start;
  if (deEl) deEl.value = end;

  // 라벨
  const dispEl = document.getElementById('dateRangeDisplay');
  if (dispEl) dispEl.textContent = `${label} (${start} ~ ${end})`;

  // QSM Analytics 링크 업데이트
  const aLink = document.getElementById('analyticsLink');
  if (aLink) {
    // Analytics 날짜 파라미터 형식: yyyyMMdd
    const s = start.replace(/-/g,'');
    const e = end.replace(/-/g,'');
    aLink.href = `https://seller.qoo10.jp/ko/?startDt=${s}&endDt=${e}`;
  }

  // 프리셋 버튼 active 상태
  document.querySelectorAll('.date-preset').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.label === label);
  });
}

function initDateBar() {
  const today = new Date();
  const fmt   = d => d.toISOString().slice(0, 10);

  // 입력창 초기값
  const dsEl = document.getElementById('dateStart');
  const deEl = document.getElementById('dateEnd');
  if (dsEl) dsEl.value = dateRange.start;
  if (deEl) deEl.value = dateRange.end;

  // 프리셋 버튼
  document.querySelectorAll('.date-preset').forEach(btn => {
    btn.dataset.label = btn.textContent.trim();
    btn.addEventListener('click', () => {
      let start, end, label = btn.textContent.trim();
      const t = new Date(today);

      if (btn.dataset.days) {
        const days = parseInt(btn.dataset.days);
        t.setDate(t.getDate() - days);
        start = fmt(t); end = fmt(today);
      } else if (btn.dataset.month === 'current') {
        start = fmt(new Date(today.getFullYear(), today.getMonth(), 1));
        end   = fmt(today);
      } else if (btn.dataset.month === 'prev') {
        start = fmt(new Date(today.getFullYear(), today.getMonth() - 1, 1));
        end   = fmt(new Date(today.getFullYear(), today.getMonth(), 0));
      }
      document.querySelectorAll('.date-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateDateRange(start, end, label);
    });
  });

  // 직접 입력 + 적용 버튼
  document.getElementById('dateApply')?.addEventListener('click', () => {
    const s = document.getElementById('dateStart')?.value;
    const e = document.getElementById('dateEnd')?.value;
    if (!s || !e) { toast('날짜를 입력해주세요', 'err'); return; }
    if (s > e) { toast('시작일이 종료일보다 늦습니다', 'err'); return; }
    document.querySelectorAll('.date-preset').forEach(b => b.classList.remove('active'));
    updateDateRange(s, e, '직접 지정');
    toast(`✅ 기간 변경: ${s} ~ ${e}`, 'ok');
  });

  // Analytics 링크 초기화
  updateDateRange(dateRange.start, dateRange.end, dateRange.label);
}

/* ══════════════════════════════════════════════════════
   QSM Analytics 페이지 스크래핑
   qoo10analytics.qoo10.jp — 거래요약, 상품Top10, 고객현황
══════════════════════════════════════════════════════ */
async function fetchFromAnalytics() {
  // QSM Analytics 탭을 열고 dateRange 기간으로 데이터 읽기
  const s = dateRange.start.replace(/-/g,'');
  const e = dateRange.end.replace(/-/g,'');
  const analyticsUrl = `https://seller.qoo10.jp/ko/summary`;

  function scrapeAnalyticsSummary() {
    // QSM Analytics 요약 페이지에서 거래 데이터 읽기
    const result = { orderCount: 0, revenue: 0, shopFollowers: 0 };
    try {
      const body = document.body.innerText || '';
      // 거래상품수량 (예: "7개", "5개")
      const countM = body.match(/거래상품수량[\s\S]{0,50}?([\d,]+)\s*個/)||
                     body.match(/거래상품수량[\s\S]{0,50}?([\d,]+)\s*개/)||
                     body.match(/거래상품수량[^\d]*([\d,]+)/);
      if (countM) result.orderCount = parseInt(countM[1].replace(/,/g,''));

      // 총 거래금액 (예: "34,632円")
      const amtM = body.match(/총\s*거래금액[\s\S]{0,100}?([\d,]+)\s*[円¥]/)||
                   body.match(/거래금액[\s\S]{0,30}?([\d,]+)\s*[円¥]/)||
                   body.match(/거래금액[^\d]*([\d,]+)/);
      if (amtM) {
        const v = parseInt(amtM[1].replace(/,/g,''));
        if (v > 0 && v < 1_000_000_000) result.revenue = v;
      }

      // 샵 팔로워
      const follM = body.match(/팔로워\s*수[^\d]*([\d,]+)/)||body.match(/([\d,]+)\s*\/\s*전일/);
      if (follM) result.shopFollowers = parseInt(follM[1].replace(/,/g,''));

      // 상품Top10 (상품코드 + 거래금액/거래량)
      result.top10 = [];
      document.querySelectorAll('[class*="top"] [class*="item"], [class*="rank"] li, table tbody tr').forEach((el, i) => {
        if (i >= 10) return;
        const text = el.innerText || '';
        const codeM = text.match(/(11\d{8})/); // 11자리 큐텐 상품코드 패턴
        const amtMs = text.match(/[\d,]{4,}/g);
        if (codeM && amtMs) {
          const amt = Math.max(...amtMs.map(a => parseInt(a.replace(/,/g,''))).filter(n => n > 0));
          result.top10.push({ code: codeM[1], revenue: amt });
        }
      });
    } catch(e) { /* 무시 */ }
    return result;
  }

  try {
    const data = await qsmScrapeTab(analyticsUrl, scrapeAnalyticsSummary);
    console.log('[QLens] Analytics 스크래핑:', data);
    return data;
  } catch(e) {
    console.warn('[QLens] Analytics 오류:', e.message);
    return null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // 탭 전환
  document.querySelectorAll('.chart-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.chart-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = 'panel-' + tab.dataset.tab;
      document.getElementById(panelId)?.classList.add('active');

      // 탭 전환 시 해당 차트 재렌더
      if (tab.dataset.tab === 'overview') {
        if (cachedProducts.length) renderDonutChart(cachedProducts);
        renderChart(); // overview 라인차트
      }
      if (tab.dataset.tab === 'orders') {
        renderOrderTrendChart();
        const el = document.getElementById('snapCountLabel');
        if (el) el.textContent = snapshots.length;
      }
      if (tab.dataset.tab === 'revenue' && settlementData.length) renderBarChart(settlementData);
      if (tab.dataset.tab === 'ranking' && rankingData.length) renderRankChart(rankingData);
      if (tab.dataset.tab === 'profit' && profitRows.length) renderProfitTable();
    });
  });

  // 정산 버튼
  document.getElementById('btnFetchSettlement')?.addEventListener('click', fetchSettlement);
  // 순위 버튼
  document.getElementById('btnFetchRanking')?.addEventListener('click', fetchSalesRanking);
  // 손익 계산/저장 버튼
  document.getElementById('btnCalcProfit')?.addEventListener('click', calcProfit);
  document.getElementById('btnBackToCsv')?.addEventListener('click', () => {
    if (!_csvProfitRows) return;
    profitRows = _csvProfitRows.slice();
    renderProfitTable();
    document.getElementById('btnBackToCsv').style.display = 'none';
    toast('CSV 정산 기준 손익으로 돌아왔습니다', 'ok');
  });
  document.getElementById('btnSaveProfit')?.addEventListener('click', saveProfit);
  // CSV 업로드 분석
  setupCsvUpload();

  // 캐시된 분석 데이터 로드
  storageGet(['lensSettlementData','lensRankingData','lensSettlementTs','lensRankingTs']).then(d => {
    const CACHE_1D = 24 * 60 * 60 * 1000;
    if (d.lensSettlementData?.length && Date.now() - (d.lensSettlementTs || 0) < CACHE_1D * 7) {
      settlementData = d.lensSettlementData;
      // 탭이 revenue면 즉시 렌더
      if (document.getElementById('panel-revenue')?.classList.contains('active')) {
        renderBarChart(settlementData);
      }
      // KPI 업데이트
      const thisMonth = new Date().toISOString().slice(0, 7);
      const tm = settlementData.find(d => d.month >= thisMonth.slice(0, 7));
      if (tm) {
        document.getElementById('kpiRevenue').textContent = fmtPrice(tm.amount);
        document.getElementById('kpiRevSub').textContent  = `${tm.month} 정산금액`;
      }
    }
    if (d.lensRankingData?.length && Date.now() - (d.lensRankingTs || 0) < CACHE_1D) {
      rankingData = d.lensRankingData;
    }
  });
});

/* ── 개요 라인차트 (panel-overview용, 기존 salesChart) ── */
// 기존 renderChart()가 #salesChart를 사용하므로 동일하게 유지

/* ── 주문 추이 풀 차트 (panel-orders용) ── */
function renderOrderTrendChart() {
  const canvas = document.getElementById('orderTrendChart');
  const empty  = document.getElementById('orderTrendEmpty');
  if (!canvas) return;

  const data = snapshots
    .filter(s => s.ts >= Date.now() - (RETENTION_DAYS[currentPeriod] || 30) * 86400_000)
    .sort((a, b) => a.ts - b.ts);

  if (data.length < 2) {
    canvas.style.display = 'none'; if (empty) empty.style.display = 'flex'; return;
  }
  canvas.style.display = 'block'; if (empty) empty.style.display = 'none';

  const W = canvas.parentElement.clientWidth || 800;
  const H = 280;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const PAD = { t:20, r:20, b:38, l:50 };
  const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;
  const orders  = data.map(d => d.orders?.total || 0);
  const onSales = data.map(d => d.products?.onSale || 0);
  const maxY = Math.max(...orders, ...onSales, 1);
  const n = data.length;

  ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.t + (cH / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + cW, y); ctx.stroke();
    ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxY * (1 - i / 4)), PAD.l - 6, y + 4);
  }
  const step = Math.max(1, Math.floor(n / 10));
  ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center';
  data.forEach((d, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    ctx.fillText(d.date.slice(5), PAD.l + (i / (n - 1)) * cW, H - PAD.b + 16);
  });
  function drawLine(vals, color, fillAlpha) {
    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = PAD.l + (i / (n - 1)) * cW, y = PAD.t + cH - (v / maxY) * cH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(PAD.l + cW, PAD.t + cH); ctx.lineTo(PAD.l, PAD.t + cH); ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + cH);
    grad.addColorStop(0, color.replace('rgb(', 'rgba(').replace(')', `,${fillAlpha})`));
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad; ctx.fill();
  }
  drawLine(onSales, 'rgb(16,185,129)', 0.15);
  drawLine(orders,  'rgb(59,130,246)', 0.15);
}

/* ── renderAll 확장 (도넛 포함) ── */
const _originalRenderAll = renderAll;
window.renderAllExtended = function() {
  _originalRenderAll();
  renderDonutChart(cachedProducts);
  renderOrderTrendChart();
  if (settlementData.length) renderBarChart(settlementData);
  if (rankingData.length) renderRankChart(rankingData);
};
