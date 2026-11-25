// Тесты ядра на имитации серверов Last.fm и Spotify. Запуск: node tests/test-core.js
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");

const Core = require(path.join(__dirname, "..", "app", "src", "main", "assets", "www", "core.js"));
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

const SECRET = "SECRET";
const state = { batches: [], badSig: 0, calls: [] };

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
    if (url.pathname === "/token") {
      assert.ok((req.headers.authorization || "").startsWith("Basic "));
      assert.equal(body, "grant_type=client_credentials");
      return send(200, { access_token: "TOK", expires_in: 3600 });
    }
    if (url.pathname === "/search") {
      assert.equal(req.headers.authorization, "Bearer TOK");
      assert.equal(url.searchParams.get("limit"), "10");
      state.lastQuery = url.searchParams.get("q");
      return send(200, {
        tracks: {
          total: 42,
          items: [
            {
              name: "Song", duration_ms: 215000,
              artists: [{ name: "Art" }, { name: "Feat" }],
              album: { name: "Album", artists: [{ name: "Art" }], images: [{ url: "big" }, { url: "mid" }, { url: "small" }] }
            },
            null
          ]
        }
      });
    }
    if (url.pathname === "/lfm") {
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
        return send(200, { scrobbles: { "@attr": { accepted: n - ign, ignored: ign }, scrobble: n > 1 ? items : items[0] } });
      }
    }
    send(404, { error: 6, message: "not found" });
  });
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

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

test("Spotify: токен, поиск, фильтр по артисту, разбор трека", async (env) => {
  const api = env.api;
  const r = await api.searchTracks({ id: "id", secret: "sec" }, "Art", "artist", 0);
  assert.equal(state.lastQuery, 'artist:"Art"');
  assert.equal(r.total, 42);
  assert.equal(r.tracks.length, 1);
  assert.deepEqual(r.tracks[0], { artist: "Art", title: "Song", album: "Album", albumArtist: "Art", durationS: 215, cover: "mid" });
  await api.searchTracks({ id: "id", secret: "sec" }, "Song", "track", 10);
  assert.equal(state.lastQuery, "Song");
});

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
  const api = Core.createApi({ http: async () => ({ status: 0, error: "timeout" }), md5 }, {});
  await assert.rejects(api.getToken({ key: "k", secret: "s" }), /Нет соединения: timeout/);
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const env = {
    http: async (method, url, headers, body) => {
      const r = await fetch(url, { method, headers, body: method === "POST" ? body : undefined });
      return { status: r.status, body: await r.text() };
    },
    md5
  };
  const api = Core.createApi(env, { lastfmApi: base + "/lfm", spotifyTokenUrl: base + "/token", spotifySearchUrl: base + "/search" });
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn({ api }); console.log("  ok   " + name); }
    catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e)); }
  }
  server.close();
  console.log(failed ? `\n${failed} тест(ов) упало` : "\nВсе тесты пройдены");
  process.exit(failed ? 1 : 0);
})();
