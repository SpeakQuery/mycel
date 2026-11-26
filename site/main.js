// Benchmark numbers: the single source of truth. Update here after `npm run bench`.
const STATS = {toolsDirect:167, toolsMycel:8, tokensDirect:"34.8k", tokensMycel:"1.1k", roundTripsDirect:21, roundTripsMycel:1};

(function () {
  "use strict";

  // ---- Stats injection -------------------------------------------------------
  // "38k" -> 38000, "1.9k" -> 1900, "2M" -> 2000000, 180 -> 180
  function toNumber(v) {
    if (typeof v === "number") return v;
    var m = String(v).trim().match(/^([\d.,]+)\s*([kKmM]?)$/);
    if (!m) return NaN;
    var n = parseFloat(m[1].replace(/,/g, ""));
    var mult = { k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[m[2]] || 1;
    return n * mult;
  }
  function cut(before, after, label) {
    var b = toNumber(before), a = toNumber(after);
    if (!(b > 0) || !(a >= 0) || a >= b) return "";
    var ratio = b / a;
    if (ratio >= 5 && isFinite(ratio)) return Math.round(ratio) + "× " + label;
    return "−" + Math.round((1 - a / b) * 100) + "%";
  }
  var derived = {
    toolsCut: cut(STATS.toolsDirect, STATS.toolsMycel, "fewer"),
    tokensCut: cut(STATS.tokensDirect, STATS.tokensMycel, "smaller"),
    roundTripsCut: cut(STATS.roundTripsDirect, STATS.roundTripsMycel, "fewer")
  };
  document.querySelectorAll("[data-stat]").forEach(function (el) {
    var key = el.getAttribute("data-stat");
    var val = key in STATS ? STATS[key] : derived[key];
    if (val !== undefined) el.textContent = String(val);
  });

  // ---- Copy to clipboard -----------------------------------------------------
  var status = document.getElementById("copy-status");
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy") ? resolve() : reject(); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }
  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var target = btn.getAttribute("data-copy-target");
      if (!text && target) {
        var node = document.getElementById(target);
        text = node ? node.textContent : "";
      }
      if (!text) return;
      var label = btn.querySelector(".copy-label") || btn;
      var original = label.textContent;
      copyText(text).then(function () {
        btn.classList.add("copied");
        label.textContent = "Copied";
        if (status) status.textContent = "Copied to clipboard";
      }, function () {
        label.textContent = "Copy manually";
        if (status) status.textContent = "Copy failed. Select the text and copy manually.";
      }).then(function () {
        setTimeout(function () { btn.classList.remove("copied"); label.textContent = original; }, 1800);
      });
    });
  });

  // ---- Video placeholder when the file is missing ----------------------------
  var video = document.getElementById("launch-video");
  var fallback = document.getElementById("video-fallback");
  if (video && fallback) {
    var showFallback = function () {
      fallback.hidden = false;
      video.setAttribute("aria-hidden", "true");
      video.removeAttribute("controls");
      video.tabIndex = -1;
    };
    video.addEventListener("error", showFallback);
    if (video.error || video.networkState === 3 /* NETWORK_NO_SOURCE */) showFallback();
  }

  // ---- Mycelium canvas background --------------------------------------------
  var canvas = document.getElementById("mesh");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  var DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  var FRAME_MS = 1000 / 30; // cap at 30 fps
  var W = 0, H = 0, nodes = [], edges = [], pulses = [], raf = 0, last = 0, running = false;

  function rand(a, b) { return a + Math.random() * (b - a); }

  function build() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    var count = Math.max(18, Math.min(64, Math.round((W * H) / 26000)));
    nodes = [];
    for (var i = 0; i < count; i++) {
      nodes.push({ x: rand(0, W), y: rand(0, H), vx: rand(-.12, .12), vy: rand(-.12, .12), r: rand(1.2, 2.6), p: rand(0, Math.PI * 2) });
    }
    // connect each node to its 2-3 nearest neighbours (stable graph = cheap per frame)
    edges = [];
    var maxD = Math.min(260, Math.max(150, W / 6));
    for (var a = 0; a < nodes.length; a++) {
      var near = [];
      for (var b = 0; b < nodes.length; b++) {
        if (a === b) continue;
        var dx = nodes[a].x - nodes[b].x, dy = nodes[a].y - nodes[b].y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < maxD) near.push([d, b]);
      }
      near.sort(function (p, q) { return p[0] - q[0]; });
      for (var k = 0; k < Math.min(3, near.length); k++) {
        var j = near[k][1];
        if (a < j) edges.push([a, j]); else if (!edges.some(function (e) { return e[0] === j && e[1] === a; })) edges.push([j, a]);
      }
    }
    pulses = [];
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    // threads
    ctx.lineWidth = 1;
    for (var i = 0; i < edges.length; i++) {
      var A = nodes[edges[i][0]], B = nodes[edges[i][1]];
      var mx = (A.x + B.x) / 2 + (A.y - B.y) * 0.12, my = (A.y + B.y) / 2 + (B.x - A.x) * 0.12; // organic curve
      ctx.strokeStyle = "rgba(61,255,176,0.13)";
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo(mx, my, B.x, B.y); ctx.stroke();
    }
    // pulses travelling along threads
    for (var p = pulses.length - 1; p >= 0; p--) {
      var pl = pulses[p], e = edges[pl.e];
      if (!e) { pulses.splice(p, 1); continue; }
      var N1 = nodes[e[0]], N2 = nodes[e[1]];
      var cx = (N1.x + N2.x) / 2 + (N1.y - N2.y) * 0.12, cy = (N1.y + N2.y) / 2 + (N2.x - N1.x) * 0.12;
      var s = pl.dir > 0 ? pl.t : 1 - pl.t, u = 1 - s;
      var x = u * u * N1.x + 2 * u * s * cx + s * s * N2.x, y = u * u * N1.y + 2 * u * s * cy + s * s * N2.y;
      var g = ctx.createRadialGradient(x, y, 0, x, y, 10);
      g.addColorStop(0, "rgba(61,255,176,0.7)"); g.addColorStop(1, "rgba(61,255,176,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();
      pl.t += pl.v;
      if (pl.t >= 1) pulses.splice(p, 1);
    }
    // nodes
    for (var n = 0; n < nodes.length; n++) {
      var nd = nodes[n], tw = 0.55 + 0.45 * Math.sin(t / 1400 + nd.p);
      ctx.fillStyle = "rgba(61,255,176," + (0.18 * tw).toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r * 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(170,255,220," + (0.55 + 0.35 * tw).toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  function step(dt) {
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      nd.x += nd.vx * dt / 16; nd.y += nd.vy * dt / 16;
      if (nd.x < -20 || nd.x > W + 20) nd.vx *= -1;
      if (nd.y < -20 || nd.y > H + 20) nd.vy *= -1;
    }
    if (edges.length && pulses.length < 7 && Math.random() < 0.05) {
      pulses.push({ e: Math.floor(Math.random() * edges.length), t: 0, v: rand(0.006, 0.014), dir: Math.random() < 0.5 ? 1 : -1 });
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < FRAME_MS) return;
    var dt = Math.min(64, now - last || FRAME_MS);
    last = now;
    step(dt);
    draw(now);
  }

  function start() {
    if (running || (reduce && reduce.matches) || document.hidden) return;
    running = true; last = performance.now(); raf = requestAnimationFrame(loop);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  build();
  draw(0); // static frame (used as-is when reduced motion is on)
  start();

  document.addEventListener("visibilitychange", function () { document.hidden ? stop() : start(); });
  if (reduce) {
    var onChange = function () { if (reduce.matches) { stop(); draw(0); } else start(); };
    reduce.addEventListener ? reduce.addEventListener("change", onChange) : reduce.addListener(onChange);
  }
  var rt = 0;
  window.addEventListener("resize", function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      if (Math.abs(window.innerWidth - W) < 2 && Math.abs(window.innerHeight - H) < 120) return; // ignore mobile URL-bar jitter
      build(); draw(performance.now());
    }, 200);
  });
})();

// ---- Shared token model (measured 1-8 servers, estimated 9-15) ---------------------
window.MycelModel = (function () {
  "use strict";
  var CTX = 200000;
  // Measured tokens of tool definitions per turn, 1..8 servers (real open-source servers).
  var DIRECT = [1089, 1451, 4729, 6658, 9424, 10585, 12498, 17798];
  var MYCEL = [1128, 1498, 3832, 919, 951, 962, 995, 1032];
  var st = { n: 8, heavy: false, mode: "direct" };
  function point(n, heavy) {
    if (heavy) return { d: 204000, m: 1200, est: false, heavy: true }; // measured: 15 servers incl. Canva + Higgsfield, 414 tools
    n = Math.max(1, Math.min(15, Math.round(n) || 1));
    if (n <= 8) return { d: DIRECT[n - 1], m: MYCEL[n - 1], est: false };
    return { d: DIRECT[7] + 2200 * (n - 8), m: MYCEL[7] + 28 * (n - 8), est: true };
  }
  function score(tokens) { return Math.max(0, Math.min(100, Math.round(100 * (1 - tokens / CTX)))); }
  function grade(s) { return s >= 95 ? "A" : s >= 85 ? "B" : s >= 70 ? "C" : s >= 50 ? "D" : "F"; }
  function set(p) {
    if (p.n != null) st.n = Math.max(1, Math.min(15, Math.round(p.n) || 1));
    st.heavy = p.heavy != null ? !!p.heavy : (p.n != null ? false : st.heavy);
    if (st.heavy) st.n = 15;
    if (p.mode) st.mode = p.mode;
    document.dispatchEvent(new CustomEvent("mycel:state", { detail: st }));
  }
  return { CTX: CTX, state: st, point: point, score: score, grade: grade, set: set };
})();

// ---- Scroll reveal ----------------------------------------------------------------
(function () {
  "use strict";
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) return;
  var targets = document.querySelectorAll(".section .wrap > *, .reason, .pains li, .features li, .sv-card, .ba-card, .qs li, .how-step");
  if (!targets.length) return;
  document.documentElement.classList.add("js-reveal");
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting || e.boundingClientRect.top < 0) { e.target.classList.add("in"); io.unobserve(e.target); }
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
  targets.forEach(function (el) {
    el.classList.add("rv");
    var sib = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
    if (el.matches("li, .ba-card, .how-step")) el.style.setProperty("--d", Math.min(sib, 7) * 70 + "ms");
    io.observe(el);
  });
})();

// ---- 3D controls + fallback readout ------------------------------------------------
(function () {
  "use strict";
  var M = window.MycelModel, $ = function (id) { return document.getElementById(id); };
  var range = $("gl-range");
  if (!range) return;
  var bD = $("gl-direct"), bM = $("gl-mycel");
  function k(v) { return v >= 100000 ? Math.round(v / 1000) + "k" : v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v)); }
  function render() {
    var s = M.state, p = M.point(s.n, s.heavy), mycel = s.mode === "mycel", tok = mycel ? p.m : p.d, pct = tok / M.CTX * 100;
    range.value = s.n; $("gl-count").textContent = s.heavy ? "15 (414 tools)" : s.n;
    bD.setAttribute("aria-pressed", String(!mycel)); bM.setAttribute("aria-pressed", String(mycel));
    $("gl-mode").textContent = mycel ? "Through Mycel" : "Direct MCP";
    $("gl-mode").className = "gl-mode " + (mycel ? "ok" : "bad");
    $("gl-tok").textContent = k(tok) + " tokens";
    $("gl-pct").textContent = (pct >= 10 ? Math.round(pct) : pct.toFixed(1)) + "% of a 200k window" + (pct > 100 ? " (overflow)" : "");
    $("gl-note").textContent = s.heavy ? "Measured in a local lab (remote servers signed in; not yet reproducible from the repo): 15 servers including Canva and Higgsfield, 414 tools. In a client that sends every definition, direct MCP overflows a 200k window before the first message."
      : p.est ? "Estimate: beyond 8 servers we assume about 2.2k extra tokens per server (direct) and about 28 (Mycel). Real heavy setups are bigger."
      : "Measured with real open-source MCP servers." + (s.n <= 2 ? " With 1 to 2 servers Mycel saves nothing." : "");
    $("fb-fill").style.height = Math.min(100, Math.max(1.5, pct)) + "%";
    $("fb-fill").className = "fb-fill " + (mycel ? "ok" : "bad");
    range.setAttribute("aria-valuetext", s.n + " servers, " + k(tok) + " tokens" + (p.est ? " (estimate)" : ""));
  }
  range.addEventListener("input", function () { M.set({ n: +range.value }); });
  bD.addEventListener("click", function () { M.set({ mode: "direct" }); });
  bM.addEventListener("click", function () { M.set({ mode: "mycel" }); });
  $("gl-heavy").addEventListener("click", function () { M.set({ heavy: true, mode: "direct" }); });
  document.addEventListener("mycel:state", render);
  render();
})();

// ---- Savings calculator ------------------------------------------------------------
(function () {
  "use strict";
  var M = window.MycelModel, $ = function (id) { return document.getElementById(id); };
  if (!$("calc")) return;
  var mq = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  var DAYS = 22;
  var inputs = { servers: [1, 15, 8], turns: [10, 2000, 200], devs: [1, 200, 5], price: [0, 1000, 3] };
  var v = { servers: 8, turns: 200, devs: 5, price: 3 };
  var heavy = false;

  // animated numbers
  function tween(el, to, fmt) {
    var from = el._v || 0;
    cancelAnimationFrame(el._r);
    if ((mq && mq.matches) || from === to) { el._v = to; el.textContent = fmt(to); return; }
    var t0 = performance.now(), dur = 700;
    (function step(now) {
      var p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el._v = from + (to - from) * e; el.textContent = fmt(el._v);
      if (p < 1) el._r = requestAnimationFrame(step); else el._v = to;
    })(t0);
  }
  function compact(x) { // 1,234 | 12.3k | 4.56M | 1.20B
    x = Math.abs(x);
    if (x >= 1e9) return (x / 1e9).toFixed(2) + "B";
    if (x >= 1e6) return (x / 1e6).toFixed(x >= 1e8 ? 0 : 1) + "M";
    if (x >= 1e4) return (x / 1e3).toFixed(x >= 1e5 ? 0 : 1) + "k";
    return Math.round(x).toLocaleString("en-US");
  }
  function money(x) { return "$" + (x >= 1e5 ? compact(x) : Math.round(x).toLocaleString("en-US")); }
  function pctf(x) { return (x >= 10 ? Math.round(x) : x.toFixed(1)) + "%"; }
  function setGain(id, amount, fmt) {
    var el = $(id);
    if (amount <= 0) { cancelAnimationFrame(el._r); el._v = 0; el.textContent = "no gain"; el.classList.add("nogain"); return; }
    el.classList.remove("nogain"); tween(el, amount, fmt);
  }
  function gauge(prefix, tokens) {
    var pct = tokens / M.CTX * 100, s = M.score(tokens), g = M.grade(s);
    $("ring-" + prefix).style.strokeDashoffset = String(100 - Math.max(1.2, Math.min(100, pct)));
    tween($("o-p" + prefix), pct, pctf);
    tween($("o-s" + prefix), s, function (x) { return String(Math.round(x)); });
    var gr = $("gr-" + prefix); gr.setAttribute("data-g", g); gr.firstChild.textContent = g;
    gr.setAttribute("aria-label", "Context headroom grade " + g + ", score " + s + " of 100");
  }
  function render() {
    var p = M.point(v.servers, heavy), saved = p.d - p.m, tokens = saved * v.turns * v.devs * DAYS, usd = tokens / 1e6 * v.price;
    tween($("o-d"), p.d, compact); tween($("o-m"), p.m, compact);
    setGain("o-tokens", tokens, compact); setGain("o-month", usd, money); setGain("o-year", usd * 12, money);
    gauge("d", p.d); gauge("m", p.m);
    $("c-est").hidden = !p.est;
    $("c-note").textContent = p.heavy
      ? "Measured in a local lab (remote servers signed in; not yet reproducible from the repo): 15 servers including Canva and Higgsfield, 414 tools. About 204k tool-definition tokens direct, 1.2k through Mycel. In a client that sends every definition, direct MCP fills the whole 200k window before the first message."
      : saved <= 0 ? "With " + v.servers + (v.servers === 1 ? " server" : " servers") + " Mycel's meta-tools cost about as much as your tool list, so there is no gain. Skip it unless you want Code Mode, refs or the safety layer."
      : p.est ? "Estimate: beyond 8 measured servers we assume about 2.2k extra tokens per server (direct) and about 28 (Mycel). Heavy real setups are larger."
      : "Measured with real open-source MCP servers.";
  }
  function clamp(key, x) { var r = inputs[key]; return Math.max(r[0], Math.min(r[1], x)); }
  function bind(key) {
    var rng = $("c-" + key), num = $("c-" + key + "-n");
    function apply(x, fromNum) {
      if (!isFinite(x)) return;
      v[key] = clamp(key, x);
      if (!fromNum || document.activeElement !== num) num.value = v[key];
      if (!fromNum || x === v[key]) rng.value = v[key];
      if (key === "servers") { heavy = false; M.set({ n: v.servers, heavy: false }); }
      render();
    }
    rng.addEventListener("input", function () { apply(parseFloat(rng.value), false); });
    num.addEventListener("input", function () { if (num.value !== "") apply(parseFloat(num.value), true); });
    num.addEventListener("blur", function () { num.value = v[key]; });
  }
  Object.keys(inputs).forEach(bind);
  $("c-heavy").addEventListener("click", function () {
    heavy = true; v.servers = 15; $("c-servers").value = 15; $("c-servers-n").value = 15;
    M.set({ heavy: true, mode: "direct" }); render();
  });
  // keep the 3D slider and the calculator in sync
  document.addEventListener("mycel:state", function (e) {
    var s = e.detail;
    if (s.n !== v.servers || s.heavy !== heavy) {
      v.servers = s.n; heavy = s.heavy; $("c-servers").value = s.n; $("c-servers-n").value = s.n; render();
    }
  });
  render();
  // count up from zero the first time the calculator scrolls into view
  if ("IntersectionObserver" in window && !(mq && mq.matches)) {
    var io = new IntersectionObserver(function (es) {
      if (!es[0].isIntersecting) return;
      io.disconnect();
      ["o-d", "o-m", "o-tokens", "o-month", "o-year", "o-pd", "o-pm", "o-sd", "o-sm"].forEach(function (id) { $(id)._v = 0; });
      render();
    }, { threshold: 0.2 });
    io.observe($("calc"));
  }
})();

// Deep links such as /#film: scroll once layout (fonts, video poster) has settled.
window.addEventListener("load", () => {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id && document.getElementById(id);
  if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
});
