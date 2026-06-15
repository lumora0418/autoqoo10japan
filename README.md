# QLens (큐렌즈) — Qoo10 Japan 셀러 가격·마진 관리 도구

한국 상품을 일본 큐텐재팬(Qoo10 Japan)에 파는 셀러를 위한 **크롬 확장 프로그램**입니다.
소싱가만 넣으면 일본 판매가·마진을 자동 계산하고, QSM 상품을 한 표에서 관리·수정합니다.

## 📥 다운로드 & 설치

1. **[`qlens-v1.9.30.zip`](./qlens-v1.9.30.zip)** 을 다운로드해 압축을 풉니다.
   - (또는 위 초록색 **`Code` → `Download ZIP`** 으로 저장소 전체를 받은 뒤 `qlens-v1.9.30` 폴더만 사용)
2. 압축 푼 **`qlens-v1.9.30` 폴더 안의 [`README.md`](./qlens-v1.9.30/README.md)** 에 **설치부터 API 발급·사용법까지 클릭 단위로** 안내돼 있습니다. 그대로 따라 하세요.

## 🚀 빠른 요약

1. `chrome://extensions` → 개발자 모드 ON → "압축해제된 확장 로드" → `qlens-v1.9.30` 폴더 선택
2. Google 스프레드시트 + Apps Script 연결 (`QSM_Lens_GAS_v1.8.4.gs` 붙여넣고 **본인 SHEET_ID로 교체** 후 웹앱 배포)
3. 큐텐 QSM API 키 입력 → 상품 불러오기 → 소싱가 입력 → 자동 계산

> ⚠️ Apps Script 코드를 붙여넣은 뒤, 맨 위 `SHEET_ID` 값을 **본인 스프레드시트 ID로 꼭 교체**해야 작동합니다. (자세한 설명은 폴더 안 README 참고)

---

자세한 설명서: **[qlens-v1.9.30/README.md](./qlens-v1.9.30/README.md)**
