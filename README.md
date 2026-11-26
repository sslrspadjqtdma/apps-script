# FINPULSE · 1분 AI 시황 브리핑

달러/원 환율, 나스닥·S&P500, 국내 반도체, 미국 빅테크, 양자컴퓨터 시세와 뉴스를 한 화면에서 보고, 관심 분야만 담은 이메일 브리핑을 구독하는 Google Apps Script 웹앱입니다.

## 주요 기능

- **시세와 차트**: TradingView 위젯으로 상단 티커, 핵심 시세 카드 4개, 인터랙티브 차트, 테마별 시세 보드를 보여 줍니다. 휴대폰 폭(640px 미만)에서는 차트 툴바를 줄입니다.
- **실시간 뉴스 피드**: Google 뉴스 RSS를 카테고리 4개(국내 반도체, 글로벌 빅테크, 환율·지수, 양자컴퓨터)로 수집합니다. 6시간 이내 기사에는 NEW 뱃지를 붙이고, 카드를 누르면 기사 원문이 새 탭으로 열립니다.
- **뉴스 기록**: 새로 수집한 기사를 스프레드시트 '뉴스' 탭에 쌓습니다. 기사 링크 기준으로 중복을 거릅니다.
- **구독과 수신 거부**: 구독 신청을 '구독자' 탭에 저장합니다. 수신 거부 링크에는 이메일별 서명 토큰이 붙어 있어 다른 사람의 구독을 끊을 수 없습니다.

## 파일 구성

| 파일 | 내용 |
|---|---|
| `Code.js` | 서버 코드: 페이지 제공, 뉴스 수집·캐시, 시트 저장, 구독·수신 거부 |
| `index.html` | 화면 전체 (HTML, CSS, JavaScript). Tailwind CDN과 TradingView 위젯 사용 |
| `appsscript.json` | Apps Script 설정 (시간대 Asia/Seoul, 웹앱 공개 범위) |
| `.clasp.json` | clasp가 연결할 Apps Script 프로젝트 ID |

## 처음 설정하기

1. clasp를 설치하고 로그인합니다.
   ```bash
   npm install -g @google/clasp
   clasp login
   ```
2. `.clasp.json`의 `scriptId`를 내 Apps Script 프로젝트 ID로 바꾸고 코드를 올립니다.
   ```bash
   clasp push
   ```
3. `Code.js`의 `APP_SPREADSHEET_ID`에 데이터를 저장할 스프레드시트 ID를 넣습니다. 시트 주소 `docs.google.com/spreadsheets/d/<ID>/edit`의 `<ID>` 부분입니다. 비워 두면 'FINPULSE 데이터' 시트를 자동으로 만듭니다.
4. Apps Script 편집기에서 아래 함수를 한 번씩 실행합니다. 처음 실행할 때 권한 승인 창이 뜹니다.

   | 함수 | 하는 일 |
   |---|---|
   | `setupSubscriberSheet` | '구독자', '뉴스' 탭을 만듭니다 |
   | `installDailyNewsTrigger` | 매일 오전 6시~7시에 뉴스를 수집하는 트리거를 만듭니다 |
   | `saveNewsNow` | (선택) 지금 바로 뉴스를 수집해 시트에 저장합니다 |

   `installDailyNewsTrigger`는 실행할 때마다 트리거를 하나씩 더 만듭니다. 한 번만 실행하고, 편집기의 트리거 화면에서 `dailyNewsWarmupTrigger`가 1개인지 확인하세요.

5. 웹앱으로 배포합니다. 처음에는 편집기의 **배포 → 새 배포 → 웹 앱**으로 만들고, 이후에는 같은 주소를 유지한 채 새 버전으로 바꿉니다.
   ```bash
   clasp deployments                                  # 배포 ID 확인
   clasp deploy -i <배포 ID> -d "변경 내용"
   ```
6. Apps Script 밖(예: VS Code Live Server)에서 `index.html`을 열 때만 `GAS_WEB_APP_URL`에 배포된 `/exec` 주소를 넣습니다. Apps Script 웹앱 안에서는 `google.script.run`을 쓰므로 필요 없습니다.

## 웹앱 요청

| 요청 | 결과 |
|---|---|
| `GET /exec` | 페이지 |
| `GET /exec?action=getFeed` | 뉴스 JSON. 같은 날(한국 시간)에는 30분 동안 캐시를 쓰고, 날짜가 바뀌면 새로 수집합니다 |
| `GET /exec?action=getFeed&refresh=true` | 캐시를 무시하고 새로 수집. 방문자 전체 기준 1분에 1번까지만 수집하고, 그 안의 요청에는 캐시와 `retryAfter`(초)를 돌려줍니다 |
| `GET /exec?action=unsubscribe&email=…&token=…` | 수신 거부 확인 페이지. 버튼을 눌러야 처리됩니다 |
| `POST /exec` `{email, interestIds, timeId, consent: true}` | 구독 신청. 같은 이메일이면 설정을 덮어씁니다 |
| `POST /exec` `{action: "unsubscribe", email, token}` | 수신 거부 |

POST 본문은 JSON 문자열을 `Content-Type: text/plain`으로 보냅니다. Apps Script가 처리하지 못하는 CORS 사전 요청을 피하기 위해서입니다.

## 시트 구조

- **구독자**: 이메일, 관심 분야, 관심 분야 ID, 발송 시각, 발송 시각 ID, 상태(구독 / 수신 거부), 동의, 최초 신청, 최근 변경
- **뉴스**: 수집 날짜, 카테고리, 제목, 언론사, 게시 시각, 기사 링크, 수집 시각

## 설정값 (`Code.js`)

| 상수 | 기본값 | 의미 |
|---|---|---|
| `APP_SPREADSHEET_ID` | — | 데이터를 저장할 스프레드시트 ID |
| `NEWS_CATEGORIES` | 4개 | 카테고리별 Google 뉴스 검색어 (`when:1d`로 최근 기사만) |
| `MAX_ITEMS_PER_CATEGORY` | 12 | 카테고리당 최대 기사 수 |
| `FEED_CACHE_SECONDS` | 1800 | 뉴스 캐시 유지 시간(초) |
| `FORCE_REFRESH_MIN_INTERVAL_SECONDS` | 60 | 강제 새로고침 최소 간격(초). `index.html`의 `FORCE_REFRESH_COOLDOWN_SEC`와 같게 맞춥니다 |

## 알아둘 점

- 수신 거부 서명 키는 스크립트 속성 `UNSUBSCRIBE_SECRET`에 처음 쓸 때 자동으로 만들어집니다. 이 값을 지우거나 바꾸면 이미 보낸 수신 거부 링크가 모두 동작하지 않습니다.
- 구독할 때 이메일 주인 확인(더블 옵트인)은 아직 하지 않습니다. 실제 서비스로 운영하려면 확인 메일 단계를 추가하는 것을 권합니다.
- 브리핑 메일 발송 기능은 아직 없습니다. 발송 코드를 만들 때 메일 하단에 `buildUnsubscribeUrl(email)`이 만든 링크를 넣으면 됩니다.
- 화면의 브리핑 문구는 정보 제공용이며 특정 상품의 매수·매도를 권하지 않습니다.
