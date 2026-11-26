// Shared helpers for every scene. Loaded once from index.html before the scenes.
(function () {
  var D = window.MYCEL_DATA || {};
  function get(path) {
    return String(path)
      .split(".")
      .reduce(function (o, k) { return o == null ? undefined : o[k]; }, D);
  }
  // Seeded PRNG (mulberry32): deterministic "random" geometry.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Replace every [data-d="key"] inside scope with the value from data.json.
  function fill(scope) {
    (scope || document).querySelectorAll("[data-d]").forEach(function (el) {
      var v = get(el.getAttribute("data-d"));
      if (v !== undefined) el.textContent = (el.getAttribute("data-pre") || "") + v + (el.getAttribute("data-post") || "");
    });
  }
  // Tween a number-with-suffix string ("38k", "1.2k", 300) from 0 on a timeline.
  function count(tl, el, value, at, dur) {
    var m = String(value).match(/^([^\d]*)([\d.]+)(.*)$/);
    if (!m) { tl.set(el, { textContent: value }, at); return; }
    var pre = m[1], target = parseFloat(m[2]), post = m[3];
    var decimals = (m[2].split(".")[1] || "").length;
    var o = { v: 0 };
    tl.fromTo(o, { v: 0 }, {
      v: target, duration: dur, ease: "power2.out",
      onUpdate: function () { el.textContent = pre + o.v.toFixed(decimals) + post; },
    }, at);
  }
  window.MY = { D: D, get: get, rng: rng, fill: fill, count: count };
})();
