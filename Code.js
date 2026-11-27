/**
 * FINPULSE web app
 *  - GET (no action)            : serves index.html
 *  - GET ?action=getFeed         : Google News RSS → JSON (cached per KST day, 30 min)
 *  - GET ?action=getFeed&refresh=true : ignores cache and re-collects immediately
 *  - POST {email, interestIds, timeId, consent}        : subscribe (saved to the "FINPULSE 구독자" sheet)
 *  - POST {action:'unsubscribe', email}                : unsubscribe
 */

var TIME_ZONE = 'Asia/Seoul';
var FEED_CACHE_SECONDS = 1800; // 30 min within the same day
var FEED_PARTIAL_CACHE_SECONDS = 300; // some categories failed: retry those within 5 min
var FEED_FAIL_BACKOFF_SECONDS = 60; // nothing collected: wait 1 min before hitting Google News again
var FEED_FAIL_KEY = 'newsFeed:failBackoff';
var FEED_CACHE_PREFIX = 'newsFeed:v1:';
var MAX_ITEMS_PER_CATEGORY = 12;
// refresh=true is public; allow at most one forced re-collection per this many seconds (shared by all visitors).
var FORCE_REFRESH_MIN_INTERVAL_SECONDS = 60;
var LAST_REFRESH_KEY = 'newsFeed:lastForcedRefresh';

var NEWS_CATEGORIES = [
  { id: 'domestic', label: '국내 (삼성·하이닉스)', tag: '국내', query: '삼성전자+OR+SK하이닉스+when:1d' },
  { id: 'global', label: '글로벌 (빅테크)', tag: '글로벌', query: '애플+OR+구글+OR+테슬라+OR+엔비디아+when:1d' },
  { id: 'macro', label: '환율·지수', tag: '시황', query: '원달러환율+OR+나스닥+OR+코스피+when:1d' },
  { id: 'quantum', label: '양자컴퓨터', tag: '테마', query: '아이온큐+OR+양자컴퓨터+when:2d' }
];

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.action === 'unsubscribe') {
    return renderUnsubscribePage_(params.email, params.token);
  }
  if (params.action === 'getFeed') {
    var feed;
    try {
      feed = getNewsFeed(params.refresh === 'true');
    } catch (err) {
      feed = { status: 'error', message: String(err && err.message || err) };
    }
    return ContentService.createTextOutput(JSON.stringify(feed)).setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('FINPULSE · 1분 AI 시황 브리핑')
    // The <meta viewport> inside index.html is ignored by HtmlService; without this the page renders at desktop width on phones.
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Returns the news feed. Also callable from the page via google.script.run.getNewsFeed(refresh).
 * The cache key contains today's KST date, so the first request after midnight always re-collects.
 */
function getNewsFeed(refresh) {
  return getNewsFeed_(refresh, false);
}

function getNewsFeed_(refresh, bypassThrottle) {
  var cache = CacheService.getScriptCache();
  var key = FEED_CACHE_PREFIX + todayKst_();
  var cached = cache.get(key);

  if (refresh && !bypassThrottle) {
    var wait = forcedRefreshWaitSeconds_(cache);
    if (wait > 0 && cached) {
      // Too soon after the last forced collection: answer from cache instead of hitting Google News again.
      var throttled = JSON.parse(cached);
      throttled.cached = true;
      throttled.throttled = true;
      throttled.retryAfter = wait;
      return throttled;
    }
  }

  if (!refresh && cached) {
    var hit = JSON.parse(cached);
    hit.cached = true;
    return hit;
  }

  // One collection at a time: concurrent refreshes wait, then reuse the result the first one cached.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    if (cached) return JSON.parse(cached);
    throw new Error('뉴스 수집이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
  }
  try {
    var fresh = cache.get(key);
    if (fresh && (!refresh || forcedRefreshWaitSeconds_(cache) > 0) && !bypassThrottle) {
      var shared = JSON.parse(fresh);
      shared.cached = true;
      return shared;
    }
    // Google News failed recently: don't hammer it on every request, retry after the short backoff.
    if (!bypassThrottle && cache.get(FEED_FAIL_KEY)) {
      if (fresh || cached) {
        var kept = JSON.parse(fresh || cached);
        kept.cached = true;
        return kept;
      }
      return { status: 'success', date: todayKst_(), updatedAt: '', news: [], errors: ['수집 재시도 대기 중'], cached: false };
    }
    var feed = collectNews_();
    if (!feed.news.length) {
      // Nothing collected (all categories failed or empty). Never cache this: the next request after the
      // backoff collects again. Keep serving the last good feed for today if there is one.
      cache.put(FEED_FAIL_KEY, '1', FEED_FAIL_BACKOFF_SECONDS);
      console.warn('News collection returned 0 items: ' + feed.errors.join(' | '));
      var previous = fresh || cached;
      if (previous) {
        var last = JSON.parse(previous);
        last.cached = true;
        last.errors = feed.errors;
        return last;
      }
      feed.cached = false;
      return feed;
    }
    // Only fresh collections reach here (never cache hits), so each Google News fetch is archived once.
    // We already hold the script lock, which also serialises subscriber writes to the same spreadsheet.
    try {
      feed.archived = saveNewsToSheet_(feed);
    } catch (err) {
      console.warn('News archive failed: ' + err);
    }
    try {
      // Some categories failed: keep it only briefly so the missing ones are retried soon.
      cache.put(key, JSON.stringify(feed), feed.errors.length ? FEED_PARTIAL_CACHE_SECONDS : FEED_CACHE_SECONDS);
      if (refresh) cache.put(LAST_REFRESH_KEY, String(Date.now()), FORCE_REFRESH_MIN_INTERVAL_SECONDS);
    } catch (err) {
      // Cache values are capped at 100KB; serving uncached is fine.
      console.warn('Feed cache put failed: ' + err);
    }
    feed.cached = false;
    return feed;
  } finally {
    lock.releaseLock();
  }
}

/** Seconds left before another forced refresh is allowed (0 = allowed now). */
function forcedRefreshWaitSeconds_(cache) {
  var last = Number(cache.get(LAST_REFRESH_KEY) || 0);
  if (!last) return 0;
  var left = FORCE_REFRESH_MIN_INTERVAL_SECONDS - Math.floor((Date.now() - last) / 1000);
  return left > 0 ? left : 0;
}

/** Run from a daily time-based trigger (e.g. 06:00–07:00 KST) so the first visitor gets a warm cache. */
function dailyNewsWarmupTrigger() {
  var feed = getNewsFeed_(true, true);
  console.log('News warmup ' + feed.date + ': ' + feed.news.length + ' items, ' + (feed.archived || 0) + ' new rows in 뉴스 sheet' +
    (feed.errors.length ? ', errors: ' + feed.errors.join(' | ') : ''));
}

/** Run once by hand from the editor to install the daily 6 AM (KST) warmup trigger. */
function installDailyNewsTrigger() {
  ScriptApp.newTrigger('dailyNewsWarmupTrigger').timeBased().everyDays(1).atHour(6).inTimezone(TIME_ZONE).create();
}

function collectNews_() {
  var requests = NEWS_CATEGORIES.map(function (cat) {
    return { url: rssUrl_(cat.query), muteHttpExceptions: true, followRedirects: true };
  });
  var responses = UrlFetchApp.fetchAll(requests);
  var errors = [];
  var seen = {};
  var news = [];

  responses.forEach(function (res, i) {
    var cat = NEWS_CATEGORIES[i];
    if (res.getResponseCode() !== 200) {
      errors.push(cat.id + ': HTTP ' + res.getResponseCode());
      return;
    }
    var items;
    try {
      items = parseRss_(res.getContentText('UTF-8'));
    } catch (err) {
      errors.push(cat.id + ': ' + err);
      return;
    }
    var added = 0;
    for (var j = 0; j < items.length && added < MAX_ITEMS_PER_CATEGORY; j++) {
      var item = items[j];
      var dedupeKey = titleKey_(item.title);
      if (!dedupeKey || seen[dedupeKey]) continue;
      seen[dedupeKey] = true;
      news.push({
        categoryId: cat.id,
        category: cat.label,
        tag: cat.tag,
        title: item.title,
        source: item.source,
        url: item.url,
        time: item.time
      });
      added++;
    }
  });

  news.sort(function (a, b) {
    return (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0);
  });

  return {
    status: 'success',
    date: todayKst_(),
    updatedAt: new Date().toISOString(),
    news: news,
    errors: errors
  };
}

/* ───────────────────────── Subscriptions (POST) ───────────────────────── */

// Must match INTERESTS / TIME_SLOTS ids in index.html.
var SUBSCRIBE_INTERESTS = {
  macro: '달러 환율 · 나스닥 · 코스피 · QQQ · S&P500',
  krSemi: '삼성전자 · SK하이닉스',
  bigtech: '애플 · 구글 · 테슬라 · X',
  quantum: '양자컴퓨터 (아이온큐·리게티·디웨이브)'
};
var SUBSCRIBE_TIME_SLOTS = {
  '0730': '출근길 (07:30)',
  '1200': '점심시간 (12:00)',
  '1830': '퇴근길 (18:30)'
};
var SUBSCRIBERS_SHEET_PROP = 'SUBSCRIBERS_SHEET_ID';
// The spreadsheet that holds the 구독자 and 뉴스 tabs (from its URL: /spreadsheets/d/<ID>/edit).
// Leave '' to let the script create and remember its own "FINPULSE 데이터" spreadsheet.
var APP_SPREADSHEET_ID = '1QaHM96C0uO1lPEeZrv5DcolP_6PoqF6VLFFvlFeLO-I';
var SUBSCRIBERS_SHEET_NAME = '구독자';
var SUBSCRIBERS_HEADER = ['이메일', '관심 분야', '관심 분야 ID', '발송 시각', '발송 시각 ID', '상태', '동의', '최초 신청', '최근 변경'];

/**
 * POST body (JSON, sent as text/plain to avoid a CORS preflight):
 *   { action?: 'subscribe', email, interestIds: [...], timeId, consent: true }
 *   { action: 'unsubscribe', email, token }   ← token comes from buildUnsubscribeUrl(email)
 */
function doPost(e) {
  var result;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    result = body.action === 'unsubscribe' ? unsubscribe(body) : subscribe(body);
  } catch (err) {
    result = { status: 'error', message: err && err.message ? err.message : '요청을 처리하지 못했습니다.' };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

/** Adds or updates a subscriber (one row per email). Also callable via google.script.run.subscribe(payload). */
function subscribe(payload) {
  var data = validateSubscription_(payload || {});
  var result = withSubscriberSheet_(function (sheet) {
    var now = new Date();
    var row = findSubscriberRow_(sheet, data.email);
    var values = [data.email, data.interestLabels.join(', '), data.interestIds.join(','), data.timeLabel, data.timeId, '구독', 'Y'];
    if (row) {
      var firstAt = sheet.getRange(row, 8).getValue() || now;
      sheet.getRange(row, 1, 1, SUBSCRIBERS_HEADER.length).setValues([values.concat([firstAt, now])]);
      return { status: 'success', updated: true, message: '구독 설정을 변경했습니다. 다음 ' + data.timeLabel + ' 발송부터 반영됩니다.' };
    }
    sheet.appendRow(values.concat([now, now]));
    return { status: 'success', updated: false, message: '브리핑 구독이 접수되었습니다. ' + data.timeLabel + '에 메일을 보내 드립니다.' };
  });
  // Same link the real briefing mails carry, so the page preview can show a working one.
  result.unsubscribeUrl = buildUnsubscribeUrl(data.email);
  return result;
}

/**
 * Marks a subscriber as unsubscribed (row is kept for the record).
 * Requires the signed token from the mail link, so nobody can unsubscribe someone else's address.
 */
function unsubscribe(payload) {
  var p = payload || {};
  var email = normalizeEmail_(p.email);
  if (!email || !isValidUnsubscribeToken_(email, p.token)) {
    throw new Error('수신 거부 링크가 올바르지 않습니다. 받으신 메일의 링크를 다시 눌러 주세요.');
  }
  return withSubscriberSheet_(function (sheet) {
    var row = findSubscriberRow_(sheet, email);
    if (row) {
      sheet.getRange(row, 6).setValue('수신 거부');
      sheet.getRange(row, 9).setValue(new Date());
    }
    return { status: 'success', message: '수신 거부가 접수되었습니다. 다음 발송부터 메일이 중단됩니다.' };
  });
}

/* ───────────────────────── Unsubscribe link ───────────────────────── */

var UNSUBSCRIBE_SECRET_PROP = 'UNSUBSCRIBE_SECRET';

/**
 * Link to put in every briefing mail (and in a List-Unsubscribe header):
 *   <web app /exec URL>?action=unsubscribe&email=...&token=...
 */
function buildUnsubscribeUrl(email) {
  var normalized = normalizeEmail_(email);
  if (!normalized) throw new Error('올바른 이메일 주소가 아닙니다: ' + email);
  return ScriptApp.getService().getUrl() +
    '?action=unsubscribe&email=' + encodeURIComponent(normalized) +
    '&token=' + unsubscribeToken_(normalized);
}

/** HMAC-SHA256(email) with a per-project secret, base64url. Stable per email, so old mails keep working. */
function unsubscribeToken_(email) {
  var bytes = Utilities.computeHmacSha256Signature(email, getUnsubscribeSecret_(), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function isValidUnsubscribeToken_(email, token) {
  var expected = unsubscribeToken_(email);
  var given = String(token || '');
  if (given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Created on first use. Changing it invalidates every unsubscribe link already sent. */
function getUnsubscribeSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty(UNSUBSCRIBE_SECRET_PROP);
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty(UNSUBSCRIBE_SECRET_PROP, secret);
  }
  return secret;
}

/**
 * GET ?action=unsubscribe → confirmation page. Unsubscribing happens only when the reader presses the button,
 * so mail scanners that pre-open links can't unsubscribe people by accident.
 */
function renderUnsubscribePage_(rawEmail, token) {
  var email = normalizeEmail_(rawEmail);
  var valid = !!email && isValidUnsubscribeToken_(email, token);
  var t = HtmlService.createTemplate(UNSUBSCRIBE_PAGE_HTML_);
  t.valid = valid;
  t.email = valid ? email : '';
  t.token = valid ? String(token) : '';
  t.home = ScriptApp.getService().getUrl();
  return t.evaluate()
    .setTitle('FINPULSE · 수신 거부')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called by the confirmation page's button via google.script.run. */
function confirmUnsubscribe(email, token) {
  return unsubscribe({ email: email, token: token });
}

// <?= ?> HTML-escapes, so the email/token are safe to print; the script reads them back from data-* attributes.
var UNSUBSCRIBE_PAGE_HTML_ = [
  '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">',
  '<style>',
  '  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#0f172a;',
  '    font-family:"Pretendard Variable",Pretendard,system-ui,-apple-system,"Malgun Gothic",sans-serif}',
  '  .card{width:min(420px,calc(100% - 32px));background:#fff;border:1px solid #e2e8f0;border-radius:16px;',
  '    box-shadow:0 10px 28px rgba(15,23,42,.06);padding:28px 24px;text-align:center}',
  '  .brand{font-size:12px;font-weight:800;letter-spacing:.14em;color:#2563eb}',
  '  h1{font-size:20px;margin:10px 0 8px} p{font-size:14px;line-height:1.6;color:#475569;margin:0}',
  '  .email{font-weight:700;color:#0f172a;word-break:break-all}',
  '  button{margin-top:20px;width:100%;border:0;border-radius:10px;padding:12px;font-size:15px;font-weight:700;',
  '    background:#2563eb;color:#fff;cursor:pointer} button:disabled{opacity:.6;cursor:default}',
  '  a{display:inline-block;margin-top:14px;font-size:13px;color:#64748b}',
  '  .msg{margin-top:14px;font-size:13px} .ok{color:#047857} .err{color:#b91c1c}',
  '</style></head><body>',
  '<main class="card" id="card" data-email="<?= email ?>" data-token="<?= token ?>">',
  '  <p class="brand">FINPULSE</p>',
  '  <? if (valid) { ?>',
  '    <h1>브리핑 수신을 거부할까요?</h1>',
  '    <p><span class="email"><?= email ?></span><br>주소로 보내는 1분 AI 브리핑을 더 이상 보내지 않습니다.</p>',
  '    <button id="confirm" type="button">수신 거부하기</button>',
  '    <p id="msg" class="msg" role="status" aria-live="polite"></p>',
  '  <? } else { ?>',
  '    <h1>링크를 확인할 수 없습니다</h1>',
  '    <p>링크가 잘렸거나 만료되었습니다. 받으신 메일 하단의 수신 거부 링크를 다시 눌러 주세요.</p>',
  '  <? } ?>',
  '  <a href="<?= home ?>" target="_top">FINPULSE 홈으로</a>',
  '</main>',
  '<script>',
  '  (function () {',
  '    var button = document.getElementById("confirm");',
  '    if (!button) return;',
  '    var card = document.getElementById("card"), msg = document.getElementById("msg");',
  '    button.addEventListener("click", function () {',
  '      button.disabled = true; button.textContent = "처리 중…"; msg.textContent = ""; msg.className = "msg";',
  '      google.script.run',
  '        .withSuccessHandler(function (res) {',
  '          button.textContent = "수신 거부 완료";',
  '          msg.className = "msg ok"; msg.textContent = res.message;',
  '        })',
  '        .withFailureHandler(function (err) {',
  '          button.disabled = false; button.textContent = "다시 시도";',
  '          msg.className = "msg err"; msg.textContent = (err && err.message) || "처리하지 못했습니다.";',
  '        })',
  '        .confirmUnsubscribe(card.dataset.email, card.dataset.token);',
  '    });',
  '  })();',
  '</script></body></html>'
].join('\n');

function validateSubscription_(p) {
  var email = normalizeEmail_(p.email);
  if (!email) throw new Error('올바른 이메일 주소를 입력해 주세요.');
  if (p.consent !== true) throw new Error('이메일 수집 및 뉴스레터 수신 동의가 필요합니다.');
  var ids = Array.isArray(p.interestIds) ? p.interestIds : [];
  var interestIds = ids.filter(function (id, i) {
    return SUBSCRIBE_INTERESTS.hasOwnProperty(id) && ids.indexOf(id) === i;
  });
  if (!interestIds.length) throw new Error('관심 분야를 하나 이상 선택해 주세요.');
  var timeId = String(p.timeId || '');
  if (!SUBSCRIBE_TIME_SLOTS.hasOwnProperty(timeId)) throw new Error('발송 시각을 선택해 주세요.');
  return {
    email: email,
    interestIds: interestIds,
    interestLabels: interestIds.map(function (id) { return SUBSCRIBE_INTERESTS[id]; }),
    timeId: timeId,
    timeLabel: SUBSCRIBE_TIME_SLOTS[timeId]
  };
}

function normalizeEmail_(value) {
  var email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : '';
}

/** Runs fn(sheet) under a script lock so simultaneous sign-ups can't create duplicate rows. */
function withSubscriberSheet_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('요청이 많아 잠시 후 다시 시도해 주세요.');
  try {
    return fn(getSubscriberSheet_());
  } finally {
    lock.releaseLock();
  }
}

/** The project's spreadsheet (구독자 + 뉴스 sheets), created on first use; its id is kept in script properties. */
function getAppSpreadsheet_() {
  if (APP_SPREADSHEET_ID) {
    try {
      return SpreadsheetApp.openById(APP_SPREADSHEET_ID);
    } catch (err) {
      throw new Error('APP_SPREADSHEET_ID 시트를 열 수 없습니다. 시트 주소의 ID가 맞는지, 이 스크립트 계정이 편집 권한을 가졌는지 확인하세요. (' + err.message + ')');
    }
  }
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(SUBSCRIBERS_SHEET_PROP);
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('FINPULSE 데이터');
    props.setProperty(SUBSCRIBERS_SHEET_PROP, ss.getId());
  }
  return ss;
}

/**
 * Run once from the editor after setting APP_SPREADSHEET_ID: copies the 구독자 and 뉴스 rows saved so far in the
 * auto-created "FINPULSE 데이터" spreadsheet into APP_SPREADSHEET_ID. Rows already there are skipped
 * (구독자 by email, 뉴스 by link), so running it twice is safe. The old spreadsheet is left untouched.
 */
function copyDataToAppSpreadsheet() {
  if (!APP_SPREADSHEET_ID) throw new Error('먼저 APP_SPREADSHEET_ID에 옮길 시트의 ID를 넣어 주세요.');
  var props = PropertiesService.getScriptProperties();
  var oldId = props.getProperty(SUBSCRIBERS_SHEET_PROP);
  var target = getAppSpreadsheet_();
  if (!oldId || oldId === APP_SPREADSHEET_ID) {
    getOrCreateSheet_(SUBSCRIBERS_SHEET_NAME, SUBSCRIBERS_HEADER);
    getOrCreateSheet_(NEWS_SHEET_NAME, NEWS_HEADER);
    console.log('옮길 이전 시트가 없습니다. 탭만 준비했습니다: ' + target.getUrl());
    return;
  }
  var source = SpreadsheetApp.openById(oldId);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('다른 작업이 진행 중입니다. 잠시 후 다시 실행해 주세요.');
  try {
    var subs = copySheetRows_(source, SUBSCRIBERS_SHEET_NAME, SUBSCRIBERS_HEADER, 1, function (v) {
      return String(v).toLowerCase();
    });
    var news = copySheetRows_(source, NEWS_SHEET_NAME, NEWS_HEADER, NEWS_LINK_COL, String);
    if (news.added) {
      var sheet = target.getSheetByName(NEWS_SHEET_NAME);
      sheet.getRange(news.start, 5, news.added, 1).setNumberFormat('yyyy-mm-dd hh:mm');
      sheet.getRange(news.start, 7, news.added, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    }
    console.log('구독자 ' + subs.added + '줄, 뉴스 ' + news.added + '줄을 옮겼습니다 (이미 있던 ' +
      (subs.skipped + news.skipped) + '줄은 건너뜀): ' + target.getUrl());
  } finally {
    lock.releaseLock();
  }
}

/** Appends source rows whose key column isn't already in the target sheet. */
function copySheetRows_(source, name, header, keyCol, keyOf) {
  var from = source.getSheetByName(name);
  var to = getOrCreateSheet_(name, header);
  var result = { added: 0, skipped: 0, start: to.getLastRow() + 1 };
  if (!from || from.getLastRow() < 2) return result;
  var rows = from.getRange(2, 1, from.getLastRow() - 1, header.length).getValues();
  var seen = {};
  if (to.getLastRow() >= 2) {
    to.getRange(2, keyCol, to.getLastRow() - 1, 1).getValues().forEach(function (r) { seen[keyOf(r[0])] = true; });
  }
  var fresh = rows.filter(function (r) {
    var key = keyOf(r[keyCol - 1]);
    if (!key || seen[key]) { result.skipped++; return false; }
    seen[key] = true;
    return true;
  });
  if (fresh.length) to.getRange(result.start, 1, fresh.length, header.length).setValues(fresh);
  result.added = fresh.length;
  return result;
}

/** Returns the named sheet, creating it (and its bold, frozen header row) if missing. */
function getOrCreateSheet_(name, header) {
  var ss = getAppSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    // A brand-new spreadsheet comes with one empty "Sheet1"; reuse it instead of leaving it behind.
    var first = ss.getSheets()[0];
    var reusable = ss.getSheets().length === 1 && first.getLastRow() === 0 && !/^(구독자|뉴스)$/.test(first.getName());
    sheet = reusable ? first : ss.insertSheet(name);
    if (reusable) sheet.setName(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
  }
  return sheet;
}

function getSubscriberSheet_() {
  return getOrCreateSheet_(SUBSCRIBERS_SHEET_NAME, SUBSCRIBERS_HEADER);
}

/* ───────────────────────── News archive (뉴스 sheet) ───────────────────────── */

var NEWS_SHEET_NAME = '뉴스';
var NEWS_HEADER = ['수집 날짜', '카테고리', '제목', '언론사', '게시 시각', '기사 링크', '수집 시각'];
var NEWS_LINK_COL = 6;
// Duplicates are always recent, so only the last N rows are checked (keeps writes fast as the sheet grows).
var NEWS_DEDUPE_LOOKBACK_ROWS = 3000;

/**
 * Appends this collection's articles to the 뉴스 sheet, skipping links already saved.
 * Returns the number of rows added. Caller must hold the script lock.
 */
function saveNewsToSheet_(feed) {
  if (!feed || !feed.news || !feed.news.length) return 0;
  var sheet = getOrCreateSheet_(NEWS_SHEET_NAME, NEWS_HEADER);
  var last = sheet.getLastRow();
  var seen = {};
  if (last >= 2) {
    var from = Math.max(2, last - NEWS_DEDUPE_LOOKBACK_ROWS + 1);
    sheet.getRange(from, NEWS_LINK_COL, last - from + 1, 1).getValues().forEach(function (r) {
      seen[String(r[0])] = true;
    });
  }
  var collectedAt = new Date(feed.updatedAt || Date.now());
  // Oldest first, so the sheet reads top-to-bottom in time order.
  var rows = feed.news.slice().reverse().filter(function (item) {
    if (!item.url || seen[item.url]) return false;
    seen[item.url] = true;
    return true;
  }).map(function (item) {
    return [
      feed.date,
      item.category,
      item.title,
      item.source,
      item.time ? new Date(item.time) : '',
      item.url,
      collectedAt
    ];
  });
  if (!rows.length) return 0;
  var start = last + 1;
  sheet.getRange(start, 1, rows.length, NEWS_HEADER.length).setValues(rows);
  sheet.getRange(start, 5, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange(start, 7, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  return rows.length;
}

/** Run from the editor: collects news now (ignoring the 1-minute limit) and saves it to the 뉴스 sheet. */
function saveNewsNow() {
  var feed = getNewsFeed_(true, true);
  console.log(feed.news.length + '건 수집, 뉴스 시트에 ' + (feed.archived || 0) + '건 추가: ' + getAppSpreadsheet_().getUrl());
}

/** 1-based row of the email, or 0. */
function findSubscriberRow_(sheet, email) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var emails = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < emails.length; i++) {
    if (String(emails[i][0]).toLowerCase() === email) return i + 2;
  }
  return 0;
}

/** Run once from the editor: creates the spreadsheet with 구독자 and 뉴스 sheets (authorising Sheets access) and logs its URL. */
function setupSubscriberSheet() {
  getSubscriberSheet_();
  getOrCreateSheet_(NEWS_SHEET_NAME, NEWS_HEADER);
  console.log('FINPULSE 데이터 시트: ' + getAppSpreadsheet_().getUrl());
}

/* ───────────────────────── RSS helpers ───────────────────────── */

function rssUrl_(query) {
  // Keep the "+" separators from the query spec, encode everything else (Korean, ":").
  var q = encodeURIComponent(query).replace(/%2B/g, '+');
  return 'https://news.google.com/rss/search?q=' + q + '&hl=ko&gl=KR&ceid=KR:ko';
}

function parseRss_(xml) {
  var channel = XmlService.parse(xml).getRootElement().getChild('channel');
  if (!channel) return [];
  return channel.getChildren('item').map(function (el) {
    var sourceEl = el.getChild('source');
    var source = sourceEl ? sourceEl.getText().trim() : '';
    var pub = new Date(el.getChildText('pubDate'));
    return {
      title: cleanTitle_(el.getChildText('title') || '', source),
      source: source || 'Google 뉴스',
      url: (el.getChildText('link') || '').trim(),
      time: isNaN(pub.getTime()) ? '' : pub.toISOString()
    };
  }).filter(function (item) {
    return item.title && item.url;
  });
}

/** Removes the trailing " - 언론사명" Google News appends to every title. */
function cleanTitle_(title, source) {
  var t = String(title).replace(/\s+/g, ' ').trim();
  if (source) {
    var suffix = ' - ' + source;
    if (t.slice(-suffix.length) === suffix) return t.slice(0, -suffix.length).trim();
  }
  return t.replace(/\s+[-–—|]\s+[^-–—|]{1,40}$/, '').trim();
}

/** Normalised title for duplicate detection (case, spacing and punctuation ignored). */
function titleKey_(title) {
  return String(title).toLowerCase().replace(/[\s"'“”‘’.,·…!?\[\]()<>「」『』-]/g, '');
}

function todayKst_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
}
