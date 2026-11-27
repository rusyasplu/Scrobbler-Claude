// Тесты ядра на имитации серверов Last.fm и Spotify. Запуск: node tests/test-core.js
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "app", "src", "main", "assets", "www", "core.js"));
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("base64url");

const SECRET = "SECRET";
const state = {
  batches: [], badSig: 0, calls: [],
  paths: [],                       // все запросы к Spotify (путь + строка запроса)
  challenge: null,                 // code_challenge, который «запомнил» сервер при входе
  validUser: new Set(), refreshToken: null, refreshCalls: 0
};
let base = "";

// ---- данные для имитации Spotify ----
const art = (...names) => names.map((name) => ({ name }));
const ALBUM_META = {
  id: "AL1", name: "Album One", artists: art("Art"), release_date: "2019-05-03", total_tracks: 3,
  images: [{ url: "big" }, { url: "mid" }, { url: "small" }]
};
const ALBUM_TRACKS = [
  { type: "track", name: "One", duration_ms: 60000, artists: art("Art") },
  { type: "track", name: "Two", duration_ms: 61000, artists: art("Art", "Feat") },
  { type: "track", name: "Three", duration_ms: 62000, artists: art("Art") }
];
const SONG = {
  type: "track", name: "Song", duration_ms: 215000, artists: art("Art", "Feat"),
  album: { name: "Album", artists: art("Art"), images: [{ url: "big" }, { url: "mid" }, { url: "small" }] }
};
const trackOf = (name, sec, artists, album) => ({
  type: "track", name, duration_ms: sec * 1000, artists, album
});
const P1_ITEMS = [
  { item: trackOf("Alpha", 100, art("X"), { name: "AlbA", artists: art("X"), images: [{ url: "i1" }] }) },
  { item: { type: "episode", name: "Podcast" } },
  null,
  { item: trackOf("Beta", 200, art("Y", "Z"), { name: "AlbB", artists: art("V"), images: [] }) }
];
const P2_LEGACY_ITEMS = [
  { track: trackOf("Gamma", 90, art("G"), { name: "AlbG", artists: art("G"), images: [] }) }
];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (code, obj) => {
      const b = JSON.stringify(obj);
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(b);
    };
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    // ---- токены Spotify ----
    if (p === "/token") {
      const form = new URLSearchParams(body);
      const gt = form.get("grant_type");
      if (gt === "client_credentials") {
        assert.ok((req.headers.authorization || "").startsWith("Basic "));
        return send(200, { access_token: "TOK", expires_in: 3600 });
      }
      if (gt === "authorization_code") {
        const ok = form.get("code") === "CODE" && form.get("redirect_uri") === "scrobbler://callback" &&
          form.get("client_id") === "id" && sha256(form.get("code_verifier") || "") === state.challenge;
        if (!ok) return send(400, { error: "invalid_grant", error_description: "Invalid authorization code" });
        state.validUser.add("UA1");
        state.refreshToken = "RT1";
        return send(200, { access_token: "UA1", refresh_token: "RT1", expires_in: 3600, token_type: "Bearer" });
      }
      if (gt === "refresh_token") {
        if (form.get("refresh_token") !== state.refreshToken || form.get("client_id") !== "id") {
          return send(400, { error: "invalid_grant", error_description: "Invalid refresh token" });
        }
        state.refreshCalls++;
        const at = "UA" + (state.refreshCalls + 1);
        state.validUser.add(at);
        state.refreshToken = "RT" + (state.refreshCalls + 1);   // Spotify может выдать новый refresh-токен
        return send(200, { access_token: at, refresh_token: state.refreshToken, expires_in: 3600 });
      }
      return send(400, { error: "unsupported_grant_type" });
    }

    // ---- Spotify Web API ----
    if (p.startsWith("/v1/")) {
      state.paths.push(p + (url.search || ""));
      const bearer = (req.headers.authorization || "").replace("Bearer ", "");
      const isUserApi = p.startsWith("/v1/me") || p.startsWith("/v1/playlists");
      if (isUserApi && !state.validUser.has(bearer)) {
        return send(401, { error: { status: 401, message: "The access token expired" } });
      }
      if (!isUserApi && bearer !== "TOK") return send(401, { error: { status: 401, message: "Invalid access token" } });

      if (p === "/v1/search") {
        assert.equal(url.searchParams.get("limit"), "10");
        state.lastQuery = url.searchParams.get("q");
        if (url.searchParams.get("type") === "album") {
          return send(200, { albums: { total: 7, items: [ALBUM_META, null] } });
        }
        return send(200, { tracks: { total: 42, items: [SONG, null] } });
      }
      if (p === "/v1/tracks/QUOTA") return send(429, { error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" } });
      if (p === "/v1/tracks/RATE") return send(429, { error: { status: 429, message: "API rate limit exceeded" } });
      if (p === "/v1/tracks/NOPREMIUM") return send(403, { error: { status: 403, message: "Active premium subscription required for the owner of the app" } });
      if (p === "/v1/tracks/T1") return send(200, SONG);
      if (p.startsWith("/v1/tracks/")) return send(404, { error: { status: 404, message: "Non existing id" } });

      if (p === "/v1/albums/AL1") return send(200, ALBUM_META);
      if (p === "/v1/albums/AL1/tracks") {
        const off = parseInt(url.searchParams.get("offset") || "0", 10);
        if (off === 0) {
          return send(200, { items: ALBUM_TRACKS.slice(0, 2), total: 3, next: base + "/v1/albums/AL1/tracks?limit=50&offset=2" });
        }
        return send(200, { items: ALBUM_TRACKS.slice(2), total: 3, next: null });
      }
      if (p.startsWith("/v1/albums/")) return send(404, { error: { status: 404, message: "Non existing id" } });

      if (p === "/v1/me") return send(200, { id: "me", display_name: "Me" });
      if (p === "/v1/me/playlists") {
        return send(200, {
          total: 3, next: null,
          items: [
            { id: "P1", name: "Мой плейлист", owner: { id: "me", display_name: "Me" }, items: { total: 4 }, images: [{ url: "pa" }, { url: "pb" }] },
            { id: "P2", name: "Совместный", collaborative: true, owner: { id: "friend", display_name: "Friend" }, tracks: { total: 1 }, images: [] },
            { id: "P3", name: "Чужой", owner: { id: "other", display_name: "Other" }, items: { total: 50 }, images: [] }
          ]
        });
      }
      if (p === "/v1/playlists/P1") return send(200, { id: "P1", name: "Мой плейлист", owner: { id: "me", display_name: "Me" }, images: [{ url: "pa" }, { url: "pb" }] });
      if (p === "/v1/playlists/P1/items") return send(200, { items: P1_ITEMS, total: 4, next: null });
      if (p === "/v1/playlists/P2") return send(200, { id: "P2", name: "Совместный", collaborative: true, owner: { id: "friend" }, images: [] });
      if (p === "/v1/playlists/P2/items") return send(404, { error: { status: 404, message: "Not found" } });
      if (p === "/v1/playlists/P2/tracks") return send(200, { items: P2_LEGACY_ITEMS, total: 1, next: null });
      if (p === "/v1/playlists/P3") return send(200, { id: "P3", name: "Чужой", owner: { id: "other" }, images: [] });
      if (p === "/v1/playlists/P3/items") return send(403, { error: { status: 403, message: "Forbidden" } });
      if (p.startsWith("/v1/playlists/")) return send(404, { error: { status: 404, message: "Not found" } });
    }

    // ---- Last.fm ----
    if (p === "/lfm") {
      const q = {};
      const src = req.method === "POST" ? new URLSearchParams(body) : url.searchParams;
      for (const [k, v] of src) q[k] = v;
      const sig = q.api_sig;
      delete q.api_sig;
      if (Core.lastfmSign(q, SECRET, md5) !== sig) {
        state.badSig++;
        return send(403, { error: 13, message: "Invalid method signature supplied" });
      }
      state.calls.push(q.method);
      if (q.method === "auth.getToken") return send(200, { token: "TKN" });
      if (q.method === "auth.getSession") {
        if (q.token !== "TKN") return send(403, { error: 14, message: "Unauthorized Token" });
        return send(200, { session: { name: "tester", key: "SESSIONKEY", subscriber: 0 } });
      }
      if (q.method === "track.scrobble") {
        if (q.sk !== "SK") return send(403, { error: 9, message: "Invalid session key" });
        let n = 0;
        while (("artist[" + n + "]") in q) n++;
        const items = [];
        let ign = 0;
        const now = Date.now() / 1000;
        for (let i = 0; i < n; i++) {
          const t = parseInt(q["timestamp[" + i + "]"], 10);
          const code = now - t > 14 * 86400 ? "3" : "0";
          if (code !== "0") ign++;
          items.push({
            artist: { "#text": q["artist[" + i + "]"] }, track: { "#text": q["track[" + i + "]"] },
            timestamp: String(t), ignoredMessage: { code, "#text": "" }
          });
        }
        state.batches.push(n);
        state.lastScrobbleQuery = q;
        return send(200, { scrobbles: { "@attr": { accepted: n - ign, ignored: ign }, scrobble: n > 1 ? items : items[0] } });
      }
    }
    send(404, { error: 6, message: "not found" });
  });
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const CFG = { id: "id", secret: "sec" };
let user = null;   // сессия пользователя Spotify, общая для тестов входа и плейлистов

// ---------- сайт: копия ядра и свои хеши ----------

test("сайт: docs/core.js совпадает с ядром приложения, хеши совпадают с Node crypto", () => {
  const fs = require("node:fs");
  const app = fs.readFileSync(path.join(__dirname, "..", "app", "src", "main", "assets", "www", "core.js"), "utf8");
  const site = fs.readFileSync(path.join(__dirname, "..", "docs", "core.js"), "utf8");
  assert.equal(site, app, "после правки core.js скопируйте его в docs/core.js");
  const H = require(path.join(__dirname, "..", "docs", "hash.js"));
  for (const s of ["", "abc", "Привет ♪ 🎵", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000)]) {
    assert.equal(H.md5(s), md5(s));
    assert.equal(H.sha256(s), sha256(s));
  }
});

test("свой адрес возврата Spotify (сайт) попадает в ссылку входа", () => {
  const web = Core.createApi({ http: async () => ({ status: 0 }), md5, sha256 }, { redirectUri: "https://u.github.io/Scrobbler-Claude/" });
  assert.equal(web.redirectUri, "https://u.github.io/Scrobbler-Claude/");
  const u = new URL(web.spotifyAuthUrl(CFG, "st", "ch"));
  assert.equal(u.searchParams.get("redirect_uri"), "https://u.github.io/Scrobbler-Claude/");
  assert.equal(Core.createApi({ http: async () => ({ status: 0 }), md5, sha256 }, {}).redirectUri, "scrobbler://callback");
});

// ---------- время, план, подпись ----------

test("подпись: порядок параметров, массивы, юникод", () => {
  const p = { api_key: "xxx", method: "auth.getSession", token: "yyy", format: "json" };
  assert.equal(Core.lastfmSign(p, "zzz", md5), md5("api_keyxxxmethodauth.getSessiontokenyyyzzz"));
  const p2 = { "artist[1]": "Б", "artist[0]": "А", api_key: "k", method: "track.scrobble", sk: "s" };
  assert.equal(Core.lastfmSign(p2, "sec", md5), md5("api_keykartist[0]Аartist[1]Бmethodtrack.scrobblesks" + "sec"));
});

test("план: метки времени идут подряд, короткие треки округляются до 30 с", () => {
  const t1 = { artist: "A", title: "One", album: "Alb", albumArtist: "A", durationS: 200 };
  const t2 = { artist: "B", title: "Two", album: "", albumArtist: "B", durationS: 10 };
  const start = new Date(2026, 10, 20, 12, 0).getTime();
  const plan = Core.buildPlan([{ track: t1, count: 2 }, { track: t2, count: 2 }], start);
  assert.deepEqual(plan.map((x) => x.ts - plan[0].ts), [0, 200, 400, 430]);
  assert.equal(Core.totalSeconds([{ track: t1, count: 2 }, { track: t2, count: 2 }]), 460);
});

test("parseStart: корректные и неверные даты", () => {
  assert.equal(Core.parseStart("2026-11-24", "18:30"), new Date(2026, 10, 24, 18, 30).getTime());
  assert.equal(Core.parseStart("2026-02-31", "10:00"), null);
  assert.equal(Core.parseStart("2026-11-24", "25:00"), null);
  assert.equal(Core.parseStart("24.11.2026", "10:00"), null);
});

test("checkPlan и endNowStart", () => {
  const t = { artist: "A", title: "T", album: "", albumArtist: "A", durationS: 240 };
  const items = [{ track: t, count: 10 }];
  const now = new Date(2026, 10, 25, 12, 0).getTime();
  assert.equal(Core.checkPlan([], now, now).level, "empty");
  assert.equal(Core.checkPlan(items, null, now).code, "bad_date");
  assert.equal(Core.checkPlan(items, now, now).code, "future");
  assert.equal(Core.checkPlan(items, now - 20 * 86400000, now).code, "old");
  assert.equal(Core.checkPlan(items, now - 3 * 86400000, now).level, "ok");
  const s = Core.endNowStart(items, now);
  assert.ok(Core.checkPlan(items, s, now).level === "ok" && s % 60000 === 0 && s <= now - 2400 * 1000 + 1);
});

// ---------- альбомы и плейлисты в очереди ----------

const mk = (title, sec, artist) => ({ artist: artist || "A", title, album: "Alb", albumArtist: "A", durationS: sec, cover: "" });
const ALB = { kind: "album", id: "AL1", name: "Alb", sub: "A", cover: "c", tracks: [mk("a1", 100), mk("a2", 200), mk("a3", 300)] };

test("очередь: коллекция повторяется целиком, дубликаты склеиваются", () => {
  const single = mk("solo", 50);
  const q = [];
  Core.addToQueue(q, Core.collectionEntry(ALB, 2));
  Core.addToQueue(q, Core.trackEntry(single, 1));
  Core.addToQueue(q, Core.collectionEntry(ALB, 1));              // тот же альбом -> счётчик 3
  Core.addToQueue(q, Core.trackEntry(Object.assign({}, single), 2)); // тот же трек -> счётчик 3
  Core.addToQueue(q, Core.collectionEntry(Object.assign({}, ALB, { kind: "playlist" }), 1)); // другой вид с тем же id — отдельный элемент
  assert.equal(q.length, 3);
  assert.deepEqual(q.map((x) => x.count), [3, 3, 1]);
  assert.equal(Core.totalCount(q), 3 * 3 + 3 + 3);
  assert.equal(Core.totalSeconds(q), 3 * 600 + 3 * 50 + 600);
  assert.equal(Core.isCollection(q[0]), true);
  assert.equal(Core.isCollection(q[1]), false);
  assert.equal(Core.collectionSeconds(ALB), 600);
});

test("план: альбом ×2 идёт треками 1…N, потом снова 1…N, затем одиночный трек", () => {
  const start = new Date(2026, 10, 20, 12, 0).getTime();
  const items = [Core.collectionEntry(ALB, 2), Core.trackEntry(mk("solo", 50), 1)];
  const plan = Core.buildPlan(items, start);
  assert.deepEqual(plan.map((x) => x.track.title), ["a1", "a2", "a3", "a1", "a2", "a3", "solo"]);
  assert.deepEqual(plan.map((x) => x.ts - plan[0].ts), [0, 100, 300, 600, 700, 900, 1200]);
  assert.equal(Core.totalCount(items), 7);
  assert.equal(Core.totalSeconds(items), 1250);
  assert.equal(Core.lastTrack(items).title, "solo");
  assert.equal(Core.lastTrack([Core.collectionEntry(ALB, 1)]).title, "a3");
  assert.equal(Core.lastTrack([]), null);
});

test("checkPlan и endNowStart учитывают коллекции", () => {
  const now = new Date(2026, 10, 25, 12, 0).getTime();
  const items = [Core.collectionEntry(ALB, 2), Core.trackEntry(mk("solo", 50), 1)];   // 1250 с
  assert.equal(Core.checkPlan(items, now, now).code, "future");
  assert.equal(Core.checkPlan(items, now - 1300 * 1000, now).level, "ok");   // последний трек стартует на 100 с раньше «сейчас»
  assert.equal(Core.checkPlan(items, now - 1100 * 1000, now).code, "future");
  const s = Core.endNowStart(items, now);
  assert.ok(s % 60000 === 0 && Core.checkPlan(items, s, now).level === "ok");
  assert.equal(Core.checkPlan([Core.collectionEntry(ALB, 1)], now - 20 * 86400000, now).code, "old");
});

test("ссылки Spotify: разбор url и uri", () => {
  assert.deepEqual(Core.parseSpotifyLink("https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?si=abc"), { type: "album", id: "4aawyAB9vmqN3uQ7FjRGTy" });
  assert.deepEqual(Core.parseSpotifyLink(" https://open.spotify.com/intl-ru/playlist/37i9dQZF1DXcBWIGoYBM5M "), { type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
  assert.deepEqual(Core.parseSpotifyLink("spotify:track:6rqhFgbbKwnb9MLmUQDhG6"), { type: "track", id: "6rqhFgbbKwnb9MLmUQDhG6" });
  assert.equal(Core.parseSpotifyLink("просто текст"), null);
  assert.equal(Core.parseSpotifyLink("https://example.com/album/abc"), null);
});

test("разбор объектов Spotify: альбом и плейлист (старая и новая форма полей)", () => {
  assert.deepEqual(Core.parseSpotifyAlbum(ALBUM_META),
    { id: "AL1", kind: "album", name: "Album One", sub: "Art", year: "2019", total: 3, cover: "mid" });
  const base = { id: "p", name: "N", owner: { id: "u", display_name: "U" }, images: [{ url: "a" }, { url: "b" }] };
  assert.equal(Core.parsePlaylist(Object.assign({ items: { total: 5 } }, base)).total, 5);
  assert.equal(Core.parsePlaylist(Object.assign({ tracks: { total: 7 } }, base)).total, 7);
  const pl = Core.parsePlaylist(Object.assign({ collaborative: true }, base));
  assert.deepEqual([pl.sub, pl.ownerId, pl.collaborative, pl.cover, pl.total], ["U", "u", true, "b", 0]);
});

// ---------- Spotify: поиск, треки, альбомы ----------

test("Spotify: токен, поиск, фильтр по артисту, разбор трека", async (env) => {
  const api = env.api;
  const r = await api.searchTracks(CFG, "Art", "artist", 0);
  assert.equal(state.lastQuery, 'artist:"Art"');
  assert.equal(r.total, 42);
  assert.equal(r.tracks.length, 1);
  assert.deepEqual(r.tracks[0], { artist: "Art", title: "Song", album: "Album", albumArtist: "Art", durationS: 215, cover: "mid" });
  await api.searchTracks(CFG, "Song", "track", 10);
  assert.equal(state.lastQuery, "Song");
});

test("Spotify: поиск альбомов и трек по ссылке", async (env) => {
  const r = await env.api.searchAlbums(CFG, "Album One", 0);
  assert.equal(r.total, 7);
  assert.deepEqual(r.albums, [{ id: "AL1", kind: "album", name: "Album One", sub: "Art", year: "2019", total: 3, cover: "mid" }]);
  const t = await env.api.getTrack(CFG, "T1");
  assert.equal(t.title, "Song");
  await assert.rejects(env.api.getTrack(CFG, "NOPE"), (e) => e.code === 404);
});

test("Spotify: понятные сообщения об исчерпанной квоте, лимите частоты и 403", async (env) => {
  await assert.rejects(env.api.getTrack(CFG, "QUOTA"), (e) => e.code === 429 && /исчерпана квота Development Mode/.test(e.message));
  await assert.rejects(env.api.getTrack(CFG, "RATE"), (e) => e.code === 429 && /слишком много запросов/.test(e.message));
  await assert.rejects(env.api.getTrack(CFG, "NOPREMIUM"), (e) => e.code === 403 && /Premium/.test(e.message) && /premium subscription required/.test(e.message));
});

test("Last.fm: к коду ошибки добавляется подсказка", async (env) => {
  await assert.rejects(env.api.sendScrobbles(Core.buildPlan([{ track: { artist: "A", title: "T", album: "", albumArtist: "A", durationS: 200 }, count: 1 }], Date.now() - 3600000),
    { key: "KEY", secret: SECRET, sk: "BAD" }, { pause: 0 }), (e) => e.code === 9 && /войдите в Last\.fm заново/.test(e.message));
});

test("Spotify: альбом целиком — страницы склеиваются, альбом и исполнитель альбома подставлены", async (env) => {
  state.paths.length = 0;
  const a = await env.api.getAlbum(CFG, "AL1");
  assert.equal(a.kind, "album");
  assert.equal(a.name, "Album One");
  assert.equal(a.sub, "Art");
  assert.equal(a.cover, "mid");
  assert.deepEqual(a.tracks.map((t) => t.title), ["One", "Two", "Three"]);
  assert.deepEqual(a.tracks[1], { artist: "Art", title: "Two", album: "Album One", albumArtist: "Art", durationS: 61, cover: "" });
  assert.ok(state.paths.some((x) => x.includes("/tracks?limit=50&offset=0")));
  assert.ok(state.paths.some((x) => x.includes("offset=2")), "вторая страница должна быть загружена по next");
  await assert.rejects(env.api.getAlbum(CFG, "NOPE"), (e) => e.code === 404);
});

// ---------- Spotify: вход (PKCE) и плейлисты ----------

test("вход в Spotify: PKCE — ссылка, обмен кода, неверный verifier отклонён", async (env) => {
  const pk = env.api.newPkce();
  assert.equal(pk.verifier.length, 64);
  assert.ok(/^[A-Za-z0-9\-._~]+$/.test(pk.verifier));
  assert.equal(pk.challenge, sha256(pk.verifier));
  const u = new URL(env.api.spotifyAuthUrl(CFG, pk.state, pk.challenge));
  assert.equal(u.origin + u.pathname, "https://accounts.spotify.com/authorize");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "id");
  assert.equal(u.searchParams.get("redirect_uri"), "scrobbler://callback");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), pk.state);
  assert.ok(u.searchParams.get("scope").includes("playlist-read-private"));
  assert.ok(u.searchParams.get("scope").includes("playlist-read-collaborative"));
  state.challenge = u.searchParams.get("code_challenge");

  await assert.rejects(env.api.spotifyLogin(CFG, "CODE", "wrong-verifier"), /вход не удался/);
  user = await env.api.spotifyLogin(CFG, "CODE", pk.verifier);
  assert.equal(user.access, "UA1");
  assert.equal(user.refresh, "RT1");
  assert.ok(user.expires > Date.now() + 3000 * 1000);
});

test("плейлисты: список — только свои и совместные; просроченный токен обновляется сам", async (env) => {
  assert.equal(state.refreshCalls, 0);
  user.expires = 0;                          // токен «протух»
  const r = await env.api.myPlaylists(CFG, user);
  assert.equal(state.refreshCalls, 1);
  assert.equal(user.access, "UA2");
  assert.equal(user.refresh, "RT2", "новый refresh-токен должен сохраниться");
  assert.deepEqual(r.playlists.map((p) => p.id), ["P1", "P2"]);
  assert.equal(r.hidden, 1);
  assert.deepEqual(r.playlists[0], { id: "P1", kind: "playlist", name: "Мой плейлист", sub: "Me", ownerId: "me", collaborative: false, total: 4, cover: "pb" });
  assert.equal(r.playlists[1].total, 1);
});

test("плейлист целиком: пропускает эпизоды и пустые позиции, читает поле item", async (env) => {
  const pl = await env.api.getPlaylist(CFG, user, "P1");
  assert.equal(pl.kind, "playlist");
  assert.equal(pl.name, "Мой плейлист");
  assert.equal(pl.sub, "Me");
  assert.equal(pl.skipped, 2);
  assert.deepEqual(pl.tracks, [
    { artist: "X", title: "Alpha", album: "AlbA", albumArtist: "X", durationS: 100, cover: "" },
    { artist: "Y", title: "Beta", album: "AlbB", albumArtist: "V", durationS: 200, cover: "" }
  ]);
});

test("плейлист: 401 -> токен обновляется и запрос повторяется; запасной адрес /tracks", async (env) => {
  const before = state.refreshCalls;
  state.validUser.delete(user.access);       // сервер отозвал токен, хотя по времени он ещё «жив»
  state.paths.length = 0;
  const pl = await env.api.getPlaylist(CFG, user, "P2");
  assert.equal(state.refreshCalls, before + 1);
  assert.deepEqual(pl.tracks.map((t) => t.title), ["Gamma"]);
  assert.ok(state.paths.some((x) => x.startsWith("/v1/playlists/P2/items")));
  assert.ok(state.paths.some((x) => x.startsWith("/v1/playlists/P2/tracks")));
});

test("плейлист: чужой (403), несуществующий (404) и вход не выполнен", async (env) => {
  await assert.rejects(env.api.getPlaylist(CFG, user, "P3"), (e) => e.code === 403 && /собственные и совместные/.test(e.message));
  await assert.rejects(env.api.getPlaylist(CFG, user, "NOPE"), (e) => e.code === 404);
  await assert.rejects(env.api.getPlaylist(CFG, null, "P1"), (e) => e.code === "no_user");
  await assert.rejects(env.api.myPlaylists(CFG, {}), (e) => e.code === "no_user");
  const dead = { access: "x", refresh: "BAD", expires: 0 };
  await assert.rejects(env.api.getPlaylist(CFG, dead, "P1"), (e) => e.code === "relogin");
});

// ---------- Last.fm ----------

test("авторизация Last.fm: token -> session; токен не разрешён -> код 14", async (env) => {
  const creds = { key: "KEY", secret: SECRET };
  const token = await env.api.getToken(creds);
  assert.equal(token, "TKN");
  assert.ok(env.api.authUrl(creds, token).startsWith("https://www.last.fm/api/auth/?api_key=KEY&token=TKN"));
  assert.deepEqual(await env.api.getSession(creds, token), { name: "tester", key: "SESSIONKEY" });
  await assert.rejects(env.api.getSession(creds, "BAD"), (e) => e.code === 14);
});

test("отправка: 120 скробблов -> пакеты 50/50/20, прогресс, подпись верна", async (env) => {
  state.batches.length = 0;
  const t = { artist: "A", title: "One", album: "Alb", albumArtist: "A", durationS: 200 };
  const plan = Core.buildPlan([{ track: t, count: 120 }], Date.now() - 10 * 3600 * 1000);
  const logs = [], prog = [];
  const r = await env.api.sendScrobbles(plan, { key: "KEY", secret: SECRET, sk: "SK" },
    { log: (m) => logs.push(m), progress: (d, n) => prog.push([d, n]), pause: 0 });
  assert.deepEqual(r, { accepted: 120, ignored: 0 });
  assert.deepEqual(state.batches, [50, 50, 20]);
  assert.deepEqual(prog, [[50, 120], [100, 120], [120, 120]]);
  assert.equal(state.badSig, 0);
});

test("отправка альбома: порядок треков, альбом и исполнитель альбома уходят в Last.fm", async (env) => {
  state.batches.length = 0;
  const album = Object.assign({}, ALB, { sub: "VA" });
  const tracks = ["a1", "a2", "a3"].map((n, i) => Object.assign(mk(n, 100 + i, i === 1 ? "Guest" : "A"), { albumArtist: "VA" }));
  const plan = Core.buildPlan([Core.collectionEntry(Object.assign(album, { tracks }), 1)], Date.now() - 3600 * 1000);
  const r = await env.api.sendScrobbles(plan, { key: "KEY", secret: SECRET, sk: "SK" }, { pause: 0 });
  assert.deepEqual(r, { accepted: 3, ignored: 0 });
  const q = state.lastScrobbleQuery;
  assert.deepEqual([q["track[0]"], q["track[1]"], q["track[2]"]], ["a1", "a2", "a3"]);
  assert.equal(q["artist[1]"], "Guest");
  assert.equal(q["album[0]"], "Alb");
  assert.equal(q["albumArtist[0]"], "VA");
  assert.equal(q["albumArtist[1]"], "VA");
  assert.equal(state.badSig, 0);
});

test("отправка: одиночный скроббл (объект, не массив) и старая дата -> отклонён", async (env) => {
  const t = { artist: "A", title: "One", album: "Alb", albumArtist: "A", durationS: 200 };
  const plan = Core.buildPlan([{ track: t, count: 1 }], Date.now() - 30 * 86400000);
  const logs = [];
  const r = await env.api.sendScrobbles(plan, { key: "KEY", secret: SECRET, sk: "SK" }, { log: (m) => logs.push(m), pause: 0 });
  assert.deepEqual(r, { accepted: 0, ignored: 1 });
  assert.ok(logs.some((l) => l.includes("дата слишком старая")));
});

test("отправка: остановка пользователем и ошибки API", async (env) => {
  const t = { artist: "A", title: "One", album: "", albumArtist: "A", durationS: 200 };
  const plan = Core.buildPlan([{ track: t, count: 120 }], Date.now() - 10 * 3600 * 1000);
  let calls = 0;
  const r = await env.api.sendScrobbles(plan, { key: "KEY", secret: SECRET, sk: "SK" },
    { pause: 0, shouldStop: () => calls++ >= 1 });
  assert.equal(r.accepted, 50); // один пакет ушёл, потом стоп
  await assert.rejects(env.api.sendScrobbles(plan.slice(0, 1), { key: "KEY", secret: "WRONG", sk: "SK" }, { pause: 0 }),
    (e) => e.code === 13);
  await assert.rejects(env.api.sendScrobbles(plan.slice(0, 1), { key: "KEY", secret: SECRET, sk: "BAD" }, { pause: 0 }),
    (e) => e.code === 9);
});

test("сеть недоступна -> понятная ошибка", async () => {
  const api = Core.createApi({ http: async () => ({ status: 0, error: "timeout" }), md5, sha256 }, {});
  await assert.rejects(api.getToken({ key: "k", secret: "s" }), /Нет соединения: timeout/);
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  const env = {
    http: async (method, url, headers, body) => {
      const r = await fetch(url, { method, headers, body: method === "POST" ? body : undefined });
      return { status: r.status, body: await r.text() };
    },
    md5,
    sha256
  };
  const api = Core.createApi(env, { lastfmApi: base + "/lfm", spotifyTokenUrl: base + "/token", spotifyApi: base + "/v1" });
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn({ api }); console.log("  ok   " + name); }
    catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e)); }
  }
  server.close();
  console.log(failed ? `\n${failed} тест(ов) упало` : "\nВсе тесты пройдены");
  process.exit(failed ? 1 : 0);
})();
