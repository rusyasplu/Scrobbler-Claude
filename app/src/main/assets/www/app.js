/* Интерфейс Last.fm Scrobbler. Логика API — в core.js, платформенные вещи — через мост Native. */
(function () {
  "use strict";

  var Core = window.Core;
  var $ = function (s, r) { return (r || document).querySelector(s); };

  var ICON_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2.5"/><circle cx="17" cy="16" r="2.5"/></svg>';
  var ICON_DISC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.6"/><path d="M12 3.5a8.5 8.5 0 0 1 6 2.5"/></svg>';
  var ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h12M4 11.5h12M4 16.5h7"/><path d="M18 14.5v5l3.5-2.5z"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';
  var ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>';
  var ICON_MINUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 12h12"/></svg>';
  var TABS = ["search", "queue", "profile"];
  var MODES = ["track", "artist", "album", "playlist"];
  var PLACEHOLDER = {
    track: "Название трека или ссылка Spotify",
    artist: "Имя артиста",
    album: "Название альбома или ссылка",
    playlist: "Фильтр по названию или ссылка"
  };
  var KIND_LABEL = { album: "альбом", playlist: "плейлист" };
  var MAX_TRACK_REPEATS = 5000;
  var MAX_COLLECTION_REPEATS = 99;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function tracksWord(n) { return n + " " + plural(n, "трек", "трека", "треков"); }
  function fmtShort(ms) {
    var d = new Date(ms);
    return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  // ---------- хранилище ----------

  var LS_KEY = "scrobbler.v1";
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  var store = loadStore();

  var S = {
    tab: "search",
    // lfmKey, lfmSecret, spId, spSecret, sk, username, pendingToken,
    // spUser {access, refresh, expires} — вход в Spotify, spPkce {verifier, state} — незавершённый вход
    cfg: store.cfg || {},
    queue: store.queue || [],     // [{track, count}] или [{kind, id, name, sub, cover, tracks, count}]
    mode: "track", query: "", offset: 0, total: 0, results: [], searching: false, paged: false,
    busyText: "", note: "",
    myPl: null,                   // кеш списка плейлистов {playlists, hidden}
    add: { track: 1, coll: 1 },   // сколько раз добавлять: трек / коллекцию целиком
    date: "", time: "",
    sending: false, stop: false
  };

  // старый формат очереди (v1.0) совместим; битые элементы выбрасываем
  S.queue = S.queue.filter(function (q) { return q && q.count > 0 && Core.itemTracks(q).length; });

  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ cfg: S.cfg, queue: S.queue })); } catch (e) { /* нет места или хранилище недоступно */ }
  }

  // ---------- мост к Android ----------

  var hasNative = typeof window.Native !== "undefined";
  var pending = {};
  var seq = 0;

  window.__nativeHttpDone = function (id, b64) {
    var cb = pending[id];
    if (!cb) return;
    delete pending[id];
    try {
      var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
      cb.resolve(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (e) { cb.reject(e); }
  };

  var env = {
    http: function (method, url, headers, body) {
      if (!hasNative) {
        return fetch(url, { method: method, headers: headers, body: method === "POST" ? body : undefined })
          .then(function (r) { return r.text().then(function (t) { return { status: r.status, body: t }; }); });
      }
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending[id] = { resolve: resolve, reject: reject };
        window.Native.http(id, method, url, JSON.stringify(headers || {}), body || "");
      });
    },
    md5: function (s) {
      if (!hasNative) throw new Error("MD5 доступен только внутри приложения");
      return window.Native.md5(s);
    },
    sha256: function (s) {
      if (!hasNative) throw new Error("SHA-256 доступен только внутри приложения");
      return window.Native.sha256(s);
    }
  };
  var api = Core.createApi(env);

  function openUrl(u) {
    if (hasNative) window.Native.openUrl(u); else window.open(u, "_blank");
  }
  function keepAwake(on) {
    if (hasNative && window.Native.keepAwake) window.Native.keepAwake(on);
  }
  function copyText(t) {
    if (hasNative && window.Native.copyText) { window.Native.copyText(t); return true; }
    try { navigator.clipboard.writeText(t); return true; } catch (e) { return false; }
  }

  // ---------- уведомления и диалог ----------

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $("#toast");
    el.textContent = msg;
    el.className = "toast glass show" + (kind === "error" ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, kind === "error" ? 5200 : 2800);
  }

  function confirmBox(title, text, okLabel) {
    return new Promise(function (resolve) {
      var m = $("#modal");
      $("#modal-title").textContent = title;
      $("#modal-text").textContent = text;
      $("#modal-ok").textContent = okLabel || "Да";
      m.classList.add("show");
      m.setAttribute("aria-hidden", "false");
      function close(v) {
        m.classList.remove("show");
        m.setAttribute("aria-hidden", "true");
        $("#modal-ok").onclick = null;
        $("#modal-cancel").onclick = null;
        resolve(v);
      }
      $("#modal-ok").onclick = function () { close(true); };
      $("#modal-cancel").onclick = function () { close(false); };
    });
  }

  // ---------- вкладки ----------

  function setTab(name) {
    S.tab = name;
    TABS.forEach(function (t) { $("#tab-" + t).classList.toggle("active", t === name); });
    document.querySelectorAll("#tabbar button").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-tab") === name);
    });
    $("#tabbar").setAttribute("data-i", String(TABS.indexOf(name)));
    window.scrollTo(0, 0);
    if (name === "queue") renderSummary();
  }

  // ---------- Spotify: ключи и вход ----------

  function spCfg() { return { id: (S.cfg.spId || "").trim(), secret: (S.cfg.spSecret || "").trim() }; }
  function isSpLogged() { return !!(S.cfg.spUser && S.cfg.spUser.refresh); }
  function isCollMode() { return S.mode === "album" || S.mode === "playlist"; }

  /** Проверяет ключи; если их нет — подсказывает и переводит в профиль. */
  function needSpotifyKeys(idOnly) {
    var c = spCfg();
    if (c.id && (idOnly || c.secret)) return c;
    toast("Введите ключи Spotify на вкладке «Профиль»", "error");
    setTab("profile");
    return null;
  }

  function fail(e) {
    if (e && e.code === "relogin") {
      S.cfg.spUser = null;
      S.myPl = null;
      persist();
      renderSpAuth();
      renderResults();
    }
    toast((e && e.message) || String(e), "error");
  }

  function renderSpAuth() {
    var logged = isSpLogged();
    var st = $("#sp-auth-state");
    st.className = "auth-state" + (logged ? " ok" : "");
    st.innerHTML = '<i class="dot"></i><span>' + (logged ? "Вход в Spotify выполнен" : "Вход в Spotify не выполнен") + "</span>";
    $("#btn-sp-login").textContent = logged ? "Войти заново" : "Войти в Spotify";
    $("#btn-sp-logout").hidden = !logged;
  }

  function onSpLogin() {
    var cfg = needSpotifyKeys(true);
    if (!cfg) return;
    if (!hasNative) { toast("Вход в Spotify работает только внутри приложения", "error"); return; }
    try {
      var pk = api.newPkce();
      S.cfg.spPkce = { verifier: pk.verifier, state: pk.state };
      persist();
      openUrl(api.spotifyAuthUrl(cfg, pk.state, pk.challenge));
      toast("Разрешите доступ на сайте Spotify, вы вернётесь в приложение сами");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  /** Приложение открыто по адресу scrobbler://callback?code=…&state=… */
  async function handleSpotifyCallback(url) {
    var qi = url.indexOf("?");
    var params = new URLSearchParams(qi >= 0 ? url.slice(qi + 1).split("#")[0] : "");
    var pk = S.cfg.spPkce;
    S.cfg.spPkce = null;
    persist();
    if (!pk || params.get("state") !== pk.state) {
      toast("Не удалось проверить ответ Spotify. Нажмите «Войти в Spotify» ещё раз.", "error");
      return;
    }
    if (params.get("error")) { toast("Spotify: вход отменён (" + params.get("error") + ")", "error"); return; }
    var code = params.get("code");
    var cfg = spCfg();
    if (!code || !cfg.id) { toast("Spotify не прислал код входа.", "error"); return; }
    try {
      S.cfg.spUser = await api.spotifyLogin(cfg, code, pk.verifier);
      S.myPl = null;
      persist();
      renderSpAuth();
      toast("Вход в Spotify выполнен");
      if (S.mode === "playlist") showPlaylists(true); else renderResults();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function pollCallback() {
    if (!hasNative || !window.Native.takeCallback) return;
    var u = window.Native.takeCallback();
    if (u) handleSpotifyCallback(u);
  }
  window.__spotifyCallback = pollCallback;

  // ---------- поиск ----------

  function coverHtml(t, icon) {
    var url = t.cover && /^https:\/\//.test(t.cover) ? t.cover : "";
    return '<div class="cover">' + (url
      ? '<img src="' + esc(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : (icon || ICON_NOTE)) + '</div>';
  }

  function collSub(r) {
    var n = r.tracks ? r.tracks.length : r.total;
    var parts = [];
    if (r.sub) parts.push(esc(r.sub));
    if (n) parts.push(tracksWord(n));
    if (r.year) parts.push(esc(r.year));
    if (r.tracks) parts.push(Core.fmtTotal(Core.collectionSeconds(r)));
    return parts.join(" · ");
  }

  function collRowHtml(r, i, buttons) {
    return '<div class="row" style="--i:' + (i % 10) + '">' +
      coverHtml(r, r.kind === "album" ? ICON_DISC : ICON_LIST) +
      '<div class="meta"><div class="t wrap">' + esc(r.name) + "</div>" +
      '<div class="s wrap"><span class="tag">' + KIND_LABEL[r.kind] + "</span>" + collSub(r) + "</div></div>" + buttons + "</div>";
  }

  function emptyHtml() {
    var icon = S.mode === "album" ? ICON_DISC : (S.mode === "playlist" ? ICON_LIST : ICON_NOTE);
    var text;
    if (S.query) text = "Ничего не найдено";
    else if (S.mode === "playlist") text = "Нет доступных плейлистов. Spotify отдаёт только ваши и совместные.";
    else if (S.mode === "album") text = "Найдите альбом или вставьте ссылку на него";
    else if (S.mode === "artist") text = "Введите имя артиста";
    else text = "Найдите трек или артиста в каталоге Spotify";
    return '<div class="empty">' + icon + "<div>" + text + "</div></div>";
  }

  function renderResults() {
    var box = $("#results");
    var needLogin = S.mode === "playlist" && !isSpLogged();
    $("#sp-login").hidden = !needLogin;
    var note = $("#results-note");
    note.hidden = !S.note;
    note.textContent = S.note || "";
    var more = $("#btn-more");

    if (needLogin && !S.results.length) {
      box.hidden = true;
      more.hidden = true;
      return;
    }
    box.hidden = false;

    if (S.searching && !S.results.length) {
      box.innerHTML = '<div class="empty"><div class="spin"></div>' + esc(S.busyText || "Ищу в Spotify…") + "</div>";
    } else if (!S.results.length) {
      box.innerHTML = emptyHtml();
    } else {
      box.innerHTML = S.results.map(function (r, i) {
        var add = '<div class="side"><button class="rbtn" data-act="add" data-i="' + i + '" aria-label="Добавить">' + ICON_PLUS + "</button></div>";
        if (r.kind) return collRowHtml(r, i, add);
        return '<div class="row" style="--i:' + (i % Core.PAGE_SIZE) + '">' + coverHtml(r) +
          '<div class="meta"><div class="t">' + esc(r.title) + "</div>" +
          '<div class="s">' + esc(r.artist) + (r.album ? " · " + esc(r.album) : "") + "</div></div>" +
          '<div class="side"><span class="dur">' + Core.fmtDur(r.durationS) + "</span>" +
          '<button class="rbtn" data-act="add" data-i="' + i + '" aria-label="Добавить">' + ICON_PLUS + "</button></div></div>";
      }).join("");
    }
    var canMore = S.paged && S.results.length > 0 && S.offset < Math.min(S.total, 1000);
    more.hidden = !canMore;
    more.disabled = S.searching;
  }

  function setMode(mode, silent) {
    // в режиме «Плейлист» поле работает как фильтр по названию: текст прошлого поиска сюда не переносим
    if (!silent && (mode === "playlist" || S.mode === "playlist")) $("#q").value = "";
    S.mode = mode;
    var i = MODES.indexOf(mode);
    $("#seg").setAttribute("data-i", String(i));
    document.querySelectorAll("#seg button").forEach(function (x) {
      x.classList.toggle("on", x.getAttribute("data-mode") === mode);
    });
    $("#q").placeholder = PLACEHOLDER[mode];
    $("#add-label").textContent = isCollMode() ? "Сколько раз целиком" : "Скробблов на трек";
    $("#add-count").textContent = isCollMode() ? S.add.coll : S.add.track;
    S.results = []; S.query = ""; S.offset = 0; S.total = 0; S.paged = false; S.note = "";
    if (silent) { renderResults(); return; }
    if (mode === "playlist") showPlaylists(false);
    else if ($("#q").value.trim()) doSearch(false);
    else renderResults();
  }

  /** Список своих плейлистов (нужен вход в Spotify); текст в поле — фильтр по названию. */
  async function showPlaylists(force) {
    S.paged = false;
    if (!isSpLogged()) { S.results = []; S.note = ""; renderResults(); return; }
    var cfg = needSpotifyKeys(true);
    if (!cfg) return;
    if (!S.myPl || force) {
      if (S.searching) return;
      S.searching = true; S.busyText = "Загружаю плейлисты…"; S.results = []; renderResults();
      try {
        S.myPl = await api.myPlaylists(cfg, S.cfg.spUser);
      } catch (e) {
        fail(e);
      } finally {
        S.searching = false;
        persist();
      }
    }
    if (S.mode !== "playlist") return;
    var f = $("#q").value.trim().toLowerCase();
    S.query = f;
    S.results = S.myPl ? S.myPl.playlists.filter(function (p) { return !f || p.name.toLowerCase().indexOf(f) >= 0; }) : [];
    S.note = S.myPl && S.myPl.hidden
      ? "Скрыто чужих плейлистов: " + S.myPl.hidden + ". Spotify отдаёт только ваши и совместные."
      : "";
    renderResults();
  }

  /** Вставлена ссылка Spotify: открываем трек / альбом / плейлист напрямую. */
  async function openLink(link) {
    if (link.type === "artist") {
      toast("Ссылки на артистов не поддерживаются: введите имя на вкладке «Артист»", "error");
      return;
    }
    setMode(link.type, true);
    var cfg;
    if (link.type === "playlist") {
      if (!isSpLogged()) { renderResults(); return; }
      cfg = needSpotifyKeys(true);
    } else {
      cfg = needSpotifyKeys(false);
    }
    if (!cfg) return;
    S.searching = true; S.busyText = "Загружаю по ссылке…"; S.query = link.id; renderResults();
    try {
      if (link.type === "track") {
        S.results = [await api.getTrack(cfg, link.id)];
      } else if (link.type === "album") {
        S.results = [await api.getAlbum(cfg, link.id)];
      } else {
        var p = await api.getPlaylist(cfg, S.cfg.spUser, link.id);
        S.results = [p];
        if (p.skipped) S.note = "Пропущено позиций, которые нельзя заскробблить (подкасты, недоступные треки): " + p.skipped + ".";
      }
    } catch (e) {
      fail(e);
    } finally {
      S.searching = false;
      persist();
      renderResults();
    }
  }

  async function doSearch(more) {
    if (S.searching) return;
    if (!more) {
      var q = $("#q").value.trim();
      var link = Core.parseSpotifyLink(q);
      if (link) { document.activeElement && document.activeElement.blur(); return openLink(link); }
      if (S.mode === "playlist") { document.activeElement && document.activeElement.blur(); return showPlaylists(false); }
      if (!q) return;
      var cfg0 = needSpotifyKeys(false);
      if (!cfg0) return;
      S.query = q; S.offset = 0; S.total = 0; S.results = []; S.note = ""; S.paged = true;
      document.activeElement && document.activeElement.blur();
    }
    var cfg = needSpotifyKeys(false);
    if (!cfg) return;
    S.searching = true; S.busyText = "Ищу в Spotify…";
    renderResults();
    try {
      if (S.mode === "album") {
        var ra = await api.searchAlbums(cfg, S.query, S.offset);
        S.results = S.results.concat(ra.albums);
        S.total = ra.total;
      } else {
        var r = await api.searchTracks(cfg, S.query, S.mode, S.offset);
        S.results = S.results.concat(r.tracks);
        S.total = r.total;
      }
      S.offset += Core.PAGE_SIZE;
    } catch (e) {
      fail(e);
    } finally {
      S.searching = false;
      renderResults();
    }
  }

  // ---------- добавление в очередь ----------

  function addTrack(t) {
    Core.addToQueue(S.queue, Core.trackEntry(t, S.add.track));
    persist();
    renderQueue();
    toast("Добавлено: " + t.title + " ×" + S.add.track);
  }

  async function addCollection(r, btn) {
    var coll = r.tracks ? r : null;
    if (!coll) {
      var cfg = r.kind === "playlist" ? needSpotifyKeys(true) : needSpotifyKeys(false);
      if (!cfg) return;
      btn.classList.add("busy");
      try {
        coll = r.kind === "album"
          ? await api.getAlbum(cfg, r.id)
          : await api.getPlaylist(cfg, S.cfg.spUser, r.id);
        r.tracks = coll.tracks;          // запоминаем, чтобы второй раз не качать
        r.skipped = coll.skipped;
        persist();
        renderResults();
      } catch (e) {
        btn.classList.remove("busy");
        fail(e);
        return;
      }
    }
    Core.addToQueue(S.queue, Core.collectionEntry({
      kind: r.kind, id: r.id, name: r.name, sub: r.sub, cover: r.cover, tracks: coll.tracks
    }, S.add.coll));
    persist();
    renderQueue();
    var msg = "Добавлено: " + r.name + " (" + tracksWord(coll.tracks.length) + ") ×" + S.add.coll;
    if (r.skipped) msg += ". Пропущено позиций: " + r.skipped;
    toast(msg);
  }

  // ---------- очередь ----------

  function renderQueue() {
    var box = $("#queue");
    box.hidden = !S.queue.length;
    box.innerHTML = S.queue.map(function (q, i) {
      var ctl = '<div class="side"><div class="qctl">' +
        '<button class="rbtn" data-act="dec" data-i="' + i + '" aria-label="Меньше">' + ICON_MINUS + "</button>" +
        '<span class="qcount">' + q.count + "</span>" +
        '<button class="rbtn" data-act="inc" data-i="' + i + '" aria-label="Больше">' + ICON_PLUS + "</button></div>" +
        '<button class="rbtn" data-act="del" data-i="' + i + '" aria-label="Удалить">' + ICON_X + "</button></div>";
      if (Core.isCollection(q)) {
        return collRowHtml({
          kind: q.kind, name: q.name, sub: q.sub, cover: q.cover, tracks: q.tracks
        }, i, ctl);
      }
      var t = q.track;
      return '<div class="row" style="--i:' + (i % 10) + '">' + coverHtml(t) +
        '<div class="meta"><div class="t">' + esc(t.title) + "</div>" +
        '<div class="s">' + esc(t.artist) + " · " + Core.fmtDur(t.durationS) + "</div></div>" + ctl + "</div>";
    }).join("");
    var n = Core.totalCount(S.queue);
    var badge = $("#badge");
    badge.hidden = n === 0;
    badge.textContent = n > 999 ? "999+" : String(n);
    renderSummary();
  }

  function renderSummary() {
    var el = $("#summary");
    var startMs = Core.parseStart(S.date, S.time);
    var chk = Core.checkPlan(S.queue, startMs, Date.now());
    var cls = chk.level === "ok" ? "" : chk.level;
    el.className = "card glass sum " + cls;
    if (chk.level === "empty") {
      el.innerHTML = '<div class="big">Очередь пуста</div><div class="line">Добавьте треки, альбомы или плейлисты на вкладке «Поиск»</div>';
      return;
    }
    var head = '<div class="big">' + chk.n + " " + plural(chk.n, "скроббл", "скроббла", "скробблов") + "</div>";
    if (chk.code === "bad_date") {
      el.innerHTML = head + '<div class="msg">Проверьте дату и время начала.</div>';
      return;
    }
    var html = head + '<div class="line">' + Core.fmtTotal(chk.secs) + " · с " + fmtShort(startMs) + " по " + fmtShort(chk.endMs) + "</div>";
    if (chk.code === "future") {
      html += '<div class="msg">Последний скроббл выходит в будущее — Last.fm его отклонит. Нажмите «Закончить сейчас» или сдвиньте дату назад.</div>';
    } else if (chk.code === "old") {
      html += '<div class="msg">Начало старше ~2 недель — Last.fm, как правило, отклоняет такие скробблы.</div>';
    }
    el.innerHTML = html;
  }

  // ---------- профиль ----------

  function renderAuth() {
    var st = $("#auth-state");
    var logged = !!(S.cfg.sk && S.cfg.username);
    st.className = "auth-state" + (logged ? " ok" : "");
    st.innerHTML = '<i class="dot"></i><span>' + (logged ? "Выполнен вход: <b>" + esc(S.cfg.username) + "</b>" : "Вход не выполнен") + "</span>";
    $("#btn-login").textContent = S.cfg.pendingToken ? "Я разрешил доступ — завершить вход"
      : (logged ? "Сменить аккаунт" : "Войти в Last.fm");
    $("#btn-logout").hidden = !logged;
  }

  async function onLogin() {
    var creds = { key: (S.cfg.lfmKey || "").trim(), secret: (S.cfg.lfmSecret || "").trim() };
    if (!creds.key || !creds.secret) { toast("Введите Last.fm API key и Shared secret", "error"); return; }
    var btn = $("#btn-login");
    btn.disabled = true;
    try {
      if (!S.cfg.pendingToken) {
        var token = await api.getToken(creds);
        S.cfg.pendingToken = token;
        persist();
        openUrl(api.authUrl(creds, token));
        toast("Разрешите доступ на сайте Last.fm и вернитесь сюда");
      } else {
        var s = await api.getSession(creds, S.cfg.pendingToken);
        S.cfg.sk = s.key; S.cfg.username = s.name; S.cfg.pendingToken = null;
        persist();
        toast("Вход выполнен: " + s.name);
      }
    } catch (e) {
      if (e.code !== 14) S.cfg.pendingToken = null;   // 14 — доступ ещё не разрешён, можно повторить
      persist();
      toast(e.code === 14 ? "Доступ ещё не разрешён: откройте страницу Last.fm и нажмите «Yes, allow access»" : e.message, "error");
    } finally {
      btn.disabled = false;
      renderAuth();
    }
  }

  // ---------- отправка ----------

  var logEl = $("#log");
  function log(msg) {
    logEl.hidden = false;
    logEl.textContent += (logEl.textContent ? "\n" : "") + msg;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setSending(on) {
    S.sending = on;
    $("#btn-send").hidden = on;
    $("#btn-stop").hidden = !on;
    $("#bar-wrap").hidden = !on && $("#bar").style.width === "0%";
    keepAwake(on);
  }

  async function onSend() {
    if (S.sending) return;
    if (!S.queue.length) { toast("Сначала добавьте треки в очередь", "error"); return; }
    var startMs = Core.parseStart(S.date, S.time);
    if (startMs === null) { toast("Проверьте дату и время начала", "error"); return; }
    var chk = Core.checkPlan(S.queue, startMs, Date.now());
    if (chk.code === "future") {
      toast("Последний скроббл выходит в будущее. Нажмите «Закончить сейчас».", "error");
      return;
    }
    var plan = Core.buildPlan(S.queue, startMs);
    var dry = $("#dry").checked;
    var creds = { key: (S.cfg.lfmKey || "").trim(), secret: (S.cfg.lfmSecret || "").trim(), sk: S.cfg.sk };

    if (!dry) {
      if (!creds.key || !creds.secret || !creds.sk) {
        toast("Сначала войдите в Last.fm на вкладке «Профиль»", "error");
        setTab("profile");
        return;
      }
      if (chk.code === "old") {
        var okOld = await confirmBox("Старая дата",
          "Начало старше ~2 недель. Last.fm, как правило, отклоняет такие скробблы. Всё равно отправить?", "Отправить");
        if (!okOld) return;
      }
      var ok = await confirmBox("Отправить?",
        plan.length + " " + plural(plan.length, "скроббл", "скроббла", "скробблов") +
        " на аккаунт " + (S.cfg.username || "?") + ". Не сворачивайте приложение, пока идёт отправка.", "Отправить");
      if (!ok) return;
    }

    S.stop = false;
    logEl.textContent = "";
    $("#bar").style.width = "0%";
    $("#bar-wrap").hidden = false;
    setSending(true);
    try {
      if (dry) {
        log("Пробный запуск: " + plan.length + " скробблов, " + Core.fmtLocal(plan[0].ts * 1000) + " … " + Core.fmtLocal(plan[plan.length - 1].ts * 1000));
        var shown = plan.length <= 12 ? plan : plan.slice(0, 6).concat([null], plan.slice(-5));
        shown.forEach(function (it) {
          log(it ? "   " + Core.fmtLocal(it.ts * 1000) + "  " + it.track.artist + " — " + it.track.title : "   …");
        });
        log("Ничего не отправлено.");
        $("#bar").style.width = "100%";
      } else {
        var r = await api.sendScrobbles(plan, creds, {
          log: log,
          progress: function (d, t) { $("#bar").style.width = Math.round(d / t * 100) + "%"; },
          shouldStop: function () { return S.stop; }
        });
        log("Готово. Принято: " + r.accepted + ", отклонено: " + r.ignored + ".");
        toast("Принято: " + r.accepted + ", отклонено: " + r.ignored, r.accepted ? undefined : "error");
      }
    } catch (e) {
      log("Ошибка: " + e.message);
      log("Если часть пакетов уже ушла, проверьте профиль Last.fm, чтобы не отправить их повторно.");
      toast(e.message, "error");
    } finally {
      setSending(false);
    }
  }

  // ---------- обработчики ----------

  function bind() {
    // вкладки
    document.querySelectorAll("#tabbar button").forEach(function (b) {
      b.addEventListener("click", function () { setTab(b.getAttribute("data-tab")); });
    });

    // поиск
    $("#btn-search").addEventListener("click", function () { doSearch(false); });
    $("#q").addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(false); });
    $("#q").addEventListener("input", function () {
      // в режиме «Плейлист» текст сразу фильтрует загруженный список
      if (S.mode === "playlist" && S.myPl && !S.searching && !Core.parseSpotifyLink($("#q").value)) showPlaylists(false);
    });
    $("#btn-more").addEventListener("click", function () { doSearch(true); });
    $("#seg").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-mode]");
      if (!b || b.getAttribute("data-mode") === S.mode) return;
      setMode(b.getAttribute("data-mode"), false);
    });
    function setAdd(n) {
      var key = isCollMode() ? "coll" : "track";
      var max = isCollMode() ? MAX_COLLECTION_REPEATS : MAX_TRACK_REPEATS;
      S.add[key] = Math.max(1, Math.min(max, n));
      $("#add-count").textContent = S.add[key];
    }
    function curAdd() { return isCollMode() ? S.add.coll : S.add.track; }
    $("#add-dec").addEventListener("click", function () {
      var n = curAdd();
      setAdd(n - (!isCollMode() && n > 10 ? 5 : 1));
    });
    $("#add-inc").addEventListener("click", function () {
      var n = curAdd();
      setAdd(n + (!isCollMode() && n >= 10 ? 5 : 1));
    });

    $("#results").addEventListener("click", function (e) {
      var b = e.target.closest("[data-act=add]");
      if (!b) return;
      var r = S.results[+b.getAttribute("data-i")];
      if (!r) return;
      b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
      if (r.kind) addCollection(r, b); else addTrack(r);
    });

    // очередь
    $("#queue").addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]");
      if (!b) return;
      var i = +b.getAttribute("data-i"), act = b.getAttribute("data-act"), q = S.queue[i];
      if (!q) return;
      var max = Core.isCollection(q) ? MAX_COLLECTION_REPEATS : MAX_TRACK_REPEATS;
      if (act === "inc") q.count = Math.min(max, q.count + 1);
      if (act === "dec") q.count = Math.max(1, q.count - 1);
      if (act === "del") S.queue.splice(i, 1);
      persist();
      renderQueue();
    });

    // дата и время
    function readDt() { S.date = $("#in-date").value; S.time = $("#in-time").value; renderSummary(); }
    $("#in-date").addEventListener("input", readDt);
    $("#in-time").addEventListener("input", readDt);
    function writeDt(ms) {
      $("#in-date").value = Core.dateValue(ms);
      $("#in-time").value = Core.timeValue(ms);
      readDt();
    }
    $("#chip-now").addEventListener("click", function () { writeDt(Date.now()); });
    $("#chip-end").addEventListener("click", function () {
      if (!S.queue.length) { toast("Очередь пуста", "error"); return; }
      writeDt(Core.endNowStart(S.queue, Date.now()));
    });
    writeDt(Date.now());

    // отправка
    $("#btn-send").addEventListener("click", onSend);
    $("#btn-stop").addEventListener("click", function () { S.stop = true; toast("Останавливаю после текущего пакета…"); });

    // профиль
    [["#in-lfm-key", "lfmKey"], ["#in-lfm-secret", "lfmSecret"], ["#in-sp-id", "spId"], ["#in-sp-secret", "spSecret"]]
      .forEach(function (p) {
        var el = $(p[0]);
        el.value = S.cfg[p[1]] || "";
        el.addEventListener("input", function () { S.cfg[p[1]] = el.value.trim(); persist(); });
      });
    $("#btn-login").addEventListener("click", onLogin);
    $("#btn-logout").addEventListener("click", function () {
      S.cfg.sk = null; S.cfg.username = null; S.cfg.pendingToken = null;
      persist(); renderAuth(); toast("Вы вышли из аккаунта");
    });
    $("#btn-sp-login").addEventListener("click", onSpLogin);
    $("#btn-sp-login-search").addEventListener("click", onSpLogin);
    $("#btn-sp-logout").addEventListener("click", function () {
      S.cfg.spUser = null; S.cfg.spPkce = null; S.myPl = null;
      persist(); renderSpAuth();
      if (S.mode === "playlist") { S.results = []; S.note = ""; }
      renderResults();
      toast("Вы вышли из Spotify");
    });
    $("#btn-copy-redirect").addEventListener("click", function () {
      var copied = copyText(Core.SPOTIFY_REDIRECT_URI);
      toast(copied ? "Адрес скопирован" : "Не удалось скопировать, перепишите вручную", copied ? undefined : "error");
    });
    $("#redirect-uri").textContent = Core.SPOTIFY_REDIRECT_URI;
    document.querySelectorAll("a[data-open]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); openUrl(a.href); });
    });

    // возвращение из браузера после входа в Spotify
    document.addEventListener("visibilitychange", function () { if (!document.hidden) pollCallback(); });

    // прячем плавающую панель, пока открыта клавиатура
    document.addEventListener("focusin", function (e) {
      if (/^(text|search|password)$/.test(e.target.type || "")) document.body.classList.add("kb");
    });
    document.addEventListener("focusout", function () { document.body.classList.remove("kb"); });
  }

  bind();
  setMode("track", true);
  renderQueue();
  renderAuth();
  renderSpAuth();
  pollCallback();
})();
