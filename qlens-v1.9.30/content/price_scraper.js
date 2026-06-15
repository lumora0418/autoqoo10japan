/* ═══════════════════════════════════════════════════════════════
 * QLens — Price Scraper (Content Script)
 * v1.9.20: Q10 Auto 수준 가격 추출 로직 통합 (다층 폴백)
 *
 * 지원 사이트:
 *  ✅ 올리브영 (oliveyoung.co.kr) — 할인율 % 패턴 + 정가/할인가 분리
 *  ✅ 네이버 스마트스토어/브랜드스토어/쇼핑 (smartstore/brand/shopping.naver.com)
 *  ✅ 쿠팡 (coupang.com) — 5단계 폴백 (Q10 수준)
 *  ✅ 무신사 (musinsa.com)
 *  ✅ 마켓컬리 (kurly.com) — random hash class 대응
 *  ✅ 다이소 (daiso.co.kr)
 *  ✅ Cafe24 기반 (themedicube/vt-cosmetics/anua)
 *  ✅ 공통 폴백: schema.org/Product, og:price meta
 * ═══════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ─── 공통 헬퍼 ──────────────────────────────────────────────
  function num(s) {
    if (typeof s === 'number') return s;
    if (!s) return 0;
    const m = String(s).match(/[\d,]+/);
    return m ? parseInt(m[0].replace(/,/g, ''), 10) : 0;
  }
  function isReasonablePrice(n) {
    return typeof n === 'number' && n >= 100 && n <= 10000000;
  }
  function directText(el) {
    if (!el) return '';
    return el.innerText || el.textContent || '';
  }

  /* ─── 가격 텍스트 → 숫자 ────────────────────────────────────
     "30% 14,000원 9,800원" → 9800 (콤마 포함 가장 작은 가격 = 할인가)
     "₩39,900원" → 39900
  ─────────────────────────────────────────────────────────── */
  function parsePrice(text) {
    if (!text) return 0;
    const str = String(text);
    const tokens = str.match(/\d{1,3}(?:,\d{3})+|\d{4,7}/g) || [];
    if (!tokens.length) return 0;
    const nums = tokens
      .map(t => parseInt(t.replace(/,/g, ''), 10))
      .filter(n => isReasonablePrice(n));
    if (!nums.length) return 0;
    nums.sort((a, b) => a - b);
    if (nums.length > 1 && nums[0] < nums[nums.length - 1] * 0.3) {
      return nums[nums.length - 1];
    }
    return nums[0];
  }

  /* ─── 사이트별 추출기 (각각 우선순위/폴백 다층 구조) ───────── */
  const SITES = {

    // ═══ 올리브영 ═════════════════════════════════════════════
    oliveyoung: {
      match: /oliveyoung\.co\.kr/,
      extract() {
        // 메인 가격 영역
        const box = document.querySelector(
          '[class*="price-box-wrap"], [class*="price-box"], #tempPriceArea, .prd_price_info, [class*="PriceArea"]'
        );
        if (!box) return { ok: false, error: '가격 영역 못 찾음' };

        const strikeEl = box.querySelector('s, del');
        const priceOrig = num(strikeEl?.textContent || '');
        const priceText = box.textContent || '';

        // 1) 할인율 % 다음 가격 (가장 정확)
        const discMatch = priceText.match(/(\d{1,2})\s*%\s*([\d,]+)\s*원/);
        if (discMatch) {
          const v = num(discMatch[2]);
          if (isReasonablePrice(v) && (priceOrig === 0 || v < priceOrig)) {
            return { ok: true, price: v, selector: 'oy-% pattern', site: 'oliveyoung' };
          }
        }

        // 2) 괄호 안 제거 후 모든 가격 후보
        const cleaned = priceText.replace(/\([^)]*\)/g, '');
        const allNums = [...cleaned.matchAll(/([\d,]+)\s*원/g)]
          .map(m => num(m[1]))
          .filter(n => isReasonablePrice(n));

        // 3) priceOrig가 있으면 그보다 작은 후보 중 최대
        if (priceOrig > 0) {
          const candidates = allNums.filter(n => n < priceOrig);
          if (candidates.length) {
            return { ok: true, price: Math.max(...candidates), selector: 'oy-strike-fallback', site: 'oliveyoung' };
          }
          return { ok: true, price: priceOrig, selector: 'oy-orig-only', site: 'oliveyoung' };
        }

        // 4) priceOrig 없으면 가장 작은 값(할인가) 우선, 단 너무 작으면 최대
        if (allNums.length) {
          allNums.sort((a, b) => a - b);
          // 두 개 이상이면 작은 게 할인가
          if (allNums.length >= 2 && allNums[0] >= allNums[allNums.length - 1] * 0.3) {
            return { ok: true, price: allNums[0], selector: 'oy-sort-min', site: 'oliveyoung' };
          }
          return { ok: true, price: allNums[allNums.length - 1], selector: 'oy-sort-max', site: 'oliveyoung' };
        }
        return { ok: false, error: '가격 후보 없음', site: 'oliveyoung' };
      }
    },

    // ═══ 네이버 스마트스토어/브랜드스토어/쇼핑 ════════════════════
    naverSmart: {
      match: /smartstore\.naver\.com|brand\.naver\.com|shopping\.naver\.com/,
      extract() {
        // 네이버는 클래스명이 난독화(해시)되어 자주 바뀜 → JSON-LD/meta 우선, 패턴 매칭 보강
        let priceDisc = 0, priceOrig = 0;

        // ─── 1순위: JSON-LD (네이버 스마트스토어 신뢰도 높음) ───
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const sc of ldScripts) {
          try {
            const data = JSON.parse(sc.textContent || '{}');
            const arr = Array.isArray(data) ? data : [data];
            for (const item of arr) {
              const offer = item.offers || (item['@graph'] || []).find(g => g.offers)?.offers;
              const price = (Array.isArray(offer) ? offer[0] : offer)?.price
                          || (Array.isArray(offer) ? offer[0] : offer)?.lowPrice || item.price;
              if (price) { const v = num(String(price)); if (isReasonablePrice(v)) { priceDisc = v; break; } }
            }
            if (priceDisc) break;
          } catch {}
        }

        // ─── 2순위: meta 태그 ───
        if (!priceDisc) {
          const meta = document.querySelector(
            'meta[property="product:price:amount"], meta[property="og:product:price:amount"], meta[itemprop="price"]'
          )?.content;
          if (meta) { const v = num(meta); if (isReasonablePrice(v)) priceDisc = v; }
        }

        // ─── 3순위: 메인 영역 정가/할인가 패턴 + strike 분리 ───
        const main = document.querySelector(
          '[class*="ProductHeaderArea"], [class*="ProductInfo"], [class*="product_info"], [class*="_priceArea"], [class*="price_area"], [class*="TotalPrice"]'
        ) || document.body;
        if (!priceDisc) {
          // "30%21,000원30,000원" 류 정가/할인가 패턴 (단가 제외)
          const clean = main.textContent.replace(/\([^)]*당\s*[\d,]+원\)/g, '').replace(/\s+/g, '').slice(0, 3000);
          const m = clean.match(/(\d+)%([\d,]+)원([\d,]+)원/);
          if (m) {
            const a = num(m[2]), b = num(m[3]);
            const orig = Math.max(a, b), disc = Math.min(a, b);  // 큰 쪽이 정가
            if (orig > disc && isReasonablePrice(disc) && disc >= 100) { priceOrig = orig; priceDisc = disc; }
          }
        }
        if (!priceDisc) {
          // strike(취소선=정가) / non-strike(할인가) 분리
          const candidates = [];
          [...main.querySelectorAll('strong, span, em, [class*="price"], [class*="Price"]')].forEach(el => {
            const text = directText(el);
            const n = num(text);
            if (!n || !isReasonablePrice(n)) return;
            if (!/[\d,]+\s*원/.test(text) && !/^\s*[\d,]+\s*$/.test(text)) return;
            // 배송/적립 문맥 제외
            let p = el.parentElement, depth = 0, ship = false;
            while (p && depth < 4) {
              if (/이상\s*무료|무료\s*배송|적립|쿠폰|배송비|포인트/.test((p.textContent || '').slice(0, 120))) { ship = true; break; }
              p = p.parentElement; depth++;
            }
            if (ship) return;
            const isStrike = el.tagName === 'DEL' || !!el.closest('del')
              || (window.getComputedStyle(el).textDecoration || '').includes('line-through');
            candidates.push({ n, isStrike });
          });
          const normal = candidates.filter(c => !c.isStrike).map(c => c.n).sort((a, b) => a - b);
          const strike = candidates.filter(c => c.isStrike).map(c => c.n).sort((a, b) => a - b);
          if (normal.length) {
            if (strike.length) {
              const maxStrike = Math.max(...strike);
              const valid = normal.filter(n => n < maxStrike);
              priceDisc = valid.length ? Math.max(...valid) : normal[normal.length - 1];
            } else {
              priceDisc = normal[normal.length - 1];  // 정상가 중 최대 (단가/소액 제외)
            }
            if (!priceOrig && strike.length) priceOrig = Math.max(...strike);
          }
        }

        // ─── 4순위: 안정적 셀렉터 (난독화 클래스 의존 최소화) ───
        if (!priceDisc) {
          const selectors = [
            'strong[class*="discount_price"]', '.price_area strong',
            '[class*="lowestPrice"]', '.price_num', '[class*="totalPrice"]', '[class*="TotalPrice"]',
          ];
          for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
              const v = parsePrice(directText(el));
              if (isReasonablePrice(v)) { priceDisc = v; break; }
            }
            if (priceDisc) break;
          }
        }

        if (priceDisc > 0) {
          return { ok: true, price: priceDisc, selector: 'naver-multi', site: 'naver', priceOrig: priceOrig || null };
        }
        return { ok: false, error: '네이버 가격 추출 실패', site: 'naver' };
      }
    },

    // ═══ 쿠팡 (가장 어려움 — Q10 Auto 5단계 폴백 이식) ═══════════
    coupang: {
      match: /coupang\.com/,
      extract() {
        // 메인 가격 영역 찾기 (광고/추천상품 제외) — Q10 Auto 셀렉터 이식
        const mainAreaEl = document.querySelector(
          '.prod-buy, .prod-info, .prod-atf, [class*="prod-buy"], [class*="prod-info"], [class*="ProductInfo"], [class*="ProductBuyHeader"], [data-region="atf"], .prod-buy-header, .product-buy, [class*="atfWrapper"]'
        ) || document.body;

        let priceDisc = 0, priceOrig = 0;

        // ─── 1순위: 페이지 표시가 (쿠팡판매가 라벨 + 정가/할인가 패턴) — Q10 Auto 로직 이식 ───
        const findVisiblePrice = () => {
          // a) "쿠팡판매가"/"판매가"/"할인가"/"와우할인" 라벨 leaf element → 부모 거슬러 라벨 앞 "X원" 매칭
          const labelEls = [...mainAreaEl.querySelectorAll('*')].filter(el => {
            const t = (el.textContent || '').trim();
            if (!/^(쿠팡판매가|판매가|할인가|와우할인)$/.test(t)) return false;
            return el.children.length === 0;  // leaf만
          });
          for (const lbl of labelEls) {
            const labelText = lbl.textContent.trim();
            let p = lbl.parentElement;
            for (let depth = 0; depth < 4 && p; depth++) {
              const fullText = p.textContent.replace(/\s+/g, '').slice(0, 300);
              const cleanText = fullText.replace(/\([^)]*당\s*[\d,]+원\)/g, '');  // 단가 제외
              const labelIdx = cleanText.indexOf(labelText);
              if (labelIdx > 0) {
                const before = cleanText.slice(0, labelIdx);
                const matches = [...before.matchAll(/([\d,]+)원/g)];
                if (matches.length > 0) {
                  const v = num(matches[matches.length - 1][1]);
                  if (isReasonablePrice(v) && v >= 100) return v;
                }
              }
              p = p.parentElement;
              if (p === document.body) break;
            }
          }
          // b) "% 정가 할인가" 패턴 (라벨 없이도 신뢰) — "44%36,000원19,950원"
          const pricePatternEls = [...mainAreaEl.querySelectorAll('div, p, span, strong')].filter(el => {
            const t = (el.textContent || '').slice(0, 300);
            if (t.length > 300 || t.length < 10) return false;
            if (el.children.length > 20) return false;
            const clean = t.replace(/\([^)]*당\s*[\d,]+원\)/g, '').replace(/\s+/g, '');
            return /\d+%[\d,]+원[\d,]+원/.test(clean);
          });
          pricePatternEls.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
          for (const el of pricePatternEls) {
            const clean = el.textContent.replace(/\([^)]*당\s*[\d,]+원\)/g, '').replace(/\s+/g, '');
            const m = clean.match(/(\d+)%([\d,]+)원([\d,]+)원/);
            if (m) {
              const orig = num(m[2]), disc = num(m[3]);
              if (orig > disc && isReasonablePrice(orig) && isReasonablePrice(disc) && disc >= 100) {
                priceOrig = orig; return disc;
              }
            }
          }
          // c) "% 가격" 패턴 (할인률 + 1개 가격)
          const discPatternEls = [...mainAreaEl.querySelectorAll('div, p, span, strong')].filter(el => {
            const t = (el.textContent || '').trim();
            if (t.length > 200) return false;
            if (el.children.length > 15) return false;
            return /\d+%\s*[\d,]+\s*원/.test(t);
          });
          for (const el of discPatternEls) {
            const clean = el.textContent.replace(/\([^)]*당\s*[\d,]+원\)/g, '').replace(/\s+/g, '');
            const m = clean.match(/(\d+)%\s*([\d,]+)원/);
            if (m) {
              const v = num(m[2]);
              if (isReasonablePrice(v) && v >= 100) return v;
            }
          }
          return 0;
        };
        const v1 = findVisiblePrice();
        if (v1 > 0) priceDisc = v1;

        // ─── 2순위: 셀렉터 매칭
        if (!priceDisc) {
          const discSel = mainAreaEl.querySelector(
            '[class*="salesPrice"], [class*="finalPrice"], .total-price strong, .price-amount, [class*="prod-sale-price"], [class*="sale-price"]'
          );
          if (discSel) {
            const v = num(directText(discSel));
            if (isReasonablePrice(v)) priceDisc = v;
          }
          const origSel = mainAreaEl.querySelector(
            '[class*="origPrice"], [class*="basePrice"], .origin-price, [class*="prod-origin-price"], del'
          );
          if (origSel) {
            const v = num(directText(origSel));
            if (isReasonablePrice(v)) priceOrig = v;
          }
        }

        // ─── 3순위: 메인 영역 strike/non-strike 분리
        if (!priceDisc) {
          const candidates = [];
          [...mainAreaEl.querySelectorAll('[class*="price"],[class*="Price"], strong, em, span')].forEach(el => {
            const text = directText(el);
            const n = num(text);
            if (!n || !isReasonablePrice(n)) return;
            if (!/^\s*[\d,]+\s*원?\s*$/.test(text) && !/[\d,]+\s*원/.test(text)) return;
            // 배송 안내문구 제외 (Q10 Auto 로직)
            let p = el.parentElement;
            let depth = 0;
            let isShipCtx = false;
            while (p && depth < 5) {
              const pt = (p.textContent || '').slice(0, 200);
              if (/이상\s*무료\s*배송|원\s*이상\s*무료|쿠팡캐시\s*적립|적립금|쿠폰\s*받기|배송비\s*무료/.test(pt)) {
                isShipCtx = true; break;
              }
              p = p.parentElement; depth++;
            }
            if (isShipCtx) return;
            const isStrike = el.tagName === 'DEL' || !!el.closest('del')
              || (window.getComputedStyle(el).textDecoration || '').includes('line-through');
            candidates.push({ n, isStrike });
          });
          const normal = candidates.filter(c => !c.isStrike).map(c => c.n).sort((a, b) => a - b);
          const strike = candidates.filter(c => c.isStrike).map(c => c.n).sort((a, b) => a - b);
          if (normal.length) {
            if (strike.length) {
              const maxStrike = Math.max(...strike);
              const validN = normal.filter(n => n < maxStrike);
              priceDisc = validN.length ? Math.max(...validN) : normal[normal.length - 1];
            } else {
              priceDisc = normal[normal.length - 1];
            }
          }
          if (!priceOrig && strike.length) priceOrig = Math.max(...strike);
        }

        // ─── 4순위: meta tag
        if (!priceDisc) {
          const meta = document.querySelector('meta[property="product:price:amount"], meta[itemprop="price"]')?.content;
          if (meta) {
            const v = num(meta);
            if (isReasonablePrice(v)) priceDisc = v;
          }
        }

        // ─── 5순위: JSON-LD
        if (!priceDisc) {
          const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
          for (const sc of ldScripts) {
            try {
              const data = JSON.parse(sc.textContent || '{}');
              const items = Array.isArray(data) ? data : [data];
              for (const item of items) {
                const offer = item.offers || (item['@graph']?.find(g => g.offers))?.offers;
                const price = offer?.price || offer?.lowPrice || item.price;
                if (price) {
                  const v = num(String(price));
                  if (isReasonablePrice(v)) { priceDisc = v; break; }
                }
              }
              if (priceDisc) break;
            } catch {}
          }
        }

        if (priceDisc > 0) {
          return { ok: true, price: priceDisc, selector: 'coupang-multi', site: 'coupang', priceOrig: priceOrig || null };
        }
        return { ok: false, error: '쿠팡 가격 추출 실패 (5단계 폴백 모두 실패)', site: 'coupang' };
      }
    },

    // ═══ 무신사 ═══════════════════════════════════════════════
    musinsa: {
      match: /musinsa\.com/,
      extract() {
        const selectors = [
          '.price_section .product_article_price',
          '#goods_price',
          '.product-price strong',
          '[data-mds="Typography"] strong',
          // 신규 무신사
          '[class*="MIPHKWB"] [class*="discountAmount"]',
          '[class*="MIPHKWB"] strong',
          'span[class*="discount-price"]',
          'span[class*="finalPrice"]',
        ];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const v = parsePrice(directText(el));
            if (isReasonablePrice(v)) {
              return { ok: true, price: v, selector: sel, site: 'musinsa' };
            }
          }
        }
        return { ok: false, error: '무신사 가격 추출 실패', site: 'musinsa' };
      }
    },

    // ═══ 마켓컬리 ═════════════════════════════════════════════
    kurly: {
      match: /kurly\.com/,
      extract() {
        // 상품 정보 영역으로 좁히기
        const candidates = [
          document.querySelector('[class*="ProductDetailInfo"]'),
          document.querySelector('[class*="goods-detail"]'),
          document.querySelector('[class*="productInfo"]'),
          document.querySelector('section[class*="Product"]'),
          document.querySelector('main'),
        ].filter(Boolean);

        for (const box of candidates) {
          const txt = (box.textContent || '').slice(0, 3000);
          // "30% 24,500원" 패턴
          const m = txt.match(/(\d{1,2})\s*%\s*([\d,]+)\s*원/);
          if (m) {
            const v = num(m[2]);
            if (isReasonablePrice(v)) {
              return { ok: true, price: v, selector: 'kurly-% pattern', site: 'kurly' };
            }
          }
          // 취소선 + 할인가
          const strike = box.querySelector('s, del, [class*="strike"]');
          if (strike) {
            const sv = num(strike.textContent);
            if (sv > 0) {
              const nums = [...txt.replace(/\([^)]*\)/g, '').matchAll(/([\d,]+)\s*원/g)]
                .map(m => num(m[1]))
                .filter(n => isReasonablePrice(n) && n < sv);
              if (nums.length) {
                return { ok: true, price: Math.max(...nums), selector: 'kurly-strike-fallback', site: 'kurly' };
              }
            }
          }
        }

        // 폴백: 셀렉터
        const selectors = [
          '[class*="ProductInfoCard"] [class*="discount"] [class*="amount"]',
          '[class*="ProductPrice"] [class*="discount"]',
          '[class*="DiscountPrice"]',
          'dl[class*="price"] dd strong',
        ];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const v = parsePrice(directText(el));
            if (isReasonablePrice(v)) {
              return { ok: true, price: v, selector: sel, site: 'kurly' };
            }
          }
        }
        return { ok: false, error: '컬리 가격 추출 실패', site: 'kurly' };
      }
    },

    // ═══ 다이소 ═══════════════════════════════════════════════
    daiso: {
      match: /daiso\.co\.kr/,
      extract() {
        const selectors = [
          '.product-price',
          '.price_num',
          '[class*="price"] strong',
          '[class*="ProductPrice"]',
          '[class*="Price__"]',
          '.goods-price',
        ];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const v = parsePrice(directText(el));
            if (isReasonablePrice(v)) {
              return { ok: true, price: v, selector: sel, site: 'daiso' };
            }
          }
        }
        return { ok: false, error: '다이소 가격 추출 실패', site: 'daiso' };
      }
    },

    // ═══ Cafe24 기반 (themedicube/vt-cosmetics/anua) ═══════════
    cafe24: {
      match: /themedicube\.co\.kr|vt-cosmetics\.com|anua\.kr/,
      extract() {
        const selectors = [
          '#span_product_price_text',           // Cafe24 표준
          '#span_product_price_sale',
          '#span_product_price_custom',
          '.xans-product-detail .price strong',
          '.product_price strong',
          '[class*="price"] strong',
        ];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const v = parsePrice(directText(el));
            if (isReasonablePrice(v)) {
              return { ok: true, price: v, selector: sel, site: 'cafe24' };
            }
          }
        }
        // 폴백: 메타
        return { ok: false, error: 'Cafe24 사이트 가격 추출 실패', site: 'cafe24' };
      }
    },
  };

  /* ─── 공통 폴백: schema.org Product / og:price ─────────────── */
  function commonFallback() {
    try {
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const sc of ldScripts) {
        try {
          const data = JSON.parse(sc.textContent || '{}');
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            const offer = item.offers || (item['@graph']?.find(g => g.offers))?.offers;
            const price = offer?.price || offer?.lowPrice || item.price;
            if (price) {
              const v = num(String(price));
              if (isReasonablePrice(v)) {
                return { ok: true, price: v, selector: 'schema.org/Product', site: 'common' };
              }
            }
          }
        } catch {}
      }
      const ogPrice = document.querySelector('meta[property="product:price:amount"]')?.content
                   || document.querySelector('meta[property="og:price:amount"]')?.content
                   || document.querySelector('meta[itemprop="price"]')?.content;
      if (ogPrice) {
        const v = num(ogPrice);
        if (isReasonablePrice(v)) {
          return { ok: true, price: v, selector: 'meta[og:price]', site: 'common' };
        }
      }
    } catch {}
    return null;
  }

  /* ─── 사이트 식별 + 추출 ──────────────────────────────────── */
  function detectAndExtract() {
    const url = location.href;
    let matchedSite = null;
    for (const [name, def] of Object.entries(SITES)) {
      if (def.match.test(url)) {
        matchedSite = name;
        try {
          const result = def.extract();
          if (result && result.ok) return result;
          // 사이트 매칭됐는데 추출 실패 → 공통 폴백
          const common = commonFallback();
          if (common) return { ...common, site: name };
          return result || { ok: false, error: '추출 실패', site: name };
        } catch (e) {
          console.error('[QLens] 추출 에러:', e);
          // 사이트 매칭 OK인데 에러 → 공통 폴백
          const common = commonFallback();
          if (common) return { ...common, site: name };
          return { ok: false, error: e.message, site: name };
        }
      }
    }
    // 어느 사이트도 매칭 안 됨 → 공통 폴백 시도
    const common = commonFallback();
    if (common) return { ...common, site: 'unknown' };
    return { ok: false, error: '지원하지 않는 사이트', site: 'unknown' };
  }

  /* ─── 메시지 리스너 ──────────────────────────────────────── */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'LENS_SCRAPE_PRICE') {
      // 페이지 로딩 대기 (특히 SPA)
      setTimeout(() => {
        const result = detectAndExtract();
        console.log('[QLens] 가격 추출:', result);
        sendResponse(result);
      }, 400);
      return true;  // async
    }
  });

  console.log('[QLens] Price Scraper v1.9.20 로드됨:', location.hostname);
})();
