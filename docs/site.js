/* Сайт Scrobbler: та же логика, что в приложении (core.js), без оформления. */
(function () {
  "use strict";

  var Core = window.Core, Hash = window.Hash;
  var $ = function (id) { return document.getElementById(id); };

  var MODES = {
    track: { ph: "Название трека или ссылка Spotify", label: "Скробблов на трек" },
    artist: { ph: "Имя артиста", label: "Скробблов на трек" },
    album: { ph: "Название альбома или ссылка", label: "Сколько раз целиком" },
    playlist: { ph: "Фильтр по названию или ссылка", label: "Сколько раз целиком" }
  };
  var KIND_LABEL = { album: "альбом", playlist: "плейлист" };

  function plural(n, one, few, many) {
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
  }
  function tracksWord(n) { return n + " " + plural(n, "трек", "трека", "треков"); }

  // ---------- хранилище ----------
  var LS_KEY = "scrobbler.web.v1";
  var store = {};
  try { store = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { store = {}; }

  var S = {
    cfg: store.cfg || {},    // lfmKey, lfmSecret, spId, spSecret, sk, username, pendingToken, spUser, spPkce
    queue: (store.queue || []).filter(function (q) { return q && q.count > 0 && Core.itemTracks(q).length; }),
    mode: "track", query: "", offset: 0, total: 0, results: [], paged: false, busy: false,
    myPl: null, note: "", sending: false, stop: false
  };
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ cfg: S.cfg, queue: S.queue })); } catch (e) { /* хранилище недоступно */ }
  }

  // ---------- сеть и хеши ----------
  var redirectUri = location.origin + location.pathname;
  var env = {
    http: function (method, url, headers, body) {
      return fetch(url, { method: method, headers: headers, body: method === "POST" ? body : undefined })
        .then(function (r) { return r.text().then(function (t) { return { status: r.status, body: t }; }); })
        .catch(function (e) {
          return { status: 0, error: "браузер не смог выполнить запрос (" + (e && e.message) + "). Проверьте интернет; если он есть, сервис мог запретить запросы из браузера (CORS)" };
        });
    },
    md5: Hash.md5,
    sha256: Hash.sha256
  };
  var api = Core.createApi(env, { redirectUri: redirectUri });

  // ---------- сообщения ----------
  function say(text, isErr) {
    var el = $("msg");
    el.textContent = text;
    el.className = isErr ? "err" : "";
  }
  function fail(e) {
    if (e && e.code === "relogin") { S.cfg.spUser = null; S.myPl = null; save(); renderSpAuth(); renderResults(); }
    say((e && e.message) || String(e), true);
  }

  // ---------- Spotify ----------
  function spCfg() { return { id: (S.cfg.spId || "").trim(), secret: (S.cfg.spSecret || "").trim() }; }
  function isSpLogged() { return !!(S.cfg.spUser && S.cfg.spUser.refresh); }
  function isCollMode() { return S.mode === "album" || S.mode === "playlist"; }
  function needKeys(idOnly) {
    var c = spCfg();
    if (c.id && (idOnly || c.secret)) return c;
    say("Введите ключи Spotify в настройках.", true);
    return null;
  }

  function renderSpAuth() {
    var on = isSpLogged();
    $("sp-auth-state").textContent = on ? "Вход в Spotify выполнен" : "Вход в Spotify не выполнен";
    $("btn-sp-login").textContent = on ? "Войти заново" : "Войти в Spotify";
    $("btn-sp-logout").hidden = !on;
  }

  function onSpLogin() {
    var cfg = needKeys(true);
    if (!cfg) return;
    try {
      var pk = api.newPkce();
      S.cfg.spPkce = { verifier: pk.verifier, state: pk.state };
      save();
      location.href = api.spotifyAuthUrl(cfg, pk.state, pk.challenge);   // Spotify вернёт на эту же страницу
    } catch (e) { fail(e); }
  }

  /** Страница открыта после входа: адрес вида …/?code=…&state=… */
  async function handleReturn() {
    var p = new URLSearchParams(location.search);
    if (!p.has("state") || !(p.has("code") || p.has("error"))) return;
    var pk = S.cfg.spPkce;
    S.cfg.spPkce = null;
    save();
    history.replaceState(null, "", location.pathname);
    if (!pk || p.get("state") !== pk.state) { say("Не удалось проверить ответ Spotify. Нажмите «Войти в Spotify» ещё раз.", true); return; }
    if (p.get("error")) { say("Spotify: вход отменён (" + p.get("error") + ").", true); return; }
    try {
      S.cfg.spUser = await api.spotifyLogin(spCfg(), p.get("code"), pk.verifier);
      S.myPl = null;
      save();
      renderSpAuth();
      $("mode").value = "playlist";
      setMode("playlist");
      say("Вход в Spotify выполнен.");
    } catch (e) { fail(e); }
  }

  // ---------- поиск ----------
  function collSub(r) {
    var n = r.tracks ? r.tracks.length : r.total, parts = [];
    if (r.sub) parts.push(r.sub);
    if (n) parts.push(tracksWord(n));
    if (r.year) parts.push(r.year);
    if (r.tracks) parts.push(Core.fmtTotal(Core.collectionSeconds(r)));
    return parts.join(", ");
  }

  function li(text, buttons) {
    var el = document.createElement("li");
    el.appendChild(document.createTextNode(text + " "));
    buttons.forEach(function (b) { el.appendChild(b); });
    return el;
  }
  function btn(label, act, i) {
    var b = document.createElement("button");
    b.textContent = label;
    b.setAttribute("data-act", act);
    b.setAttribute("data-i", String(i));
    return b;
  }

  function renderResults() {
    var box = $("results");
    box.textContent = "";
    var needLogin = S.mode === "playlist" && !isSpLogged();
    $("results-note").hidden = !S.note && !needLogin;
    $("results-note").textContent = needLogin
      ? "Чтобы увидеть плейлисты, войдите в Spotify (кнопка в настройках выше)."
      : S.note;
    if (S.busy && !S.results.length) { box.appendChild(li("Загрузка…", [])); }
    S.results.forEach(function (r, i) {
      var text = r.kind
        ? "[" + KIND_LABEL[r.kind] + "] " + r.name + " — " + collSub(r)
        : r.artist + " — " + r.title + (r.album ? " (" + r.album + ")" : "") + " " + Core.fmtDur(r.durationS);
      box.appendChild(li(text, [btn("+ в очередь", "add", i)]));
    });
    $("btn-more").hidden = !(S.paged && S.results.length && S.offset < Math.min(S.total, 1000));
    $("btn-more").disabled = S.busy;
  }

  function setMode(mode) {
    var wasPl = S.mode === "playlist";
    S.mode = mode;
    $("mode").value = mode;
    $("q").placeholder = MODES[mode].ph;
    $("add-label").textContent = MODES[mode].label;
    if (mode === "playlist" || wasPl) $("q").value = "";
    S.results = []; S.query = ""; S.offset = 0; S.total = 0; S.paged = false; S.note = "";
    if (mode === "playlist") showPlaylists(false);
    else if ($("q").value.trim()) doSearch(false);
    else renderResults();
  }

  async function showPlaylists(force) {
    S.paged = false;
    if (!isSpLogged()) { S.results = []; renderResults(); return; }
    var cfg = needKeys(true);
    if (!cfg) return;
    if (!S.myPl || force) {
      if (S.busy) return;
      S.busy = true; S.results = []; renderResults();
      try { S.myPl = await api.myPlaylists(cfg, S.cfg.spUser); }
      catch (e) { fail(e); }
      finally { S.busy = false; save(); }
    }
    if (S.mode !== "playlist") return;
    var f = $("q").value.trim().toLowerCase();
    S.results = S.myPl ? S.myPl.playlists.filter(function (p) { return !f || p.name.toLowerCase().indexOf(f) >= 0; }) : [];
    S.note = S.myPl && S.myPl.hidden ? "Скрыто чужих плейлистов: " + S.myPl.hidden + ". Spotify отдаёт только ваши и совместные." : "";
    renderResults();
  }

  async function openLink(link) {
    if (link.type === "artist") { say("Ссылки на артистов не поддерживаются: выберите «Артист» и введите имя.", true); return; }
    $("mode").value = link.type;
    S.mode = link.type;
    $("q").placeholder = MODES[S.mode].ph;
    $("add-label").textContent = MODES[S.mode].label;
    S.results = []; S.paged = false; S.note = "";
    var cfg = null;
    if (link.type === "playlist") {
      if (!isSpLogged()) { renderResults(); return; }
      cfg = needKeys(true);
    } else cfg = needKeys(false);
    if (!cfg) return;
    S.busy = true; renderResults();
    try {
      if (link.type === "track") S.results = [await api.getTrack(cfg, link.id)];
      else if (link.type === "album") S.results = [await api.getAlbum(cfg, link.id)];
      else {
        var p = await api.getPlaylist(cfg, S.cfg.spUser, link.id);
        S.results = [p];
        if (p.skipped) S.note = "Пропущено позиций, которые нельзя заскробблить (подкасты, недоступные треки): " + p.skipped + ".";
      }
    } catch (e) { fail(e); }
    finally { S.busy = false; save(); renderResults(); }
  }

  async function doSearch(more) {
    if (S.busy) return;
    if (!more) {
      var q = $("q").value.trim();
      var link = Core.parseSpotifyLink(q);
      if (link) return openLink(link);
      if (S.mode === "playlist") return showPlaylists(false);
      if (!q) return;
      if (!needKeys(false)) return;
      S.query = q; S.offset = 0; S.total = 0; S.results = []; S.note = ""; S.paged = true;
    }
    var cfg = needKeys(false);
    if (!cfg) return;
    S.busy = true; say(""); renderResults();
    try {
      if (S.mode === "album") {
        var ra = await api.searchAlbums(cfg, S.query, S.offset);
        S.results = S.results.concat(ra.albums); S.total = ra.total;
      } else {
        var r = await api.searchTracks(cfg, S.query, S.mode, S.offset);
        S.results = S.results.concat(r.tracks); S.total = r.total;
      }
      S.offset += Core.PAGE_SIZE;
      if (!S.results.length) S.note = "Ничего не найдено.";
    } catch (e) { fail(e); }
    finally { S.busy = false; renderResults(); }
  }

  // ---------- очередь ----------
  function repeats() { return Math.max(1, Math.min(isCollMode() ? 99 : 5000, parseInt($("add-count").value, 10) || 1)); }

  async function addResult(i) {
    var r = S.results[i];
    if (!r) return;
    var n = repeats();
    if (!r.kind) {
      Core.addToQueue(S.queue, Core.trackEntry(r, n));
      say("Добавлено: " + r.title + " ×" + n);
    } else {
      var coll = r.tracks ? r : null;
      if (!coll) {
        var cfg = r.kind === "playlist" ? needKeys(true) : needKeys(false);
        if (!cfg) return;
        say("Загружаю список треков…");
        try {
          coll = r.kind === "album" ? await api.getAlbum(cfg, r.id) : await api.getPlaylist(cfg, S.cfg.spUser, r.id);
          r.tracks = coll.tracks; r.skipped = coll.skipped;
          save();
          renderResults();
        } catch (e) { fail(e); return; }
      }
      Core.addToQueue(S.queue, Core.collectionEntry({ kind: r.kind, id: r.id, name: r.name, sub: r.sub, cover: r.cover, tracks: coll.tracks }, n));
      say("Добавлено: " + r.name + " (" + tracksWord(coll.tracks.length) + ") ×" + n + (r.skipped ? ". Пропущено позиций: " + r.skipped : ""));
    }
    save();
    renderQueue();
  }

  function renderQueue() {
    var box = $("queue");
    box.textContent = "";
    S.queue.forEach(function (q, i) {
      var text = Core.isCollection(q)
        ? "[" + KIND_LABEL[q.kind] + "] " + q.name + " — " + collSub(q) + "  ×" + q.count
        : q.track.artist + " — " + q.track.title + " " + Core.fmtDur(q.track.durationS) + "  ×" + q.count;
      box.appendChild(li(text, [btn("−", "dec", i), btn("+", "inc", i), btn("Удалить", "del", i)]));
    });
    if (!S.queue.length) box.appendChild(li("Очередь пуста.", []));
    renderSummary();
  }

  function startMs() { return Core.parseStart($("in-date").value, $("in-time").value); }

  function renderSummary() {
    var chk = Core.checkPlan(S.queue, startMs(), Date.now());
    var el = $("summary");
    if (chk.level === "empty") { el.textContent = ""; return; }
    var text = chk.n + " " + plural(chk.n, "скроббл", "скроббла", "скробблов");
    if (chk.code === "bad_date") text += ". Проверьте дату и время начала.";
    else {
      text += ", " + Core.fmtTotal(chk.secs) + ": с " + Core.fmtLocal(startMs()) + " по " + Core.fmtLocal(chk.endMs) + ".";
      if (chk.code === "future") text += " Последний скроббл выходит в будущее, Last.fm его отклонит: нажмите «Закончить сейчас» или сдвиньте дату назад.";
      if (chk.code === "old") text += " Начало старше ~2 недель: Last.fm, как правило, отклоняет такие скробблы.";
    }
    el.textContent = text;
  }

  function writeDt(ms) {
    $("in-date").value = Core.dateValue(ms);
    $("in-time").value = Core.timeValue(ms);
    renderSummary();
  }

  // ---------- Last.fm: вход ----------
  function renderAuth() {
    var logged = !!(S.cfg.sk && S.cfg.username);
    $("auth-state").textContent = logged ? "Выполнен вход: " + S.cfg.username : "Вход не выполнен";
    $("btn-login").textContent = S.cfg.pendingToken ? "Я разрешил доступ, завершить вход" : (logged ? "Сменить аккаунт" : "Войти в Last.fm");
    $("btn-logout").hidden = !logged;
  }

  async function onLogin() {
    var creds = { key: (S.cfg.lfmKey || "").trim(), secret: (S.cfg.lfmSecret || "").trim() };
    if (!creds.key || !creds.secret) { say("Введите Last.fm API key и Shared secret.", true); return; }
    $("btn-login").disabled = true;
    try {
      if (!S.cfg.pendingToken) {
        var token = await api.getToken(creds);
        S.cfg.pendingToken = token;
        save();
        window.open(api.authUrl(creds, token), "_blank", "noopener");
        say("Разрешите доступ на сайте Last.fm, вернитесь сюда и нажмите «Я разрешил доступ».");
      } else {
        var s = await api.getSession(creds, S.cfg.pendingToken);
        S.cfg.sk = s.key; S.cfg.username = s.name; S.cfg.pendingToken = null;
        save();
        say("Вход выполнен: " + s.name);
      }
    } catch (e) {
      if (e.code !== 14) S.cfg.pendingToken = null;   // 14: доступ ещё не разрешён, можно повторить
      save();
      say(e.code === 14 ? "Доступ ещё не разрешён: откройте страницу Last.fm и нажмите «Yes, allow access»." : e.message, true);
    } finally {
      $("btn-login").disabled = false;
      renderAuth();
    }
  }

  // ---------- отправка ----------
  var logEl = $("log");
  function log(msg) {
    logEl.hidden = false;
    logEl.textContent += (logEl.textContent ? "\n" : "") + msg;
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setSending(on) {
    S.sending = on;
    $("btn-send").hidden = on;
    $("btn-stop").hidden = !on;
    window.onbeforeunload = on ? function () { return "Идёт отправка"; } : null;
  }

  async function onSend() {
    if (S.sending) return;
    if (!S.queue.length) { say("Сначала добавьте треки в очередь.", true); return; }
    var start = startMs();
    if (start === null) { say("Проверьте дату и время начала.", true); return; }
    var chk = Core.checkPlan(S.queue, start, Date.now());
    if (chk.code === "future") { say("Последний скроббл выходит в будущее. Нажмите «Закончить сейчас».", true); return; }
    var plan = Core.buildPlan(S.queue, start);
    var dry = $("dry").checked;
    var creds = { key: (S.cfg.lfmKey || "").trim(), secret: (S.cfg.lfmSecret || "").trim(), sk: S.cfg.sk };
    if (!dry) {
      if (!creds.key || !creds.secret || !creds.sk) { say("Сначала войдите в Last.fm в настройках.", true); return; }
      if (chk.code === "old" && !confirm("Начало старше ~2 недель. Last.fm, как правило, отклоняет такие скробблы. Всё равно отправить?")) return;
      if (!confirm("Отправить " + plan.length + " " + plural(plan.length, "скроббл", "скроббла", "скробблов") +
        " на аккаунт " + (S.cfg.username || "?") + "? Не закрывайте вкладку, пока идёт отправка.")) return;
    }
    S.stop = false;
    logEl.textContent = "";
    $("bar").hidden = false; $("bar").value = 0;
    setSending(true);
    try {
      if (dry) {
        log("Пробный запуск: " + plan.length + " скробблов, " + Core.fmtLocal(plan[0].ts * 1000) + " … " + Core.fmtLocal(plan[plan.length - 1].ts * 1000));
        var shown = plan.length <= 12 ? plan : plan.slice(0, 6).concat([null], plan.slice(-5));
        shown.forEach(function (it) { log(it ? "   " + Core.fmtLocal(it.ts * 1000) + "  " + it.track.artist + " — " + it.track.title : "   …"); });
        log("Ничего не отправлено.");
        $("bar").value = 100;
      } else {
        var r = await api.sendScrobbles(plan, creds, {
          log: log,
          progress: function (d, t) { $("bar").value = Math.round(d / t * 100); },
          shouldStop: function () { return S.stop; }
        });
        log("Готово. Принято: " + r.accepted + ", отклонено: " + r.ignored + ".");
        say("Принято: " + r.accepted + ", отклонено: " + r.ignored + ".", !r.accepted);
      }
    } catch (e) {
      log("Ошибка: " + e.message);
      log("Если часть пакетов уже ушла, проверьте профиль Last.fm, чтобы не отправить их повторно.");
      say(e.message, true);
    } finally {
      setSending(false);
    }
  }

  // ---------- привязка к странице ----------
  function bindField(id, key) {
    var el = $(id);
    el.value = S.cfg[key] || "";
    el.addEventListener("input", function () { S.cfg[key] = el.value.trim(); save(); });
  }

  function init() {
    bindField("in-lfm-key", "lfmKey"); bindField("in-lfm-secret", "lfmSecret");
    bindField("in-sp-id", "spId"); bindField("in-sp-secret", "spSecret");
    $("redirect-uri").textContent = redirectUri;
    $("btn-copy-redirect").addEventListener("click", function () {
      (navigator.clipboard ? navigator.clipboard.writeText(redirectUri) : Promise.reject())
        .then(function () { say("Адрес скопирован."); }, function () { say("Не удалось скопировать: выделите адрес и скопируйте вручную.", true); });
    });
    $("btn-login").addEventListener("click", onLogin);
    $("btn-logout").addEventListener("click", function () {
      S.cfg.sk = null; S.cfg.username = null; S.cfg.pendingToken = null; save(); renderAuth(); say("Вы вышли из Last.fm.");
    });
    $("btn-sp-login").addEventListener("click", onSpLogin);
    $("btn-sp-logout").addEventListener("click", function () {
      S.cfg.spUser = null; S.cfg.spPkce = null; S.myPl = null; save(); renderSpAuth();
      if (S.mode === "playlist") S.results = [];
      renderResults(); say("Вы вышли из Spotify.");
    });

    $("mode").addEventListener("change", function () { setMode($("mode").value); });
    $("btn-search").addEventListener("click", function () { doSearch(false); });
    $("q").addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(false); });
    $("q").addEventListener("input", function () {
      if (S.mode === "playlist" && S.myPl && !S.busy && !Core.parseSpotifyLink($("q").value)) showPlaylists(false);
    });
    $("btn-more").addEventListener("click", function () { doSearch(true); });
    $("results").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-act=add]");
      if (b) addResult(+b.getAttribute("data-i"));
    });
    $("queue").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-act]");
      if (!b) return;
      var i = +b.getAttribute("data-i"), act = b.getAttribute("data-act"), q = S.queue[i];
      if (!q) return;
      var max = Core.isCollection(q) ? 99 : 5000;
      if (act === "inc") q.count = Math.min(max, q.count + 1);
      if (act === "dec") q.count = Math.max(1, q.count - 1);
      if (act === "del") S.queue.splice(i, 1);
      save(); renderQueue();
    });

    $("in-date").addEventListener("input", renderSummary);
    $("in-time").addEventListener("input", renderSummary);
    $("chip-now").addEventListener("click", function () { writeDt(Date.now()); });
    $("chip-end").addEventListener("click", function () {
      if (!S.queue.length) { say("Очередь пуста.", true); return; }
      writeDt(Core.endNowStart(S.queue, Date.now()));
    });
    $("btn-send").addEventListener("click", onSend);
    $("btn-stop").addEventListener("click", function () { S.stop = true; say("Останавливаю после текущего пакета…"); });

    writeDt(Date.now());
    $("q").placeholder = MODES.track.ph;
    renderAuth(); renderSpAuth(); renderResults(); renderQueue();
    handleReturn();
  }

  init();
})();
