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
  var SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
  var SPOTIFY_API = "https://api.spotify.com/v1";
  // этот адрес нужно добавить в Redirect URIs приложения на developer.spotify.com/dashboard
  var SPOTIFY_REDIRECT_URI = "scrobbler://callback";
  var SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative";
  var MAX_COLLECTION_TRACKS = 1000;   // предохранитель для огромных плейлистов

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

  // ---- очередь: одиночные треки и целые альбомы / плейлисты ---------------------
  // Элемент очереди: {track, count} — один трек count раз,
  //                  {kind: "album"|"playlist", id, name, sub, cover, tracks: [...], count} —
  //                  вся коллекция целиком count раз подряд (трек 1…N, потом снова 1…N).

  function itemTracks(q) { return q.tracks || (q.track ? [q.track] : []); }
  function isCollection(q) { return !!q.tracks; }

  function sameTrack(a, b) { return a.artist === b.artist && a.title === b.title && a.album === b.album; }

  function trackEntry(track, count) { return { track: track, count: count }; }

  function collectionEntry(coll, count) {
    return { kind: coll.kind, id: coll.id, name: coll.name, sub: coll.sub || "", cover: coll.cover || "",
      tracks: coll.tracks, count: count };
  }

  /** Добавляет элемент; такой же трек / та же коллекция увеличивают счётчик, а не дублируются. */
  function addToQueue(items, entry) {
    for (var i = 0; i < items.length; i++) {
      var q = items[i];
      var same = isCollection(entry)
        ? (isCollection(q) && q.kind === entry.kind && q.id === entry.id)
        : (!isCollection(q) && q.track && sameTrack(q.track, entry.track));
      if (same) { q.count += entry.count; return items; }
    }
    items.push(entry);
    return items;
  }

  function collectionSeconds(coll) {
    return coll.tracks.reduce(function (a, t) { return a + effDuration(t); }, 0);
  }

  function itemCount(q) { return q.count * itemTracks(q).length; }

  function itemSeconds(q) {
    return q.count * itemTracks(q).reduce(function (a, t) { return a + effDuration(t); }, 0);
  }

  function totalCount(items) {
    return items.reduce(function (a, q) { return a + itemCount(q); }, 0);
  }

  function totalSeconds(items) {
    return items.reduce(function (a, q) { return a + itemSeconds(q); }, 0);
  }

  /** Последний трек очереди (по порядку проигрывания) или null. */
  function lastTrack(items) {
    for (var i = items.length - 1; i >= 0; i--) {
      var ts = itemTracks(items[i]);
      if (ts.length && items[i].count > 0) return ts[ts.length - 1];
    }
    return null;
  }

  /** Раскладывает очередь в [{track, ts}]: прослушивания идут подряд,
   *  каждое начинается, когда закончилось предыдущее. ts — unix-секунды. */
  function buildPlan(items, startMs) {
    var ts = Math.floor(startMs / 1000);
    var plan = [];
    items.forEach(function (q) {
      var tracks = itemTracks(q);
      for (var r = 0; r < q.count; r++) {
        for (var i = 0; i < tracks.length; i++) {
          plan.push({ track: tracks[i], ts: ts });
          ts += effDuration(tracks[i]);
        }
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
    var lastStartMs = endMs - effDuration(lastTrack(items)) * 1000;
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

  function midImage(images) {
    images = images || [];
    return images.length ? (images[Math.min(1, images.length - 1)].url || "") : "";
  }

  function parseSpotifyAlbum(a) {
    var artists = a.artists || [];
    return {
      id: a.id || "",
      kind: "album",
      name: a.name || "",
      sub: artists.length ? (artists[0].name || "") : "",
      year: (a.release_date || "").slice(0, 4),
      total: a.total_tracks || 0,
      cover: midImage(a.images)
    };
  }

  function parsePlaylist(p) {
    var cnt = p.items && !Array.isArray(p.items) && typeof p.items === "object" ? p.items : p.tracks;
    var owner = p.owner || {};
    return {
      id: p.id || "",
      kind: "playlist",
      name: p.name || "",
      sub: owner.display_name || owner.id || "",
      ownerId: owner.id || "",
      collaborative: !!p.collaborative,
      total: cnt && cnt.total ? cnt.total : 0,
      cover: midImage(p.images)
    };
  }

  /** Ссылка или URI Spotify -> {type: track|album|playlist|artist, id} либо null. */
  function parseSpotifyLink(text) {
    var s = (text || "").trim();
    var m = /^spotify:(track|album|playlist|artist):([A-Za-z0-9]+)$/.exec(s);
    if (!m) m = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:embed\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)/.exec(s);
    return m ? { type: m[1], id: m[2] } : null;
  }

  var RAND_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

  function randomString(n) {
    var c = typeof globalThis !== "undefined" ? globalThis.crypto : null;
    if (!c || !c.getRandomValues) throw new ApiError("В этой среде нет генератора случайных чисел.");
    var bytes = new Uint8Array(n);
    c.getRandomValues(bytes);
    var out = "";
    for (var i = 0; i < n; i++) out += RAND_CHARS.charAt(bytes[i] % RAND_CHARS.length);
    return out;
  }

  var PLAYLIST_FORBIDDEN = "Spotify не отдаёт содержимое этого плейлиста: с февраля 2026 доступны только ваши собственные и совместные плейлисты.";
  var RELOGIN = "Сессия Spotify истекла. Войдите заново на вкладке «Профиль».";

  /**
   * env: { http(method, url, headers, body) -> Promise<{status, body, error?}>, md5(str) -> hex,
   *        sha256(str) -> base64url (для входа в Spotify), sleep?(ms) }
   * opts: { lastfmApi, spotifyTokenUrl, spotifyApi } — для тестов.
   */
  function createApi(env, opts) {
    opts = opts || {};
    var lfmUrl = opts.lastfmApi || LASTFM_API;
    var spTokenUrl = opts.spotifyTokenUrl || SPOTIFY_TOKEN_URL;
    var spBase = opts.spotifyApi || SPOTIFY_API;
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

    function spError(r) {
      if (r.status === 429) return new ApiError("Spotify: слишком много запросов, подождите минуту.", 429);
      var err = r.data && r.data.error;
      var msg = err && typeof err === "object" ? err.message : err;
      return new ApiError("Spotify: HTTP " + r.status + (msg ? " — " + msg : ""), r.status);
    }

    var FORM = { "Content-Type": "application/x-www-form-urlencoded" };

    /** Токен приложения (Client Credentials): поиск, альбомы, треки. */
    async function spotifyToken(cfg, force) {
      if (!force && spotify.token && spotify.id === cfg.id && spotify.secret === cfg.secret &&
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

    /** Токен пользователя (вход через PKCE): плейлисты. user = {access, refresh, expires} — обновляется на месте. */
    async function userToken(cfg, user, force) {
      if (!user || !user.refresh) throw new ApiError("Войдите в Spotify на вкладке «Профиль».", "no_user");
      if (!force && user.access && Date.now() < (user.expires || 0) - 30000) return user.access;
      var body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: user.refresh, client_id: cfg.id }).toString();
      var r = await fetchJson("POST", spTokenUrl, FORM, body);
      if (r.status !== 200 || !r.data.access_token) throw new ApiError(RELOGIN, "relogin");
      user.access = r.data.access_token;
      user.expires = Date.now() + (parseInt(r.data.expires_in || 3600, 10) * 1000);
      if (r.data.refresh_token) user.refresh = r.data.refresh_token;
      return user.access;
    }

    function appAuth(cfg) { return function (force) { return spotifyToken(cfg, force); }; }
    function userAuth(cfg, user) { return function (force) { return userToken(cfg, user, force); }; }

    /** GET с токеном; при 401 один раз обновляет токен и повторяет. Возвращает {status, data}. */
    async function spGet(auth, url) {
      var token = await auth(false);
      var r = await fetchJson("GET", url, { "Authorization": "Bearer " + token }, "");
      if (r.status === 401) {
        token = await auth(true);
        r = await fetchJson("GET", url, { "Authorization": "Bearer " + token }, "");
      }
      return r;
    }

    /** Листает постраничный ответ ({items, next}) до конца или до max элементов. */
    async function pageAll(auth, url, max) {
      var out = [];
      while (url && out.length < max) {
        var r = await spGet(auth, url);
        if (r.status !== 200) throw spError(r);
        var block = r.data || {};
        var items = block.items || [];
        out = out.concat(items);
        url = items.length ? block.next : null;
      }
      return out.slice(0, max);
    }

    // --- вход в Spotify (Authorization Code + PKCE, без секрета) ---

    function newPkce() {
      if (!env.sha256) throw new ApiError("SHA-256 недоступен в этой среде.");
      var verifier = randomString(64);
      return { verifier: verifier, state: randomString(24), challenge: env.sha256(verifier) };
    }

    function spotifyAuthUrl(cfg, state, challenge) {
      return SPOTIFY_AUTH_URL + "?" + new URLSearchParams({
        response_type: "code", client_id: cfg.id, redirect_uri: SPOTIFY_REDIRECT_URI,
        code_challenge_method: "S256", code_challenge: challenge, state: state, scope: SPOTIFY_SCOPES
      }).toString();
    }

    async function spotifyLogin(cfg, code, verifier) {
      var body = new URLSearchParams({
        grant_type: "authorization_code", code: code, redirect_uri: SPOTIFY_REDIRECT_URI,
        client_id: cfg.id, code_verifier: verifier
      }).toString();
      var r = await fetchJson("POST", spTokenUrl, FORM, body);
      if (r.status !== 200 || !r.data.access_token || !r.data.refresh_token) {
        var desc = r.data.error_description || r.data.error || r.status;
        throw new ApiError("Spotify: вход не удался (" + desc + ").");
      }
      return {
        access: r.data.access_token,
        refresh: r.data.refresh_token,
        expires: Date.now() + (parseInt(r.data.expires_in || 3600, 10) * 1000)
      };
    }

    // --- поиск ---

    /** mode: "track" — обычный поиск, "artist" — фильтр по исполнителю. -> {tracks, total} */
    async function searchTracks(cfg, query, mode, offset) {
      var q = mode === "artist" ? 'artist:"' + query + '"' : query;
      var qs = new URLSearchParams({ q: q, type: "track", limit: String(PAGE_SIZE), offset: String(offset || 0) });
      var r = await spGet(appAuth(cfg), spBase + "/search?" + qs.toString());
      if (r.status !== 200) throw spError(r);
      var block = r.data.tracks || {};
      var tracks = (block.items || []).filter(Boolean).map(parseSpotifyTrack);
      return { tracks: tracks, total: parseInt(block.total || 0, 10) };
    }

    /** -> {albums: [{id, kind, name, sub, year, total, cover}], total} */
    async function searchAlbums(cfg, query, offset) {
      var qs = new URLSearchParams({ q: query, type: "album", limit: String(PAGE_SIZE), offset: String(offset || 0) });
      var r = await spGet(appAuth(cfg), spBase + "/search?" + qs.toString());
      if (r.status !== 200) throw spError(r);
      var block = r.data.albums || {};
      return {
        albums: (block.items || []).filter(Boolean).map(parseSpotifyAlbum),
        total: parseInt(block.total || 0, 10)
      };
    }

    async function getTrack(cfg, id) {
      var r = await spGet(appAuth(cfg), spBase + "/tracks/" + encodeURIComponent(id));
      if (r.status === 404) throw new ApiError("Трек не найден в Spotify.", 404);
      if (r.status !== 200) throw spError(r);
      return parseSpotifyTrack(r.data);
    }

    // --- альбомы и плейлисты ---

    /** Весь альбом: -> {kind: "album", id, name, sub, cover, tracks} */
    async function getAlbum(cfg, id) {
      var auth = appAuth(cfg);
      var safe = encodeURIComponent(id);
      var r = await spGet(auth, spBase + "/albums/" + safe);
      if (r.status === 404) throw new ApiError("Альбом не найден в Spotify.", 404);
      if (r.status !== 200) throw spError(r);
      var info = parseSpotifyAlbum(r.data);
      var raw = await pageAll(auth, spBase + "/albums/" + safe + "/tracks?limit=50&offset=0", MAX_COLLECTION_TRACKS);
      var tracks = raw.filter(function (it) { return it && it.name; }).map(function (it) {
        var artists = it.artists || [];
        return {
          artist: artists.length ? (artists[0].name || info.sub) : info.sub,
          title: it.name,
          album: info.name,
          albumArtist: info.sub,
          durationS: Math.round((it.duration_ms || 0) / 1000),
          cover: ""
        };
      });
      if (!tracks.length) throw new ApiError("В альбоме нет треков.");
      return { kind: "album", id: info.id || id, name: info.name, sub: info.sub, cover: info.cover, tracks: tracks };
    }

    /** Плейлисты текущего пользователя, которые можно прочитать: свои и совместные.
     *  -> {playlists, hidden} (hidden — сколько чужих скрыто). */
    async function myPlaylists(cfg, user) {
      var auth = userAuth(cfg, user);
      var me = await spGet(auth, spBase + "/me");
      if (me.status === 401) throw new ApiError(RELOGIN, "relogin");
      var meId = me.status === 200 && me.data && me.data.id ? me.data.id : null;
      var raw = await pageAll(auth, spBase + "/me/playlists?limit=50", 300);
      var all = raw.filter(Boolean).map(parsePlaylist);
      var list = meId ? all.filter(function (p) { return p.ownerId === meId || p.collaborative; }) : all;
      return { playlists: list, hidden: all.length - list.length };
    }

    /** Весь плейлист: -> {kind: "playlist", id, name, sub, cover, tracks, skipped} */
    async function getPlaylist(cfg, user, id) {
      var auth = userAuth(cfg, user);
      var safe = encodeURIComponent(id);
      var r = await spGet(auth, spBase + "/playlists/" + safe);
      if (r.status === 404) throw new ApiError("Плейлист не найден или недоступен вашему аккаунту.", 404);
      if (r.status === 403) throw new ApiError(PLAYLIST_FORBIDDEN, 403);
      if (r.status === 401) throw new ApiError(RELOGIN, "relogin");
      if (r.status !== 200) throw spError(r);
      var info = parsePlaylist(r.data);
      var raw;
      try {
        // с 2026 года эндпоинт называется /items; старый /tracks оставлен запасным вариантом
        try {
          raw = await pageAll(auth, spBase + "/playlists/" + safe + "/items?limit=50&offset=0", MAX_COLLECTION_TRACKS);
        } catch (e) {
          if (e.code !== 404) throw e;
          raw = await pageAll(auth, spBase + "/playlists/" + safe + "/tracks?limit=50&offset=0", MAX_COLLECTION_TRACKS);
        }
      } catch (e) {
        if (e.code === 403) throw new ApiError(PLAYLIST_FORBIDDEN, 403);
        throw e;
      }
      var tracks = [], skipped = 0;
      raw.forEach(function (it) {
        var t = it && (it.item || it.track);
        if (!t || (t.type && t.type !== "track") || !t.name || !(t.artists && t.artists.length)) { skipped++; return; }
        var tr = parseSpotifyTrack(t);
        tr.cover = "";
        tracks.push(tr);
      });
      if (!tracks.length) throw new ApiError("В плейлисте нет треков, которые можно заскробблить.");
      return { kind: "playlist", id: info.id || id, name: info.name, sub: info.sub, cover: info.cover,
        tracks: tracks, skipped: skipped };
    }

    return {
      getToken: getToken,
      authUrl: authUrl,
      getSession: getSession,
      sendScrobbles: sendScrobbles,
      searchTracks: searchTracks,
      searchAlbums: searchAlbums,
      getTrack: getTrack,
      getAlbum: getAlbum,
      myPlaylists: myPlaylists,
      getPlaylist: getPlaylist,
      newPkce: newPkce,
      spotifyAuthUrl: spotifyAuthUrl,
      spotifyLogin: spotifyLogin
    };
  }

  return {
    ApiError: ApiError,
    createApi: createApi,
    lastfmSign: lastfmSign,
    parseSpotifyTrack: parseSpotifyTrack,
    parseSpotifyAlbum: parseSpotifyAlbum,
    parsePlaylist: parsePlaylist,
    parseSpotifyLink: parseSpotifyLink,
    effDuration: effDuration,
    fmtDur: fmtDur,
    fmtTotal: fmtTotal,
    fmtLocal: fmtLocal,
    dateValue: dateValue,
    timeValue: timeValue,
    parseStart: parseStart,
    itemTracks: itemTracks,
    isCollection: isCollection,
    trackEntry: trackEntry,
    collectionEntry: collectionEntry,
    collectionSeconds: collectionSeconds,
    addToQueue: addToQueue,
    lastTrack: lastTrack,
    totalCount: totalCount,
    totalSeconds: totalSeconds,
    buildPlan: buildPlan,
    endNowStart: endNowStart,
    checkPlan: checkPlan,
    BATCH_SIZE: BATCH_SIZE,
    PAGE_SIZE: PAGE_SIZE,
    MAX_AGE_DAYS: MAX_AGE_DAYS,
    SPOTIFY_REDIRECT_URI: SPOTIFY_REDIRECT_URI
  };
});
