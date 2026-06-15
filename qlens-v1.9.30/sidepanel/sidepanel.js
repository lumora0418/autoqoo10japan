/* ═══════════════════════════════════════════════════════════════
 * QLens — Side Panel
 * 소싱 페이지 가격 추적 + 시트 자동 업데이트
 * ═══════════════════════════════════════════════════════════════ */

let _currentTabId = null;
let _currentUrl = '';
let _currentSheetItem = null;  // 시트에서 매칭된 항목 (소싱가, code 등)
let _scrapedPrice = 0;

const $ = id => document.getElementById(id);
const setStatus = (msg, type = 'idle') => {
  const el = $('statusBar');
  el.textContent = msg;
  el.className = 'status ' + type;
};

/* ═════════ 페이지 정보 표시 ═════════ */
function showCurrentPageInfo(url, tabTitle) {
  $('currentPageInfo').innerHTML = `
    <div style="font-size:12px;color:var(--text);margin-bottom:6px;font-weight:600">
      ${tabTitle || '제목 없음'}
    </div>
    <div class="url-display">${url}</div>
  `;
}

/* ═════════ 가격 차이 표시 ═════════ */
function renderPriceComparison(sheetPrice, currentPrice) {
  $('sheetPrice').textContent  = sheetPrice  > 0 ? '₩' + sheetPrice.toLocaleString() : '-';
  $('currentPrice').textContent = currentPrice > 0 ? '₩' + currentPrice.toLocaleString() : '추출 실패';

  const diffEl = $('priceDiffArea');
  if (!sheetPrice || !currentPrice) {
    diffEl.innerHTML = '<span class="price-diff same">비교 불가</span>';
    return;
  }
  const diff = currentPrice - sheetPrice;
  const pct = (diff / sheetPrice * 100).toFixed(1);
  if (diff === 0) {
    diffEl.innerHTML = '<span class="price-diff same">변동 없음</span>';
  } else if (diff > 0) {
    diffEl.innerHTML = `<span class="price-diff up">▲ +₩${diff.toLocaleString()} (+${pct}%)</span>`;
  } else {
    diffEl.innerHTML = `<span class="price-diff down">▼ ₩${diff.toLocaleString()} (${pct}%)</span>`;
  }
}

/* ═════════ 현재 활성 탭 URL 가져오기 ═════════ */
async function detectCurrentPage() {
  // ★ 진입 시점에 즉시 이전 상태 초기화 (UI 깜빡임 방지)
  _currentSheetItem = null;
  _scrapedPrice = 0;
  $('sheetPrice').textContent = '-';
  $('currentPrice').textContent = '-';
  $('priceDiffArea').innerHTML = '<span class="price-diff same">-</span>';
  $('metaName').textContent = '조회 중...';
  $('metaSite').textContent = '-';
  $('metaUrl').textContent = '-';
  $('metaTime').textContent = '-';
  $('btnUpdate').disabled = true;

  try {
    const sourcingHosts = ['oliveyoung.co.kr', 'smartstore.naver.com', 'brand.naver.com',
      'shopping.naver.com', 'coupang.com', 'musinsa.com', 'kurly.com',
      'daiso.co.kr', 'themedicube.co.kr', 'vt-cosmetics.com', 'anua.kr'];

    // ★ 우선순위 1: 가장 최근 포커스 받은 창의 active 탭 (사용자가 방금 본 탭)
    let tab = null;
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (activeTab?.url && sourcingHosts.some(h => activeTab.url.includes(h))) {
        tab = activeTab;
      }
    } catch {}

    // 우선순위 2: 모든 창의 active 탭 중 소싱 사이트
    if (!tab) {
      const activeSourcingTabs = await chrome.tabs.query({ active: true });
      tab = activeSourcingTabs.find(t => t.url && sourcingHosts.some(h => t.url.includes(h)));
    }

    // 우선순위 3: 모든 탭 중 가장 최근 lastAccessed 소싱 탭
    if (!tab) {
      const allTabs = await chrome.tabs.query({});
      const sourcingTabs = allTabs.filter(t => t.url && sourcingHosts.some(h => t.url.includes(h)));
      // lastAccessed 내림차순 정렬 (가장 최근에 본 탭이 첫 번째)
      sourcingTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      tab = sourcingTabs[0];
    }

    // 최후의 폴백: 그냥 활성 탭
    if (!tab) {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    }

    if (!tab || !tab.url) {
      setStatus('❌ 소싱 페이지를 찾을 수 없음. 소싱 사이트(올리브영/네이버 등)를 먼저 여세요', 'error');
      return;
    }
    _currentTabId = tab.id;
    _currentUrl = tab.url;
    showCurrentPageInfo(tab.url, tab.title);

    if (!/^https?:/.test(tab.url)) {
      setStatus('⚠️ HTTP/HTTPS 페이지만 분석 가능', 'idle');
      return;
    }

    // 지원 사이트인지 확인
    if (!sourcingHosts.some(h => tab.url.includes(h))) {
      setStatus(`⚠️ 지원하지 않는 사이트입니다. (${detectSite(tab.url)})`, 'idle');
      $('currentPageInfo').innerHTML = `
        <div style="font-size:12px;margin-bottom:6px">${tab.title || ''}</div>
        <div class="url-display">${tab.url}</div>
        <div style="margin-top:8px;font-size:11px;color:var(--orange)">
          ⚠️ 지원 사이트: 올리브영, 네이버, 쿠팡, 무신사, 컬리, 다이소 등
        </div>
      `;
      return;
    }

    await loadMatchingSheetItem(tab.url);
    await scrapePrice();
  } catch (e) {
    setStatus('❌ ' + e.message, 'error');
    console.error('[QLens Panel]', e);
  }
}

/* ═════════ URL → 사이트별 고유 상품 ID 추출 ═════════
   ★ 올리브영처럼 path가 동일하고 query만 다른 경우 → query에서 ID 추출
*/
function extractProductId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // 올리브영: ?goodsNo=AXXXXXX
    if (host.includes('oliveyoung.co.kr')) {
      const id = u.searchParams.get('goodsNo');
      return id ? `oy:${id}` : null;
    }
    // 컬리: /goods/숫자 또는 ?no=숫자
    if (host.includes('kurly.com')) {
      const m = u.pathname.match(/\/goods\/(\d+)/);
      if (m) return `kurly:${m[1]}`;
      const no = u.searchParams.get('no');
      return no ? `kurly:${no}` : null;
    }
    // 네이버 스마트스토어/브랜드스토어: /products/숫자
    if (host.includes('naver.com')) {
      const m = u.pathname.match(/\/products\/(\d+)/);
      return m ? `naver:${m[1]}` : null;
    }
    // 쿠팡: /vp/products/숫자
    if (host.includes('coupang.com')) {
      const m = u.pathname.match(/\/products\/(\d+)/);
      const item = u.searchParams.get('itemId') || '';
      return m ? `coupang:${m[1]}${item ? ':' + item : ''}` : null;
    }
    // 무신사: /products/숫자
    if (host.includes('musinsa.com')) {
      const m = u.pathname.match(/\/products?\/(\d+)/);
      return m ? `musinsa:${m[1]}` : null;
    }
    // 다이소: ?pdNo=숫자
    if (host.includes('daiso.co.kr')) {
      const id = u.searchParams.get('pdNo');
      return id ? `daiso:${id}` : null;
    }
    // 더메디큐브/VT/아누아 등 브랜드몰 (Cafe24): ?product_no=숫자
    if (host.includes('themedicube.co.kr') || host.includes('vt-cosmetics.com') || host.includes('anua.kr')) {
      const pn = u.searchParams.get('product_no');
      return pn ? `${host}:${pn}` : null;
    }
    // 기타: 전체 URL을 ID로 (path + query)
    return `url:${u.pathname}?${u.searchParams.toString()}`;
  } catch {
    return null;
  }
}

/* ═════════ 시트의 매칭 데이터 로드 ═════════ */
async function loadMatchingSheetItem(url) {
  // ★ 진입 시점에 즉시 이전 상태 초기화 (UI 깜빡임 방지)
  _currentSheetItem = null;
  _scrapedPrice = 0;
  $('sheetPrice').textContent  = '-';
  $('currentPrice').textContent = '-';
  $('priceDiffArea').innerHTML = '<span class="price-diff same">-</span>';
  $('metaName').textContent = '조회 중...';
  $('metaTime').textContent = '';
  $('btnUpdate').disabled = true;
  $('resultArea').style.display = 'block';

  setStatus('⏳ 시트에서 매칭 상품 검색 중...', 'scanning');
  try {
    const { lensItemManagerCache } = await chrome.storage.local.get('lensItemManagerCache');
    const cached = lensItemManagerCache?.items || [];

    // ★ 사이트별 고유 상품 ID 기반 매칭 (URL 부분 비교는 false-positive 발생)
    const currentId = extractProductId(url);
    let match = null;

    if (currentId) {
      match = cached.find(it => extractProductId(it.sourceUrl) === currentId);
    }

    // 폴백: ID 추출 실패 시 전체 URL 정확 일치만 허용 (부분 일치 금지)
    if (!match) {
      const normUrl = url.toLowerCase().split('#')[0].replace(/\/$/, '');
      match = cached.find(it => {
        if (!it.sourceUrl) return false;
        const itemUrl = it.sourceUrl.toLowerCase().split('#')[0].replace(/\/$/, '');
        return normUrl === itemUrl;  // 정확 일치만
      });
    }

    if (match) {
      _currentSheetItem = match;
      $('resultArea').style.display = 'block';
      $('metaName').textContent = match.name || match.code;
      $('metaSite').textContent = detectSite(url);
      $('metaUrl').textContent = url;
      renderPriceComparison(match.sourcePrice || 0, 0);
      setStatus('✅ 시트에서 상품 발견 — 가격 추출 중...', 'success');
    } else {
      $('resultArea').style.display = 'block';
      _currentSheetItem = null;
      $('metaName').textContent = '시트에 등록되지 않은 상품';
      $('metaSite').textContent = detectSite(url);
      $('metaUrl').textContent = url;
      $('btnUpdate').disabled = true;
      setStatus('⚠️ 시트에 등록되지 않은 페이지', 'idle');
    }
  } catch (e) {
    setStatus('❌ 시트 매칭 실패: ' + e.message, 'error');
  }
}

/* ═════════ 페이지에서 가격 추출 (content_script와 통신) ═════════ */
async function scrapePrice() {
  if (!_currentTabId) {
    setStatus('❌ 소싱 탭이 선택되지 않음', 'error');
    return;
  }
  setStatus('⏳ 페이지 가격 추출 중...', 'scanning');

  // 메시지 전송 with timeout + retry
  const trySend = (retryCount = 0) => new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      console.warn('[Panel] scrape 타임아웃');
      resolve({ ok: false, error: '응답 타임아웃 (페이지 로딩 중일 수 있음)' });
    }, 5000);

    try {
      chrome.tabs.sendMessage(_currentTabId, { type: 'LENS_SCRAPE_PRICE' }, (res) => {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message;
          // content_script가 아직 로드 안 됨 → 1회 재시도
          if (retryCount < 1 && /Could not establish|message port|Receiving end/.test(err)) {
            setTimeout(() => trySend(retryCount + 1).then(resolve), 800);
            return;
          }
          resolve({ ok: false, error: err });
          return;
        }
        resolve(res || { ok: false, error: '응답 없음' });
      });
    } catch (e) {
      clearTimeout(timeoutId);
      resolve({ ok: false, error: e.message });
    }
  });

  try {
    const res = await trySend();
    if (!res?.ok) throw new Error(res?.error || '가격 추출 실패');

    _scrapedPrice = res.price || 0;
    if (_scrapedPrice <= 0) {
      setStatus(`⚠️ 가격을 찾을 수 없습니다 (셀렉터: ${res.selector || 'none'})`, 'error');
      $('currentPrice').textContent = '추출 실패';
      return;
    }

    $('metaTime').textContent = new Date().toLocaleTimeString('ko-KR');
    if (_currentSheetItem) {
      renderPriceComparison(_currentSheetItem.sourcePrice || 0, _scrapedPrice);
      const diff = _scrapedPrice - (_currentSheetItem.sourcePrice || 0);
      if (diff === 0) setStatus('✅ 가격 변동 없음', 'success');
      else if (diff > 0) setStatus(`⚠️ 가격 상승: +₩${diff.toLocaleString()}`, 'error');
      else setStatus(`✅ 가격 하락: ₩${diff.toLocaleString()}`, 'success');
      $('btnUpdate').disabled = false;
    } else {
      $('currentPrice').textContent = '₩' + _scrapedPrice.toLocaleString();
      setStatus(`✅ 가격 추출 완료: ₩${_scrapedPrice.toLocaleString()}`, 'success');
    }
  } catch (e) {
    setStatus('❌ ' + e.message, 'error');
  }
}

/* ═════════ 사이트 식별 ═════════ */
function detectSite(url) {
  if (!url) return '-';
  if (url.includes('oliveyoung')) return '올리브영';
  if (url.includes('smartstore.naver') || url.includes('brand.naver')) return '네이버';
  if (url.includes('coupang')) return '쿠팡';
  if (url.includes('musinsa')) return '무신사';
  if (url.includes('kurly')) return '컬리';
  if (url.includes('daiso')) return '다이소';
  if (url.includes('themedicube') || url.includes('vt-cosmetics') || url.includes('anua')) return '브랜드몰';
  return '기타';
}

/* ═════════ 시트 가격 업데이트 ═════════ */
async function updateSheetPrice() {
  if (!_currentSheetItem || !_scrapedPrice) return;

  // ★ 안전장치: 스크랩 가격이 잘못 읽혔을 수 있으므로 적용 전 사용자 확인
  //   (소싱가 오염 방지 — 단가/옵션가/세트가 오인 시 여기서 거를 수 있음)
  const _oldKrw = _currentSheetItem.sourcePrice || 0;
  const _nm = (_currentSheetItem.name || _currentSheetItem.code || '').slice(0, 40);
  const _changePct = _oldKrw > 0 ? Math.round(Math.abs(_scrapedPrice - _oldKrw) / _oldKrw * 100) : 0;
  const _warn = (_oldKrw > 0 && _changePct >= 30) ? `\n\n⚠️ 기존가 대비 ${_changePct}% 차이 — 스크랩 가격이 정확한지 꼭 확인하세요!` : '';
  if (!confirm(
    `소싱가를 시트에 적용할까요?\n\n${_nm}\n₩${_oldKrw.toLocaleString()} → ₩${_scrapedPrice.toLocaleString()}${_warn}`
  )) {
    setStatus('취소됨 — 소싱가 변경 안 함', '');
    return;
  }

  setStatus('⏳ 시트에 가격 업데이트 중...', 'scanning');
  try {
    // ★ webhook URL 직접 조회 (대시보드 탭 없어도 작동)
    const { lensSheetsWebhookUrl, sheetsWebhookUrl } = await chrome.storage.local.get(
      ['lensSheetsWebhookUrl', 'sheetsWebhookUrl']
    );
    const webhookUrl = lensSheetsWebhookUrl || sheetsWebhookUrl;

    if (!webhookUrl) {
      // 폴백: 대시보드 탭에 메시지 (열려있을 때만)
      chrome.runtime.sendMessage({
        type: 'LENS_SIDEPANEL_UPDATE_PRICE',
        code: _currentSheetItem.code,
        newSourcePrice: _scrapedPrice,
        sourceUrl: _currentUrl,
      }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          setStatus('❌ webhook URL이 설정되지 않았습니다 (설정 → Google Sheets webhook URL 입력)', 'error');
          return;
        }
        setStatus(`✅ 시트 업데이트 완료`, 'success');
        if (_currentSheetItem) _currentSheetItem.sourcePrice = _scrapedPrice;
        renderPriceComparison(_scrapedPrice, _scrapedPrice);
      });
      return;
    }

    // ★ webhook 직접 호출 (대시보드 탭 불필요)
    const oldPrice = _currentSheetItem.sourcePrice || 0;
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'LENS_UPDATE_PRICE_ONLY',
        qsmCode: _currentSheetItem.code,
        newSourcePriceKrw: _scrapedPrice,
        sourceUrl: _currentUrl,
      }),
    });

    if (!res.ok) {
      setStatus(`❌ HTTP ${res.status}`, 'error');
      return;
    }

    const json = await res.json();
    if (json.ok) {
      setStatus(`✅ ₩${oldPrice.toLocaleString()} → ₩${_scrapedPrice.toLocaleString()}`, 'success');
      _currentSheetItem.sourcePrice = _scrapedPrice;
      renderPriceComparison(_scrapedPrice, _scrapedPrice);
    } else {
      setStatus(`❌ ${json.error || '시트 업데이트 실패'}`, 'error');
    }
  } catch (e) {
    setStatus('❌ ' + e.message, 'error');
  }
}

/* ═════════ 기획세트 빌더 (v1.9.11) ═════════ */
let _bundleList = [];  // [{ code, name, componentCount }]

async function loadBundleList() {
  try {
    const { lensSheetsWebhookUrl, sheetsWebhookUrl } = await chrome.storage.local.get(
      ['lensSheetsWebhookUrl', 'sheetsWebhookUrl']
    );
    const url = lensSheetsWebhookUrl || sheetsWebhookUrl;
    if (!url) return;

    // 1) 모든 상품 로드
    const itemsRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'LENS_LOAD' }),
    });
    const itemsJson = await itemsRes.json();
    if (!itemsJson.ok) return;

    // 2) 번들 매핑 로드
    const bRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'LENS_BUNDLE_LOAD' }),
    });
    const bJson = await bRes.json();
    const bundlesMap = (bJson.ok && bJson.bundles) ? bJson.bundles : {};

    // 3) 기획세트만 추출 (itemType==='기획' 또는 _bundlesMap에 있는 것)
    _bundleList = (itemsJson.items || [])
      .filter(it => it.itemType === '기획' || bundlesMap[it.code])
      .map(it => ({
        code: it.code,
        name: it.sellerCode || it.seller || it.name || it.code,
        componentCount: (bundlesMap[it.code] || []).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

    // 4) 셀렉트 옵션 채우기
    const sel = $('bundleSelect');
    if (sel) {
      sel.innerHTML = '<option value="">— 기획세트 선택 —</option>'
        + _bundleList.map(b => `<option value="${b.code}">${b.name.slice(0, 30)} (${b.code}) · ${b.componentCount}개</option>`).join('')
        + '<option value="__NEW__" style="color:#3d9eff">➕ 새 세트로 추가...</option>';
    }
  } catch (e) {
    console.warn('[QLens 사이드패널] 번들 목록 로드 실패:', e.message);
  }
}

async function addToBundle() {
  const sel = $('bundleSelect').value;
  if (!sel) { setStatus('세트를 선택하세요', 'error'); return; }
  if (!_scrapedPrice) { setStatus('가격이 추출되지 않았습니다', 'error'); return; }

  let qsmCode = sel;
  if (sel === '__NEW__') {
    qsmCode = prompt('새 세트의 QSM 상품코드를 입력하세요\n(QSM에 이미 등록되어 있어야 합니다):');
    if (!qsmCode) return;
    qsmCode = qsmCode.trim();
  }

  const qty = +$('bundleQty').value || 1;
  const isFree = $('bundleIsFree').checked;

  const { lensSheetsWebhookUrl, sheetsWebhookUrl } = await chrome.storage.local.get(
    ['lensSheetsWebhookUrl', 'sheetsWebhookUrl']
  );
  const url = lensSheetsWebhookUrl || sheetsWebhookUrl;
  if (!url) { setStatus('webhook 미설정', 'error'); return; }

  const component = {
    name: _currentSheetItem?.name || document.title.split(' | ')[0] || '구성품',
    site: _detectSiteName(_currentUrl),
    url: _currentUrl,
    price: _scrapedPrice,
    weight: 0,  // 기본값 (사용자 편집 가능)
    qty,
    isFree,
    memo: '사이드패널 추가',
  };

  $('btnAddToBundle').disabled = true;
  $('bundleAddResult').textContent = '⏳ 추가 중...';
  $('bundleAddResult').style.color = 'var(--text2)';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'LENS_BUNDLE_ADD_COMPONENT', qsmCode, component }),
    });
    const json = await res.json();
    if (json.ok) {
      $('bundleAddResult').textContent = `✅ 세트 ${qsmCode}에 추가됨 (총 ${json.total}개)`;
      $('bundleAddResult').style.color = 'var(--green)';
      setTimeout(() => { $('bundleAddResult').textContent = ''; }, 5000);
      loadBundleList();  // 카운트 갱신
    } else {
      $('bundleAddResult').textContent = '❌ ' + (json.error || '실패');
      $('bundleAddResult').style.color = 'var(--red)';
    }
  } catch (e) {
    $('bundleAddResult').textContent = '❌ ' + e.message;
    $('bundleAddResult').style.color = 'var(--red)';
  } finally {
    $('btnAddToBundle').disabled = false;
  }
}

function _detectSiteName(url) {
  if (!url) return '';
  if (url.includes('oliveyoung'))  return '올리브영';
  if (url.includes('naver'))       return '네이버';
  if (url.includes('coupang'))     return '쿠팡';
  if (url.includes('kurly'))       return '컬리';
  if (url.includes('musinsa'))     return '무신사';
  if (url.includes('daiso'))       return '다이소';
  if (url.includes('themedicube')) return '메디큐브';
  try { return new URL(url).hostname.replace('www.', ''); } catch { return ''; }
}

/* ═════════ 초기화 ═════════ */
document.addEventListener('DOMContentLoaded', () => {
  detectCurrentPage();

  const sourcingHosts = ['oliveyoung.co.kr', 'smartstore.naver.com', 'brand.naver.com',
    'shopping.naver.com', 'coupang.com', 'musinsa.com', 'kurly.com',
    'daiso.co.kr', 'themedicube.co.kr', 'vt-cosmetics.com', 'anua.kr'];

  // ★ 마지막 감지된 URL — 중복 새로고침 방지
  let _lastDetectedUrl = '';

  // 디바운스된 재감지
  let _detectTimer = null;
  const debouncedDetect = () => {
    clearTimeout(_detectTimer);
    _detectTimer = setTimeout(() => { detectCurrentPage(); }, 300);
  };

  // 탭 활성화 감지 (사용자가 탭 클릭)
  chrome.tabs.onActivated.addListener(async (info) => {
    try {
      const tab = await chrome.tabs.get(info.tabId);
      if (tab?.url && sourcingHosts.some(h => tab.url.includes(h))) {
        if (tab.url !== _lastDetectedUrl) {
          _lastDetectedUrl = tab.url;
          debouncedDetect();
        }
      }
    } catch {}
  });

  // 탭 URL 변경 감지 (페이지 이동, 새 탭 오픈 모두)
  // ★ tabId 비교 제거 — 어떤 소싱 탭이든 변경되면 무조건 재감지
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab?.url || !sourcingHosts.some(h => tab.url.includes(h))) return;
    if (tab.url === _lastDetectedUrl) return;  // 같은 URL이면 스킵
    _lastDetectedUrl = tab.url;
    debouncedDetect();
  });

  // 윈도우 포커스 변경 (다른 창으로 전환 시)
  if (chrome.windows?.onFocusChanged) {
    chrome.windows.onFocusChanged.addListener(async (windowId) => {
      if (windowId === chrome.windows.WINDOW_ID_NONE) return;
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, windowId });
        if (activeTab?.url && sourcingHosts.some(h => activeTab.url.includes(h))) {
          if (activeTab.url !== _lastDetectedUrl) {
            _lastDetectedUrl = activeTab.url;
            debouncedDetect();
          }
        }
      } catch {}
    });
  }

  // 버튼 핸들러
  $('btnRefresh').addEventListener('click', () => {
    _lastDetectedUrl = '';  // 강제 재감지
    detectCurrentPage();
  });
  $('btnUpdate').addEventListener('click', updateSheetPrice);

  // 📋 현재 페이지 링크 복사 (소싱처 URL 붙여넣기용)
  $('btnCopyUrl')?.addEventListener('click', async () => {
    const url = _currentUrl || $('metaUrl')?.textContent || '';
    if (!url) { setStatus('복사할 링크가 없습니다', 'error'); return; }
    const btn = $('btnCopyUrl');
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // 폴백: 임시 textarea로 복사
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = '✅'; btn.classList.add('copied');
      setTimeout(() => { btn.textContent = prev; btn.classList.remove('copied'); }, 1200);
    }
    setStatus('📋 링크 복사됨 — 소싱처 URL 칸에 붙여넣으세요', 'success');
  });

  // ★ v1.9.11: 기획세트 빌더 이벤트
  $('btnAddToBundle')?.addEventListener('click', addToBundle);
  $('bundleSelect')?.addEventListener('change', () => {
    const btn = $('btnAddToBundle');
    if (btn) btn.disabled = !$('bundleSelect').value || !_scrapedPrice;
  });

  // 페이지가 소싱 페이지일 때만 번들 빌더 카드 표시
  const updateBundleCard = () => {
    const card = $('bundleBuilderCard');
    if (!card) return;
    const show = _currentUrl && sourcingHosts.some(h => _currentUrl.includes(h));
    card.style.display = show ? '' : 'none';
    if (show && _bundleList.length === 0) {
      loadBundleList();
    }
    const btn = $('btnAddToBundle');
    if (btn) btn.disabled = !$('bundleSelect')?.value || !_scrapedPrice;
  };
  setInterval(updateBundleCard, 1500);
  updateBundleCard();
});
