/* Интерфейс Last.fm Scrobbler. Логика API — в core.js, платформенные вещи — через мост Native. */
(function () {
  "use strict";

  var Core = window.Core;
  var $ = function (s, r) { return (r || document).querySelector(s); };

  var ICON_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2.5"/><circle cx="17" cy="16" r="2.5"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';
  var ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>';
  var ICON_MINUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 12h12"/></svg>';
  var TABS = ["search", "queue", "profile"];

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
    cfg: store.cfg || {},         // lfmKey, lfmSecret, spId, spSecret, sk, username, pendingToken
    queue: store.queue || [],     // [{track, count}]
    mode: "track", query: "", offset: 0, total: 0, results: [], searching: false,
    addCount: 1,
    date: "", time: "",
    sending: false, stop: false
  };

  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ cfg: S.cfg, queue: S.queue })); } catch (e) { /* ignore */ }
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
    }
  };
  var api = Core.createApi(env);

  function openUrl(u) {
    if (hasNative) window.Native.openUrl(u); else window.open(u, "_blank");
  }
  function keepAwake(on) {
    if (hasNative && window.Native.keepAwake) window.Native.keepAwake(on);
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

  // ---------- поиск ----------

  function coverHtml(t) {
    var url = t.cover && /^https:\/\//.test(t.cover) ? t.cover : "";
    return '<div class="cover">' + (url
      ? '<img src="' + esc(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : ICON_NOTE) + '</div>';
  }

  function renderResults() {
    var box = $("#results");
    if (S.searching && !S.results.length) {
      box.innerHTML = '<div class="empty"><div class="spin"></div>Ищу в Spotify…</div>';
    } else if (!S.results.length) {
      box.innerHTML = '<div class="empty">' + ICON_NOTE + '<div>' +
        (S.query ? "Ничего не найдено" : "Найдите трек или артиста в каталоге Spotify") + '</div></div>';
    } else {
      box.innerHTML = S.results.map(function (t, i) {
        return '<div class="row" style="--i:' + (i % Core.PAGE_SIZE) + '">' + coverHtml(t) +
          '<div class="meta"><div class="t">' + esc(t.title) + '</div>' +
          '<div class="s">' + esc(t.artist) + (t.album ? " · " + esc(t.album) : "") + '</div></div>' +
          '<div class="side"><span class="dur">' + Core.fmtDur(t.durationS) + '</span>' +
          '<button class="rbtn" data-act="add" data-i="' + i + '" aria-label="Добавить">' + ICON_PLUS + '</button></div></div>';
      }).join("");
    }
    var more = $("#btn-more");
    var canMore = S.results.length > 0 && S.offset < Math.min(S.total, 1000);
    more.hidden = !canMore;
    more.disabled = S.searching;
  }

  async function doSearch(more) {
    if (S.searching) return;
    var cfg = { id: (S.cfg.spId || "").trim(), secret: (S.cfg.spSecret || "").trim() };
    if (!cfg.id || !cfg.secret) {
      toast("Введите ключи Spotify на вкладке «Профиль»", "error");
      setTab("profile");
      return;
    }
    if (!more) {
      var q = $("#q").value.trim();
      if (!q) return;
      S.query = q; S.offset = 0; S.total = 0; S.results = [];
      document.activeElement && document.activeElement.blur();
    }
    S.searching = true;
    renderResults();
    try {
      var r = await api.searchTracks(cfg, S.query, S.mode, S.offset);
      S.results = S.results.concat(r.tracks);
      S.offset += Core.PAGE_SIZE;
      S.total = r.total;
    } catch (e) {
      toast(e.message, "error");
    } finally {
      S.searching = false;
      renderResults();
    }
  }

  // ---------- очередь ----------

  function addToQueue(track, cnt) {
    for (var i = 0; i < S.queue.length; i++) {
      var q = S.queue[i].track;
      if (q.artist === track.artist && q.title === track.title && q.album === track.album) {
        S.queue[i].count += cnt;
        return;
      }
    }
    S.queue.push({ track: track, count: cnt });
  }

  function renderQueue() {
    var box = $("#queue");
    box.hidden = !S.queue.length;
    box.innerHTML = S.queue.map(function (q, i) {
      var t = q.track;
      return '<div class="row" style="--i:' + i + '">' + coverHtml(t) +
        '<div class="meta"><div class="t">' + esc(t.title) + '</div>' +
        '<div class="s">' + esc(t.artist) + ' · ' + Core.fmtDur(t.durationS) + '</div></div>' +
        '<div class="side"><div class="qctl">' +
        '<button class="rbtn" data-act="dec" data-i="' + i + '" aria-label="Меньше">' + ICON_MINUS + '</button>' +
        '<span class="qcount">' + q.count + '</span>' +
        '<button class="rbtn" data-act="inc" data-i="' + i + '" aria-label="Больше">' + ICON_PLUS + '</button></div>' +
        '<button class="rbtn" data-act="del" data-i="' + i + '" aria-label="Удалить">' + ICON_X + '</button></div></div>';
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
      el.innerHTML = '<div class="big">Очередь пуста</div><div class="line">Добавьте треки на вкладке «Поиск»</div>';
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
    $("#btn-more").addEventListener("click", function () { doSearch(true); });
    $("#seg").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-mode]");
      if (!b) return;
      S.mode = b.getAttribute("data-mode");
      $("#seg").setAttribute("data-i", S.mode === "artist" ? "1" : "0");
      document.querySelectorAll("#seg button").forEach(function (x) { x.classList.toggle("on", x === b); });
      if ($("#q").value.trim()) doSearch(false);
    });
    function setAdd(n) { S.addCount = Math.max(1, Math.min(5000, n)); $("#add-count").textContent = S.addCount; }
    $("#add-dec").addEventListener("click", function () { setAdd(S.addCount - (S.addCount > 10 ? 5 : 1)); });
    $("#add-inc").addEventListener("click", function () { setAdd(S.addCount + (S.addCount >= 10 ? 5 : 1)); });

    $("#results").addEventListener("click", function (e) {
      var b = e.target.closest("[data-act=add]");
      if (!b) return;
      var t = S.results[+b.getAttribute("data-i")];
      if (!t) return;
      addToQueue(t, S.addCount);
      persist();
      renderQueue();
      b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
      toast("Добавлено: " + t.title + " ×" + S.addCount);
    });

    // очередь
    $("#queue").addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]");
      if (!b) return;
      var i = +b.getAttribute("data-i"), act = b.getAttribute("data-act"), q = S.queue[i];
      if (!q) return;
      if (act === "inc") q.count = Math.min(5000, q.count + 1);
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
    document.querySelectorAll("a[data-open]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); openUrl(a.href); });
    });

    // прячем плавающую панель, пока открыта клавиатура
    document.addEventListener("focusin", function (e) {
      if (/^(text|search|password)$/.test(e.target.type || "")) document.body.classList.add("kb");
    });
    document.addEventListener("focusout", function () { document.body.classList.remove("kb"); });
  }

  bind();
  renderResults();
  renderQueue();
  renderAuth();
})();
