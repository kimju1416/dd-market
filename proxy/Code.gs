/**
 * 오늘의 시황 - 시세 중계 API
 *
 * 브라우저에서 직접 못 부르는 시세(주가 지수·ETF·원자재·암호화폐)를
 * 구글 서버가 대신 받아와 JSON으로 돌려준다.
 *   - CORS 제약 없음 (서버 사이드 호출)
 *   - 학교·사내망 차단과 무관 (호출 주체가 구글)
 *
 * GET ?v=1                            → 전체
 * GET ?v=1&only=quotes|series|crypto  → 일부만
 *
 * 데이터: Yahoo Finance chart API (공개, 키 불필요).
 *   호출 한 번에 현재가 · 전일 종가 · 6개월 일봉이 함께 온다.
 *   Stooq는 구글 IP에 봇 검증을 걸어 쓸 수 없고,
 *   CoinGecko는 구글 IP 공유 탓에 429가 잦아 코인도 야후로 받는다.
 */

/* 표시 키 → 야후 심볼 */
var SYM = {
  // 해외 지수
  SPX:'^GSPC', NDX:'^NDX', DJI:'^DJI', SOX:'^SOX',
  // 국내·아시아 + 변동성
  KOSPI:'^KS11', KOSDAQ:'^KQ11', NI225:'^N225', VIX:'^VIX',
  // 금리·달러 (^TNX는 미 10년물 수익률, DX-Y.NYB는 달러인덱스)
  US10Y:'^TNX', DXY:'DX-Y.NYB',
  // 원자재
  GOLD:'GC=F', SILV:'SI=F', COPR:'HG=F', WTI:'CL=F',
  // ETF
  VOO:'VOO', QQQ:'QQQ', SCHD:'SCHD', SOXX:'SOXX', MAGS:'MAGS',
  // 암호화폐
  BTC:'BTC-USD', ETH:'ETH-USD', SOL:'SOL-USD', XRP:'XRP-USD'
};

/* 6개월 시계열을 함께 담아 보낼 대상 */
var SERIES_KEYS = ['VOO','QQQ','SCHD','SOXX','MAGS','SPX','KOSPI','US10Y'];
var COIN_KEYS   = ['BTC','ETH','SOL','XRP'];

var CACHE_SEC = {quotes:600, series:21600, crypto:300};
var UA = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept':'application/json,text/plain,*/*'
};

function doGet(e) {
  var only = (e && e.parameter && e.parameter.only) || 'all';
  var out = {ok:true, ts:new Date().toISOString(), source:'yahoo-finance'};

  try {
    if (only === 'plus' || only === 'extra' || only === 'news' || only === 'kimchi' || only === 'beach' || only === 'chart' || only === 'diag' || only === 'diagnews') {
      /* 확장 데이터 — 기존 core 응답과 완전히 분리해 둔다(옛 화면에 영향 없음) */
      if (only === 'plus' || only === 'extra')  out.extra  = fetchExtra_();
      if (only === 'plus' || only === 'news')   out.news   = fetchNews_();
      if (only === 'plus' || only === 'kimchi') out.kimchi = fetchKimchi_();
      if (only === 'beach') out.beach = fetchBeach_();
      if (only === 'chart') out.chart = fetchChartOne_((e && e.parameter && e.parameter.k) || '');
      if (only === 'diag') out.diag = diagSyms_();
      if (only === 'diagnews') out.diagnews = diagNews_();
    } else {
      var all = fetchAllQuotes_();          // 캐시된 한 벌
      if (only === 'all' || only === 'quotes') out.quotes = all.quotes;
      if (only === 'all' || only === 'series') out.series = all.series;
      if (only === 'all' || only === 'crypto') out.crypto = all.crypto;
      out.count = Object.keys(all.quotes).length;
    }
  } catch (err) {
    out.ok = false;
    out.error = String(err);
  }

  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- 본체 ---------------- */
function fetchAllQuotes_() {
  var c = CacheService.getScriptCache();
  var hitQ = c.get('q_v7'), hitS = c.get('s_v7'), hitC = c.get('c_v7');
  if (hitQ && hitS && hitC) {
    try {
      return {quotes:JSON.parse(hitQ), series:JSON.parse(hitS), crypto:JSON.parse(hitC)};
    } catch (e) {}
  }

  var keys = Object.keys(SYM);
  var reqs = keys.map(function (k) {
    return {
      url:'https://query1.finance.yahoo.com/v8/finance/chart/' +
          encodeURIComponent(SYM[k]) + '?range=6mo&interval=1d',
      muteHttpExceptions:true, followRedirects:true, headers:UA
    };
  });

  var res;
  try {
    res = UrlFetchApp.fetchAll(reqs);
  } catch (e) {
    res = reqs.map(function (q) {
      try { return UrlFetchApp.fetch(q.url, q); } catch (x) { return null; }
    });
  }

  var quotes = {}, series = {}, crypto = {prices:{}, btc30:null};

  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var parsed = parseYahoo_(res[i]);
    if (!parsed) continue;

    quotes[k] = {last:parsed.last, prev:parsed.prev, date:parsed.date};

    if (SERIES_KEYS.indexOf(k) >= 0 && parsed.rows.length > 10) {
      var w = sample_(parsed.rows, 27);
      series[k] = {
        labels: w.map(function (r) { return r.d.slice(5).replace('-', '/'); }),
        close:  w.map(function (r) { return round_(r.c, 4); })
      };
    }

    if (COIN_KEYS.indexOf(k) >= 0) {
      crypto.prices[k] = {last:parsed.last, prev:parsed.prev};
      if (k === 'BTC' && parsed.rows.length > 10) {
        var last30 = parsed.rows.slice(-31);
        crypto.btc30 = {
          labels: last30.map(function (r) {
            var p = r.d.split('-');
            return parseInt(p[1], 10) + '/' + parseInt(p[2], 10);
          }),
          close: last30.map(function (r) { return round_(r.c, 2); })
        };
      }
    }
  }

  putCache_(c, 'q_v7', quotes, CACHE_SEC.quotes);
  putCache_(c, 's_v7', series, CACHE_SEC.series);
  putCache_(c, 'c_v7', crypto, CACHE_SEC.crypto);

  return {quotes:quotes, series:series, crypto:crypto};
}

/** 야후 chart 응답 → {last, prev, date, rows:[{d,c}]} */
function parseYahoo_(resp) {
  if (!resp) return null;
  var body;
  try {
    if (resp.getResponseCode() !== 200) return null;
    body = resp.getContentText();
  } catch (e) { return null; }

  var j;
  try { j = JSON.parse(body); } catch (e) { return null; }
  if (!j || !j.chart || !j.chart.result || !j.chart.result.length) return null;

  var r = j.chart.result[0];
  var meta = r.meta || {};
  var ts = r.timestamp || [];
  var closes = (r.indicators && r.indicators.quote && r.indicators.quote[0])
             ? (r.indicators.quote[0].close || []) : [];

  var rows = [];
  for (var i = 0; i < ts.length; i++) {
    var v = closes[i];
    if (v == null || !isFinite(v)) continue;
    rows.push({d: isoDate_(ts[i] * 1000), c: v});
  }
  if (!rows.length && !isFinite(meta.regularMarketPrice)) return null;

  var last = isFinite(meta.regularMarketPrice)
           ? meta.regularMarketPrice
           : (rows.length ? rows[rows.length - 1].c : null);

  /* 전일 종가는 반드시 "직전 일봉"으로 잡는다.
     meta.chartPreviousClose 는 전일이 아니라 조회 구간(6개월) 시작 직전 종가라
     그대로 쓰면 하루 변동이 +11% 같은 값으로 표시된다. */
  var prev = null;
  if (rows.length >= 2) prev = rows[rows.length - 2].c;
  if (prev == null && isFinite(meta.previousClose)) prev = meta.previousClose;
  if (prev == null && isFinite(meta.chartPreviousClose)) prev = meta.chartPreviousClose;

  return {
    last: round_(last, 4),
    prev: prev == null ? null : round_(prev, 4),
    date: rows.length ? rows[rows.length - 1].d : null,
    rows: rows
  };
}

/* ---------------- 유틸 ---------------- */
function putCache_(c, key, val, sec) {
  try {
    var s = JSON.stringify(val);
    if (s.length < 95000) c.put(key, s, sec);
  } catch (e) {}
}

function sample_(rows, n) {
  if (rows.length <= n) return rows;
  var step = (rows.length - 1) / (n - 1), out = [];
  for (var i = 0; i < n; i++) out.push(rows[Math.round(i * step)]);
  return out;
}

function isoDate_(ms) {
  var d = new Date(ms);
  var p = function (x) { return (x < 10 ? '0' : '') + x; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function round_(v, d) {
  if (v == null || !isFinite(v)) return null;
  var m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

/** 편집기에서 눌러 동작 확인용 */
function testAll() {
  CacheService.getScriptCache().removeAll(['q_v7','s_v7','c_v7']);
  var a = fetchAllQuotes_();
  Logger.log('quotes ' + Object.keys(a.quotes).length + '종: ' + Object.keys(a.quotes).join(','));
  Logger.log('series: ' + Object.keys(a.series).join(','));
  Logger.log('crypto: ' + Object.keys(a.crypto.prices).join(','));
  Logger.log(JSON.stringify(a.quotes).slice(0, 600));
}

/* =======================================================================
   확장 데이터 (2026-08-22 추가) — 「DD 오늘의 투자시황」용
   core(위쪽) 응답은 손대지 않는다. 옛 화면이 그대로 돌아가야 하기 때문.
   GET ?only=extra  → 세계지수·금리커브·종목·국내ETF·원자재/코인 추가분
   GET ?only=news   → 구글 뉴스 RSS 경제 헤드라인
   GET ?only=kimchi → 업비트 원화가 대비 김치 프리미엄
   GET ?only=plus   → 위 셋을 한 번에
   ======================================================================= */

var SYM_X = {
  /* 세계 지수 */
  HSI:'^HSI', SHCOMP:'000001.SS', TWII:'^TWII', NIFTY:'^NSEI',
  DAX:'^GDAXI', FTSE:'^FTSE', STOXX:'^STOXX50E', CAC:'^FCHI',
  /* 미국 국채 수익률 커브 (10년물 ^TNX 는 core 쪽에 있음) */
  US3M:'^IRX', US5Y:'^FVX', US30Y:'^TYX',
  /* 미국 대표 종목 */
  NVDA:'NVDA', AAPL:'AAPL', MSFT:'MSFT', GOOGL:'GOOGL',
  AMZN:'AMZN', META:'META', TSLA:'TSLA', AVGO:'AVGO',
  /* 국내 대표 종목 */
  K005930:'005930.KS', K000660:'000660.KS', K373220:'373220.KS', K207940:'207940.KS',
  K005380:'005380.KS', K035420:'035420.KS', K000270:'000270.KS', K068270:'068270.KS',
  /* 국내 상장 ETF */
  K069500:'069500.KS', K360750:'360750.KS', K133690:'133690.KS', K379800:'379800.KS',
  /* 원자재 추가 */
  BRENT:'BZ=F', NGAS:'NG=F',
  /* 코인 추가 */
  DOGE:'DOGE-USD', ADA:'ADA-USD', BNB:'BNB-USD',
  /* 원/달러 — 김치 프리미엄 계산에 쓴다 */
  USDKRW:'KRW=X'
};

/* 세계 지수는 6개월 곡선도 함께 보낸다 */
var SERIES_X = ['HSI','SHCOMP','DAX','NIFTY'];

var CACHE_X = {extra:600, news:900, kimchi:180};

function fetchExtra_() {
  var c = CacheService.getScriptCache();
  var hit = c.get('x_v1');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var quotes = {}, series = {};

  /* 심볼 묶음 한 벌 받아 채우기 */
  var pass_ = function (keys) {
    /* 37개를 한 번에 때리면 야후가 일부를 조용히 흘린다 — 12개씩 끊어 부른다 */
    if (keys.length > 12) {
      for (var s0 = 0; s0 < keys.length; s0 += 12) {
        pass_(keys.slice(s0, s0 + 12));
        if (s0 + 12 < keys.length) Utilities.sleep(250);
      }
      return;
    }
    var reqs = keys.map(function (k) {
      return {
        url:'https://query1.finance.yahoo.com/v8/finance/chart/' +
            encodeURIComponent(SYM_X[k]) + '?range=6mo&interval=1d',
        muteHttpExceptions:true, followRedirects:true, headers:UA
      };
    });
    var res;
    try {
      res = UrlFetchApp.fetchAll(reqs);
    } catch (e) {
      res = reqs.map(function (q) {
        try { return UrlFetchApp.fetch(q.url, q); } catch (x) { return null; }
      });
    }
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var parsed = parseYahoo_(res[i]);
      if (!parsed || !isFinite(parsed.last)) continue;
      quotes[k] = {last:parsed.last, prev:parsed.prev, date:parsed.date};
      if (SERIES_X.indexOf(k) >= 0 && parsed.rows.length > 10) {
        var w = sample_(parsed.rows, 27);
        series[k] = {
          labels: w.map(function (r) { return r.d.slice(5).replace('-', '/'); }),
          close:  w.map(function (r) { return round_(r.c, 4); })
        };
      }
    }
  };

  var all = Object.keys(SYM_X);
  pass_(all);

  /* 야후는 같은 요청도 일부 심볼만 빈 응답을 주는 일이 잦다(^FTSE·^NSEI 실측).
     빠진 것만 한 번 더 부른다 — 그래도 없으면 화면에서 "연결 대기"로 표시된다. */
  var missing = all.filter(function (k) { return !quotes[k]; });
  if (missing.length && missing.length < all.length) {
    Utilities.sleep(500);
    pass_(missing);
  }

  /* 그래도 빈 자리는 마지막으로 성공했던 값으로 메운다(카드가 통째로 비는 것보다 낫다) */
  var good = {};
  try { var g = c.get('x_good'); if (g) good = JSON.parse(g); } catch (e) {}
  var fresh = Object.keys(quotes).length;
  all.forEach(function (k) {
    if (quotes[k]) good[k] = quotes[k];
    else if (good[k]) quotes[k] = good[k];
  });
  putCache_(c, 'x_good', good, 21600);

  var out = {quotes:quotes, series:series, count:Object.keys(quotes).length, fresh:fresh};
  /* 다 못 받았으면 짧게만 캐시해서 다음 호출에 다시 시도하게 한다 */
  putCache_(c, 'x_v1', out, fresh === all.length ? CACHE_X.extra : 120);
  return out;
}

/* ---------------- 경제 뉴스 헤드라인 ---------------- */
var FEEDS = [
  {k:'kr',    label:'국내 증시',   q:'코스피 OR 코스닥 OR 국내증시'},
  {k:'us',    label:'미국·글로벌', q:'뉴욕증시 OR 나스닥 OR 연준'},
  {k:'macro', label:'금리·환율',   q:'기준금리 OR 원달러 환율'}
];

function fetchNews_() {
  var c = CacheService.getScriptCache();
  var hit = c.get('n_v3');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var reqs = FEEDS.map(function (f) {
    return {
      url:'https://news.google.com/rss/search?q=' + encodeURIComponent(f.q) +
          '&hl=ko&gl=KR&ceid=KR%3Ako',
      muteHttpExceptions:true, followRedirects:true, headers:UA
    };
  });

  var res;
  try { res = UrlFetchApp.fetchAll(reqs); } catch (e) { res = []; }

  var groups = [];
  for (var i = 0; i < FEEDS.length; i++) {
    groups.push({key:FEEDS[i].k, label:FEEDS[i].label, items:parseRss_(res[i], 8)});
  }
  var out = {groups:groups};
  putCache_(c, 'n_v3', out, CACHE_X.news);
  return out;
}

function parseRss_(resp, limit) {
  if (!resp) return [];
  var body;
  try {
    if (resp.getResponseCode() !== 200) return [];
    body = resp.getContentText();
  } catch (e) { return []; }

  var items = [];
  try {
    var root = XmlService.parse(body).getRootElement();
    var ch = root.getChild('channel');
    if (!ch) return [];
    var list = ch.getChildren('item');
    for (var i = 0; i < list.length && items.length < limit; i++) {
      var it = list[i];
      var title = it.getChildText('title') || '';
      var link  = it.getChildText('link') || '';
      var pub   = it.getChildText('pubDate') || '';
      var srcEl = it.getChild('source');
      var src   = srcEl ? srcEl.getText() : '';
      /* 구글 뉴스 제목은 "제목 - 언론사" 꼴인데, 언론사명이 두 번 붙어 오는 경우가 있다
         (실측: "...[부꾸미] - 머니투데이 - 머니투데이"). 그래서 붙은 만큼 반복해서 떼어 낸다. */
      for (var k = 0; k < 3; k++) {
        var before = title;
        if (src && title.length > src.length + 3 &&
            title.slice(-(src.length + 3)) === ' - ' + src) {
          title = title.slice(0, title.length - src.length - 3);
        } else {
          /* source 표기(영문 사명 등)와 제목 꼬리가 다를 때 — 마지막 " - 언론사"를 떼어 낸다 */
          var cut = title.lastIndexOf(' - ');
          if (cut > 10 && title.length - cut - 3 <= 25) {
            var tail = title.slice(cut + 3);
            if (tail.indexOf('.') < 0 && tail.indexOf('?') < 0 && tail.indexOf('!') < 0) {
              if (!src) src = tail;
              title = title.slice(0, cut);
            }
          }
        }
        if (title === before) break;
      }
      if (!title || !link) continue;
      var at = null;
      if (pub) { try { at = new Date(pub).toISOString(); } catch (e2) { at = null; } }
      items.push({t:title, u:link, s:src, at:at});
    }
  } catch (e) { return items; }
  return items;
}

/* ---------------- 김치 프리미엄 ---------------- */
var UPBIT_MK = {BTC:'KRW-BTC', ETH:'KRW-ETH', XRP:'KRW-XRP', SOL:'KRW-SOL', DOGE:'KRW-DOGE'};

function fetchKimchi_() {
  var c = CacheService.getScriptCache();
  var hit = c.get('k_v1');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var out = {ok:false, usdkrw:null, coins:{}};

  /* 원/달러 — 확장 시세에서 가져온다(캐시되어 있으면 즉시) */
  var xq = null;
  try {
    xq = fetchExtra_().quotes;
    if (xq.USDKRW && isFinite(xq.USDKRW.last)) out.usdkrw = xq.USDKRW.last;
  } catch (e) {}

  /* 달러가 — core 쪽 코인 시세를 재사용 */
  var usd = {};
  try {
    var core = fetchAllQuotes_();
    Object.keys(core.crypto.prices).forEach(function (k) {
      usd[k] = core.crypto.prices[k].last;
    });
  } catch (e) {}
  if (usd.DOGE == null && xq && xq.DOGE) usd.DOGE = xq.DOGE.last;

  var keys = Object.keys(UPBIT_MK);
  var mk = keys.map(function (k) { return UPBIT_MK[k]; }).join(',');
  var resp = null;
  try {
    resp = UrlFetchApp.fetch('https://api.upbit.com/v1/ticker?markets=' + encodeURIComponent(mk),
      {muteHttpExceptions:true, followRedirects:true, headers:UA});
  } catch (e) {}

  var arr = null;
  if (resp) {
    try {
      if (resp.getResponseCode() === 200) arr = JSON.parse(resp.getContentText());
    } catch (e) { arr = null; }
  }
  if (!arr || !arr.length) { putCache_(c, 'k_v1', out, 120); return out; }

  var byMk = {};
  arr.forEach(function (r) { byMk[r.market] = r; });

  keys.forEach(function (k) {
    var r = byMk[UPBIT_MK[k]];
    if (!r || !isFinite(r.trade_price)) return;
    var row = {
      krw: r.trade_price,
      chg: isFinite(r.signed_change_rate) ? round_(r.signed_change_rate * 100, 2) : null,
      usd: isFinite(usd[k]) ? usd[k] : null,
      prem: null
    };
    if (row.usd && out.usdkrw) row.prem = round_((row.krw / (row.usd * out.usdkrw) - 1) * 100, 2);
    out.coins[k] = row;
  });

  out.ok = Object.keys(out.coins).length > 0;
  putCache_(c, 'k_v1', out, CACHE_X.kimchi);
  return out;
}

/** 편집기에서 눌러 확장 데이터 확인용 */
function testPlus() {
  CacheService.getScriptCache().removeAll(['x_v1', 'n_v3', 'k_v1']);
  var x = fetchExtra_();
  var miss = Object.keys(SYM_X).filter(function (k) { return !x.quotes[k]; });
  Logger.log('extra ' + x.count + '종 / 빠진 것: ' + (miss.length ? miss.join(',') : '없음'));
  var n = fetchNews_();
  n.groups.forEach(function (g) { Logger.log(g.label + ' ' + g.items.length + '건'); });
  var k = fetchKimchi_();
  Logger.log('kimchi ok=' + k.ok + ' usdkrw=' + k.usdkrw + ' ' + JSON.stringify(k.coins));
}

/* 진단 — 잘 안 붙는 심볼만 콕 집어 응답을 본다(후보는 코드에 박아 둔다) */
function diagSyms_() {
  var cand = ['^FTSE', '^NSEI', '^BSESN', '^FTAS', '^HSI'];
  return cand.map(function (sym) {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
              encodeURIComponent(sym) + '?range=6mo&interval=1d';
    try {
      var r = UrlFetchApp.fetch(url, {muteHttpExceptions:true, followRedirects:true, headers:UA});
      return {sym:sym, code:r.getResponseCode(), head:r.getContentText().slice(0, 160)};
    } catch (e) {
      return {sym:sym, code:-1, head:String(e).slice(0, 160)};
    }
  });
}

/* 진단 — 뉴스 제목에서 언론사 꼬리가 왜 안 떨어지는지 본다 */
function diagNews_() {
  var url = 'https://news.google.com/rss/search?q=' + encodeURIComponent('코스피') + '&hl=ko&gl=KR&ceid=KR%3Ako';
  var r = UrlFetchApp.fetch(url, {muteHttpExceptions:true, followRedirects:true, headers:UA});
  var root = XmlService.parse(r.getContentText()).getRootElement();
  var ch = root.getChild('channel');
  var it = ch.getChildren('item')[0];
  var title = it.getChildText('title') || '';
  var srcEl = it.getChild('source');
  var src = srcEl ? srcEl.getText() : '';
  return {
    code: r.getResponseCode(),
    title: title,
    src: src,
    typeTitle: typeof title,
    typeSrc: typeof src,
    lenTitle: title.length,
    lenSrc: src.length,
    tail: title.slice(-(src.length + 3)),
    eq: title.slice(-(src.length + 3)) === ' - ' + src,
    lastIdx: title.lastIndexOf(' - ')
  };
}

/* ---------------- 오보해변 바다 상태(파고·바람·수온) ----------------
   브라우저가 Open-Meteo 를 직접 부르는 게 기본이고, 이 경로는 망이 막혔을 때의 대비책이다. */
var BEACH_PT = {lat:36.447, lon:129.431, mlat:36.447, mlon:129.45};

function fetchBeach_() {
  var c = CacheService.getScriptCache();
  var hit = c.get('b_v1');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var urls = [
    'https://marine-api.open-meteo.com/v1/marine?latitude=' + BEACH_PT.mlat +
      '&longitude=' + BEACH_PT.mlon +
      '&current=wave_height,wave_period,wave_direction,sea_surface_temperature&timezone=Asia%2FSeoul',
    'https://api.open-meteo.com/v1/forecast?latitude=' + BEACH_PT.lat +
      '&longitude=' + BEACH_PT.lon +
      '&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code' +
      '&wind_speed_unit=ms&timezone=Asia%2FSeoul'
  ];
  var reqs = urls.map(function (u) {
    return {url:u, muteHttpExceptions:true, followRedirects:true, headers:UA};
  });

  var res;
  try { res = UrlFetchApp.fetchAll(reqs); } catch (e) { res = []; }

  var pick = function (r) {
    if (!r) return null;
    try {
      if (r.getResponseCode() !== 200) return null;
      var j = JSON.parse(r.getContentText());
      return j && j.current ? {current:j.current} : null;
    } catch (e) { return null; }
  };

  var out = {marine:pick(res[0]), weather:pick(res[1])};
  putCache_(c, 'b_v1', out, (out.marine || out.weather) ? 600 : 120);
  return out;
}

/* ---------------- 카드 클릭용 개별 차트 (최근 1년 일봉) ----------------
   키는 반드시 SYM / SYM_X 에 등록된 것만 받는다(임의 URL 중계 금지). */
function fetchChartOne_(k) {
  var sym = SYM[k] || SYM_X[k];
  if (!sym) return {ok:false, error:'unknown key'};

  var c = CacheService.getScriptCache();
  var ck = 'ch_' + k;
  var hit = c.get(ck);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
            encodeURIComponent(sym) + '?range=1y&interval=1d';
  var parsed = null;
  for (var i = 0; i < 2 && !parsed; i++) {
    var r = null;
    try {
      r = UrlFetchApp.fetch(url, {muteHttpExceptions:true, followRedirects:true, headers:UA});
    } catch (e) {}
    parsed = parseYahoo_(r);
    if (!parsed && i === 0) Utilities.sleep(400);
  }
  if (!parsed || parsed.rows.length < 5) return {ok:false, error:'no data', key:k};

  var out = {
    ok: true, key: k, symbol: sym,
    labels: parsed.rows.map(function (r) {
      var p = r.d.split('-');
      return parseInt(p[1], 10) + '/' + parseInt(p[2], 10);
    }),
    dates: parsed.rows.map(function (r) { return r.d; }),
    close: parsed.rows.map(function (r) { return round_(r.c, 4); }),
    last: parsed.last, prev: parsed.prev, date: parsed.date
  };
  putCache_(c, ck, out, 21600);
  return out;
}
