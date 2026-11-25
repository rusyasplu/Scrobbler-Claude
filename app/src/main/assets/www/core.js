/* Ядро Last.fm Scrobbler: логика без привязки к интерфейсу.
 * Работает и в WebView приложения, и в Node (для тестов).
 * Всё, что зависит от платформы (HTTP, MD5), передаётся через объект env. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.Core = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
  var LASTFM_AUTH_URL = "https://www.last.fm/api/auth/";
  var SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
  var SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";

  var BATCH_SIZE = 50;            // максимум скробблов в одном запросе track.scrobble
  var PAGE_SIZE = 10;             // максимум результатов поиска Spotify (с февраля 2026)
  var MAX_AGE_DAYS = 14;          // Last.fm, как правило, отклоняет скробблы старше ~2 недель
  var MIN_TRACK_SECONDS = 30;     // Last.fm не засчитывает треки короче 30 секунд
  var DEFAULT_TRACK_SECONDS = 180;

  var IGNORE_REASONS = {
    "1": "артист отфильтрован Last.fm",
    "2": "трек отфильтрован Last.fm",
    "3": "дата слишком старая",
    "4": "дата слишком далеко в будущем",
    "5": "превышен дневной лимит скробблов"
  };

  class ApiError extends Error {
    constructor(message, code) {
      super(message);
      this.name = "ApiError";
      this.code = code === undefined ? null : code;
    }
  }

  // ---- время и план ---------------------------------------------------------

  function pad2(n) { return String(n).padStart(2, "0"); }

  function effDuration(track) {
    if (!track.durationS || track.durationS <= 0) return DEFAULT_TRACK_SECONDS;
    return Math.max(track.durationS, MIN_TRACK_SECONDS);
  }

  function fmtDur(sec) { return Math.floor(sec / 60) + ":" + pad2(sec % 60); }

  function fmtTotal(sec) {
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    return h ? h + " ч " + m + " мин" : m + " мин";
  }

  function fmtLocal(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
      pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  function dateValue(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function timeValue(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  /** "2026-11-24", "18:30" (местное время) -> миллисекунды или null. */
  function parseStart(dateStr, timeStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateStr || "").trim());
    var t = /^(\d{1,2}):(\d{2})$/.exec((timeStr || "").trim());
    if (!m || !t) return null;
    var y = +m[1], mo = +m[2], d = +m[3], hh = +t[1], mi = +t[2];
    if (hh > 23 || mi > 59) return null;
    var dt = new Date(y, mo - 1, d, hh, mi, 0, 0);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt.getTime();
  }

  function totalCount(items) {
    return items.reduce(function (a, q) { return a + q.count; }, 0);
  }

  function totalSeconds(items) {
    return items.reduce(function (a, q) { return a + q.count * effDuration(q.track); }, 0);
  }

  /** Раскладывает очередь в [{track, ts}]: прослушивания идут подряд,
   *  каждое начинается, когда закончилось предыдущее. ts — unix-секунды. */
  function buildPlan(items, startMs) {
    var ts = Math.floor(startMs / 1000);
    var plan = [];
    items.forEach(function (q) {
      for (var i = 0; i < q.count; i++) {
        plan.push({ track: q.track, ts: ts });
        ts += effDuration(q.track);
      }
    });
    return plan;
  }

  /** Старт, при котором очередь заканчивается к текущему моменту (с точностью до минуты). */
  function endNowStart(items, nowMs) {
    var start = nowMs - totalSeconds(items) * 1000;
    return Math.floor(start / 60000) * 60000;
  }

  /** level: empty | ok | warn | error; code: bad_date | future | old | null */
  function checkPlan(items, startMs, nowMs) {
    var n = totalCount(items);
    if (!n) return { level: "empty", code: null, n: 0 };
    if (startMs === null || startMs === undefined) return { level: "error", code: "bad_date", n: n };
    var secs = totalSeconds(items);
    var endMs = startMs + secs * 1000;
    var lastStartMs = endMs - effDuration(items[items.length - 1].track) * 1000;
    var level = "ok", code = null;
    if (lastStartMs > nowMs) { level = "error"; code = "future"; }
    else if (nowMs - startMs > MAX_AGE_DAYS * 86400000) { level = "warn"; code = "old"; }
    return { level: level, code: code, n: n, secs: secs, endMs: endMs, lastStartMs: lastStartMs };
  }

  // ---- Last.fm ---------------------------------------------------------------

  /** api_sig = md5(имя1значение1имя2значение2... + secret): имена по алфавиту, без format и callback. */
  function lastfmSign(params, secret, md5) {
    var s = "";
    Object.keys(params).sort().forEach(function (k) {
      if (k === "format" || k === "callback") return;
      s += k + params[k];
    });
    return md5(s + secret);
  }

  function parseSpotifyTrack(item) {
    var artists = item.artists || [];
    var album = item.album || {};
    var albumArtists = album.artists || [];
    var images = album.images || [];
    var artist = artists.length ? (artists[0].name || "") : "";
    // средняя по размеру обложка, если есть
    var cover = images.length ? (images[Math.min(1, images.length - 1)].url || "") : "";
    return {
      artist: artist,
      title: item.name || "",
      album: album.name || "",
      albumArtist: albumArtists.length ? (albumArtists[0].name || artist) : artist,
      durationS: Math.round((item.duration_ms || 0) / 1000),
      cover: cover
    };
  }

  /**
   * env: { http(method, url, headers, body) -> Promise<{status, body, error?}>, md5(str) -> hex, sleep?(ms) }
   * opts: { lastfmApi, spotifyTokenUrl, spotifySearchUrl } — для тестов.
   */
  function createApi(env, opts) {
    opts = opts || {};
    var lfmUrl = opts.lastfmApi || LASTFM_API;
    var spTokenUrl = opts.spotifyTokenUrl || SPOTIFY_TOKEN_URL;
    var spSearchUrl = opts.spotifySearchUrl || SPOTIFY_SEARCH_URL;
    var sleep = env.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var spotify = { token: null, expires: 0, id: null, secret: null };

    async function fetchJson(method, url, headers, body) {
      var res;
      try {
        res = await env.http(method, url, headers || {}, body || "");
      } catch (e) {
        throw new ApiError("Сетевая ошибка: " + ((e && e.message) || e));
      }
      if (!res || res.status === 0) {
        throw new ApiError("Нет соединения: " + ((res && res.error) || "неизвестная ошибка"));
      }
      try {
        return { status: res.status, data: JSON.parse(res.body) };
      } catch (e) {
        throw new ApiError("HTTP " + res.status + ": неожиданный ответ сервера");
      }
    }

    async function lastfmCall(method, params, creds, post) {
      var p = {};
      Object.keys(params).forEach(function (k) { p[k] = String(params[k]); });
      p.method = method;
      p.api_key = creds.key;
      if (creds.sk) p.sk = creds.sk;
      p.api_sig = lastfmSign(p, creds.secret, env.md5);
      p.format = "json";
      var body = new URLSearchParams(p).toString();
      var r = post
        ? await fetchJson("POST", lfmUrl, { "Content-Type": "application/x-www-form-urlencoded" }, body)
        : await fetchJson("GET", lfmUrl + "?" + body, {}, "");
      var data = r.data;
      if (data && typeof data === "object" && "error" in data) {
        throw new ApiError("Last.fm [" + data.error + "]: " + data.message, data.error);
      }
      return data;
    }

    async function callWithRetry(method, params, creds, log, tries) {
      tries = tries || 4;
      for (var attempt = 1; ; attempt++) {
        try {
          return await lastfmCall(method, params, creds, true);
        } catch (e) {
          var transient = e.code === 11 || e.code === 16 || e.code === 29;
          if (transient && attempt < tries) {
            var wait = 5000 * attempt;
            log("Last.fm временно недоступен или ограничил запросы (" + e.message + "). Повтор через " + (wait / 1000) + " с…");
            await sleep(wait);
            continue;
          }
          throw e;
        }
      }
    }

    // --- авторизация (без пароля: через страницу разрешения Last.fm) ---

    async function getToken(creds) {
      var data = await lastfmCall("auth.getToken", {}, { key: creds.key, secret: creds.secret }, false);
      return data.token;
    }

    function authUrl(creds, token) {
      return LASTFM_AUTH_URL + "?" + new URLSearchParams({ api_key: creds.key, token: token }).toString();
    }

    async function getSession(creds, token) {
      var data = await lastfmCall("auth.getSession", { token: token }, { key: creds.key, secret: creds.secret }, false);
      return { name: data.session.name, key: data.session.key };
    }

    // --- отправка ---

    async function sendScrobbles(plan, creds, hooks) {
      hooks = hooks || {};
      var log = hooks.log || function () {};
      var progress = hooks.progress || function () {};
      var shouldStop = hooks.shouldStop || function () { return false; };
      var pause = hooks.pause === undefined ? 500 : hooks.pause;
      var total = plan.length;
      var nBatches = Math.ceil(total / BATCH_SIZE);
      var accepted = 0, ignored = 0, done = 0;

      for (var b = 0; b * BATCH_SIZE < total; b++) {
        if (shouldStop()) { log("Остановлено пользователем."); break; }
        var batch = plan.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
        var params = {};
        batch.forEach(function (it, i) {
          var tr = it.track;
          params["artist[" + i + "]"] = tr.artist;
          params["track[" + i + "]"] = tr.title;
          params["timestamp[" + i + "]"] = it.ts;
          if (tr.album) params["album[" + i + "]"] = tr.album;
          if (tr.albumArtist && tr.albumArtist !== tr.artist) params["albumArtist[" + i + "]"] = tr.albumArtist;
          if (tr.durationS) params["duration[" + i + "]"] = tr.durationS;
        });
        var data = await callWithRetry("track.scrobble", params, creds, log);
        var sc = (data && data.scrobbles) || {};
        var attr = sc["@attr"] || {};
        var acc = parseInt(attr.accepted || 0, 10);
        var ign = parseInt(attr.ignored || 0, 10);
        accepted += acc;
        ignored += ign;
        done += batch.length;

        var items = sc.scrobble || [];
        if (!Array.isArray(items)) items = [items];
        var reasons = {};
        items.forEach(function (it) {
          var code = String((it.ignoredMessage || {}).code !== undefined ? it.ignoredMessage.code : "0");
          if (code !== "0") {
            if (!reasons[code]) reasons[code] = [];
            reasons[code].push(it);
          }
        });
        log("Пакет " + (b + 1) + "/" + nBatches + ": принято " + acc + ", отклонено " + ign);
        Object.keys(reasons).forEach(function (code) {
          var its = reasons[code];
          var ex = its[0];
          log("   отклонено " + its.length + ": " + (IGNORE_REASONS[code] || "код " + code) +
            " (например: " + textOf(ex.artist) + " — " + textOf(ex.track) + ")");
        });
        progress(done, total);
        if (reasons["5"]) { log("Дневной лимит исчерпан, останавливаюсь."); break; }
        if (done < total && pause) await sleep(pause);
      }
      return { accepted: accepted, ignored: ignored };
    }

    function textOf(x) {
      if (x && typeof x === "object") return x["#text"] || "";
      return x ? String(x) : "";
    }

    // --- Spotify ---

    async function spotifyToken(cfg) {
      if (spotify.token && spotify.id === cfg.id && spotify.secret === cfg.secret &&
          Date.now() < spotify.expires - 30000) {
        return spotify.token;
      }
      var basic = btoa(cfg.id + ":" + cfg.secret);
      var r = await fetchJson("POST", spTokenUrl, {
        "Authorization": "Basic " + basic,
        "Content-Type": "application/x-www-form-urlencoded"
      }, "grant_type=client_credentials");
      if (r.status !== 200 || !r.data.access_token) {
        var desc = r.data.error_description || r.data.error || r.status;
        throw new ApiError("Spotify: не удалось получить токен (" + desc + "). Проверьте Client ID и Secret.");
      }
      spotify = {
        token: r.data.access_token,
        expires: Date.now() + (parseInt(r.data.expires_in || 3600, 10) * 1000),
        id: cfg.id,
        secret: cfg.secret
      };
      return spotify.token;
    }

    /** mode: "track" — обычный поиск, "artist" — фильтр по исполнителю. -> {tracks, total} */
    async function searchTracks(cfg, query, mode, offset) {
      var token = await spotifyToken(cfg);
      var q = mode === "artist" ? 'artist:"' + query + '"' : query;
      var qs = new URLSearchParams({ q: q, type: "track", limit: String(PAGE_SIZE), offset: String(offset || 0) });
      var r = await fetchJson("GET", spSearchUrl + "?" + qs.toString(), { "Authorization": "Bearer " + token }, "");
      if (r.status === 429) throw new ApiError("Spotify: слишком много запросов, подождите минуту.");
      if (r.status !== 200) {
        var err = r.data && r.data.error;
        var msg = err && typeof err === "object" ? err.message : err;
        throw new ApiError("Spotify: HTTP " + r.status + " — " + msg);
      }
      var block = r.data.tracks || {};
      var tracks = (block.items || []).filter(Boolean).map(parseSpotifyTrack);
      return { tracks: tracks, total: parseInt(block.total || 0, 10) };
    }

    return {
      getToken: getToken,
      authUrl: authUrl,
      getSession: getSession,
      sendScrobbles: sendScrobbles,
      searchTracks: searchTracks
    };
  }

  return {
    ApiError: ApiError,
    createApi: createApi,
    lastfmSign: lastfmSign,
    parseSpotifyTrack: parseSpotifyTrack,
    effDuration: effDuration,
    fmtDur: fmtDur,
    fmtTotal: fmtTotal,
    fmtLocal: fmtLocal,
    dateValue: dateValue,
    timeValue: timeValue,
    parseStart: parseStart,
    totalCount: totalCount,
    totalSeconds: totalSeconds,
    buildPlan: buildPlan,
    endNowStart: endNowStart,
    checkPlan: checkPlan,
    BATCH_SIZE: BATCH_SIZE,
    PAGE_SIZE: PAGE_SIZE,
    MAX_AGE_DAYS: MAX_AGE_DAYS
  };
});
