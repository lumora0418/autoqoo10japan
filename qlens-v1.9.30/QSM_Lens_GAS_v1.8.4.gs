// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Q10 Auto + QLens 통합 Google Apps Script v1.8.4 (📖 사용설명서 시트 + 소싱시트 폐지 | v1.8.3: 상품별 수수료율 AC열 + 시트 수식 per-item 수수료 + 마진율 부가세 제외)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// QSM_Lens_Items — 23컬럼 (A~W) / 마진계산기ver3 구조 기반
//
// ┌─ [A~C] 상품 기본 ─────────────────────────────────────────────┐
// │  A: ItemCode   B: Status   C: 상품명                          │
// ├─ [D~I] 소싱 입력 ─────────────────────────────────────────────┤
// │  D: 소싱처URL  E: 소싱가(₩)  F: 무게(kg)                     │
// │  G: 배대지비용(₩)  H: 배송사  I: 마진율(%)                   │
// ├─ [J~K] 비용 소계 (수식) ───────────────────────────────────────┤
// │  J: 기대비용(₩) = 추천판매가×환율×수수료%+포장비              │
// │  K: 소싱가+기대비용(₩) = E+J                                  │
// ├─ [L~M] QSM 현재 설정 ─────────────────────────────────────────┤
// │  L: 현재QSM가(¥)   M: 고객배송비(¥)                          │
// ├─ [N~P] 추천 판매가 (수식) ─────────────────────────────────────┤
// │  N: 평상시가(¥)  O: 메가포가(¥)  P: 메가와리가(¥)            │
// ├─ [Q~T] 수익 분석 (수식) ───────────────────────────────────────┤
// │  Q: 판매가 원환산(₩)  R: 총비용(₩)                           │
// │  S: 이익(₩)          T: 마진율(%)                            │
// └─ [U~W] 메타 ───────────────────────────────────────────────────┘
//    U: 브랜드명   V: 메모   W: 마지막 업데이트
//
// QSM_Lens_Config B열 참조 위치:
//   B2: 환율(¥→₩)  B3: QSM수수료%  B4: 메가포%
//   B5: 메가와리할인%  B6: 메가와리행사수수료%  B7: 메가와리셀러부담%
//   B8: 국내포장비₩   B9: 부가세환급율%
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ★★★ 여기에 본인 스프레드시트 ID를 넣으세요 ★★★
//   내 시트 URL: https://docs.google.com/spreadsheets/d/[이 부분이 ID]/edit
//   예) .../d/1AbcD... /edit  →  '1AbcD...' 를 아래 따옴표 안에 붙여넣기
const SHEET_ID  = 'PASTE_YOUR_SPREADSHEET_ID_HERE';
const SHEET_TAB = '상품관리';

const COLUMN_MAP = [
  { dataKey: 'thumbnail',     aliases: ['썸네일','대표이미지','이미지','thumbnail','image'] },
  { dataKey: '브랜드명',       aliases: ['브랜드명','브랜드','brand'] },
  { dataKey: '브랜드코드',     aliases: ['브랜드코드','브랜드 코드','brandno','brandcode'] },
  { dataKey: '기획_단품',      aliases: ['기획/단품','기획_단품','기획단품','단품/기획'] },
  { dataKey: '상품명',         aliases: ['상품명','상 품 명','title','한국어 상품명','한글 상품명'] },
  { dataKey: '일본어상품명',   aliases: ['일본어 상품명','일본어상품명','JA상품명','jp_title'] },
  { dataKey: '소싱처',         aliases: ['소싱처','쇼핑몰','사이트','site'] },
  { dataKey: '소싱처_링크',    aliases: ['소싱처 링크','소싱처_링크','소싱링크','URL','url','링크'] },
  { dataKey: '공식판매가_원',  aliases: ['공식판매가','공식판매가(원)','official_price'] },
  { dataKey: '소싱판매가_원',  aliases: ['소싱판매가','할인판매가','소싱판매가(원)','할인판매가(원)','discount_price'] },
  { dataKey: '판매가_엔',      aliases: ['판매가(엔)','판매가_엔','판매가¥','판매가엔'] },
  { dataKey: '고객배송비_엔',  aliases: ['고객배송비(엔)','고객배송비_엔','고객배송비¥'] },
  { dataKey: '매출_원',        aliases: ['매출(원)','매출_원','매출'] },
  { dataKey: '상품원가_원',    aliases: ['상품원가(원)','상품원가_원','원가'] },
  { dataKey: '배송사',         aliases: ['배송사','배송업체','carrier'] },
  { dataKey: '총중량_kg',      aliases: ['총중량(kg)','총중량_kg','총중량','무게','weight'] },
  { dataKey: '국제배송비_원',  aliases: ['국제배송비(원)','국제배송비_원','국제배송비','해외배송비','배대지비용'] },
  { dataKey: '큐텐수수료_원',  aliases: ['큐텐수수료(원)','큐텐수수료_원','Qoo10수수료','수수료_원','수수료'] },
  { dataKey: '국내배송비_원',  aliases: ['국내배송비(원)','국내배송비_원','국내배송비'] },
  { dataKey: '총비용_원',      aliases: ['총비용(원)','총비용_원','총비용'] },
  { dataKey: '부가세환급_9',   aliases: ['부가세환급(9%)','부가세환급_9','부가세환급','VAT환급','부가세'] },
  { dataKey: '이익_원',        aliases: ['이익(원)','이익_원','이익','순이익'] },
  { dataKey: '마진율_pct',     aliases: ['마진율(%)','마진율_pct','마진율','margin'] },
  { dataKey: 'qsmGoodsCode',   aliases: ['QSM코드','QSM 코드','GdNo','goodscode','큐텐상품코드'] },
  { dataKey: 'registeredAtKr', aliases: ['등록일시','등록 일시','등록일','registeredAt','등록시간'] },
];
const DEFAULT_HEADERS = [
  '썸네일','브랜드명','브랜드코드','기획/단품','상품명','일본어 상품명',
  '소싱처','소싱처 링크','공식판매가(원)','소싱판매가(원)',
  '판매가(엔)','고객배송비(엔)','매출(원)','상품원가(원)',
  '배송사','총중량(kg)','국제배송비(원)','큐텐수수료(원)','국내배송비(원)','총비용(원)',
  '부가세환급(9%)','이익(원)','마진율(%)','QSM코드','등록일시',
];

function _getSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  return SHEET_TAB ? (ss.getSheetByName(SHEET_TAB)||ss.getSheets()[0]) : ss.getSheets()[0];
}
function _ensureHeader(sheet, userHeaders) {
  if (sheet.getLastRow()===0) {
    const h=(Array.isArray(userHeaders)&&userHeaders.length)?userHeaders:DEFAULT_HEADERS;
    sheet.appendRow(h);
    sheet.getRange(1,1,1,h.length).setFontWeight('bold').setBackground('#1c1c2e').setFontColor('#eeeef5');
    sheet.setFrozenRows(1);
  }
}
function _getColumnMapping(sheet) {
  const lastCol=sheet.getLastColumn(); if(!lastCol) return [];
  const header=sheet.getRange(1,1,1,lastCol).getValues()[0];
  const result=[];
  header.forEach((cell,idx)=>{
    const norm=String(cell||'').trim().toLowerCase().replace(/\s+/g,'');
    if(!norm) return;
    for(const def of COLUMN_MAP){
      if(def.aliases.some(a=>a.toLowerCase().replace(/\s+/g,'')=== norm)){
        result.push({col:idx+1,dataKey:def.dataKey}); return;
      }
    }
  });
  return result;
}
function _findDuplicateRow(sheet,name,url,mapping){
  if(!name) return 0; const lastRow=sheet.getLastRow(); if(lastRow<2) return 0;
  const nameMap=mapping.find(m=>m.dataKey==='상품명'); const linkMap=mapping.find(m=>m.dataKey==='소싱처_링크');
  if(!nameMap) return 0;
  const names=sheet.getRange(2,nameMap.col,lastRow-1,1).getValues().flat().map(String);
  const links=linkMap?sheet.getRange(2,linkMap.col,lastRow-1,1).getValues().flat().map(String):[];
  for(let i=0;i<names.length;i++){
    if(names[i]===String(name)&&(!url||(linkMap&&links[i]===String(url)))) return i+2;
  }
  return 0;
}
function _applyFormulas(sheet,row,mapping,data){
  const get=key=>{const m=mapping.find(x=>x.dataKey===key);return m?sheet.getRange(row,m.col).getA1Notation():'';};
  const exch=data.exchangeRate||9.5;
  const cP=get('판매가_엔'),cS=get('고객배송비_엔'),cRev=get('매출_원');
  const cSrc=get('소싱판매가_원'),cIntl=get('국제배송비_원'),cFee=get('큐텐수수료_원');
  const cDom=get('국내배송비_원'),cTotal=get('총비용_원'),cVat=get('부가세환급_9');
  const cProfit=get('이익_원'),cMargin=get('마진율_pct');
  if(cRev&&cP) sheet.getRange(cRev).setFormula(cS?`=(${cP}+${cS})*${exch}`:`=${cP}*${exch}`);
  if(cTotal&&cSrc){const p=[cSrc,cIntl,cFee,cDom].filter(Boolean);sheet.getRange(cTotal).setFormula(`=${p.join('+')}+500`);}
  if(cVat&&cSrc) sheet.getRange(cVat).setFormula(`=${cSrc}*0.09`);
  if(cProfit&&cRev&&cTotal) sheet.getRange(cProfit).setFormula(`=${cRev}-${cTotal}${cVat?'+'+cVat:''}`);
  if(cMargin&&cProfit&&cRev){sheet.getRange(cMargin).setFormula(`=IFERROR(${cProfit}/${cRev}*100,0)`);try{sheet.getRange(cMargin).setNumberFormat('0.00"%"');}catch(_){}}
}
function _handleUpdatePrice(sheet,data){
  try{
    const qsmCode=String(data.qsmCode||'').trim(); if(!qsmCode) return _json({ok:false,error:'qsmCode 없음'});
    const mapping=_getColumnMapping(sheet);
    const qsmMap=mapping.find(m=>m.dataKey==='qsmGoodsCode'||m.dataKey==='QSM코드');
    if(!qsmMap) return _json({ok:false,error:'QSM코드 컬럼 없음'});
    const lastRow=sheet.getLastRow(); if(lastRow<2) return _json({ok:false,error:'데이터 없음'});
    const codes=sheet.getRange(2,qsmMap.col,lastRow-1,1).getValues().flat().map(String);
    let targetRow=-1;
    for(let i=codes.length-1;i>=0;i--){if(codes[i]===qsmCode){targetRow=i+2;break;}}
    if(targetRow<0) return _json({ok:false,error:'코드 없음: '+qsmCode});
    const priceMap=mapping.find(m=>m.dataKey==='판매가_엔');
    if(priceMap) sheet.getRange(targetRow,priceMap.col).setValue(Number(data.newPriceJpy)||0);
    _applyFormulas(sheet,targetRow,mapping,{exchangeRate:data.exchangeRate});
    return _json({ok:true,row:targetRow,qsmCode,newPriceJpy:data.newPriceJpy});
  }catch(err){return _json({ok:false,error:err.toString()});}
}
function _json(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}

function doPost(e){
  try{
    const data=JSON.parse(e.postData.contents);
    // LENS_ 액션은 QLens 전용 핸들러로
    if(data.action&&data.action.startsWith('LENS_')) return doPost_lens(e);

    // ── 그 외 (Q10 Auto 스캔 등) → 모두 QSM_Lens_Items 시트로 통합 ──
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName('QSM_Lens_Items');
    if(!sheet){
      const r = lensInitSheets(ss);
      if(!r.ok) return _json({ok:false, error:'QSM_Lens_Items 초기화 실패: '+r.error});
      sheet = ss.getSheetByName('QSM_Lens_Items');
    }

    // updatePrice 액션 처리 (QSM 가격 수정)
    if(data.action==='updatePrice') return _handleQ10UpdatePrice(sheet, data);

    // 일반 스캔 데이터를 23컬럼 매핑
    return _handleQ10ToLensItems(sheet, data);
  }catch(err){return _json({ok:false,error:err.toString()});}
}

// ── Q10 Auto 스캔 데이터 → QSM_Lens_Items 매핑 (24컬럼 A~X) ──
// ★ 배열수식(ARRAYFORMULA) 등 보호된 셀에 setValue 시 에러 → 전체 행 쓰기 중단되던 문제 방지
//   QSM_Lens_Items의 B열(브랜드=C열에서 자동추출) 등 수식 셀은 스킵, 나머지 raw 컬럼만 기록
function _setCell(sheet, r, c, v){
  try { sheet.getRange(r, c).setValue(v); return true; }
  catch(e){ Logger.log('[_setCell] skip r'+r+'c'+c+' (수식/보호셀): '+e.message); return false; }
}

function _handleQ10ToLensItems(sheet, data){
  const ts = new Date().toLocaleString('ko-KR');
  const itemCode  = String(data.qsmGoodsCode || '').trim();
  const sellerCode= String(data.sellerCode || data['판매자상품코드'] || data['SellerCode'] || '').trim();
  const koreanName= String(data['한국어상품명'] || data.koreanName || sellerCode).trim();
  const jaName    = String(data['상품명'] || data['일본어상품명'] || '').trim();
  // ★ v1.6.1: brand 변수 누락 수정 (B열 항상 비어있던 버그)
  const brand     = String(data.brand || data['브랜드명'] || data['브랜드'] || '').trim();
  const brandJa   = String(data.brandJa || data['일본어브랜드'] || '').trim();   // (B)방식: 일본어 브랜드명
  const brandNo   = String(data.brandNo || data['브랜드코드'] || data['BrandNo'] || '').trim();
  const sourceUrl = String(data['소싱처_링크'] || '').trim();

  // 중복 체크
  const lastRow = sheet.getLastRow();
  let targetRow = 0;
  if(lastRow >= 2){
    const aCol = sheet.getRange(2, 1, lastRow-1, 1).getValues().flat().map(String);
    const dCol = sheet.getRange(2, 4, lastRow-1, 1).getValues().flat().map(String);
    for(let i=0; i<aCol.length; i++){
      if((itemCode && aCol[i] === itemCode) || (sourceUrl && dCol[i] === sourceUrl)){
        targetRow = i + 2; break;
      }
    }
  }
  const isUpdate = targetRow > 0;
  if(!isUpdate) targetRow = lastRow + 1;

  const num = v => { const n = Number(String(v||'').replace(/[^\d.\-]/g, '')); return isNaN(n) ? 0 : n; };
  const row = targetRow;

  // A: ItemCode
  _setCell(sheet, row, 1, itemCode);
  // B: 브랜드명 (일본어 브랜드 우선 — (B)방식: 큐렌즈/큐토/모바일 공유, 큐텐 표시용)
  const brandVal = brandJa || brand;
  if(brandVal || !isUpdate) _setCell(sheet, row, 2, brandVal);
  // C: 한국어 상품명 (SellerCode)
  if(koreanName || !isUpdate) _setCell(sheet, row, 3, koreanName);
  // D: 일본어 상품명
  if(jaName || !isUpdate) _setCell(sheet, row, 4, jaName);
  // E: 소싱처 (사이트명)
  const siteName = String(data['소싱처_사이트'] || data['sourcingSite'] || '').trim();
  if(siteName || !isUpdate) _setCell(sheet, row, 5, siteName);
  // F: 소싱처URL
  _setCell(sheet, row, 6, sourceUrl);

  const srcPrice = num(data['소싱판매가_원']);
  if(srcPrice > 0 || !isUpdate) _setCell(sheet, row, 7, srcPrice);  // G

  // ★ 배대지비용(I열) = 국제배송비 + 포장대행지비 + 포장비 + 수출신고비 + 국내배송비
  //   Q10 Auto의 totalKrw 계산과 동일하게 모든 원가를 합산해 마진율 일치
  const intlShip     = num(data['국제배송비_원']);
  const packAgentFee = num(data['포장대행지비_원']);
  const packCost     = num(data['포장비_원']);
  const exportFee    = num(data['수출신고비_원']);
  const domesticShip = num(data['국내배송비_원']);
  const totalExtraCost = intlShip + packAgentFee + packCost + exportFee + domesticShip;
  if(totalExtraCost > 0 || !isUpdate) _setCell(sheet, row, 9, totalExtraCost);  // I(배대지비용)

  const weight = num(data['총중량_kg']);
  if(weight > 0 || !isUpdate) _setCell(sheet, row, 8, weight);  // H

  const carrier = String(data['배송사'] || '').trim();
  if(carrier || !isUpdate) _setCell(sheet, row, 10, carrier);  // J

  // K: 마진율 — 0 또는 빈 값이면 비워두기 (Config B10 사용)
  const margin = num(data['마진율_pct']);
  if(margin > 0 && !isUpdate) _setCell(sheet, row, 11, margin);  // K

  // N: 현재QSM가¥ (14번째)
  const priceJpy = num(data['판매가_엔']);
  if(priceJpy > 0 || !isUpdate) _setCell(sheet, row, 14, priceJpy);

  // O: 고객배송비¥ (15번째) — ★ 신규 행은 0이라도 입력
  const custShipJpy = num(data['고객배송비_엔'] || data['customerShipJpy']);
  if(!isUpdate) {
    _setCell(sheet, row, 15, custShipJpy);
  } else if(custShipJpy > 0) {
    _setCell(sheet, row, 15, custShipJpy);
  }

  // W: 상태 (23번째)
  if(!isUpdate) _setCell(sheet, row, 23, '판매중');

  // X: 메모 (24번째)
  if(!isUpdate){
    const memo = data.registeredAtKr ? `Q10 Auto 등록 ${data.registeredAtKr}` : 'Q10 Auto 스캔';
    _setCell(sheet, row, 24, memo);
  }

  // Y: 마지막 업데이트 (25번째)
  _setCell(sheet, row, 25, ts);

  // ★ v1.6: Z(상품종류) / AA(구성품수) 자동 설정
  const itemType = (data.itemType === 'bundle' || (data.bundleInfo && data.bundleInfo.extras && data.bundleInfo.extras.length))
    ? '기획' : '단품';
  _setCell(sheet, row, 26, itemType);  // Z
  let componentCount = 0;
  if (data.bundleInfo) {
    componentCount = (data.bundleInfo.mainProduct ? 1 : 0) + (data.bundleInfo.extras || []).length;
  }
  _setCell(sheet, row, 27, componentCount); // AA
  // AB(28): 브랜드코드 (BrandNo) — 큐텐 등록/매칭용 (없으면 빈칸)
  if(sheet.getRange(1,28).getValue()==='') _setCell(sheet, 1, 28, '브랜드코드');
  if(brandNo) _setCell(sheet, row, 28, brandNo);

  _insertFormulas15b(sheet, row, row);

  // ★ v1.6: 기획세트면 QSM_Lens_Bundles 시트에도 구성품 저장
  if (itemType === '기획' && data.bundleInfo && itemCode) {
    try {
      const ss = sheet.getParent();
      _saveBundleFromQ10Auto(ss, itemCode, data.bundleInfo);
    } catch (e) {
      console.warn('Bundle save failed: ' + e.message);
    }
  }

  return _json({
    ok: true, row, action: isUpdate ? 'updated' : 'created',
    itemCode, koreanName, jaName,
    itemType, componentCount,
    message: isUpdate ? '기존 행 업데이트' : 'QSM_Lens_Items에 신규 행 추가'
  });
}

// ── Q10 Auto의 가격 업데이트 처리 (QSM_Lens_Items의 L컬럼) ──────
function _handleQ10UpdatePrice(sheet, data){
  try{
    const qsmCode = String(data.qsmCode || '').trim();
    if(!qsmCode) return _json({ok:false, error:'qsmCode 없음'});
    const lastRow = sheet.getLastRow();
    if(lastRow < 2) return _json({ok:false, error:'데이터 없음'});
    const codes = sheet.getRange(2, 1, lastRow-1, 1).getValues().flat().map(String);
    let targetRow = -1;
    for(let i=codes.length-1; i>=0; i--){
      if(codes[i] === qsmCode){ targetRow = i + 2; break; }
    }
    if(targetRow < 0) return _json({ok:false, error:'ItemCode 없음: ' + qsmCode});
    // L컬럼(현재QSM가¥) 업데이트
    sheet.getRange(targetRow, 12).setValue(Number(data.newPriceJpy) || 0);
    // 마지막 업데이트
    sheet.getRange(targetRow, 23).setValue(new Date().toLocaleString('ko-KR'));
    return _json({ok:true, row:targetRow, qsmCode, newPriceJpy:data.newPriceJpy, sheet:'QSM_Lens_Items'});
  }catch(err){return _json({ok:false, error:err.toString()});}
}
function doGet(e){
  try{
    const sheet=_getSheet(); _ensureHeader(sheet);
    return _json({ok:true,sheet:sheet.getName(),rows:Math.max(sheet.getLastRow()-1,0),message:'Q10 Auto 정상 동작 중'});
  }catch(err){return _json({ok:false,error:err.toString()});}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QLens v1.5b 핸들러
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function doPost_lens(e){
  const data=JSON.parse(e.postData.contents),action=data.action;
  if(action==='LENS_PING') return _resp({ok:true,msg:'pong',ts:new Date().toISOString()});
  let ss; try{ss=SpreadsheetApp.openById(SHEET_ID);}catch(err){return _resp({ok:false,error:'SHEET_ID 오류: '+err.message});}
  if(!ss) return _resp({ok:false,error:'시트를 찾을 수 없음'});
  if(action==='LENS_DIAG') return _resp(lensDiag(ss));
  if(action==='LENS_INIT_SHEETS')      return _resp(lensInitSheets(ss));
  if(action==='LENS_FIX_HEADERS')      return _resp(lensFixHeaders(ss));  // ★ 헤더만 갱신
  if(action==='LENS_GET_SHIP_RATE')    return _resp(lensGetShipRate(ss, data.carrier||'', +data.weight||0));
  if(action==='LENS_LOAD_MARGIN_CALC') return _resp(lensLoadMarginCalc(ss));
  // LENS_LOAD_SOURCING 제거 (v1.8.4) — 소싱 시트 기능 폐지, Items 시트에 직접 입력
  if(action==='LENS_KEYWORD_SAVE')     return _resp(lensKeywordSave(ss, data.rows||[], data.productName||''));
  if(action==='LENS_KEYWORD_GET')      return _resp(lensKeywordGet(ss));
  if(action==='LENS_KEYWORD_SET')      return _resp(lensKeywordSet(ss, data.keywords||[]));
  if(action==='LENS_BRAND_PENDING')    return _resp(lensBrandPending(ss, +data.limit||500));
  if(action==='LENS_BRAND_APPLY')      return _resp(lensBrandApply(ss, data.resolved||[], data.unresolved||[]));
  if(action==='LENS_PING')             return _resp({ok:true,msg:'pong',ts:new Date().toISOString()});
  if(action==='LENS_PRODUCT_PUSH')     return _resp({ok:true,msg:'수신됨 (webhook 전용)'});
  // ★ 정산 관리 (v1.6.2) ──────────────────────
  if(action==='LENS_SETTLE_LOAD')      return _resp(lensSettleLoad(ss, data.month||''));
  if(action==='LENS_SETTLE_SAVE_ORDER')return _resp(lensSettleSaveOrder(ss, data.orders||[]));
  if(action==='LENS_TAX_LOAD')         return _resp(lensTaxLoad(ss));
  if(action==='LENS_TAX_SAVE')         return _resp(lensTaxSave(ss, data.invoice||{}));
  if(action==='LENS_TAX_DELETE')       return _resp(lensTaxDelete(ss, data.id||''));
  if(action==='LENS_AGENCY_RATE_LOAD') return _resp(lensAgencyRateLoad(ss));
  if(action==='LENS_AGENCY_RATE_SAVE') return _resp(lensAgencyRateSave(ss, data.rates||[]));
  let sheet=ss.getSheetByName('QSM_Lens_Items');
  if(!sheet){const r=lensInitSheets(ss);if(!r.ok) return _resp(r);sheet=ss.getSheetByName('QSM_Lens_Items');}
  if(!sheet) return _resp({ok:false,error:'QSM_Lens_Items 시트 생성 실패'});
  if(action==='LENS_LOAD') return _resp(lensLoad(sheet));
  if(action==='LENS_SAVE') return _resp(lensSave(sheet,data.items||[]));
  if(action==='LENS_UPDATE_PRICE_ONLY') return _resp(lensUpdatePriceOnly(sheet,data));
  // ★ v1.6 기획세트 (Bundles) ──────────────────────
  if(action==='LENS_BUNDLE_LOAD')   return _resp(lensBundleLoad(ss));
  if(action==='LENS_BUNDLE_SAVE')   return _resp(lensBundleSave(ss, data.qsmCode, data.components||[]));
  if(action==='LENS_BUNDLE_DELETE') return _resp(lensBundleDelete(ss, data.qsmCode));
  if(action==='LENS_BUNDLE_ADD_COMPONENT') return _resp(lensBundleAddComponent(ss, data.qsmCode, data.component||{}));
  return _resp({ok:false,error:'Unknown LENS action: '+action});
}

// ── 사이드패널에서 소싱가만 빠르게 업데이트 ────────────────
function lensUpdatePriceOnly(sheet, data){
  const qsmCode = String(data.qsmCode || '').trim();
  const newPrice = +data.newSourcePriceKrw || 0;
  if(!qsmCode) return {ok:false,error:'qsmCode 없음'};
  if(newPrice <= 0) return {ok:false,error:'유효하지 않은 가격'};
  const lastRow = sheet.getLastRow();
  if(lastRow < 2) return {ok:false,error:'시트가 비어있음'};
  const aCol = sheet.getRange(2,1,lastRow-1,1).getValues();
  for(let i=0;i<aCol.length;i++){
    if(String(aCol[i][0]).trim() === qsmCode){
      const row = i+2;
      sheet.getRange(row,7).setValue(newPrice);  // G열: 소싱가(₩)
      sheet.getRange(row,25).setValue(new Date().toLocaleString('ko-KR')); // Y열: 마지막업데이트
      return {ok:true,row,qsmCode,newPrice};
    }
  }
  return {ok:false,error:'상품 못 찾음: '+qsmCode};
}
function _resp(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}

// ── LENS_LOAD (25컬럼 A~Y v1.5c) ─────────────────────────────────
function lensLoad(sheet){
  const lastRow=sheet.getLastRow(); if(lastRow<2) return {ok:true,items:[]};
  const maxCol=Math.max(sheet.getLastColumn(),29);
  const rows=sheet.getRange(2,1,lastRow-1,maxCol).getValues();
  const items=rows.map(r=>({
    code:            String(r[0]  ||''),  // A ItemCode
    brand:           String(r[1]  ||''),  // B 브랜드명 ★
    sellerCode:      String(r[2]  ||''),  // C 한국어 상품명
    seller:          String(r[2]  ||''),  // C (확장 호환)
    name:            String(r[3]  ||''),  // D 일본어 상품명
    sourcingSite:    String(r[4]  ||''),  // E 소싱처
    sourceUrl:       String(r[5]  ||''),  // F 소싱처URL
    sourcePrice:     +r[6]  ||0,          // G 소싱가₩
    weight:          +r[7]  ||0,          // H 무게kg
    shipFee:         +r[8]  ||0,          // I 배대지비용₩
    carrier:         String(r[9]  ||''),  // J 배송사
    marginRate:      +r[10] ||0,          // K 마진율%
    // L=수수료+포장[식], M=총원가[식] — 읽기만
    curPrice:        +r[13] ||0,          // N 현재QSM가¥
    customerShipJpy: +r[14] ||0,          // O 고객배송비¥
    basePrice:       +r[15] ||0,          // P 평상시가¥[수식값]
    megaponPrice:    +r[16] ||0,          // Q 메가포가¥[수식값]
    megawariPrice:   +r[17] ||0,          // R 메가와리가¥[수식값]
    // S~V: 수익분석[수식값] — 읽기만
    status:          String(r[22] ||'판매중'), // W 상태
    memo:            String(r[23] ||''),  // X 메모
    updatedAt:       String(r[24] ||''),  // Y 마지막업데이트
    itemType:        String(r[25] ||'단품'), // Z 상품종류 ★ v1.6
    componentCount:  +r[26] ||0,          // AA 구성품 수 ★ v1.6
    // r[27]=AB 브랜드코드(읽기 생략) / AC 상품별 수수료율%
    qFeeRate:        +r[28] ||'',          // AC 수수료율% (빈값=기본 수수료) ★ v1.8.3
  })).filter(i=>i.code);
  return {ok:true,items};
}

// ── LENS_FIX_HEADERS: 기존 데이터 보존 + 헤더만 25컬럼으로 강제 갱신 ─
// 시트 구조 변경 시 헤더만 고치고 데이터는 그대로 유지
function lensFixHeaders(ss) {
  try {
    const sheet = ss.getSheetByName('QSM_Lens_Items');
    if (!sheet) return { ok: false, error: 'QSM_Lens_Items 시트를 찾을 수 없습니다' };

    const headers = [
      'ItemCode','브랜드명','한국어 상품명','일본어 상품명',             // A~D
      '소싱처','소싱처URL','소싱가(₩)','무게(kg)','배대지비용(₩)','배송사','마진율(%)', // E~K
      '수수료+포장(₩)','총원가(₩)',                                     // L~M
      '현재QSM가(¥)','고객배송비(¥)',                                   // N~O
      '평상시가(¥)','메가포가(¥)','메가와리가(¥)',                      // P~R
      '판매가원환산(₩)','총비용(₩)','이익(₩)','마진율(%)',              // S~V
      '상태','메모','마지막업데이트',                                    // W~Y
      '상품종류','구성품수','브랜드코드','수수료율(%)',                  // Z~AC ★ v1.8.3
    ];

    // 헤더 행만 덮어쓰기 (데이터 행 유지)
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setFontColor('#fff')
      .setHorizontalAlignment('center').setVerticalAlignment('middle');

    // 색상 갱신
    sheet.getRange('A1:D1').setBackground('#1565c0');
    sheet.getRange('E1:K1').setBackground('#2e7d32');
    sheet.getRange('L1:M1').setBackground('#e65100');
    sheet.getRange('N1:O1').setBackground('#0277bd');
    sheet.getRange('P1:R1').setBackground('#f57c00');
    sheet.getRange('S1:V1').setBackground('#c62828');
    sheet.getRange('W1:Y1').setBackground('#424242');

    // 컬럼 너비
    [110,100,200,260, 80,200,90,60,80,75,62, 105,100, 90,88, 88,85,95, 115,100,90,78, 75,140,120]
      .forEach((w, i) => sheet.setColumnWidth(i + 1, w));

    // ★ 기존 병합 해제 후 고정 (옛 시트 구조 호환)
    try {
      const lastRow = Math.max(sheet.getLastRow(), 2);
      sheet.getRange(1, 1, lastRow, 30).breakApart();
    } catch (e) { /* 병합 없으면 무시 */ }
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(2);

    return { ok: true, msg: '헤더 25컬럼으로 갱신 완료 (데이터 유지)' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── LENS_SAVE (25컬럼 A~Y v1.5c) ─────────────────────────────────
function lensSave(sheet, items){
  if(!items.length) return {ok:false,error:'저장할 데이터 없음'};
  const lastRow=sheet.getLastRow();

  // ★ 기존 행에서 수동 입력값을 ItemCode 기준으로 백업 (브랜드/소싱가/URL 등)
  //    QSM API엔 소싱가·브랜드가 없어 0/공백으로 들어오는데, 통째로 지우면
  //    사용자가 직접 입력한 값이 날아간다 → 빈 값만 기존값으로 채워 보존
  const prev = {};
  if(lastRow>1){
    // ★ AC(29)=수수료율(%) 백업 위해 29컬럼까지 읽음
    const ex=sheet.getRange(2,1,lastRow-1,29).getValues();
    ex.forEach(r=>{
      const c=String(r[0]||'').trim(); if(!c) return;
      prev[c]={ brand:r[1], sellerCode:r[2], name:r[3], sourcingSite:r[4], sourceUrl:r[5],
        sourcePrice:r[6], weight:r[7], shipFee:r[8], carrier:r[9], marginRate:r[10],
        curPrice:r[13], customerShipJpy:r[14], status:r[22], memo:r[23],
        itemType:r[25], componentCount:r[26], qFeeRate:r[28] };
    });
    sheet.getRange(2,1,lastRow-1,27).clearContent();  // A~AA (AB 브랜드코드는 보존)
    sheet.getRange(2,29,lastRow-1,1).clearContent();  // AC 수수료율(%) — 아래서 재기록
  }
  // 들어온 항목의 빈 칸을 기존값으로 백필
  items.forEach(i=>{
    const p=prev[String(i.code||'').trim()]; if(!p) return;
    const keepStr=(v,o)=>(v===undefined||v===null||String(v).trim()==='')?o:v;
    const keepNum=(v,o)=>(!v||+v===0)?(+o||0):v;
    i.brand        = keepStr(i.brand, p.brand);
    i.sellerCode   = keepStr(i.sellerCode || i.koreanName, p.sellerCode);
    i.name         = keepStr(i.name, p.name);
    i.sourcingSite = keepStr(i.sourcingSite, p.sourcingSite);
    i.sourceUrl    = keepStr(i.sourceUrl, p.sourceUrl);
    i.sourcePrice  = keepNum(i.sourcePrice, p.sourcePrice);
    i.weight       = keepNum(i.weight, p.weight);
    i.shipFee      = keepNum(i.shipFee, p.shipFee);
    i.carrier      = keepStr(i.carrier, p.carrier);
    i.marginRate   = keepStr(i.marginRate, p.marginRate);
    if(!i.curPrice)        i.curPrice = +p.curPrice || 0;
    if(!i.customerShipJpy) i.customerShipJpy = +p.customerShipJpy || 0;
    i.memo         = keepStr(i.memo, p.memo);
    i.qFeeRate     = keepStr(i.qFeeRate, p.qFeeRate);  // ★ 상품별 수수료율 보존
  });

  const ts=new Date().toLocaleString('ko-KR');
  const EXCH=`'QSM_Lens_Config'!$B$2`, FEE=`'QSM_Lens_Config'!$B$3`;
  const PON=`'QSM_Lens_Config'!$B$4`,  WR=`'QSM_Lens_Config'!$B$5`;
  const WF=`'QSM_Lens_Config'!$B$6`,   WS=`'QSM_Lens_Config'!$B$7`;
  const PACK=`'QSM_Lens_Config'!$B$8`, VAT=`'QSM_Lens_Config'!$B$9`;
  const DMR=`'QSM_Lens_Config'!$B$10`;

  const rows=items.map((i,idx)=>{
    const r=idx+2;
    // ★ 새 컬럼 배치: G=소싱가 H=무게 I=배대지 K=마진율 N=현재QSM가 O=고객배송비
    const sG=`G${r}`, sH=`H${r}`, sI=`I${r}`, sK=`K${r}`;
    const sN=`N${r}`, sO=`O${r}`, sP=`P${r}`;
    // K열 마진율이 비면 Config B10 사용
    const sKeff=`IF(OR(${sK}="",${sK}=0),${DMR},${sK})`;
    // ★ AC열 상품별 수수료율이 비면 Config B3 기본 수수료 사용 (시트 0.00%p 정합)
    const sFEE=`IF(OR(AC${r}="",AC${r}=0),${FEE},AC${r})`;

    return [
      //── 섹션1 상품 기본 (A~D) ──────────────────────────────────
      i.code       ||'',   // A: ItemCode
      i.brand      ||'',   // B: 브랜드명 ★ (이전 U→B)
      i.sellerCode ||i.koreanName||'', // C: 한국어 상품명
      i.name       ||'',   // D: 일본어 상품명

      //── 섹션2 소싱 입력 (E~K) ──────────────────────────────────
      i.sourcingSite||'',  // E: 소싱처 (예: 올리브영, 네이버)
      i.sourceUrl  ||'',   // F: 소싱처URL
      i.sourcePrice||0,    // G: 소싱가(₩)
      i.weight     ||0,    // H: 무게(kg)
      i.shipFee    ||0,    // I: 배대지비용(₩)
      i.carrier    ||'',   // J: 배송사
      i.marginRate ||'',   // K: 마진율(%) — 빈 값이면 Config B10

      //── 섹션3 비용 소계 (L~M) [수식] ──────────────────────────
      // L: 수수료+포장 = (현재QSM가¥ or 평상시가¥ + 고객배송비¥) × 환율 × 수수료% + 포장비
      //    ★ 수수료는 매출 전체(판매가+고객배송비) 기준 — 큐렌즈 화면과 통일
      `=IFERROR(IF(AND(${sN}=0,${sP}=""),"",(IF(${sN}>0,${sN},IFERROR(VALUE(${sP}),0))+${sO})*${EXCH}*(${sFEE})/100+${PACK}),"")`,
      // M: 총원가 = 소싱가 + 수수료+포장
      `=IFERROR(IF(${sG}=0,"",${sG}+L${r}),"")`,

      //── 섹션4 QSM 현재 (N~O) ───────────────────────────────────
      i.curPrice       ||0, // N: 현재QSM가(¥)
      i.customerShipJpy||0, // O: 고객배송비(¥)

      //── 섹션5 추천 판매가 (P~R) [수식] ────────────────────────
      // P: 평상시가 = (소싱가+배대지)/환율×(1+마진율)/(1-수수료) → 10¥올림
      `=IFERROR(IF(${sG}=0,"",ROUNDUP((${sG}+${sI})/${EXCH}*(1+${sKeff}/100)/(1-(${sFEE})/100)/10)*10),"")`,
      // Q: 메가포가
      `=IFERROR(IF(${sP}="","",ROUNDUP(${sP}*(1-(${sFEE})/100)/(1-(${sFEE})/100-${PON}/100)/10)*10),"")`,
      // R: 메가와리가
      `=IFERROR(IF(${sP}="","",ROUNDUP(${sP}*(1-(${sFEE})/100)/((1-${WR}/100)*(1-${WF}/100)-${WS}/100)/10)*10),"")`,

      //── 섹션6 수익 분석 (S~V) [수식] ──────────────────────────
      // S: 판매가원환산 = (현재QSM가 or 평상시가 + 고객배송비) × 환율
      `=IFERROR(IF(AND(${sN}=0,${sP}=""),"",(IF(${sN}>0,${sN},IFERROR(VALUE(${sP}),0))+${sO})*${EXCH}),"")`,
      // T: 총비용 = 소싱가 + 배대지 + 수수료+포장
      `=IFERROR(IF(${sG}=0,"",${sG}+${sI}+L${r}),"")`,
      // U: 이익 = 판매가원환산 - 총비용 (★ 부가세환급 제외 — 큐렌즈 화면 마진율과 0.00%p 일치)
      `=IFERROR(IF(S${r}="","",S${r}-T${r}),"")`,
      // V: 마진율 = 이익/판매가원환산×100
      `=IFERROR(IF(U${r}="","",U${r}/S${r}*100),"")`,

      //── 섹션7 메타 (W~Y) ───────────────────────────────────────
      i.status ||'판매중', // W: 상태
      i.memo   ||'',       // X: 메모
      ts,                  // Y: 마지막업데이트
      //── 섹션8 상품 분류 (Z~AA) ★ v1.6 ─────────────────────────
      i.itemType === 'bundle' ? '기획' : '단품', // Z: 상품종류
      +i.componentCount || 0,                     // AA: 구성품 수
    ];
  });
  if(rows.length) sheet.getRange(2,1,rows.length,27).setValues(rows);
  // ★ AC(29) 상품별 수수료율(%) — 메인 블록(A~AA)과 분리 기록 (AB 브랜드코드 보존)
  if(rows.length){
    if(sheet.getRange(1,29).getValue()==='') _setCell(sheet, 1, 29, '수수료율(%)');
    const feeRows = items.map(i => [ (+i.qFeeRate > 0) ? +i.qFeeRate : '' ]);
    sheet.getRange(2,29,feeRows.length,1).setValues(feeRows);
  }
  return {ok:true,saved:rows.length,count:rows.length};
}

// ── LENS_LOAD_MARGIN_CALC ────────────────────────────────────────
function lensLoadMarginCalc(ss){
  const calcSheet=ss.getSheetByName('마진계산기ver3');
  if(!calcSheet) return {ok:false,error:'마진계산기ver3 시트를 찾을 수 없음'};
  const lastRow=calcSheet.getLastRow(); if(lastRow<2) return {ok:true,rows:[],config:null};
  const maxRow=Math.min(lastRow,600);
  const rawVals=calcSheet.getRange(1,1,maxRow,Math.max(calcSheet.getLastColumn(),40)).getValues();
  let config=null;
  for(let i=1;i<Math.min(rawVals.length,5);i++){
    const row=rawVals[i]; const exch=parseFloat(row[37]),fee=parseFloat(row[38]),mgn=parseFloat(row[39]);
    if(!isNaN(exch)&&exch>5){config={exchangeRate:exch,qFeeRate:!isNaN(fee)?fee:0.13,targetMargin:!isNaN(mgn)?mgn:0.10,vatRate:0.09};break;}
  }
  const rows=rawVals.map(row=>row.map(cell=>{
    if(cell===null||cell===undefined||cell==='') return '';
    if(cell instanceof Date){const m=('0'+(cell.getMonth()+1)).slice(-2),d=('0'+cell.getDate()).slice(-2);return m+'-'+d;}
    return String(cell);
  }));
  return {ok:true,rows,config};
}

// ── LENS_INIT_SHEETS (v1.5b) ─────────────────────────────────────
function lensInitSheets(ss){
  try{
    // QSM_Lens_Config
    let cfg=ss.getSheetByName('QSM_Lens_Config');
    if(!cfg) cfg=ss.insertSheet('QSM_Lens_Config'); else cfg.clear();
    cfg.getRange('A1:B10').setValues([
      ['⚙️ QLens 설정 v1.5b', ''],
      ['환율 (1¥ = ?₩)',          9.5],  // B2
      ['큐텐 수수료 (%)',          13],   // B3 ★ 통일: 기본 13%
      ['메가포 포인트율 (%)',      10],   // B4
      ['메가와리 할인율 (%)',      20],   // B5
      ['메가와리 행사수수료 (%)', 13],   // B6
      ['메가와리 셀러부담 (%)',   10],   // B7
      ['국내 포장비 (₩, 고정)',   500],  // B8
      ['부가세 환급율 (%)',         9],   // B9
      ['기본 마진율 (%, I열 비울 시)', 10],  // B10 ★ 평상시 기본 마진율 10%
    ]);
    cfg.getRange('A1:B1').merge().setBackground('#1a73e8').setFontColor('#fff').setFontWeight('bold').setHorizontalAlignment('center').setFontSize(13);
    cfg.getRange('A2:A10').setFontWeight('bold').setBackground('#f8fafc');
    cfg.getRange('B2:B10').setBackground('#fff8e1').setHorizontalAlignment('right')
      .setBorder(true,true,true,true,false,false,'#fbc02d',SpreadsheetApp.BorderStyle.SOLID);
    cfg.setColumnWidth(1,240); cfg.setColumnWidth(2,100);
    cfg.getRange('A12').setValue(
      '💡 B열 수식 참조 위치\n'+
      '  B2:환율  B3:수수료%  B4:메가포%\n'+
      '  B5:메가와리할인%  B6:행사수수료%  B7:셀러부담%\n'+
      '  B8:포장비₩  B9:부가세환급율%  B10:기본마진율%\n\n'+
      '수수료+포장비 = (판매가¥ + 고객배송비¥) × 환율 × 수수료% + 포장비\n'+
      '이익 = 판매가원환산 - 총비용  (부가세환급 제외 — 큐렌즈 화면 마진율과 일치)\n'+
      '※ 부가세환급(소싱가×9%)은 실제 돌려받지만 보수적 마진 표시를 위해 마진율에서 제외'
    ).setFontStyle('italic').setFontColor('#64748b').setFontSize(10).setWrap(true);
    cfg.getRange('A12:B12').merge(); cfg.setRowHeight(12,95);

    // QSM_Lens_Items (25컬럼 A~Y) ─────────────────────────────────
    let sheet=ss.getSheetByName('QSM_Lens_Items');
    if(!sheet) sheet=ss.insertSheet('QSM_Lens_Items');

    // ★ 사용자 요청 컬럼 순서 (2025.05.21 확정)
    const headers=[
      'ItemCode','브랜드명','한국어 상품명','일본어 상품명',             // A~D 섹션1
      '소싱처','소싱처URL','소싱가(₩)','무게(kg)','배대지비용(₩)','배송사','마진율(%)', // E~K 섹션2
      '수수료+포장(₩)','총원가(₩)',                                     // L~M 섹션3 수식
      '현재QSM가(¥)','고객배송비(¥)',                                   // N~O 섹션4
      '평상시가(¥)','메가포가(¥)','메가와리가(¥)',                      // P~R 섹션5 수식
      '판매가원환산(₩)','총비용(₩)','이익(₩)','마진율(%)',              // S~V 섹션6 수식
      '상태','메모','마지막업데이트',                                    // W~Y 섹션7
      '상품종류','구성품수',                                              // Z~AA ★ v1.6 NEW
      '브랜드코드','수수료율(%)',                                          // AB~AC ★ v1.8.3 NEW
    ];
    sheet.getRange(1,1,1,headers.length).setValues([headers])
      .setFontWeight('bold').setFontColor('#fff').setHorizontalAlignment('center').setVerticalAlignment('middle');
    sheet.setRowHeight(1,38);
    // ★ 기존 병합 해제 후 고정 (옛 시트 구조 호환)
    try {
      const lastRow = Math.max(sheet.getLastRow(), 2);
      sheet.getRange(1, 1, lastRow, 30).breakApart();
    } catch (e) { /* 병합 없으면 무시 */ }
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(2);

    // 컬럼 너비 (25개 A~Y)
    [110,100,200,260,  // A~D
     80,200,90,60,80,75,62,  // E~K
     105,100,  // L~M
     90,88,    // N~O
     88,85,95, // P~R
     115,100,90,78, // S~V
     75,140,120, // W~Y
     75,70,      // Z~AA (상품종류/구성품수)
     90,72       // AB~AC (브랜드코드/수수료율%) ★ v1.8.3
    ].forEach((w,i)=>sheet.setColumnWidth(i+1,w));

    // 헤더 색상 (섹션별)
    sheet.getRange('A1:D1').setBackground('#1565c0');  // 섹션1 상품기본 (파랑)
    sheet.getRange('E1:K1').setBackground('#2e7d32');  // 섹션2 소싱입력 (초록)
    sheet.getRange('L1:M1').setBackground('#e65100');  // 섹션3 비용소계 (주황)
    sheet.getRange('N1:O1').setBackground('#0277bd');  // 섹션4 QSM현재 (파랑)
    sheet.getRange('P1:R1').setBackground('#f57c00');  // 섹션5 추천가 (주황)
    sheet.getRange('S1:V1').setBackground('#c62828');  // 섹션6 수익분석 (빨강)
    sheet.getRange('W1:Y1').setBackground('#424242');  // 섹션7 메타 (회색)

    // 배경색 (섹션별)
    sheet.getRange('E2:K1000').setBackground('#f0fff4');  // 소싱입력 연초록
    sheet.getRange('L2:M1000').setBackground('#fff8e1').setFontColor('#666').setFontStyle('italic');
    sheet.getRange('N2:O1000').setBackground('#e3f2fd');  // QSM현재 연파랑
    sheet.getRange('P2:R1000').setBackground('#fff3e0').setFontWeight('bold').setNumberFormat('"¥"#,##0');
    sheet.getRange('S2:S1000').setBackground('#fce4ec').setNumberFormat('"₩"#,##0');
    sheet.getRange('T2:T1000').setBackground('#fce4ec').setNumberFormat('"₩"#,##0');
    sheet.getRange('U2:U1000').setBackground('#e8f5e9').setFontWeight('bold').setNumberFormat('"₩"#,##0');
    sheet.getRange('V2:V1000').setBackground('#e8f5e9').setFontWeight('bold').setNumberFormat('0.0"%"');

    // 숫자 포맷
    sheet.getRange('G2:G1000').setNumberFormat('"₩"#,##0');   // 소싱가
    sheet.getRange('H2:H1000').setNumberFormat('0.0"kg"');     // 무게
    sheet.getRange('I2:I1000').setNumberFormat('"₩"#,##0');   // 배대지비용
    sheet.getRange('K2:K1000').setNumberFormat('0.0"%"');      // 마진율
    sheet.getRange('L2:M1000').setNumberFormat('"₩"#,##0');   // 수수료+포장, 총원가
    sheet.getRange('N2:O1000').setNumberFormat('"¥"#,##0');   // 현재QSM가, 고객배송비
    sheet.getRange('AC2:AC1000').setNumberFormat('0.0"%"');   // ★ v1.8.3 상품별 수수료율

    // 마진율(V) 조건부 서식 ─────────────────────────────────────
    const rules=[
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextEqualTo('ja').setBackground('#e3f2fd')
        .setRanges([sheet.getRange('D2:D1000')]).build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenNumberLessThan(0).setBackground('#ffcdd2').setFontColor('#c62828')
        .setRanges([sheet.getRange('V2:V1000')]).build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenNumberBetween(0,5).setBackground('#fff9c4').setFontColor('#f57f17')
        .setRanges([sheet.getRange('V2:V1000')]).build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenNumberGreaterThan(20).setBackground('#c8e6c9').setFontColor('#1b5e20')
        .setRanges([sheet.getRange('V2:V1000')]).build(),
    ];
    sheet.setConditionalFormatRules(rules);

    // 마진율 K열 유효성 검사 (0~100)
    sheet.getRange('K2:K1000').setDataValidation(
      SpreadsheetApp.newDataValidation().requireNumberBetween(0,100).setAllowInvalid(false).build()
    );

    // 기존 데이터 수식 재삽입
    const lastRow=sheet.getLastRow();
    if(lastRow>1) _insertFormulas15b(sheet,2,lastRow);

    // ★ v1.8.4: QSM_Lens_Sourcing(소싱 표준양식) 제거 — 사용자가 QSM_Lens_Items에 직접 입력
    _removeSourcingSheet(ss);
    _createShipRatesSheet(ss);  // ★ NEW: 배대지 요율표
    _createBundlesSheet(ss);
    _createKeywordSheet(ss);    // ★ 병합: 키워드 관리 시트(14컬럼)
    _createGuideSheet(ss);      // ★ v1.8.4: 📖 사용설명서 시트 (맨 앞)

    return {ok:true,msg:'시트 세팅 완료 (v1.8.4 / 사용설명서 + Items + Config + ShipRates + Bundles + Keywords)',sheets:['📖 사용설명서','QSM_Lens_Config','QSM_Lens_Items','QSM_Lens_ShipRates','QSM_Lens_Bundles','QSM_Lens_Keywords']};
  }catch(err){return {ok:false,error:'시트 세팅 실패: '+err.message};}
}

// ★ v1.8.4: 소싱 시트(QSM_Lens_Sourcing) 삭제 — 기능 폐지
function _removeSourcingSheet(ss){
  try { var s = ss.getSheetByName('QSM_Lens_Sourcing'); if(s) ss.deleteSheet(s); }
  catch(e){ Logger.log('[_removeSourcingSheet] '+e.message); }
}

// ★ v1.8.4: 📖 사용설명서 시트 (맨 앞) — 비전공자가 직접 데이터 입력할 수 있게 안내
function _createGuideSheet(ss){
  try {
    var name = '📖 사용설명서';
    var sheet = ss.getSheetByName(name);
    if (sheet) sheet.clear(); else sheet = ss.insertSheet(name, 0);
    ss.setActiveSheet(sheet); ss.moveActiveSheet(1);   // 항상 맨 앞으로

    sheet.setColumnWidth(1, 240);
    sheet.setColumnWidth(2, 600);

    var rows = [
      ['📖 QLens(큐렌즈) 사용설명서', ''],
      ['이 스프레드시트는?', '큐렌즈 크롬 확장과 자동으로 동기화되는 데이터 저장소입니다. 확장에서 [시트 불러오기 / 저장]을 누르면 아래 시트들과 데이터를 주고받습니다. 표를 직접 수정해도 됩니다.'],
      ['── 시트 안내 ──', ''],
      ['QSM_Lens_Items', '★ 메인 시트. 상품·소싱가·마진이 모두 여기 있습니다. 직접 입력 가능 (아래 "직접 입력하는 법" 참고).'],
      ['QSM_Lens_Config', '환율·큐텐수수료(B3)·기본마진율(B10) 등 설정값. 숫자만 바꾸면 전체 계산에 반영됩니다.'],
      ['QSM_Lens_Bundles', '기획세트(번들) 구성품 목록. 확장에서 자동 관리됩니다.'],
      ['QSM_Lens_ShipRates', '무게별 국제배송(배대지) 요율표.'],
      ['QSM_Lens_Keywords', '키워드 수집 결과 (선택 기능).'],
      ['── QSM_Lens_Items 직접 입력하는 법 ──', '아래 "입력" 컬럼에만 값을 넣으세요. 주황/빨강 컬럼(L·M·P~V)은 자동 계산되는 수식이니 건드리지 마세요.'],
      ['A  ItemCode', '큐텐 상품코드(11자리). QSM에서 불러오면 자동으로 채워집니다. 직접 추가도 가능.'],
      ['B  브랜드명(일본어)', '큐텐 표기 브랜드명. 비워도 됩니다.'],
      ['C  한국어 상품명', '내가 알아보는 상품명.'],
      ['D  일본어 상품명', '큐텐에 등록된 상품명.'],
      ['E  소싱처', '예: 올리브영, 네이버, 쿠팡.'],
      ['F  소싱처 URL', '구매 페이지 주소.'],
      ['G  소싱가(₩)  ★필수', '한국에서 사오는 가격(원화). 이 값이 있어야 마진이 계산됩니다.'],
      ['H  무게(kg)', '예: 0.3. 비우면 0.5로 계산. 국제배송비 자동 산출에 사용.'],
      ['I  배대지비용(₩)', '국제배송비(원화). 비우면 무게로 자동 계산.'],
      ['J  배송사', '예: KSE, MIR REG.'],
      ['K  마진율(%)', '목표 마진율. 비우면 Config 기본값(10%) 적용.'],
      ['N  현재 QSM 판매가(¥)', '큐텐에 현재 올라간 판매가(엔). 있으면 그 가격 기준으로 마진을 보여줍니다.'],
      ['O  고객배송비(¥)', '고객이 내는 배송비(엔). 보통 0.'],
      ['AC 수수료율(%)', '상품별 큐텐 수수료. 비우면 Config 기본값(13%) 적용.'],
      ['── 자동 계산 (수정 금지) ──', 'L 수수료+포장 / M 총원가 / P 평상시가 / Q 메가포가 / R 메가와리가 / S 판매가환산 / T 총비용 / U 이익 / V 마진율 — 위 입력값으로 자동 계산됩니다.'],
      ['── 기존 마진계산기 데이터 옮기기 ──', ''],
      ['1단계', '마진계산기에서 상품코드·상품명·소싱가·무게·마진율 등을 복사합니다.'],
      ['2단계', 'QSM_Lens_Items 탭의 알맞은 컬럼(위 표 참고) 2행부터 [값만 붙여넣기]로 붙입니다.  (붙여넣기 단축키: Ctrl+Shift+V → "값만")'],
      ['3단계', '큐렌즈 확장에서 [🔧 시트 자동 세팅]을 한 번 누르면 수식이 채워져 자동 계산됩니다.'],
      ['⚠️ 주의', '수식 컬럼(L·M·P~V)에는 값을 붙여넣지 마세요. 수식이 덮어써져 계산이 멈춥니다. 실수했으면 [🔧 시트 자동 세팅]을 다시 누르면 복구됩니다.'],
      ['💡 팁', 'ItemCode가 같으면 확장이 같은 행을 알아서 갱신합니다. 직접 추가한 행도 확장의 [📥 시트 불러오기]로 화면에 나타납니다.'],
    ];
    sheet.getRange(1,1,rows.length,2).setValues(rows);

    // 서식
    sheet.getRange('A1:B1').merge().setBackground('#1a73e8').setFontColor('#fff')
      .setFontWeight('bold').setFontSize(15).setHorizontalAlignment('center');
    sheet.setRowHeight(1, 40);
    sheet.getRange(1,1,rows.length,1).setFontWeight('bold');
    sheet.getRange(1,1,rows.length,2).setVerticalAlignment('middle').setWrap(true);
    for (var i=0;i<rows.length;i++){
      if (String(rows[i][0]).indexOf('──')===0) {
        sheet.getRange(i+1,1,1,2).setBackground('#e8eefc').setFontColor('#1a3a7a').setFontWeight('bold');
      }
    }
    // G(필수) 줄 강조
    sheet.setFrozenRows(1);
    return {ok:true};
  } catch(e){ Logger.log('[_createGuideSheet] '+e.message); return {ok:false,error:e.message}; }
}

// ─────────────────────────────────────────────────────────────────
// QSM_Lens_ShipRates — 배대지 요율표 (사용자 입력 + G열 자동 매칭)
// ─────────────────────────────────────────────────────────────────
// 컬럼:
//   A: 배송사 (예: KSE, MIR REG, EMS)
//   B: 최소 무게(kg)
//   C: 최대 무게(kg)
//   D: 배송비(₩)
//   E: 메모 (선택)
//
// 사용 예:
//   KSE | 0.0 | 0.5 | 4500 | 소형
//   KSE | 0.5 | 1.0 | 6500 | 중형
//   KSE | 1.0 | 2.0 | 9500 | 대형
//
// QSM_Lens_Items의 G열은 F(무게) + H(배송사) 조합으로 자동 매칭
// ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════
// QSM_Lens_ShipRates v2 — 배대지 요율표 (KSE/MIR REG/KSE LIGHT 등)
// ═══════════════════════════════════════════════════════════════════
//
// 구조:
//  [1행] ── 유류할증료 Config ────────────────────────────────────
//    A1: "🛢 유류할증료(항공, ¥/kg)" | B1: 216 (매달 1일 업데이트)
//    C1: "🛢 유류할증료(선편, ¥/kg)" | D1: 100
//    E1: "💱 기본 환율(₩/¥)"         | F1: 9.55
//    G1: "📅 마지막 업데이트"         | H1: 날짜
//  [2행] ── 컬럼 헤더 ────────────────────────────────────────────
//    A: 배송사 | B: KG상한 | C: 기본요금(¥) | D: 유류할증(¥) | E: 합계(¥) | F: 환율 | G: 최종(₩) | H: 메모
//  [3행~] ── 실제 요율 데이터 ────────────────────────────────────
//    D열(유류할증): =B열(무게) × $B$1 (항공) 또는 × $D$1 (선편)
//    E열(합계¥): =C+D
//    G열(최종₩): =E × F
//
// 사용:
//  매달 1일 → B1(항공 유류할증료/kg) + D1(선편) 값만 변경 → 전체 자동 재계산
// ═══════════════════════════════════════════════════════════════════
function _createShipRatesSheet(ss) {
  let sheet = ss.getSheetByName('QSM_Lens_ShipRates');
  const isNew = !sheet;
  if (isNew) sheet = ss.insertSheet('QSM_Lens_ShipRates');
  else sheet.clear();

  // ── 1행: 월별 업데이트 Config (원화로 입력) ──────────────────
  // ★ 유류할증료는 배대지 회사에서 원화(₩/kg)로 공지받음 → 그대로 입력
  sheet.getRange('A1').setValue('🛢 유류할증료 항공(₩/kg)');
  sheet.getRange('B1').setValue(2060).setFontWeight('bold').setFontSize(13)
    .setBackground('#fff3cd').setFontColor('#856404').setNumberFormat('"₩"#,##0');
  sheet.getRange('C1').setValue('🛢 유류할증료 선편(₩/kg)');
  sheet.getRange('D1').setValue(1000).setFontWeight('bold').setFontSize(13)
    .setBackground('#fff3cd').setFontColor('#856404').setNumberFormat('"₩"#,##0');
  sheet.getRange('E1').setValue('💱 환율(₩/¥)');
  sheet.getRange('F1').setValue(9.55).setFontWeight('bold').setFontSize(13)
    .setBackground('#cfe2ff').setFontColor('#084298').setNumberFormat('0.00');
  sheet.getRange('G1').setValue('📅 마지막업데이트');
  sheet.getRange('H1').setValue(new Date().toLocaleDateString('ko-KR'))
    .setFontColor('#6c757d');

  // Config 행 서식
  sheet.getRange('A1:H1').setFontSize(11).setVerticalAlignment('middle');
  sheet.getRange('A1').setBackground('#343a40').setFontColor('#fff');
  sheet.getRange('C1').setBackground('#343a40').setFontColor('#fff');
  sheet.getRange('E1').setBackground('#343a40').setFontColor('#fff');
  sheet.getRange('G1').setBackground('#343a40').setFontColor('#fff');
  sheet.setRowHeight(1, 44);

  // 안내 박스
  sheet.getRange('A2:H2').merge().setValue(
    '⚠️ 매달 1일: B1(항공 유류할증/kg, ₩) · D1(선편 유류할증/kg, ₩) · F1(환율) 만 수정하면 G열(최종₩) 전체 자동 재계산됩니다. 배대지 회사 공지를 원화 그대로 입력하세요.'
  ).setBackground('#d1ecf1').setFontColor('#0c5460').setFontSize(10)
   .setFontStyle('italic').setHorizontalAlignment('left').setWrap(true);
  sheet.setRowHeight(2, 28);

  // ── 3행: 컬럼 헤더 ─────────────────────────────────────────────
  const HEADERS = ['배송사','KG상한','기본요금(¥)','유류할증(₩)','기본요금환산(₩)','환율','최종금액(₩)','메모'];
  sheet.getRange(3, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setFontColor('#fff').setBackground('#212529')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.setRowHeight(3, 34);
  sheet.setFrozenRows(3);

  // 컬럼 너비
  [110, 80, 90, 90, 90, 70, 110, 160].forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  // ── 4행~: 실제 요율 데이터 ─────────────────────────────────────
  // 유류할증 판별: "선편" 포함 → $D$1, 아니면 $B$1
  // D열 수식: =B{r} * IF(REGEXMATCH(A{r},"선편"),$D$1,$B$1)
  // E열 수식: =C{r}+D{r}
  // G열 수식: =E{r}*F{r}

  const rawData = [
    // [배송사, KG상한, 기본요금JPY, 메모]
    ['KSE', 0.10, 490, ''],
    ['KSE', 0.25, 560, ''],
    ['KSE', 0.50, 620, ''],
    ['KSE', 0.75, 700, ''],
    ['KSE', 1.00, 750, ''],
    ['KSE', 1.25, 780, ''],
    ['KSE', 1.50, 830, ''],
    ['KSE', 1.75, 880, ''],
    ['KSE', 2.00, 940, ''],
    ['KSE', 2.50, 1090, ''],
    ['KSE', 3.00, 1197, ''],
    ['KSE', 3.50, 1302, ''],
    ['KSE', 4.00, 1402, ''],
    ['KSE', 4.50, 1498, ''],
    ['KSE', 5.00, 1597, ''],
    ['KSE', 5.50, 1806, ''],
    ['KSE', 6.00, 1906, ''],
    ['KSE', 6.50, 2003, ''],
    ['KSE', 7.00, 2099, ''],
    ['KSE', 7.50, 2195, ''],
    ['KSE', 8.00, 2291, ''],
    ['KSE', 8.50, 2397, ''],
    ['KSE', 9.00, 2494, ''],
    ['KSE', 9.50, 2590, ''],
    ['KSE', 10.00, 2684, ''],
    ['KSE', 10.50, 2965, ''],
    ['KSE', 11.00, 3061, ''],
    ['KSE', 11.50, 3164, ''],
    ['KSE', 12.00, 3264, ''],
    ['KSE', 12.50, 3360, ''],
    ['KSE', 13.00, 3456, ''],
    ['KSE', 13.50, 3552, ''],
    ['KSE', 14.00, 3652, ''],
    ['KSE', 14.50, 3748, ''],
    ['KSE', 15.00, 3845, ''],
    ['KSE', 15.50, 3941, ''],
    ['KSE', 16.00, 4037, ''],
    ['KSE', 16.50, 4143, ''],
    ['KSE', 17.00, 4239, ''],
    ['KSE', 17.50, 4335, ''],
    ['KSE', 18.00, 4432, ''],
    ['KSE', 18.50, 4532, ''],
    ['KSE', 19.00, 4628, ''],
    ['KSE', 19.50, 4724, ''],
    ['KSE', 20.00, 4820, ''],
    ['KSE', 20.50, 4195, '주의: 원본 데이터 확인 필요'],
    ['KSE', 21.00, 5290, ''],
    ['KSE', 21.50, 5393, ''],
    ['KSE', 22.00, 5489, ''],
    ['KSE', 22.50, 5585, ''],
    ['KSE', 23.00, 5685, ''],
    ['KSE', 23.50, 5781, ''],
    ['KSE', 24.00, 5878, ''],
    ['KSE', 24.50, 5974, ''],
    ['KSE', 25.00, 6074, ''],
    ['KSE', 25.50, 6170, ''],
    ['KSE', 26.00, 6266, ''],
    ['KSE', 26.50, 6368, ''],
    ['KSE', 27.00, 6468, ''],
    ['KSE', 27.50, 6565, ''],
    ['KSE', 28.00, 6661, ''],
    ['KSE', 28.50, 6916, ''],
    ['KSE', 29.00, 6857, ''],
    ['KSE', 29.50, 6553, '주의: 원본 데이터 확인 필요'],
    ['KSE', 30.00, 7049, ''],
    // KSE 선편
    ['KSE 선편', 0.10, 450, ''],
    ['KSE 선편', 0.25, 525, ''],
    ['KSE 선편', 0.50, 590, ''],
    ['KSE 선편', 0.75, 680, ''],
    ['KSE 선편', 1.00, 720, ''],
    ['KSE 선편', 1.25, 760, ''],
    ['KSE 선편', 1.50, 810, ''],
    ['KSE 선편', 1.75, 860, ''],
    ['KSE 선편', 2.00, 910, ''],
    ['KSE 선편', 2.50, 950, ''],
    ['KSE 선편', 3.00, 1020, ''],
    ['KSE 선편', 3.50, 1110, ''],
    ['KSE 선편', 4.00, 1170, ''],
    ['KSE 선편', 4.50, 1230, ''],
    ['KSE 선편', 5.00, 1340, ''],
    ['KSE 선편', 5.50, 1460, ''],
    ['KSE 선편', 6.00, 1530, ''],
    ['KSE 선편', 6.50, 1610, ''],
    ['KSE 선편', 7.00, 1680, ''],
    ['KSE 선편', 7.50, 1760, ''],
    ['KSE 선편', 8.00, 1830, ''],
    ['KSE 선편', 8.50, 1900, ''],
    ['KSE 선편', 9.00, 1980, ''],
    ['KSE 선편', 9.50, 2040, ''],
    ['KSE 선편', 10.00, 2120, ''],
    ['KSE 선편', 10.50, 2190, ''],
    ['KSE 선편', 11.00, 2270, ''],
    ['KSE 선편', 11.50, 2340, ''],
    ['KSE 선편', 12.00, 2420, ''],
    ['KSE 선편', 12.50, 2490, ''],
    ['KSE 선편', 13.00, 2560, ''],
    ['KSE 선편', 13.50, 2640, ''],
    ['KSE 선편', 14.00, 2720, ''],
    ['KSE 선편', 14.50, 2780, ''],
    ['KSE 선편', 15.00, 2860, ''],
    ['KSE 선편', 15.50, 2940, ''],
    ['KSE 선편', 16.00, 3020, ''],
    ['KSE 선편', 16.50, 3110, ''],
    ['KSE 선편', 17.00, 3180, ''],
    ['KSE 선편', 17.50, 3260, ''],
    ['KSE 선편', 18.00, 3350, ''],
    ['KSE 선편', 18.50, 3430, ''],
    ['KSE 선편', 19.00, 3510, ''],
    ['KSE 선편', 19.50, 3600, ''],
    ['KSE 선편', 20.00, 3680, ''],
    ['KSE 선편', 20.50, 3760, ''],
    ['KSE 선편', 21.00, 3830, ''],
    ['KSE 선편', 21.50, 3930, ''],
    ['KSE 선편', 22.00, 3980, ''],
    ['KSE 선편', 22.50, 4050, ''],
    ['KSE 선편', 23.00, 4120, ''],
    ['KSE 선편', 23.50, 4270, ''],
    ['KSE 선편', 24.00, 4300, ''],
    ['KSE 선편', 24.50, 4330, ''],
    ['KSE 선편', 25.00, 4400, ''],
    ['KSE 선편', 25.50, 4460, ''],
    ['KSE 선편', 26.00, 4550, ''],
    ['KSE 선편', 26.50, 4630, ''],
    ['KSE 선편', 27.00, 4700, ''],
    ['KSE 선편', 27.50, 4770, ''],
    ['KSE 선편', 28.00, 4840, ''],
    ['KSE 선편', 28.50, 4910, ''],
    ['KSE 선편', 29.00, 4960, ''],
    ['KSE 선편', 29.50, 4980, ''],
    ['KSE 선편', 30.00, 5090, ''],
    // KSE LIGHT 항공
    ['KSE LIGHT 항공', 0.10, 350, ''],
    ['KSE LIGHT 항공', 0.25, 400, ''],
    ['KSE LIGHT 항공', 0.50, 460, ''],
    ['KSE LIGHT 항공', 0.75, 490, ''],
    ['KSE LIGHT 항공', 1.00, 530, ''],
    // KSE LIGHT 선편
    ['KSE LIGHT 선편', 0.10, 350, ''],
    ['KSE LIGHT 선편', 0.25, 400, ''],
    ['KSE LIGHT 선편', 0.50, 460, ''],
    ['KSE LIGHT 선편', 0.75, 490, ''],
    ['KSE LIGHT 선편', 1.00, 530, ''],
    // MIR REG
    ['MIR REG', 0.10, 465, ''],
    ['MIR REG', 0.30, 530, ''],
    ['MIR REG', 0.50, 600, ''],
    ['MIR REG', 0.70, 650, ''],
    ['MIR REG', 1.00, 702, ''],
    ['MIR REG', 1.50, 810, ''],
    ['MIR REG', 2.00, 905, ''],
    ['MIR REG', 2.50, 1055, ''],
    ['MIR REG', 3.00, 1165, ''],
    ['MIR REG', 3.50, 1285, ''],
    ['MIR REG', 4.00, 1390, ''],
    ['MIR REG', 4.50, 1490, ''],
    ['MIR REG', 5.00, 1588, ''],
    ['MIR REG', 5.50, 1819, ''],
    ['MIR REG', 6.00, 1920, ''],
    ['MIR REG', 6.50, 2021, ''],
    ['MIR REG', 7.00, 2122, ''],
    ['MIR REG', 7.50, 2223, ''],
    ['MIR REG', 8.00, 2324, ''],
    ['MIR REG', 8.50, 2425, ''],
    ['MIR REG', 9.00, 2526, ''],
    ['MIR REG', 9.50, 2627, ''],
    ['MIR REG', 10.00, 2728, ''],
  ];

  const dataStart = 4;
  const rowCount  = rawData.length;

  // A~C, H열: 직접 값
  const staticData = rawData.map(r => [r[0], r[1], r[2], '', '', '', '', r[3]]);
  sheet.getRange(dataStart, 1, rowCount, 8).setValues(staticData);

  // D열: 유류할증(₩) = KG상한 × 유류할증료_per_kg(₩) (선편 여부 분기)
  // E열: 기본요금(₩) = 기본요금¥ × 환율
  // G열: 최종(₩) = 기본요금₩ + 유류할증₩
  for (let i = 0; i < rowCount; i++) {
    const r = dataStart + i;
    const surcharge_ref = `IF(REGEXMATCH(A${r},"선편"),$D$1,$B$1)`;
    sheet.getRange(r, 4).setFormula(`=ROUND(B${r}*${surcharge_ref},0)`);    // D: 유류할증₩
    sheet.getRange(r, 5).setFormula(`=ROUND(C${r}*$F$1,0)`);                // E: 기본요금₩환산
    sheet.getRange(r, 6).setFormula(`=$F$1`);                               // F: 환율
    sheet.getRange(r, 7).setFormula(`=E${r}+D${r}`);                        // G: 최종₩
  }

  // 배송사별 색상 구분
  const carrierColors = {
    'KSE':            '#fff9e6',
    'KSE 선편':       '#e6f4ff',
    'KSE LIGHT 항공': '#e6ffe6',
    'KSE LIGHT 선편': '#f0ffe0',
    'MIR REG':        '#ffe6f0',
  };
  rawData.forEach((r, i) => {
    const row = dataStart + i;
    const color = carrierColors[r[0]] || '#ffffff';
    sheet.getRange(row, 1, 1, 8).setBackground(color);
  });

  // 숫자 포맷
  const dEnd = dataStart + rowCount - 1;
  sheet.getRange(`B${dataStart}:B${dEnd}`).setNumberFormat('0.00"kg"');
  sheet.getRange(`C${dataStart}:C${dEnd}`).setNumberFormat('"¥"#,##0');  // 기본요금만 ¥
  sheet.getRange(`D${dataStart}:E${dEnd}`).setNumberFormat('"₩"#,##0');  // 유류할증·환산
  sheet.getRange(`F${dataStart}:F${dEnd}`).setNumberFormat('0.00');
  sheet.getRange(`G${dataStart}:G${dEnd}`).setNumberFormat('"₩"#,##0');

  // H열 메모 주의색
  rawData.forEach((r, i) => {
    if (r[3] && r[3].includes('주의')) {
      sheet.getRange(dataStart + i, 1, 1, 8).setBackground('#ffe0e0');
    }
  });

  sheet.setFrozenRows(3);
  // ★ setFrozenColumns 제거: A2:H2가 병합 → 컬럼 고정 시 에러 발생
  // 대신 헤더 행(1~3)만 고정하면 충분함

  return sheet;
}

// ─────────────────────────────────────────────────────────────────
// LENS_LOAD_SHIPRATES — ShipRates 시트에서 배송비 조회
// carrier: 배송사명 (KSE, MIR REG, KSE 선편, ...)
// weightKg: 무게 (kg)
// 반환: 해당 무게 구간의 최종₩ 금액
// ─────────────────────────────────────────────────────────────────
function lensGetShipRate(ss, carrier, weightKg) {
  const sheet = ss.getSheetByName('QSM_Lens_ShipRates');
  if (!sheet) return { ok: false, error: 'ShipRates 시트 없음' };

  const lastRow = sheet.getLastRow();
  if (lastRow < 4) return { ok: false, error: '요율 데이터 없음' };

  const rows = sheet.getRange(4, 1, lastRow - 3, 7).getValues();
  const carrierLower = (carrier || '').toLowerCase().replace(/\s+/g, '');

  // 배송사 매칭 + KG상한이 무게 이상인 첫 번째 행
  for (const row of rows) {
    const rowCarrier = (String(row[0] || '')).toLowerCase().replace(/\s+/g, '');
    const kgLimit    = +row[1] || 0;
    const finalKrw   = +row[6] || 0;

    if (rowCarrier === carrierLower && kgLimit >= weightKg && finalKrw > 0) {
      return {
        ok: true,
        carrier: row[0],
        kgLimit,
        baseJpy:    +row[2] || 0,
        surchargeJpy: +row[3] || 0,
        totalJpy:   +row[4] || 0,
        rate:       +row[5] || 9.55,
        finalKrw,
      };
    }
  }

  return { ok: false, error: `${carrier} / ${weightKg}kg 매칭 요율 없음` };
}


// ── LENS_DIAG: 웹훅이 실제로 보는 스프레드시트 상태 진단 ──────────
// ── (B) 브랜드 일괄 해결 — 미해결 행 조회 ─────────────────────────
//   QSM_Lens_Items에서 B열(브랜드명)이 비어있는 행을 반환 (수동 입력/미해결 행)
function lensBrandPending(ss, limit){
  const sheet=ss.getSheetByName('QSM_Lens_Items');
  if(!sheet) return {ok:false,error:'QSM_Lens_Items 시트 없음'};
  const lastRow=sheet.getLastRow();
  if(lastRow<2) return {ok:true,rows:[]};
  // A(itemCode), B(brand), C(koreanName) 한 번에 읽기
  const vals=sheet.getRange(2,1,lastRow-1,3).getValues();
  const rows=[];
  for(let i=0;i<vals.length;i++){
    const itemCode=String(vals[i][0]||'').trim();
    const brand=String(vals[i][1]||'').trim();
    const koreanName=String(vals[i][2]||'').trim();
    if(!brand && koreanName){               // 브랜드 비었고 상품명은 있는 행만
      rows.push({row:i+2, itemCode:itemCode, koreanName:koreanName});
      if(rows.length>=limit) break;
    }
  }
  return {ok:true, rows:rows, total:rows.length};
}

// ── (B) 브랜드 일괄 해결 — 결과 기록 + 미해결 빨간 표시 ────────────
//   resolved: [{row, brandJa, brandNo}]  /  unresolved: [row, ...]
function lensBrandApply(ss, resolved, unresolved){
  const sheet=ss.getSheetByName('QSM_Lens_Items');
  if(!sheet) return {ok:false,error:'QSM_Lens_Items 시트 없음'};
  if(sheet.getRange(1,28).getValue()==='') _setCell(sheet,1,28,'브랜드코드');
  let okCnt=0, redCnt=0;
  (resolved||[]).forEach(r=>{
    if(!r||!r.row) return;
    const ja=String(r.brandJa||'').trim();
    if(ja){ _setCell(sheet, r.row, 2, ja); sheet.getRange(r.row,2).setFontColor('#000000'); okCnt++; }
    if(r.brandNo) _setCell(sheet, r.row, 28, String(r.brandNo).trim());
  });
  (unresolved||[]).forEach(row=>{
    if(!row) return;
    // 빨간 글씨로 표시 — 사용자 수동 확인 필요 (값은 비워두거나 기존 유지)
    try{ sheet.getRange(row,2).setFontColor('#ff0000'); redCnt++; }catch(e){}
  });
  return {ok:true, resolved:okCnt, flagged:redCnt};
}

function lensDiag(ss) {
  const info = { ok:true, sheetId: SHEET_ID, spreadsheetName: '', sheets: {} };
  try { info.spreadsheetName = ss.getName(); } catch(e) {}
  ['QSM_Lens_Items','QSM_Lens_Config','QSM_Lens_Bundles','QSM_Lens_ShipRates'].forEach(nm=>{
    const sh = ss.getSheetByName(nm);
    info.sheets[nm] = sh ? Math.max(sh.getLastRow()-1,0) : '시트없음';
  });
  return info;
}


// ── 수식 삽입 헬퍼 v1.5b ─────────────────────────────────────────
function _insertFormulas15b(sheet,startRow,endRow){
  const EXCH=`'QSM_Lens_Config'!$B$2`, FEE=`'QSM_Lens_Config'!$B$3`;
  const PON=`'QSM_Lens_Config'!$B$4`,  WR=`'QSM_Lens_Config'!$B$5`;
  const WF=`'QSM_Lens_Config'!$B$6`,   WS=`'QSM_Lens_Config'!$B$7`;
  const PACK=`'QSM_Lens_Config'!$B$8`, VAT=`'QSM_Lens_Config'!$B$9`;
  const DMR=`'QSM_Lens_Config'!$B$10`;

  for(let r=startRow;r<=endRow;r++){
    // ★ 25컬럼 배치: G=소싱가 I=배대지 K=마진율 N=현재QSM가 O=고객배송비 P=평상시가
    const Keff=`IF(OR(K${r}="",K${r}=0),${DMR},K${r})`;
    // ★ AC열 상품별 수수료율이 비면 Config B3 기본 수수료 사용
    const Feff=`IF(OR(AC${r}="",AC${r}=0),${FEE},AC${r})`;
    // L: 수수료+포장 — 수수료는 매출 전체(판매가+고객배송비 O) 기준
    sheet.getRange(`L${r}`).setFormula(
      `=IFERROR(IF(AND(N${r}=0,P${r}=""),"",(IF(N${r}>0,N${r},IFERROR(VALUE(P${r}),0))+O${r})*${EXCH}*(${Feff})/100+${PACK}),"")`);
    // M: 총원가
    sheet.getRange(`M${r}`).setFormula(
      `=IFERROR(IF(G${r}=0,"",G${r}+L${r}),"")`);
    // P: 평상시가
    sheet.getRange(`P${r}`).setFormula(
      `=IFERROR(IF(G${r}=0,"",ROUNDUP((G${r}+I${r})/${EXCH}*(1+${Keff}/100)/(1-(${Feff})/100)/10)*10),"")`);
    // Q: 메가포가
    sheet.getRange(`Q${r}`).setFormula(
      `=IFERROR(IF(P${r}="","",ROUNDUP(P${r}*(1-(${Feff})/100)/(1-(${Feff})/100-${PON}/100)/10)*10),"")`);
    // R: 메가와리가
    sheet.getRange(`R${r}`).setFormula(
      `=IFERROR(IF(P${r}="","",ROUNDUP(P${r}*(1-(${Feff})/100)/((1-${WR}/100)*(1-${WF}/100)-${WS}/100)/10)*10),"")`);
    // S: 판매가원환산
    sheet.getRange(`S${r}`).setFormula(
      `=IFERROR(IF(AND(N${r}=0,P${r}=""),"",(IF(N${r}>0,N${r},IFERROR(VALUE(P${r}),0))+O${r})*${EXCH}),"")`);
    // T: 총비용
    sheet.getRange(`T${r}`).setFormula(
      `=IFERROR(IF(G${r}=0,"",G${r}+I${r}+L${r}),"")`);
    // U: 이익 = 판매가원환산 - 총비용 (★ 부가세환급 제외 — 큐렌즈 화면과 일치)
    sheet.getRange(`U${r}`).setFormula(
      `=IFERROR(IF(S${r}="","",S${r}-T${r}),"")`);
    // V: 마진율
    sheet.getRange(`V${r}`).setFormula(
      `=IFERROR(IF(U${r}="","",U${r}/S${r}*100),"")`);
  }
}

// ─────────────────────────────────────────────────────────────────
// LENS_KEYWORD_SAVE — 키워드 수집 결과를 QSM_Lens_Keywords 시트에 저장
// ─────────────────────────────────────────────────────────────────
// QSM_Lens_Keywords 컬럼 (8컬럼 A~H):
//   A: 키워드   B: 카테고리(한국어)   C: 카테고리(일본어)
//   D: 언어(ja/ko/en)   E: 소싱 상품명   F: 소싱처URL
//   G: 등록일시   H: 카테고리Key
// ─────────────────────────────────────────────────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 키워드 관리 (QSM_Lens_Keywords, 14컬럼) — v1.7.0 신버전 통합
//   LENS_KEYWORD_SAVE / LENS_KEYWORD_GET / LENS_KEYWORD_SET
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function lensKeywordSave(ss, rows, productName) {
  if (!rows || !rows.length) return { ok: false, error: '저장할 키워드 없음' };
  try {
    var sheet = ss.getSheetByName('QSM_Lens_Keywords');
    if (!sheet) sheet = _createKeywordSheet(ss);

    // ── 시트 기존 데이터 로드 ──
    var lastRow = sheet.getLastRow();
    var existIds = new Set();
    var existKws = new Set();  // 정규화된 키워드 텍스트 (소문자 + 공백 제거)
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, 2).getValues()
        .forEach(function(r) {
          var id = String(r[0] || '').trim();
          var kw = String(r[1] || '').trim().toLowerCase().replace(/\s+/g, '');
          if (id) existIds.add(id);
          if (kw) existKws.add(kw);
        });
    }

    var ts = new Date().toLocaleString('ko-KR');
    var newRows       = [];
    var skippedIds    = 0;   // ID 중복
    var skippedKws    = 0;   // 키워드 텍스트 중복
    var skippedBatch  = 0;   // 배치 내 중복

    // 배치 내 중복 체크용 Set
    var batchKws = new Set();

    rows.forEach(function(r) {
      var id = String(r.id || '').trim();
      var kw = String(r.ja || r.keyword || '').trim();
      if (!kw) return;

      var kwNorm = kw.toLowerCase().replace(/\s+/g, '');

      // 단계1: 배치 내 중복
      if (batchKws.has(kwNorm)) { skippedBatch++; return; }
      batchKws.add(kwNorm);

      // 단계2: 시트 ID 중복
      if (id && existIds.has(id)) { skippedIds++; return; }

      // 단계3: 시트 키워드 텍스트 중복
      if (existKws.has(kwNorm)) { skippedKws++; return; }

      // 통과 → 존재 Set에 추가 (이후 행에서 재중복 방지)
      if (id) existIds.add(id);
      existKws.add(kwNorm);

      var tagsRaw = Array.isArray(r.tags) ? r.tags.join(', ') : String(r.tags || '');
      newRows.push([
        id || ('kp_' + new Date().getTime() + '_' + Math.random().toString(36).slice(2,5)),
        kw,
        r.ko || r.kwKo || '',
        r.en || '',
        r.bigCat || r.categoryKo || r.categoryKey || '',
        r.midCat || r.productType || '',
        tagsRaw,
        r.role || 'sub',
        Number(r.freq)     || 1,
        Number(r.seoCount) || 0,
        r.fav ? 'TRUE' : 'FALSE',
        Number(r.usedCount) || 0,
        r.sourceUrl || '',
        r.savedAt || r.createdAt || ts,
      ]);
    });

    var totalSkipped = skippedIds + skippedKws + skippedBatch;
    if (newRows.length === 0) {
      return {
        ok: true, saved: 0,
        skipped: totalSkipped,
        skippedIds: skippedIds, skippedKws: skippedKws, skippedBatch: skippedBatch,
        msg: '모두 중복 — 신규 없음 (시트중복:' + skippedKws + ', ID중복:' + skippedIds + ', 배치중복:' + skippedBatch + ')',
      };
    }

    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 14).setValues(newRows);

    // 역할별 A열 색상
    var ROLE_BG = { main: '#c8e6c9', sub: '#e3f2fd', recommended: '#fff9c4' };
    var startRow = sheet.getLastRow() - newRows.length + 1;
    newRows.forEach(function(r, i) {
      sheet.getRange(startRow + i, 1).setBackground(ROLE_BG[r[7]] || '#f5f5f5');
    });

    return {
      ok: true,
      saved:         newRows.length,
      skipped:       totalSkipped,
      skippedIds:    skippedIds,
      skippedKws:    skippedKws,
      skippedBatch:  skippedBatch,
    };
  } catch(err) {
    return { ok: false, error: err.toString() };
  }
}

function lensKeywordGet(ss) {
  try {
    var sheet = ss.getSheetByName('QSM_Lens_Keywords');
    if (!sheet || sheet.getLastRow() <= 1)
      return { ok: true, keywords: [], msg: 'QSM_Lens_Keywords 시트가 비어있습니다' };

    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 14).getValues();
    var keywords = data
      .filter(function(r) { return String(r[1] || '').trim(); })
      .map(function(r) {
        var tagsStr = String(r[6] || '').trim();
        return {
          id:         String(r[0] || '').trim(),
          ja:         String(r[1] || '').trim(),
          ko:         String(r[2] || '').trim(),
          en:         String(r[3] || '').trim(),
          bigCat:     String(r[4] || '').trim(),
          midCat:     String(r[5] || '').trim(),
          tags:       tagsStr ? tagsStr.split(/[,，、]+/).map(function(t){return t.trim();}).filter(Boolean) : [],
          role:       String(r[7] || 'sub').trim(),
          freq:       Number(r[8]) || 1,
          seoCount:   Number(r[9]) || 0,
          fav:        String(r[10]).toLowerCase() === 'true',
          usedCount:  Number(r[11]) || 0,
          sourceUrl:  String(r[12] || '').trim(),
          createdAt:  String(r[13] || '').trim(),
          category:   String(r[5] || r[4] || '').trim(),
          productType:String(r[5] || '').trim(),
        };
      });

    return { ok: true, keywords: keywords, count: keywords.length };
  } catch(err) {
    return { ok: false, error: err.toString() };
  }
}

function lensKeywordSet(ss, keywords) {
  if (!Array.isArray(keywords))
    return { ok: false, error: 'keywords 배열 필요' };
  try {
    var sheet = ss.getSheetByName('QSM_Lens_Keywords');
    if (!sheet) sheet = _createKeywordSheet(ss);

    var lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 14).clearContent().clearFormat();

    if (!keywords.length) return { ok: true, saved: 0, msg: '빈 배열 — 기존 데이터 삭제됨' };

    var ts = new Date().toLocaleString('ko-KR');
    var rows = keywords.map(function(r) {
      var tagsRaw = Array.isArray(r.tags) ? r.tags.join(', ') : (String(r.tags || ''));
      return [
        r.id || ('kp_' + Date.now() + '_' + Math.random().toString(36).slice(2,5)),
        r.ja || r.keyword || '',
        r.ko || '',
        r.en || '',
        r.bigCat || r.category || '',
        r.midCat || r.productType || '',
        tagsRaw,
        r.role || 'sub',
        Number(r.freq) || 1,
        Number(r.seoCount) || 0,
        r.fav ? 'TRUE' : 'FALSE',
        Number(r.usedCount) || 0,
        r.sourceUrl || '',
        r.createdAt || r.savedAt || ts,
      ];
    });

    sheet.getRange(2, 1, rows.length, 14).setValues(rows);

    var ROLE_BG = { main: '#c8e6c9', sub: '#e3f2fd', recommended: '#fff9c4' };
    rows.forEach(function(r, i) {
      sheet.getRange(2 + i, 1).setBackground(ROLE_BG[r[7]] || '#f5f5f5');
    });

    return { ok: true, saved: rows.length };
  } catch(err) {
    return { ok: false, error: err.toString() };
  }
}

function _createKeywordSheet(ss) {
  var sheet = ss.getSheetByName('QSM_Lens_Keywords');
  if (sheet) return sheet;

  sheet = ss.insertSheet('QSM_Lens_Keywords');
  var headers = [
    'ID', '키워드(일본어)', '한국어', '영어',
    '대카테고리', '중카테고리', '속성태그',
    '역할', '빈도수', 'SEO검색수', '즐겨찾기', '사용횟수',
    '수집출처URL', '저장일시',
  ];
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setFontColor('#fff')
    .setBackground('#7c3aed')
    .setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);

  [100, 160, 100, 80, 130, 120, 180, 70, 60, 80, 75, 65, 200, 130]
    .forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });

  sheet.getRange('I2:I1000').setNumberFormat('#,##0');
  sheet.getRange('J2:J1000').setNumberFormat('#,##0');
  sheet.getRange('L2:L1000').setNumberFormat('#,##0');

  sheet.getRange('H2:H1000').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['main', 'sub', 'recommended'], true)
      .setAllowInvalid(false).build()
  );
  sheet.getRange('K2:K1000').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['TRUE', 'FALSE'], true)
      .setAllowInvalid(false).build()
  );

  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('main').setBackground('#c8e6c9').setFontWeight('bold')
      .setRanges([sheet.getRange('H2:H1000')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('sub').setBackground('#e3f2fd')
      .setRanges([sheet.getRange('H2:H1000')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('recommended').setBackground('#fff9c4')
      .setRanges([sheet.getRange('H2:H1000')]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('TRUE').setBackground('#fffde7').setFontWeight('bold')
      .setRanges([sheet.getRange('K2:K1000')]).build(),
  ]);

  return sheet;
}


// ═══════════════════════════════════════════════════════════════════
// ★ v1.6 — QSM_Lens_Bundles : 기획세트 구성품 관리 시트
// ═══════════════════════════════════════════════════════════════════
//
// 구조 (10컬럼 A~J):
//   A: 세트QSM코드  (Items 시트 A열과 매칭)
//   B: 순번         (1, 2, 3...)
//   C: 구성품명
//   D: 소싱처       (올리브영, 네이버 등)
//   E: 소싱URL
//   F: 가격(₩)
//   G: 무게(kg)
//   H: 수량         (기본 1)
//   I: 증정여부     ('증정' / '')
//   J: 메모
//
// 사용:
//  - QLens 대시보드에서 행 펼침 시 자동 로드
//  - Q10 Auto 콤보 등록 시 자동 행 생성
//  - 시트에서 직접 편집 가능 (열려있는 행 추가/수정)
// ═══════════════════════════════════════════════════════════════════
function _createBundlesSheet(ss) {
  let sheet = ss.getSheetByName('QSM_Lens_Bundles');
  const isNew = !sheet;
  if (isNew) sheet = ss.insertSheet('QSM_Lens_Bundles');

  // 헤더 (이미 있으면 덮어쓰지 않음)
  if (isNew || sheet.getLastRow() === 0) {
    const headers = ['세트QSM코드','순번','구성품명','소싱처','소싱URL','가격(₩)','무게(kg)','수량','증정여부','메모'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setFontColor('#fff').setBackground('#1f6feb')
      .setHorizontalAlignment('center').setVerticalAlignment('middle');
    sheet.setRowHeight(1, 36);
    sheet.setFrozenRows(1);
    // 컬럼 폭
    sheet.setColumnWidth(1, 130);  // A 세트코드
    sheet.setColumnWidth(2, 50);   // B 순번
    sheet.setColumnWidth(3, 280);  // C 구성품명
    sheet.setColumnWidth(4, 100);  // D 소싱처
    sheet.setColumnWidth(5, 320);  // E URL
    sheet.setColumnWidth(6, 100);  // F 가격
    sheet.setColumnWidth(7, 80);   // G 무게
    sheet.setColumnWidth(8, 60);   // H 수량
    sheet.setColumnWidth(9, 80);   // I 증정
    sheet.setColumnWidth(10, 200); // J 메모
    // 포맷
    sheet.getRange('F2:F1000').setNumberFormat('₩#,##0');
    sheet.getRange('G2:G1000').setNumberFormat('0.00');
    sheet.getRange('H2:H1000').setNumberFormat('0');
    sheet.getRange('I2:I1000').setHorizontalAlignment('center');
    sheet.getRange('A:J').setVerticalAlignment('middle');
    sheet.getRange('A:A').setHorizontalAlignment('center');
    sheet.getRange('B:B').setHorizontalAlignment('center');
  }
  return sheet;
}

// ── LENS_BUNDLE_LOAD : 모든 구성품 로드 ─────────────────────
//   반환 { ok, bundles: { '1154945768': [{name, url, ...}, ...], ... } }
function lensBundleLoad(ss) {
  const sheet = ss.getSheetByName('QSM_Lens_Bundles') || _createBundlesSheet(ss);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, bundles: {} };
  const rows = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  const bundles = {};
  rows.forEach(r => {
    const code = String(r[0] || '').trim();
    if (!code) return;
    if (!bundles[code]) bundles[code] = [];
    bundles[code].push({
      seq:     +r[1] || 0,
      name:    String(r[2] || ''),
      site:    String(r[3] || ''),
      url:     String(r[4] || ''),
      price:   +r[5] || 0,
      weight:  +r[6] || 0,
      qty:     +r[7] || 1,
      isFree:  String(r[8] || '').includes('증정'),
      memo:    String(r[9] || ''),
    });
  });
  // 각 세트의 구성품을 순번 기준 정렬
  Object.keys(bundles).forEach(code => {
    bundles[code].sort((a, b) => a.seq - b.seq);
  });
  return { ok: true, bundles, totalCodes: Object.keys(bundles).length };
}

// ── LENS_BUNDLE_SAVE : 특정 세트의 모든 구성품을 통째로 교체 ──
function lensBundleSave(ss, qsmCode, components) {
  const code = String(qsmCode || '').trim();
  if (!code) return { ok: false, error: '세트QSM코드 누락' };
  const sheet = ss.getSheetByName('QSM_Lens_Bundles') || _createBundlesSheet(ss);
  // 1) 기존 해당 세트 행 모두 삭제
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const aCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    // 뒤에서부터 삭제 (인덱스 안정성)
    for (let i = aCol.length - 1; i >= 0; i--) {
      if (String(aCol[i][0]).trim() === code) {
        sheet.deleteRow(i + 2);
      }
    }
  }
  // 2) 새 행 추가
  if (!components.length) return { ok: true, saved: 0, msg: '모든 구성품 삭제됨' };
  const rows = components.map((c, idx) => [
    code,
    idx + 1,
    c.name || '',
    c.site || '',
    c.url || '',
    +c.price || 0,
    +c.weight || 0,
    +c.qty || 1,
    c.isFree ? '증정' : '',
    c.memo || '',
  ]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 10).setValues(rows);

  // 3) Items 시트의 Z(상품종류), AA(구성품수) 갱신
  _updateItemBundleMeta(ss, code, 'bundle', components.length);
  return { ok: true, saved: rows.length };
}

// ── LENS_BUNDLE_DELETE : 세트 전체 구성품 삭제 → 단품으로 환원 ──
function lensBundleDelete(ss, qsmCode) {
  const code = String(qsmCode || '').trim();
  if (!code) return { ok: false, error: '세트QSM코드 누락' };
  const sheet = ss.getSheetByName('QSM_Lens_Bundles');
  if (!sheet) return { ok: true, deleted: 0 };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, deleted: 0 };
  const aCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let cnt = 0;
  for (let i = aCol.length - 1; i >= 0; i--) {
    if (String(aCol[i][0]).trim() === code) {
      sheet.deleteRow(i + 2);
      cnt++;
    }
  }
  _updateItemBundleMeta(ss, code, 'single', 0);
  return { ok: true, deleted: cnt };
}

// ── LENS_BUNDLE_ADD_COMPONENT : 단일 구성품 추가 (사이드패널용) ──
function lensBundleAddComponent(ss, qsmCode, component) {
  const code = String(qsmCode || '').trim();
  if (!code) return { ok: false, error: '세트QSM코드 누락' };
  if (!component || !component.name) return { ok: false, error: '구성품명 누락' };
  const sheet = ss.getSheetByName('QSM_Lens_Bundles') || _createBundlesSheet(ss);

  // 현재 해당 세트의 마지막 순번 조회
  const lastRow = sheet.getLastRow();
  let nextSeq = 1;
  let total = 0;
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    data.forEach(r => {
      if (String(r[0]).trim() === code) {
        total++;
        if (+r[1] >= nextSeq) nextSeq = +r[1] + 1;
      }
    });
  }
  sheet.appendRow([
    code,
    nextSeq,
    component.name || '',
    component.site || '',
    component.url || '',
    +component.price || 0,
    +component.weight || 0,
    +component.qty || 1,
    component.isFree ? '증정' : '',
    component.memo || '',
  ]);
  _updateItemBundleMeta(ss, code, 'bundle', total + 1);
  return { ok: true, seq: nextSeq, total: total + 1 };
}

// ── 헬퍼: Items 시트의 Z(상품종류), AA(구성품수) 동기화 ──────
function _updateItemBundleMeta(ss, qsmCode, type, count) {
  const sheet = ss.getSheetByName('QSM_Lens_Items');
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const aCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < aCol.length; i++) {
    if (String(aCol[i][0]).trim() === qsmCode) {
      const row = i + 2;
      sheet.getRange(row, 26).setValue(type === 'bundle' ? '기획' : '단품'); // Z
      sheet.getRange(row, 27).setValue(count || 0);                          // AA
      return;
    }
  }
}

// ── Q10 Auto webhook 페이로드의 bundleInfo 처리 (자동 시트 생성) ──
// _lensPush_QioAuto 내부에서 호출됨
function _saveBundleFromQ10Auto(ss, itemCode, bundleInfo) {
  if (!itemCode || !bundleInfo) return { ok: false };
  // mainProduct + extras 합쳐서 구성품 배열 생성
  const components = [];
  if (bundleInfo.mainProduct) {
    components.push({
      name: bundleInfo.mainProduct.name,
      site: bundleInfo.mainProduct.site,
      url: bundleInfo.mainProduct.url,
      price: +bundleInfo.mainProduct.price || 0,
      weight: +bundleInfo.mainProduct.weight || 0,
      qty: +bundleInfo.mainProduct.qty || 1,
      isFree: false,
      memo: '메인 (Q10 등록)',
    });
  }
  (bundleInfo.extras || []).forEach(ex => {
    components.push({
      name: ex.name,
      site: ex.site,
      url: ex.url,
      price: +ex.price || 0,
      weight: +ex.weight || 0,
      qty: +ex.qty || 1,
      isFree: false,
      memo: 'Q10 콤보 추가',
    });
  });
  if (!components.length) return { ok: false };
  return lensBundleSave(ss, itemCode, components);
}


/* ════════════════════════════════════════════════════════
   정산 관리 (v1.6.2) — 3개 시트 연동
   - QSM_Lens_Settle      : 주문별 손익
   - QSM_Lens_Tax         : 세금계산서(매입 증빙)
   - QSM_Lens_AgencyRate  : 대행지 구간 요율표
   ════════════════════════════════════════════════════════ */

// ── 시트 헬퍼 ──
function _settleSheet(ss) {
  let s = ss.getSheetByName('QSM_Lens_Settle');
  if (!s) {
    s = ss.insertSheet('QSM_Lens_Settle');
    s.appendRow(['주문번호','주문일','월','상품명','상품코드','seller_code',
                 '판매가(엔)','판매가(원)','수수료(원)','소싱가(원)',
                 '배송대행비(원)','포장대행비(원)','부가세환급(원)','순이익(원)','메모']);
    s.getRange(1,1,1,15).setBackground('#22223a').setFontColor('#fff').setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}
function _taxSheet(ss) {
  let s = ss.getSheetByName('QSM_Lens_Tax');
  if (!s) {
    s = ss.insertSheet('QSM_Lens_Tax');
    s.appendRow(['ID','발행일','월','거래처','구분','공급가액(원)','부가세(원)','합계(원)','품목','메모']);
    s.getRange(1,1,1,10).setBackground('#22223a').setFontColor('#fff').setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}
function _agencyRateSheet(ss) {
  let s = ss.getSheetByName('QSM_Lens_AgencyRate');
  if (!s) {
    s = ss.insertSheet('QSM_Lens_AgencyRate');
    s.appendRow(['대행지','종류','무게상한(kg)','요금(원)','메모']);
    s.getRange(1,1,1,5).setBackground('#22223a').setFontColor('#fff').setFontWeight('bold');
    s.setFrozenRows(1);
    // 기본 구간요율 예시 (배송대행)
    [['기본배송','배송',0.5,1500,'~0.5kg'],
     ['기본배송','배송',1.0,2000,'~1kg'],
     ['기본배송','배송',2.0,3000,'~2kg'],
     ['기본배송','배송',5.0,5000,'~5kg'],
     ['기본포장','포장',999,500,'건당 포장비']].forEach(r => s.appendRow(r));
  }
  return s;
}

// ── 대행지 구간요율 ──
function lensAgencyRateLoad(ss) {
  try {
    const s = _agencyRateSheet(ss);
    const last = s.getLastRow();
    if (last < 2) return { ok: true, rates: [] };
    const vals = s.getRange(2,1,last-1,5).getValues();
    const rates = vals.filter(r => r[0]).map(r => ({
      agency: r[0], type: r[1], maxWeight: Number(r[2])||0,
      fee: Number(r[3])||0, memo: r[4]||''
    }));
    return { ok: true, rates };
  } catch (e) { return { ok:false, error:'요율 로드 실패: '+e.message }; }
}
function lensAgencyRateSave(ss, rates) {
  try {
    const s = _agencyRateSheet(ss);
    const last = s.getLastRow();
    if (last > 1) s.getRange(2,1,last-1,5).clearContent();
    if (rates.length) {
      const rows = rates.map(r => [r.agency||'', r.type||'배송', +r.maxWeight||0, +r.fee||0, r.memo||'']);
      s.getRange(2,1,rows.length,5).setValues(rows);
    }
    return { ok: true, count: rates.length };
  } catch (e) { return { ok:false, error:'요율 저장 실패: '+e.message }; }
}

// 무게로 구간요금 찾기 (type=배송/포장)
function _findAgencyFee(rates, type, weight) {
  const cand = rates.filter(r => r.type === type).sort((a,b)=>a.maxWeight-b.maxWeight);
  for (const r of cand) { if (weight <= r.maxWeight) return r.fee; }
  return cand.length ? cand[cand.length-1].fee : 0;
}

// ── 주문별 손익 저장 (배열 일괄) ──
function lensSettleSaveOrder(ss, orders) {
  try {
    const s = _settleSheet(ss);
    const last = s.getLastRow();
    // 기존 주문번호 맵 (중복 방지 — 같은 주문번호면 업데이트)
    const existing = {};
    if (last > 1) {
      const ono = s.getRange(2,1,last-1,1).getValues();
      ono.forEach((v,i) => { if(v[0]) existing[String(v[0])] = i+2; });
    }
    let added=0, updated=0;
    orders.forEach(o => {
      const row = [
        o.orderNo||'', o.orderDate||'', (o.orderDate||'').slice(0,7),
        o.goodsName||'', o.itemCode||'', o.sellerCode||'',
        +o.priceJpy||0, +o.priceKrw||0, +o.feeKrw||0, +o.sourcingKrw||0,
        +o.shipAgencyKrw||0, +o.packAgencyKrw||0, +o.vatRefundKrw||0,
        +o.profitKrw||0, o.memo||''
      ];
      const key = String(o.orderNo||'');
      if (key && existing[key]) { s.getRange(existing[key],1,1,15).setValues([row]); updated++; }
      else { s.appendRow(row); added++; }
    });
    return { ok:true, added, updated };
  } catch (e) { return { ok:false, error:'손익 저장 실패: '+e.message }; }
}

// ── 정산 로드 (월 필터 + 요약) ──
function lensSettleLoad(ss, month) {
  try {
    const s = _settleSheet(ss);
    const last = s.getLastRow();
    let orders = [];
    if (last >= 2) {
      const vals = s.getRange(2,1,last-1,15).getValues();
      orders = vals.filter(r => r[0]).map(r => ({
        orderNo:r[0], orderDate: r[1] instanceof Date ? r[1].toISOString().slice(0,10):String(r[1]),
        month:r[2], goodsName:r[3], itemCode:r[4], sellerCode:r[5],
        priceJpy:+r[6]||0, priceKrw:+r[7]||0, feeKrw:+r[8]||0, sourcingKrw:+r[9]||0,
        shipAgencyKrw:+r[10]||0, packAgencyKrw:+r[11]||0, vatRefundKrw:+r[12]||0,
        profitKrw:+r[13]||0, memo:r[14]||''
      }));
    }
    if (month) orders = orders.filter(o => String(o.month)===month || String(o.orderDate).startsWith(month));

    // 세금계산서 매입 합 (월 필터)
    const tax = lensTaxLoad(ss).invoices || [];
    const taxFiltered = month ? tax.filter(t => String(t.month)===month) : tax;
    const taxTotal = taxFiltered.reduce((s,t)=>s+(+t.total||0),0);
    const taxVat   = taxFiltered.reduce((s,t)=>s+(+t.vat||0),0);

    // 요약
    const sum = (k)=>orders.reduce((a,o)=>a+(+o[k]||0),0);
    const summary = {
      orderCount: orders.length,
      revenueKrw: sum('priceKrw'),
      feeKrw:     sum('feeKrw'),
      sourcingKrw:sum('sourcingKrw'),
      shipKrw:    sum('shipAgencyKrw'),
      packKrw:    sum('packAgencyKrw'),
      vatRefundKrw: sum('vatRefundKrw'),
      profitKrw:  sum('profitKrw'),
      taxPurchaseTotal: taxTotal,
      taxPurchaseVat:   taxVat,
      // 세금계산서 매입 부가세 환급 반영한 최종 순익
      netProfitKrw: sum('profitKrw') + taxVat,
    };
    return { ok:true, orders, summary };
  } catch (e) { return { ok:false, error:'정산 로드 실패: '+e.message }; }
}

// ── 세금계산서 ──
function lensTaxLoad(ss) {
  try {
    const s = _taxSheet(ss);
    const last = s.getLastRow();
    if (last < 2) return { ok:true, invoices: [] };
    const vals = s.getRange(2,1,last-1,10).getValues();
    const invoices = vals.filter(r=>r[0]).map(r=>({
      id:r[0], date: r[1] instanceof Date ? r[1].toISOString().slice(0,10):String(r[1]),
      month:r[2], vendor:r[3], type:r[4],
      supply:+r[5]||0, vat:+r[6]||0, total:+r[7]||0, item:r[8]||'', memo:r[9]||''
    }));
    return { ok:true, invoices };
  } catch (e) { return { ok:false, error:'세금계산서 로드 실패: '+e.message }; }
}
function lensTaxSave(ss, inv) {
  try {
    const s = _taxSheet(ss);
    const id = inv.id || ('TAX'+Date.now());
    const month = (inv.date||'').slice(0,7);
    const supply = +inv.supply||0;
    const vat = inv.vat!=null ? +inv.vat : Math.round(supply*0.1);
    const total = inv.total!=null ? +inv.total : supply+vat;
    const row = [id, inv.date||'', month, inv.vendor||'', inv.type||'배송대행',
                 supply, vat, total, inv.item||'', inv.memo||''];
    // 기존 ID 있으면 업데이트
    const last = s.getLastRow();
    let found = 0;
    if (last>1) {
      const ids = s.getRange(2,1,last-1,1).getValues();
      ids.forEach((v,i)=>{ if(String(v[0])===String(id)) found=i+2; });
    }
    if (found) s.getRange(found,1,1,10).setValues([row]);
    else s.appendRow(row);
    return { ok:true, id };
  } catch (e) { return { ok:false, error:'세금계산서 저장 실패: '+e.message }; }
}
function lensTaxDelete(ss, id) {
  try {
    const s = _taxSheet(ss);
    const last = s.getLastRow();
    if (last<2) return { ok:true };
    const ids = s.getRange(2,1,last-1,1).getValues();
    for (let i=0;i<ids.length;i++){
      if (String(ids[i][0])===String(id)) { s.deleteRow(i+2); return { ok:true, deleted:id }; }
    }
    return { ok:true, deleted:null };
  } catch (e) { return { ok:false, error:'삭제 실패: '+e.message }; }
}


/* ════════════════════════════════════════════════════════
   정산 시트 수동 초기화 (GAS 편집기에서 직접 실행용)
   → script.google.com 에서 이 함수 선택 후 ▶ 실행
   ════════════════════════════════════════════════════════ */
function 정산시트_생성() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  _settleSheet(ss);       // QSM_Lens_Settle
  _taxSheet(ss);          // QSM_Lens_Tax
  _agencyRateSheet(ss);   // QSM_Lens_AgencyRate (기본 요율 포함)
  Logger.log('✅ 정산 시트 3개 생성 완료: QSM_Lens_Settle, QSM_Lens_Tax, QSM_Lens_AgencyRate');
  return '정산 시트 3개 생성 완료';
}
