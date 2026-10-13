// Photo Caliper v3 — 3D mode (three.js), WebXR AR, COLMAP set builder
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { PLYExporter } from "three/addons/exporters/PLYExporter.js";

const $ = id => document.getElementById(id);
const PC = () => window.PC;
const st = (m) => { const e = $("m3Status"); if (e) e.textContent = m; };

/* ---------------- viewer ---------------- */
let renderer, scene, camera, controls, root = null, picks = [], pickMode = false, markers, sliceLine;
let unitScale = 1; // model units -> mm
let inited = false;

function init() {
  if (inited) return; inited = true;
  const stage = $("stage3d"); if (!stage) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  stage.appendChild(renderer.domElement);
  scene = new THREE.Scene(); scene.background = new THREE.Color(0x111418);
  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
  camera.position.set(0, 0, 100);
  controls = new OrbitControls(camera, renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
  const dl = new THREE.DirectionalLight(0xffffff, 0.8); dl.position.set(1, 2, 3); scene.add(dl);
  markers = new THREE.Group(); scene.add(markers);
  const ro = new ResizeObserver(resize); ro.observe(stage); resize();
  renderer.domElement.addEventListener("pointerdown", e => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener("pointerup", onPick);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
}
let downAt = null;
function resize() {
  const s = $("stage3d"); if (!s || !renderer) return;
  const w = s.clientWidth || 320, h = Math.max(260, Math.round(w * 0.8));
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}

function setModel(obj, name) {
  init();
  if (root) { scene.remove(root); }
  root = obj; scene.add(root); clearPicks();
  unitScale = 1;
  const box = new THREE.Box3().setFromObject(root), c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
  const r = Math.max(sz.x, sz.y, sz.z) || 1;
  controls.target.copy(c); camera.near = r / 1000; camera.far = r * 100;
  camera.position.copy(c).add(new THREE.Vector3(r * .9, r * .6, r * 1.4)); camera.updateProjectionMatrix();
  st("โหลด: " + (name || "model"));
  report();
}

function geomOf(obj) {
  const list = [];
  obj.updateMatrixWorld(true);
  obj.traverse(o => { if ((o.isMesh || o.isPoints) && o.geometry) list.push(o); });
  return list;
}

function meshStats() {
  let vol = 0, area = 0, tri = 0, pts = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const o of geomOf(root)) {
    const g = o.geometry, p = g.attributes.position; if (!p) continue;
    if (o.isPoints || !o.isMesh) { pts += p.count; continue; }
    const idx = g.index, n = idx ? idx.count : p.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(p, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(p, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(p, i2).applyMatrix4(o.matrixWorld);
      vol += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
      area += new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).length() / 2;
      tri++;
    }
  }
  return { vol: Math.abs(vol), area, tri, pts };
}

function report() {
  const out = $("m3Out"); if (!out || !root) return;
  const box = new THREE.Box3().setFromObject(root), sz = box.getSize(new THREE.Vector3()).multiplyScalar(unitScale);
  const s = meshStats(), f = v => v.toFixed(1);
  let h = `<div>กรอบ (มม.): ${f(sz.x)} × ${f(sz.y)} × ${f(sz.z)}</div>`;
  if (s.tri) h += `<div>สามเหลี่ยม ${s.tri.toLocaleString()} · พื้นผิว ${f(s.area * unitScale ** 2)} มม² · ปริมาตร ${f(s.vol * unitScale ** 3 / 1000)} ซม³ <small>(ถูกต้องเฉพาะเมชปิด)</small></div>`;
  if (s.pts) h += `<div>จุด ${s.pts.toLocaleString()} (point cloud — ไม่มีปริมาตร)</div>`;
  if (unitScale === 1) h += `<div class="warn">ยังไม่ได้ตั้งสเกล — หน่วยเป็นหน่วยของไฟล์</div>`;
  for (let i = 0; i + 1 < picks.length; i += 2) h += `<div>ระยะ ${i / 2 + 1}: <b>${f(picks[i].distanceTo(picks[i + 1]) * unitScale)} มม.</b></div>`;
  h += sliceText;
  out.innerHTML = h;
}

/* picking */
const ray = new THREE.Raycaster();
function onPick(e) {
  if (!pickMode || !root || !downAt) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  const r = renderer.domElement.getBoundingClientRect();
  const m = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const box = new THREE.Box3().setFromObject(root), rad = box.getSize(new THREE.Vector3()).length();
  ray.params.Points = { threshold: rad / 200 };
  ray.setFromCamera(m, camera);
  const hit = ray.intersectObject(root, true)[0]; if (!hit) return;
  picks.push(hit.point.clone());
  const sp = new THREE.Mesh(new THREE.SphereGeometry(rad / 150, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffcc00, depthTest: false }));
  sp.position.copy(hit.point); sp.renderOrder = 9; markers.add(sp);
  if (picks.length % 2 === 0) {
    const g = new THREE.BufferGeometry().setFromPoints(picks.slice(-2));
    const ln = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffcc00, depthTest: false })); ln.renderOrder = 9; markers.add(ln);
  }
  report();
}
function clearPicks() { picks = []; if (markers) markers.clear(); report(); }

/* scale */
function setScaleMm(mm) {
  if (picks.length < 2) { st("แตะ 2 จุดก่อน"); return; }
  const d = picks[picks.length - 2].distanceTo(picks[picks.length - 1]);
  if (!(mm > 0) || !(d > 0)) return;
  unitScale = mm / d; st(`สเกล = ${unitScale.toPrecision(5)} มม./หน่วย`); report();
}

/* slice / girth */
let sliceText = "";
function doSlice() {
  if (!root) return;
  const axisSel = $("m3Axis")?.value || "pca", t = (+($("m3Pos")?.value ?? 50)) / 100;
  const P = [];
  for (const o of geomOf(root)) { const p = o.geometry.attributes.position; for (let i = 0; i < p.count; i += Math.max(1, Math.floor(p.count / 20000))) P.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld)); }
  if (!P.length) return;
  const c = P.reduce((s, v) => s.add(v), new THREE.Vector3()).multiplyScalar(1 / P.length);
  let ax;
  if (axisSel === "x") ax = new THREE.Vector3(1, 0, 0); else if (axisSel === "y") ax = new THREE.Vector3(0, 1, 0); else if (axisSel === "z") ax = new THREE.Vector3(0, 0, 1);
  else { // power iteration on covariance
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const v of P) { const d = [v.x - c.x, v.y - c.y, v.z - c.z]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; }
    let x = [1, .7, .3]; for (let k = 0; k < 60; k++) { const y = C.map(r => r[0] * x[0] + r[1] * x[1] + r[2] * x[2]); const n = Math.hypot(...y) || 1; x = y.map(v => v / n); }
    ax = new THREE.Vector3(...x);
  }
  let lo = Infinity, hi = -Infinity; for (const v of P) { const s = v.clone().sub(c).dot(ax); lo = Math.min(lo, s); hi = Math.max(hi, s); }
  const h0 = lo + (hi - lo) * t;
  // intersect mesh triangles with plane
  const segs = [], a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  const sd = v => v.clone().sub(c).dot(ax) - h0;
  for (const o of geomOf(root)) {
    if (!o.isMesh) continue;
    const g = o.geometry, p = g.attributes.position, idx = g.index, n = idx ? idx.count : p.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const V = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(p, idx ? idx.getX(i + k) : i + k).applyMatrix4(o.matrixWorld));
      const S = V.map(sd), cut = [];
      for (let k = 0; k < 3; k++) { const k2 = (k + 1) % 3; if ((S[k] > 0) !== (S[k2] > 0)) { const u = S[k] / (S[k] - S[k2]); cut.push(V[k].clone().lerp(V[k2], u)); } }
      if (cut.length === 2) segs.push(cut);
    }
  }
  if (sliceLine) { scene.remove(sliceLine); sliceLine = null; }
  if (!segs.length) { sliceText = `<div>หน้าตัด: ไม่มี (point cloud หรือพ้นวัตถุ)</div>`; report(); return; }
  let L = 0; const pts = []; for (const [p1, p2] of segs) { L += p1.distanceTo(p2); pts.push(p1, p2); }
  // convex-hull perimeter in plane (robust to holes/noise)
  const u = new THREE.Vector3().crossVectors(ax, Math.abs(ax.x) < .9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize(), w = new THREE.Vector3().crossVectors(ax, u);
  const q = pts.map(v => [v.dot(u), v.dot(w)]).sort((A, B) => A[0] - B[0] || A[1] - B[1]);
  const cr = (o, A, B) => (A[0] - o[0]) * (B[1] - o[1]) - (A[1] - o[1]) * (B[0] - o[0]);
  const lw = [], up = []; for (const p of q) { while (lw.length > 1 && cr(lw[lw.length - 2], lw[lw.length - 1], p) <= 0) lw.pop(); lw.push(p); }
  for (let i = q.length - 1; i >= 0; i--) { const p = q[i]; while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  const hull = lw.slice(0, -1).concat(up.slice(0, -1)); let H = 0; for (let i = 0; i < hull.length; i++) { const A = hull[i], B = hull[(i + 1) % hull.length]; H += Math.hypot(A[0] - B[0], A[1] - B[1]); }
  sliceLine = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x00e0ff, depthTest: false })); sliceLine.renderOrder = 8; scene.add(sliceLine);
  sliceText = `<div>หน้าตัด @${Math.round(t * 100)}%: รอบวง(ตามผิว) ${(L * unitScale).toFixed(1)} มม. · รอบวง(ตลับเมตร/hull) <b>${(H * unitScale).toFixed(1)} มม.</b></div>`;
  report();
}

/* loading */
async function loadFile(file) {
  const name = file.name.toLowerCase(), buf = await file.arrayBuffer();
  const mat = new THREE.MeshStandardMaterial({ color: 0xc8b8a8, side: THREE.DoubleSide, flatShading: false });
  try {
    if (name.endsWith(".json")) { const j = JSON.parse(new TextDecoder().decode(buf)); if (j.mm_per_unit) { unitScale = 1; st(`scale.json: ${j.mm_per_unit} มม./หน่วย (ใช้กับไฟล์ต้นฉบับที่ยังไม่สเกล)`); pendingScale = j.mm_per_unit; } return; }
    if (name.endsWith(".ply") || name.endsWith(".splat")) {
      if (name.endsWith(".splat")) { setModel(splatPoints(buf), file.name); return; }
      const g = new PLYLoader().parse(buf); g.computeBoundingBox();
      const isMesh = g.index && g.index.count > 0;
      let obj;
      if (isMesh) { g.computeVertexNormals(); if (g.attributes.color) mat.vertexColors = true; obj = new THREE.Mesh(g, mat); }
      else obj = new THREE.Points(g, new THREE.PointsMaterial({ size: 0, sizeAttenuation: false, vertexColors: !!g.attributes.color, color: g.attributes.color ? 0xffffff : 0xc8b8a8 })), obj.material.size = 2;
      setModel(obj, file.name);
    } else if (name.endsWith(".stl")) { const g = new STLLoader().parse(buf); g.computeVertexNormals(); setModel(new THREE.Mesh(g, mat), file.name); }
    else if (name.endsWith(".obj")) { const o = new OBJLoader().parse(new TextDecoder().decode(buf)); o.traverse(m => { if (m.isMesh) m.material = mat; }); setModel(o, file.name); }
    else if (name.endsWith(".glb") || name.endsWith(".gltf")) { new GLTFLoader().parse(buf, "", g => setModel(g.scene, file.name), e => st("GLTF error: " + e)); return; }
    else { st("ไม่รองรับไฟล์นี้ (PLY/OBJ/STL/GLB/SPLAT/scale.json)"); return; }
    if (pendingScale) { unitScale = pendingScale; report(); }
  } catch (e) { st("โหลดไม่สำเร็จ: " + e.message); }
}
let pendingScale = 0;
function splatPoints(buf) { // antimatter15 .splat: 32 bytes per splat
  const n = Math.floor(buf.byteLength / 32), f = new Float32Array(buf), u = new Uint8Array(buf);
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pos.set([f[i * 8], f[i * 8 + 1], f[i * 8 + 2]], i * 3); col.set([u[i * 32 + 24] / 255, u[i * 32 + 25] / 255, u[i * 32 + 26] / 255], i * 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true }));
}

/* mesh from measured item profile */
function fromItem(id) {
  const it = PC().objItems().find(x => String(x.id) === String(id)); if (!it || !it.res?.profile) { st("รายการนี้ไม่มีโปรไฟล์รูปทรง"); return; }
  const { front, side, L } = it.res.profile, N = front.length, seg = 48;
  const pos = [], idx = [];
  for (let i = 0; i < N; i++) {
    const y = L * (i / (N - 1)) - L / 2, a = front[i] / 2, b = (side ? side[i] : front[i]) / 2;
    for (let j = 0; j < seg; j++) { const t = j / seg * Math.PI * 2; pos.push(a * Math.cos(t), y, b * Math.sin(t)); }
  }
  for (let i = 0; i < N - 1; i++) for (let j = 0; j < seg; j++) { const p = i * seg + j, q = i * seg + (j + 1) % seg; idx.push(p, p + seg, q, q, p + seg, q + seg); }
  // caps
  const c0 = pos.length / 3; pos.push(0, -L / 2, 0); const c1 = c0 + 1; pos.push(0, L / 2, 0);
  for (let j = 0; j < seg; j++) { idx.push(c0, j, (j + 1) % seg); const o = (N - 1) * seg; idx.push(c1, o + (j + 1) % seg, o + j); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  setModel(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xd8b8a0, side: THREE.DoubleSide })), "รายการ " + (it.label || it.id) + (side ? " (2 มุม)" : " (สมมาตรรอบแกน)"));
  unitScale = 1; pendingScale = 0; report();
}

/* export */
function exportAs(kind) {
  if (!root) { st("ยังไม่มีโมเดล"); return; }
  const exp = root.clone(true); exp.scale.multiplyScalar(unitScale); exp.updateMatrixWorld(true);
  const dl = (data, ext, type) => PC().download(new Blob([data], { type }), "model_mm." + ext);
  if (kind === "obj") dl(new OBJExporter().parse(exp), "obj", "text/plain");
  else if (kind === "stl") dl(new STLExporter().parse(exp, { binary: true }), "stl", "application/octet-stream");
  else if (kind === "ply") new PLYExporter().parse(exp, r => dl(r, "ply", "application/octet-stream"), { binary: true });
  else if (kind === "glb") new GLTFExporter().parse(exp, r => dl(r, "glb", "model/gltf-binary"), e => st("" + e), { binary: true });
}

/* ---------------- WebXR AR ---------------- */
let xr = null;
async function startAR() {
  if (!navigator.xr || !(await navigator.xr.isSessionSupported("immersive-ar").catch(() => false))) { st("เครื่อง/เบราว์เซอร์ไม่รองรับ WebXR AR"); return; }
  init();
  const ov = $("arOverlay");
  const session = await navigator.xr.requestSession("immersive-ar", { requiredFeatures: ["hit-test", "local"], optionalFeatures: ["dom-overlay"], domOverlay: { root: ov } }).catch(e => { st("เปิด AR ไม่ได้: " + e.message); return null; });
  if (!session) return;
  ov.hidden = false;
  const arR = new THREE.WebGLRenderer({ alpha: true, antialias: true }); arR.xr.enabled = true; arR.xr.setReferenceSpaceType("local");
  arR.setSize(innerWidth, innerHeight); arR.domElement.style.display = "none"; document.body.appendChild(arR.domElement);
  await arR.xr.setSession(session);
  const sc = new THREE.Scene(), cam = new THREE.PerspectiveCamera();
  const reticle = new THREE.Mesh(new THREE.RingGeometry(.006, .009, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x00ff88 })); reticle.matrixAutoUpdate = false; reticle.visible = false; sc.add(reticle);
  const viewer = await session.requestReferenceSpace("viewer"), hts = await session.requestHitTestSource({ space: viewer });
  xr = { session, pts: [], sc, arR, dots: [] };
  const read = () => {
    const P = xr.pts, f = v => (v * 1000).toFixed(1);
    let s = P.length ? "" : "เล็งที่ผิว แล้วแตะหน้าจอเพื่อวางจุด";
    for (let i = 0; i + 1 < P.length; i += 2) s += `ระยะ ${i / 2 + 1}: ${f(P[i].distanceTo(P[i + 1]))} มม.  `;
    if (xr.delta) s += ` | Δ = ${f(xr.delta.d)} ± ${f(xr.delta.sd)} มม.`;
    $("arRead").textContent = s;
  };
  read();
  session.addEventListener("select", () => {
    if (!reticle.visible) return;
    const p = new THREE.Vector3().setFromMatrixPosition(reticle.matrix); xr.pts.push(p);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(.003), new THREE.MeshBasicMaterial({ color: 0xffcc00 })); dot.position.copy(p); sc.add(dot); xr.dots.push(dot);
    if (xr.deltaMode && xr.pts.length >= 2) {
      // Δ along camera forward: pts[-2]=nail, pts[-1]=object
      const fw = new THREE.Vector3(0, 0, -1).applyQuaternion(xr.camQ || new THREE.Quaternion());
      const d = xr.pts[xr.pts.length - 1].clone().sub(xr.pts[xr.pts.length - 2]).dot(fw);
      xr.delta = { d, sd: 0.004 }; xr.deltaMode = false;
    }
    read();
  });
  $("arUndo").onclick = () => { xr.pts.pop(); const d = xr.dots.pop(); if (d) sc.remove(d); read(); };
  $("arDelta").onclick = () => { xr.deltaMode = true; $("arRead").textContent = "Δ: แตะที่เล็บก่อน แล้วแตะที่วัตถุ"; };
  const sel = $("arSend"); sel.innerHTML = PC().objItems().map(it => `<option value="${it.id}">${PC().esc(it.label || ("#" + it.id))}</option>`).join("") || `<option value="">(ไม่มีรายการ)</option>`;
  $("arSendBtn").onclick = () => { if (xr.delta && sel.value) { PC().setARDelta(sel.value, xr.delta.d * 1000, xr.delta.sd * 1000); $("arRead").textContent = "ส่ง Δ แล้ว"; } };
  $("arExit").onclick = () => session.end();
  session.addEventListener("end", () => { ov.hidden = true; arR.setAnimationLoop(null); arR.domElement.remove(); xr = null; });
  arR.setAnimationLoop((t, frame) => {
    if (!frame) return;
    const ref = arR.xr.getReferenceSpace(), hit = frame.getHitTestResults(hts)[0];
    if (hit) { reticle.visible = true; reticle.matrix.fromArray(hit.getPose(ref).transform.matrix); } else reticle.visible = false;
    const vp = frame.getViewerPose(ref); if (vp) { const o = vp.transform.orientation; xr.camQ = new THREE.Quaternion(o.x, o.y, o.z, o.w); }
    arR.render(sc, cam);
  });
}

/* ---------------- COLMAP set ---------------- */
const CM = []; // {name, blob, w, h, ref:{p1,p2,mm,sd}|null, thumb}
async function addBlob(blob, name, ref) {
  const bmp = await createImageBitmap(blob);
  const max = 3200, s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  const jpg = await new Promise(r => c.toBlob(r, "image/jpeg", .93));
  if (ref) ref = { ...ref, p1: [ref.p1[0] * s, ref.p1[1] * s], p2: [ref.p2[0] * s, ref.p2[1] * s] };
  const t = document.createElement("canvas"); t.width = 72; t.height = Math.round(72 * h / w); t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
  CM.push({ name: `img_${String(CM.length + 1).padStart(3, "0")}.jpg`, blob: jpg, w, h, ref, thumb: t.toDataURL("image/jpeg", .6), src: name });
  renderCM();
}
function renderCM() {
  const n = CM.length, nr = CM.filter(x => x.ref).length;
  $("cmStatus") && ($("cmStatus").textContent = `${n} ภาพ · มีมาตราวัด ${nr} ภาพ` + (n && n < 15 ? " · แนะนำ ≥ 20–40 ภาพ รอบวัตถุ ซ้อนกัน 60–80%" : "") + (n && !nr ? " · ⚠ ไม่มีมาตราวัด จะได้สเกลไม่ทราบหน่วย" : ""));
  const th = $("cmThumbs"); if (th) th.innerHTML = PC().SET.thumbs ? CM.map(x => `<img src="${x.thumb}" title="${x.name}${x.ref ? " (ref)" : ""}" style="height:48px;margin:2px;${x.ref ? "outline:2px solid #0F6E7A" : ""}">`).join("") : "";
}
function refFromIm(im) {
  // reference segment (first two ref points) in original-image pixels
  const d = PC().refDef(); if (!im || d.kind === "circle" || !im.refPts || im.refPts.length < 2) return null;
  const sz = PC().refSize(), k = im.k || 1, a = im.refPts[0], b = im.refPts[1];
  return { p1: [a.x / k, a.y / k], p2: [b.x / k, b.y / k], mm: sz.a, sd: sz.sd ?? .3 };
}
async function tryRef(blob) {
  try { const im = await PC().makeImg(blob, {}); if (await PC().autoRef(im)) return refFromIm(im); } catch (e) { }
  return null;
}
async function addImages(files) {
  for (const f of files) { st("เพิ่ม " + f.name); await addBlob(f, f.name, await tryRef(f)); }
  st("");
}
async function addVideo(file) {
  const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(file);
  await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = j; });
  const want = Math.max(5, +($("cmN")?.value || 30)), cand = want * 3, dur = v.duration;
  const c = document.createElement("canvas"), sw = 320, sh = Math.round(320 * v.videoHeight / v.videoWidth); c.width = sw; c.height = sh;
  const ctx = c.getContext("2d", { willReadFrequently: true }), frames = [];
  for (let i = 0; i < cand; i++) {
    v.currentTime = dur * (i + .5) / cand; await new Promise(r => v.onseeked = r);
    ctx.drawImage(v, 0, 0, sw, sh); const d = ctx.getImageData(0, 0, sw, sh).data;
    let s = 0, n = 0; for (let y = 1; y < sh - 1; y += 2) for (let x = 1; x < sw - 1; x += 2) { const k = (y * sw + x) * 4, g = d[k + 1], lap = 4 * g - d[k - 3] - d[k + 5] - d[k - sw * 4 + 1] - d[k + sw * 4 + 1]; s += lap * lap; n++; }
    frames.push({ t: v.currentTime, sharp: s / n }); $("cmStatus").textContent = `วิเคราะห์วิดีโอ ${i + 1}/${cand}`;
  }
  // pick sharpest frame per bucket
  const per = cand / want, pick = [];
  for (let b = 0; b < want; b++) { const g = frames.slice(Math.round(b * per), Math.round((b + 1) * per)); if (g.length) pick.push(g.reduce((a, c) => c.sharp > a.sharp ? c : a)); }
  const big = document.createElement("canvas"); big.width = v.videoWidth; big.height = v.videoHeight; const bx = big.getContext("2d");
  for (const p of pick) {
    v.currentTime = p.t; await new Promise(r => v.onseeked = r); bx.drawImage(v, 0, 0);
    const blob = await new Promise(r => big.toBlob(r, "image/jpeg", .95)); await addBlob(blob, file.name + "@" + p.t.toFixed(2), CM.some(x => x.ref) ? null : await tryRef(blob));
  }
  st(`ได้ ${pick.length} เฟรมที่คมที่สุด`);
}
async function fromMeasure() {
  const S = PC().S; let n = 0;
  for (const im of (S.imgs || [])) {
    const blob = im.fullBlob || im.file; if (!blob) continue;
    const ref = refFromIm(im);
    await addBlob(blob, im.name || "measure", ref); n++;
  }
  st(n ? `เพิ่ม ${n} ภาพจากแท็บวัด` : "แท็บวัดยังไม่มีภาพ");
}

/* zip (STORE) */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
export function zip(files) { // [{name, data:Uint8Array}]
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), d = f.data, c = crc32(d);
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(14, c, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, d);
    const ce = new DataView(new ArrayBuffer(46)); ce.setUint32(0, 0x02014b50, true); ce.setUint16(4, 20, true); ce.setUint16(6, 20, true); ce.setUint16(8, 0x0800, true);
    ce.setUint32(16, c, true); ce.setUint32(20, d.length, true); ce.setUint32(24, d.length, true); ce.setUint16(28, nm.length, true); ce.setUint32(42, off, true);
    cen.push(new Uint8Array(ce.buffer), nm); off += 30 + nm.length + d.length;
  }
  const cs = cen.reduce((s, a) => s + a.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: "application/zip" });
}
async function exportCM() {
  if (CM.length < 3) { st("ต้องมีอย่างน้อย 3 ภาพ"); return; }
  const enc = new TextEncoder(), files = [];
  for (const x of CM) files.push({ name: "images/" + x.name, data: new Uint8Array(await x.blob.arrayBuffer()) });
  const refs = CM.filter(x => x.ref).map(x => ({ image: x.name, p1: x.ref.p1, p2: x.ref.p2, length_mm: x.ref.mm, sd_mm: x.ref.sd }));
  files.push({ name: "refs.json", data: enc.encode(JSON.stringify({ app: "photo-caliper", refs }, null, 1)) });
  for (const f of ["run_colmap.bat", "scale_model.py", "README.txt"]) {
    try { const r = await fetch("colmap/" + f); files.push({ name: f, data: new Uint8Array(await r.arrayBuffer()) }); } catch (e) { st("โหลด colmap/" + f + " ไม่ได้"); }
  }
  PC().download(zip(files), "colmap_set.zip"); st("ส่งออก colmap_set.zip แล้ว");
}

/* ---------------- wiring ---------------- */
function fillItems() {
  const sel = $("m3FromItem"); if (!sel || !PC()) return;
  const items = PC().objItems().filter(it => it.res?.profile);
  sel.innerHTML = `<option value="">— สร้างเมชจากรายการวัด —</option>` + items.map(it => `<option value="${it.id}">${PC().esc(it.label || ("#" + it.id))}</option>`).join("");
  const rs = $("m3Ref"); if (rs) {
    const refs = PC().SET.myRefs || [];
    rs.innerHTML = `<option value="">— มาตราวัดที่บันทึกไว้ —</option>` + refs.map(r => `<option value="${r.size}">${PC().esc(r.name)} (${(+r.size).toFixed(2)} มม.)</option>`).join("");
  }
}
function wire() {
  const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };
  on("m3File", "change", e => { for (const f of e.target.files) loadFile(f); e.target.value = ""; });
  on("m3FromItem", "change", e => e.target.value && fromItem(e.target.value));
  on("m3Pick", "click", e => { pickMode = !pickMode; e.target.classList.toggle("on", pickMode); st(pickMode ? "แตะบนโมเดลเพื่อวางจุด (คู่ละ 1 ระยะ)" : "ปิดการวางจุด"); });
  on("m3Clear", "click", clearPicks);
  on("m3SetScale", "click", () => setScaleMm(+($("m3Ref")?.value || $("m3Known")?.value)));
  on("m3ScaleFile", "change", e => { const f = e.target.files[0]; if (f) f.text().then(t => { const j = JSON.parse(t); if (j.mm_per_unit) { unitScale = j.mm_per_unit; report(); st("ใช้สเกลจาก scale.json"); } }); });
  on("m3Axis", "change", doSlice);
  on("m3Pos", "input", () => { const v = $("m3PosV"); if (v) v.textContent = $("m3Pos").value + "%"; });
  on("m3Pos", "change", doSlice);
  on("m3Slice", "click", doSlice);
  document.querySelectorAll("[data-exp]").forEach(b => b.addEventListener("click", () => exportAs(b.dataset.exp)));
  on("m3AR", "click", startAR);
  on("cmImgs", "change", e => { addImages([...e.target.files]); e.target.value = ""; });
  on("cmVid", "change", e => { const f = e.target.files[0]; if (f) addVideo(f).catch(er => st("วิดีโอ: " + er.message)); e.target.value = ""; });
  on("cmFromMeasure", "click", fromMeasure);
  on("cmExport", "click", exportCM);
  on("cmClear", "click", () => { CM.length = 0; renderCM(); });
  on("aiArm", "click", () => {
    if (confirm("ลิงก์ AI ภายนอกจะ 'อัปโหลดภาพออกจากเครื่อง' ไปยังเซิร์ฟเวอร์ของผู้อื่น (Hugging Face) ซึ่งอาจเก็บหรือเห็นภาพได้\nผลลัพธ์จาก AI ไม่มีสเกลจริงและเดารูปด้านที่มองไม่เห็น\nยืนยันเปิดลิงก์?")) { const l = $("aiLinks"); if (l) l.hidden = false; }
  });
  if (navigator.xr) navigator.xr.isSessionSupported("immersive-ar").then(ok => { if (ok && $("m3AR")) $("m3AR").hidden = false; }).catch(() => { });
}
wire();

window.PC3D = {
  show() { init(); resize(); fillItems(); renderCM(); },
  onMeasureChange() { fillItems(); },
};
