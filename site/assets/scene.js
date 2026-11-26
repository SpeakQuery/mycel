// 3D "context window": a glass column (200k tokens) that tool definitions fill up.
// Direct MCP: stacked blocks overflow and glow red. Through Mycel: one thin green slice
// plus a mycelium network of servers wired to a single hub. State comes from window.MycelModel.
import * as T from "./vendor/three.module.min.js";

const M = window.MycelModel;
const stage = document.getElementById("gl-stage");
const canvas = document.getElementById("gl-canvas");

(async function init() {
  if (!M || !stage || !canvas) return;
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    if (!renderer.getContext()) throw new Error("no webgl");
  } catch (e) { return; } // CSS fallback stays visible
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = T.SRGBColorSpace;

  const H = 6, W = 2, CTX = M.CTX, MAXH = H * 1.55;
  const GREEN = new T.Color(0x3dffb0), RED = new T.Color(0xff6b5b), AMBER = new T.Color(0xffb547);
  const scene = new T.Scene();
  const cam = new T.PerspectiveCamera(38, 1, 0.1, 100);
  const world = new T.Group();
  scene.add(world);

  // soft round sprite texture shared by glows and pulses
  const cv = document.createElement("canvas"); cv.width = cv.height = 64;
  const cx = cv.getContext("2d"), g = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(255,255,255,.45)"); g.addColorStop(1, "rgba(255,255,255,0)");
  cx.fillStyle = g; cx.fillRect(0, 0, 64, 64);
  const glowTex = new T.CanvasTexture(cv);

  // ---- column
  const colGeo = new T.BoxGeometry(W, H, W);
  const col = new T.Mesh(colGeo, new T.MeshBasicMaterial({ color: 0x7fffd4, transparent: true, opacity: 0.05, side: T.DoubleSide, depthWrite: false }));
  col.position.y = H / 2; world.add(col);
  const colEdges = new T.LineSegments(new T.EdgesGeometry(colGeo), new T.LineBasicMaterial({ color: 0x3dffb0, transparent: true, opacity: 0.55 }));
  colEdges.position.y = H / 2; world.add(colEdges);
  [0.25, 0.5, 0.75, 1].forEach((f) => { // 50k / 100k / 150k / 200k rings
    const h = W / 2, y = H * f;
    const geo = new T.BufferGeometry().setFromPoints([[-h, y, -h], [h, y, -h], [h, y, h], [-h, y, h], [-h, y, -h]].map((p) => new T.Vector3(...p)));
    world.add(new T.Line(geo, new T.LineBasicMaterial({ color: 0x3dffb0, transparent: true, opacity: f === 1 ? 0.8 : 0.22 })));
  });
  const base = new T.Mesh(new T.BoxGeometry(W + 1, 0.08, W + 1), new T.MeshBasicMaterial({ color: 0x0f2a20 }));
  base.position.y = -0.04; world.add(base);
  const baseGlow = new T.Sprite(new T.SpriteMaterial({ map: glowTex, color: GREEN, transparent: true, opacity: 0.35, blending: T.AdditiveBlending, depthWrite: false }));
  baseGlow.scale.set(9, 9, 1); baseGlow.position.set(0, 0.1, 0); world.add(baseGlow);
  const topGlow = new T.Sprite(new T.SpriteMaterial({ map: glowTex, color: RED, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
  topGlow.scale.set(7, 5, 1); topGlow.position.set(0, H, 0); world.add(topGlow);
  const bodyGlow = new T.Sprite(new T.SpriteMaterial({ map: glowTex, color: RED, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
  bodyGlow.scale.set(5, H * 1.8, 1); bodyGlow.position.set(0, H / 2, 0); world.add(bodyGlow);

  // ---- tool-definition blocks (one per server)
  const unit = new T.BoxGeometry(1, 1, 1), unitEdges = new T.EdgesGeometry(unit);
  const segs = [];
  for (let i = 0; i < 15; i++) {
    const m = new T.Mesh(unit, new T.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.62 }));
    const e = new T.LineSegments(unitEdges, new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
    m.add(e); m.visible = false; world.add(m);
    segs.push({ m, e, vis: 0 });
  }

  // ---- servers, hub and wiring
  const hub = new T.Vector3(2.7, H * 0.62, 2.7);
  const slice = new T.Vector3(0, 0.3, W / 2);
  const hubMesh = new T.Mesh(new T.SphereGeometry(0.34, 20, 14), new T.MeshBasicMaterial({ color: 0xcfffea, transparent: true, opacity: 0 }));
  hubMesh.position.copy(hub); world.add(hubMesh);
  const hubGlow = new T.Sprite(new T.SpriteMaterial({ map: glowTex, color: GREEN, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
  hubGlow.scale.set(2.6, 2.6, 1); hubGlow.position.copy(hub); world.add(hubGlow);

  const srv = [];
  const STEPS = 28;
  for (let i = 0; i < 15; i++) {
    const a = i * 2.399963 + 0.4, r = 4.5 + (i % 3) * 0.35, y = 0.7 + ((i * 0.381966) % 1) * (H - 1.4);
    const pos = new T.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
    const node = new T.Mesh(new T.SphereGeometry(0.17, 12, 10), new T.MeshBasicMaterial({ color: 0xe6f4ee, transparent: true, opacity: 0 }));
    node.position.copy(pos); world.add(node);
    const halo = new T.Sprite(new T.SpriteMaterial({ map: glowTex, color: AMBER, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
    halo.scale.set(1.1, 1.1, 1); halo.position.copy(pos); world.add(halo);
    // direct: server straight into the column wall; mycel: wandering hypha to the hub
    const dir = pos.clone().setY(0).normalize(), end = new T.Vector3(dir.x * (W / 2) * 1.0, y, dir.z * (W / 2) * 1.0);
    const cD = new T.QuadraticBezierCurve3(pos, pos.clone().lerp(end, 0.5).add(new T.Vector3(0, 0.5, 0)), end).getPoints(STEPS);
    const wob = new T.Vector3(Math.sin(i * 7.1) * 0.9, Math.cos(i * 3.7) * 0.8, Math.cos(i * 5.3) * 0.9);
    const cM = new T.QuadraticBezierCurve3(pos, pos.clone().lerp(hub, 0.5).add(wob), hub).getPoints(STEPS);
    const lD = new T.Line(new T.BufferGeometry().setFromPoints(cD), new T.LineBasicMaterial({ color: RED, transparent: true, opacity: 0 }));
    const lM = new T.Line(new T.BufferGeometry().setFromPoints(cM), new T.LineBasicMaterial({ color: GREEN, transparent: true, opacity: 0 }));
    world.add(lD, lM);
    srv.push({ node, halo, lD, lM, cD, cM, vis: 0, ph: (i * 0.137) % 1 });
  }
  const cH = new T.QuadraticBezierCurve3(hub, hub.clone().lerp(slice, 0.5).add(new T.Vector3(0.6, 0.8, 0.4)), slice).getPoints(STEPS);
  const lH = new T.Line(new T.BufferGeometry().setFromPoints(cH), new T.LineBasicMaterial({ color: GREEN, transparent: true, opacity: 0 }));
  world.add(lH);

  // pulses travelling along the wires (one point per server + one on the hub wire)
  const pArr = new Float32Array(16 * 3);
  const pGeo = new T.BufferGeometry(); pGeo.setAttribute("position", new T.BufferAttribute(pArr, 3));
  const pMat = new T.PointsMaterial({ map: glowTex, color: RED, size: 0.55, transparent: true, depthWrite: false, blending: T.AdditiveBlending });
  const pulses = new T.Points(pGeo, pMat); pulses.frustumCulled = false; world.add(pulses);

  // spores: faint drifting dust around the hub (mycelium feel)
  const SP = 70, sArr = new Float32Array(SP * 3), sSeed = [];
  for (let i = 0; i < SP; i++) { sSeed.push([Math.random() * 6.28, Math.random() * 6.28, 1 + Math.random() * 4.2, 0.1 + Math.random() * 0.25]); }
  const sGeo = new T.BufferGeometry(); sGeo.setAttribute("position", new T.BufferAttribute(sArr, 3));
  const sMat = new T.PointsMaterial({ map: glowTex, color: GREEN, size: 0.2, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending });
  const spores = new T.Points(sGeo, sMat); spores.frustumCulled = false; world.add(spores);

  // ---- animated state
  const A = { tot: 0.01, t: 0, tTot: 0.01, hubVis: 0 };
  const target = () => {
    const s = M.state, p = M.point(s.n, s.heavy), my = s.mode === "mycel";
    return { n: s.n, my, h: Math.min(MAXH, Math.max(my ? 0.07 : 0.05, (my ? p.m : p.d) / CTX * H)) };
  };
  const tmp = new T.Color();
  function update(dt, snap, time) {
    const k = snap ? 1 : 1 - Math.exp(-dt * 5.5), tg = target();
    A.tot += (tg.h - A.tot) * k; A.t += ((tg.my ? 1 : 0) - A.t) * k;
    let sum = 0;
    segs.forEach((s, i) => { s.vis += ((i < tg.n ? 1 : 0) - s.vis) * k; sum += s.vis; });
    sum = Math.max(sum, 0.001);
    const gap = 0.035 * (1 - A.t);
    let y = 0;
    segs.forEach((s, i) => {
      const h = Math.max(0.0001, (A.tot * s.vis) / sum - gap * s.vis);
      s.m.visible = s.vis > 0.01;
      s.m.scale.set(W * 0.86, h, W * 0.86); s.m.position.set(0, y + h / 2, 0); y += h + gap * s.vis;
      tmp.copy(AMBER).lerp(RED, i / 14); s.m.material.color.copy(tmp).lerp(GREEN, A.t);
      s.m.material.opacity = (0.5 + 0.2 * A.t) * Math.min(1, s.vis * 1.5);
      s.e.material.opacity = 0.5 * s.vis;
    });
    const over = Math.max(0, A.tot - H) / (MAXH - H);
    const fill = Math.min(1, A.tot / H), mycelP = A.t;
    topGlow.material.opacity = (1 - mycelP) * Math.min(1, over * 1.3 + (fill > 0.97 ? 0.35 : 0)) * 0.85;
    topGlow.position.y = Math.min(A.tot, H) + 0.1;
    bodyGlow.material.opacity = (1 - mycelP) * fill * 0.35 + mycelP * 0.06;
    tmp.copy(RED).lerp(GREEN, mycelP); bodyGlow.material.color.copy(tmp); baseGlow.material.color.copy(tmp);
    baseGlow.material.opacity = 0.2 + 0.25 * mycelP;
    colEdges.material.color.copy(tmp.copy(GREEN).lerp(RED, (1 - mycelP) * Math.min(1, fill * 1.2)));
    A.hubVis += (mycelP - A.hubVis) * k;
    hubMesh.material.opacity = A.hubVis; hubGlow.material.opacity = A.hubVis * (0.75 + 0.2 * Math.sin(time * 2.4));
    hubMesh.scale.setScalar(1 + 0.08 * Math.sin(time * 2.4));
    lH.material.opacity = A.hubVis * 0.9;
    pMat.color.copy(tmp.copy(RED).lerp(GREEN, mycelP));
    sMat.opacity = mycelP * 0.8;
    srv.forEach((s, i) => {
      s.vis += ((i < tg.n ? 1 : 0) - s.vis) * k;
      s.node.material.opacity = s.vis; s.node.scale.setScalar(0.4 + 0.6 * s.vis);
      s.halo.material.opacity = s.vis * 0.7; s.halo.material.color.copy(AMBER).lerp(GREEN, mycelP);
      s.lD.material.opacity = (1 - mycelP) * s.vis * 0.65; s.lM.material.opacity = mycelP * s.vis * 0.75;
      // pulse position
      const u = (time * (0.35 + 0.1 * (i % 3)) + s.ph) % 1, c = mycelP > 0.5 ? s.cM : s.cD, f = u * (STEPS), j = Math.min(STEPS - 1, Math.floor(f)), a = c[j], b = c[j + 1], w = f - j;
      const on = s.vis > 0.5;
      pArr[i * 3] = on ? a.x + (b.x - a.x) * w : 0; pArr[i * 3 + 1] = on ? a.y + (b.y - a.y) * w : -50; pArr[i * 3 + 2] = on ? a.z + (b.z - a.z) * w : 0;
    });
    { // hub -> slice pulse
      const u = (time * 0.5) % 1, f = u * STEPS, j = Math.min(STEPS - 1, Math.floor(f)), a = cH[j], b = cH[j + 1], w = f - j, on = mycelP > 0.5;
      pArr[45] = on ? a.x + (b.x - a.x) * w : 0; pArr[46] = on ? a.y + (b.y - a.y) * w : -50; pArr[47] = on ? a.z + (b.z - a.z) * w : 0;
    }
    pGeo.attributes.position.needsUpdate = true;
    if (mycelP > 0.02) {
      for (let i = 0; i < SP; i++) {
        const q = sSeed[i], an = q[0] + time * q[3], el = q[1] + time * q[3] * 0.6;
        sArr[i * 3] = hub.x * 0.5 + Math.cos(an) * Math.cos(el) * q[2]; sArr[i * 3 + 1] = hub.y * 0.8 + Math.sin(el) * q[2] * 0.8; sArr[i * 3 + 2] = hub.z * 0.5 + Math.sin(an) * Math.cos(el) * q[2];
      }
      sGeo.attributes.position.needsUpdate = true;
    }
  }

  // ---- orbit (tiny, hand written)
  const O = { az: 0.7, el: 0.3, vAz: 0, vEl: 0, drag: false, lastX: 0, lastY: 0, idle: 0, dist: 15 };
  const target3 = new T.Vector3(0, 3.1, 0);
  function placeCamera() {
    const ce = Math.cos(O.el);
    cam.position.set(target3.x + O.dist * ce * Math.sin(O.az), target3.y + O.dist * Math.sin(O.el), target3.z + O.dist * ce * Math.cos(O.az));
    cam.lookAt(target3);
  }
  canvas.style.touchAction = "pan-y";
  canvas.addEventListener("pointerdown", (e) => { O.drag = true; O.lastX = e.clientX; O.lastY = e.clientY; O.idle = 0; canvas.setPointerCapture(e.pointerId); stage.classList.add("dragging"); });
  canvas.addEventListener("pointermove", (e) => {
    if (!O.drag) return;
    const dx = e.clientX - O.lastX, dy = e.clientY - O.lastY; O.lastX = e.clientX; O.lastY = e.clientY;
    O.az -= dx * 0.008; O.el = Math.max(-0.15, Math.min(1.2, O.el + dy * 0.006)); O.vAz = -dx * 0.008; O.idle = 0;
    wake();
  });
  const endDrag = () => { O.drag = false; stage.classList.remove("dragging"); };
  canvas.addEventListener("pointerup", endDrag); canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") O.az -= 0.2; else if (e.key === "ArrowRight") O.az += 0.2; else return; e.preventDefault(); wake(); });
  canvas.tabIndex = 0;

  // ---- size
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    cam.aspect = w / h; cam.updateProjectionMatrix();
    const t = Math.tan((cam.fov * Math.PI) / 360);
    O.dist = Math.max(6.4 / t, 5.6 / (t * cam.aspect));
    wake();
  }
  new ResizeObserver(resize).observe(stage);

  // ---- loop: only while visible; static frames under reduced motion
  let raf = 0, visible = true, last = 0, time = 0;
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
    const reduced = mq.matches;
    time += reduced ? 0 : dt;
    if (!reduced) {
      if (!O.drag) { O.idle += dt; O.az += O.vAz * 0.9; O.vAz *= 0.92; if (O.idle > 1.2) O.az += dt * 0.18; }
    }
    update(dt, reduced, time);
    placeCamera();
    renderer.render(scene, cam);
    if (visible && !document.hidden && !reduced) raf = requestAnimationFrame(frame);
  }
  function wake() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) wake(); }, { threshold: 0.01 }).observe(stage);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  document.addEventListener("mycel:state", wake);
  mq.addEventListener && mq.addEventListener("change", wake);
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); stage.classList.remove("gl-ready"); cancelAnimationFrame(raf); raf = 0; visible = false; });

  stage.classList.add("gl-ready");
  resize();
  wake();
})();
