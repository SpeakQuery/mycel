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

// ---- Savings calculator (measured 1-8, estimated beyond) -----------------------
(function () {
  "use strict";
  var range = document.getElementById("sv-range");
  if (!range) return;
  // Measured tokens of tool definitions per turn, 1..8 servers (real open-source servers).
  var DIRECT = [1089, 1451, 4729, 6658, 9424, 10585, 12498, 17798];
  var MYCEL = [1128, 1498, 3832, 919, 951, 962, 995, 1032];
  // Estimate beyond 8 servers: ~2.2k tokens per extra server direct, ~28 tokens for Mycel.
  function pt(n) {
    if (n <= 8) return { d: DIRECT[n - 1], m: MYCEL[n - 1], est: false };
    return { d: DIRECT[7] + 2200 * (n - 8), m: MYCEL[7] + 28 * (n - 8), est: true };
  }
  function fmt(v) {
    if (v >= 100000) return Math.round(v / 1000) + "k";
    if (v >= 1000) return (v / 1000).toFixed(1) + "k";
    return String(Math.round(v));
  }
  var el = function (id) { return document.getElementById(id); };
  function render() {
    var n = parseInt(range.value, 10) || 1;
    var p = pt(n);
    var pct = Math.round((1 - p.m / p.d) * 100);
    el("sv-count").textContent = n + (n === 1 ? " server" : " servers");
    el("sv-d1").textContent = fmt(p.d);
    el("sv-m1").textContent = fmt(p.m);
    el("sv-d30").textContent = fmt(p.d * 30);
    el("sv-m30").textContent = fmt(p.m * 30);
    el("sv-pct").textContent = pct < 0 ? "\u2212" + Math.abs(pct) + "%" : pct + "%";
    var maxD = pt(15).d;
    el("sv-bar-d").style.width = (p.d / maxD * 100).toFixed(1) + "%";
    el("sv-bar-m").style.width = (p.m / maxD * 100).toFixed(1) + "%";
    el("sv-note").textContent = p.est
      ? "Estimate: beyond 8 servers we assume ~2.2k tokens per extra server. Real heavy setups are larger (15 servers with 414 tools measured ~204k vs ~1.2k)."
      : "Measured with real open-source MCP servers" + (n <= 2 ? ". With 1\u20132 servers Mycel saves nothing, so skip it." : ".");
    range.setAttribute("aria-valuetext", n + " servers, " + pct + "% saved" + (p.est ? " (estimate)" : " (measured)"));
  }
  range.addEventListener("input", render);
  render();
})();

// Deep links such as /#film: scroll once layout (fonts, video poster) has settled.
window.addEventListener("load", () => {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id && document.getElementById(id);
  if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
});
