"use strict";
/* Photo Caliper v2 — on-device photogrammetry. Images never leave the device.
   Optional libraries (loaded from CDN once, then cached): OpenCV.js, SlimSAM (Segment Anything via Transformers.js), MediaPipe Hand Landmarker. */

/* ======================= helpers ======================= */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const R2D = 180 / Math.PI;
const fmt = (v, d = 1) => (v == null || !isFinite(v)) ? "—" : v.toFixed(d);
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const hyp = (...a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
function rn() { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
function sdOf(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function solve(A, b) {
  const n = b.length; A = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((r, i) => r[n] / r[i]);
}
function homog(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) { const { x, y } = src[i], u = dst[i].x, v = dst[i].y; A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); }
  const h = solve(A, b); return h ? [...h, 1] : null;
}
function hApply(h, p) { const w = h[6] * p.x + h[7] * p.y + h[8]; return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }; }
function fitEllipse(pts) {
  if (pts.length < 5) return null;
  const mx = mean(pts.map(p => p.x)), my = mean(pts.map(p => p.y));
  const sc = Math.max(...pts.map(p => Math.hypot(p.x - mx, p.y - my))) || 1;
  const M = Array.from({ length: 5 }, () => Array(5).fill(0)), r = Array(5).fill(0);
  for (const p0 of pts) { const p = { x: (p0.x - mx) / sc, y: (p0.y - my) / sc }; const row = [p.x * p.x, p.x * p.y, p.y * p.y, p.x, p.y]; for (let i = 0; i < 5; i++) { r[i] += -row[i]; for (let j = 0; j < 5; j++) M[i][j] += row[i] * row[j]; } }
  const s = solve(M, r); if (!s) return null; const [a, B, c, d, e] = s, f = 1;
  const det = 4 * a * c - B * B; if (det <= 0) return null;
  const cx = (B * e - 2 * c * d) / det, cy = (B * d - 2 * a * e) / det;
  const F = a * cx * cx + B * cx * cy + c * cy * cy + d * cx + e * cy + f;
  let ang = 0.5 * Math.atan2(B, a - c);
  const ev = t => a * Math.cos(t) ** 2 + B * Math.cos(t) * Math.sin(t) + c * Math.sin(t) ** 2;
  const e1 = ev(ang), e2 = ev(ang + Math.PI / 2); if (-F / e1 <= 0 || -F / e2 <= 0) return null;
  let ra = Math.sqrt(-F / e1), rb = Math.sqrt(-F / e2);
  if (rb > ra) { [ra, rb] = [rb, ra]; ang += Math.PI / 2; }
  return { cx: mx + cx * sc, cy: my + cy * sc, a: ra * sc, b: rb * sc, ang };
}
const ellPt = (e, t) => ({ x: e.cx + e.a * Math.cos(t) * Math.cos(e.ang) - e.b * Math.sin(t) * Math.sin(e.ang), y: e.cy + e.a * Math.cos(t) * Math.sin(e.ang) + e.b * Math.sin(t) * Math.cos(e.ang) });
const ramanujan = (a, b) => { const h = ((a - b) / (a + b || 1)) ** 2; return Math.PI * (a + b) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h))); };

/* ======================= storage & settings ======================= */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};
const DEF_SET = { refType: "nail", nail: { w: 12.0, sd: 0.3, len: 8.17, h: 16 }, nailCal: [], rect: { a: 100, b: 100, sd: 0.5 }, circle: { d: 20, sd: 0.1 }, line: { L: 100, sd: 0.5 }, f35app: 27, libs: { cv: true, sam: true, hands: true } };
let SET = Object.assign({}, DEF_SET, store.get("pc_set", {}));
SET.nail = Object.assign({}, DEF_SET.nail, SET.nail || {}); SET.libs = Object.assign({}, DEF_SET.libs, SET.libs || {}); SET.nailCal = SET.nailCal || [];
function saveSet() { store.set("pc_set", SET); }

/* ======================= EXIF ======================= */
function parseExif(buf) {
  const o = {};
  try {
    const v = new DataView(buf); if (v.getUint16(0) !== 0xFFD8) return o; let p = 2;
    while (p < v.byteLength - 10) {
      const m = v.getUint16(p); if ((m & 0xFF00) !== 0xFF00) break; const len = v.getUint16(p + 2);
      if (m === 0xFFE1 && v.getUint32(p + 4) === 0x45786966) {
        const t = p + 10, le = v.getUint16(t) === 0x4949, g16 = x => v.getUint16(x, le), g32 = x => v.getUint32(x, le);
        const str = e => { const c = g32(e + 4), off = c > 4 ? t + g32(e + 8) : e + 8; let s = ""; for (let i = 0; i < c && i < 80; i++) { const ch = v.getUint8(off + i); if (!ch) break; s += String.fromCharCode(ch); } return s.trim(); };
        const rat = e => { const off = t + g32(e + 8), d = g32(off + 4); return d ? g32(off) / d : null; };
        const rd = (q, cb) => { const n = g16(q); for (let i = 0; i < n; i++) { const e = q + 2 + i * 12; cb(g16(e), e); } };
        let ex = 0;
        rd(t + g32(t + 4), (tag, e) => { if (tag === 0x8769) ex = t + g32(e + 8); if (tag === 0x010F) o.make = str(e); if (tag === 0x0110) o.model = str(e); if (tag === 0x0131) o.software = str(e); if (tag === 0x0112) o.orientation = g16(e + 8); });
        if (ex) rd(ex, (tag, e) => {
          if (tag === 0x920A) o.f = rat(e); if (tag === 0xA405) o.f35 = g16(e + 8); if (tag === 0x829D) o.fnum = rat(e); if (tag === 0x829A) o.exp = rat(e);
          if (tag === 0x8827) o.iso = g16(e + 8); if (tag === 0xA404) o.dzoom = rat(e); if (tag === 0x9206) o.subjDist = rat(e); if (tag === 0xA434) o.lens = str(e); if (tag === 0x9003) o.date = str(e);
        });
        return o;
      }
      p += 2 + len;
    }
  } catch (e) { }
  return o;
}

/* ======================= WebGPU feature map ======================= */
const WGSL = `
@group(0) @binding(0) var img: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outb: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> dims: vec2<u32>;
fn g(q:vec2<i32>)->f32{let c=clamp(q,vec2<i32>(0,0),vec2<i32>(i32(dims.x)-1,i32(dims.y)-1));return dot(textureLoad(img,c,0).rgb,vec3<f32>(0.299,0.587,0.114));}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3<u32>){
  if(id.x>=dims.x||id.y>=dims.y){return;}
  let p=vec2<i32>(id.xy); var sxx=0.0; var syy=0.0; var sxy=0.0;
  for(var dy=-2;dy<=2;dy++){for(var dx=-2;dx<=2;dx++){
    let q=p+vec2<i32>(dx,dy);
    let ix=(g(q+vec2<i32>(1,0))-g(q-vec2<i32>(1,0)))*0.5;
    let iy=(g(q+vec2<i32>(0,1))-g(q-vec2<i32>(0,1)))*0.5;
    sxx+=ix*ix; syy+=iy*iy; sxy+=ix*iy;}}
  let det=sxx*syy-sxy*sxy; let tr=sxx+syy;
  outb[id.y*dims.x+id.x]=vec2<f32>(det-0.05*tr*tr, tr);
}`;
const G = { dev: null, pipe: null, state: "…" };
async function initGPU() {
  try {
    if (!navigator.gpu) throw 0; const a = await navigator.gpu.requestAdapter(); if (!a) throw 0; G.dev = await a.requestDevice();
    G.pipe = G.dev.createComputePipeline({ layout: "auto", compute: { module: G.dev.createShaderModule({ code: WGSL }), entryPoint: "main" } }); G.state = "WebGPU";
  } catch (e) { G.state = "CPU"; }
}
async function featureMap(im) {
  const { W, H } = im;
  if (G.dev) {
    try {
      const d = G.dev;
      const tex = d.createTexture({ size: [W, H], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      d.queue.copyExternalImageToTexture({ source: im.canvas }, { texture: tex }, [W, H]);
      const size = W * H * 8, ob = d.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }), rb = d.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const ub = d.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); d.queue.writeBuffer(ub, 0, new Uint32Array([W, H]));
      const bg = d.createBindGroup({ layout: G.pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: { buffer: ob } }, { binding: 2, resource: { buffer: ub } }] });
      const enc = d.createCommandEncoder(), ps = enc.beginComputePass(); ps.setPipeline(G.pipe); ps.setBindGroup(0, bg); ps.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); ps.end();
      enc.copyBufferToBuffer(ob, 0, rb, 0, size); d.queue.submit([enc.finish()]); await rb.mapAsync(GPUMapMode.READ);
      im.feat = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap(); tex.destroy(); ob.destroy(); rb.destroy(); ub.destroy(); im.featEngine = "WebGPU"; return;
    } catch (e) { console.warn(e); }
  }
  const px = im.px, gr = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gr[i] = (.299 * px[i * 4] + .587 * px[i * 4 + 1] + .114 * px[i * 4 + 2]) / 255;
  const xx = new Float32Array(W * H), yy = new Float32Array(W * H), xy = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x, ix = (gr[i + 1] - gr[i - 1]) / 2, iy = (gr[i + W] - gr[i - W]) / 2; xx[i] = ix * ix; yy[i] = iy * iy; xy[i] = ix * iy; }
  const box = a => {
    const t = new Float32Array(W * H), o = new Float32Array(W * H);
    for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) { s += a[y * W + x]; if (x >= 5) s -= a[y * W + x - 5]; t[y * W + x] = s; } }
    for (let x = 0; x < W; x++) { let s = 0; for (let y = 0; y < H; y++) { s += t[y * W + x]; if (y >= 5) s -= t[(y - 5) * W + x]; o[y * W + x] = s; } }
    return o;
  };
  const A = box(xx), B = box(yy), C = box(xy); im.feat = new Float32Array(W * H * 2);
  for (let i = 0; i < W * H; i++) { const det = A[i] * B[i] - C[i] * C[i], tr = A[i] + B[i]; im.feat[i * 2] = det - .05 * tr * tr; im.feat[i * 2 + 1] = tr; }
  im.featEngine = "CPU";
}
function featStats(im) {
  const { W, H, feat } = im; let mx = 0, tm = 0;
  for (let i = 0; i < W * H; i++) { if (feat[i * 2] > mx) mx = feat[i * 2]; if (feat[i * 2 + 1] > tm) tm = feat[i * 2 + 1]; }
  const thr = mx * .01, cell = 16; let n = 0;
  for (let cy = 0; cy < H; cy += cell) for (let cx = 0; cx < W; cx += cell) { let m = 0; for (let y = cy; y < Math.min(H, cy + cell); y++) for (let x = cx; x < Math.min(W, cx + cell); x++) m = Math.max(m, feat[(y * W + x) * 2]); if (m > thr) n++; }
  im.corners = n; im.fmax = mx || 1; im.tmax = tm || 1;
}
const grad = (im, x, y) => { x = clamp(Math.round(x), 0, im.W - 1); y = clamp(Math.round(y), 0, im.H - 1); return im.feat[(y * im.W + x) * 2 + 1]; };
let SNAP = true;
function snapPoint(im, p) {
  if (!im.feat || !SNAP) return { x: p.x, y: p.y, snapped: false };
  const r = Math.max(6, Math.round(Math.max(im.W, im.H) / 180)); let best = null, bv = 0, bt = null, btv = 0;
  for (let y = Math.max(0, p.y - r | 0); y <= Math.min(im.H - 1, p.y + r | 0); y++) for (let x = Math.max(0, p.x - r | 0); x <= Math.min(im.W - 1, p.x + r | 0); x++) {
    if ((x - p.x) ** 2 + (y - p.y) ** 2 > r * r) continue; const i = (y * im.W + x) * 2, R = im.feat[i], T = im.feat[i + 1];
    if (R > bv) { bv = R; best = { x, y }; } if (T > btv) { btv = T; bt = { x, y }; }
  }
  if (best && bv > im.fmax * .02) { const q = cvSubPix(im, best) || best; return { x: q.x, y: q.y, snapped: "corner" }; }
  if (bt && btv > im.tmax * .08) return { ...bt, snapped: "edge" };
  return { x: p.x, y: p.y, snapped: false };
}
// move a point along a direction to the strongest edge, with sub-pixel parabola fit
function snapAlong(im, p, d, r) {
  if (!im.feat) return { ...p, snapped: false };
  let best = 0, bs = 0; const vals = {};
  for (let s = -r; s <= r; s++) { const g = grad(im, p.x + d.x * s, p.y + d.y * s); vals[s] = g; if (g > best) { best = g; bs = s; } }
  if (best < im.tmax * .06) return { ...p, snapped: false };
  const a = vals[bs - 1] ?? best, c = vals[bs + 1] ?? best, den = a - 2 * best + c; const off = den < 0 ? clamp(0.5 * (a - c) / den, -.5, .5) : 0;
  return { x: p.x + d.x * (bs + off), y: p.y + d.y * (bs + off), snapped: "edge" };
}

/* ======================= optional libraries ======================= */
const LIB = { cv: { state: "off" }, sam: { state: "off" }, hands: { state: "off" } };
function libText() {
  const t = s => ({ off: "ปิด", loading: "กำลังโหลด…", ok: "พร้อม", fail: "โหลดไม่ได้" }[s]);
  return `OpenCV ${t(LIB.cv.state)} · SAM ${t(LIB.sam.state)}${LIB.sam.device ? " (" + LIB.sam.device + ")" : ""} · Hands ${t(LIB.hands.state)}`;
}
function updLib() { const el = $("libStatus"); if (el) el.textContent = libText(); }
function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.async = true; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
async function loadCV() {
  if (!SET.libs.cv || LIB.cv.state === "ok" || LIB.cv.state === "loading") return; LIB.cv.state = "loading"; updLib();
  try {
    try { await loadScript("https://docs.opencv.org/4.10.0/opencv.js"); } catch (e) { await loadScript("https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js"); }
    let c = window.cv; if (c instanceof Promise) c = await c; else if (c && !c.Mat) await new Promise(r => { c.onRuntimeInitialized = r; setTimeout(r, 20000); });
    if (!c || !c.Mat) throw new Error("cv not ready"); window.cv = c; LIB.cv.state = "ok";
  } catch (e) { console.warn("OpenCV", e); LIB.cv.state = "fail"; }
  updLib();
}
function cvGray(im) {
  if (im.cvGray) return im.cvGray; const cv = window.cv; const m = cv.matFromImageData(new ImageData(new Uint8ClampedArray(im.px), im.W, im.H)); const g = new cv.Mat(); cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY); m.delete(); im.cvGray = g; return g;
}
function cvSubPix(im, p) {
  if (LIB.cv.state !== "ok") return null;
  try {
    const cv = window.cv, g = cvGray(im); const pts = cv.matFromArray(1, 1, cv.CV_32FC2, [p.x, p.y]);
    cv.cornerSubPix(g, pts, new cv.Size(5, 5), new cv.Size(-1, -1), new cv.TermCriteria(cv.TERM_CRITERIA_EPS + cv.TERM_CRITERIA_COUNT, 30, 0.01));
    const q = { x: pts.data32F[0], y: pts.data32F[1] }; pts.delete(); return dist(q, p) < 8 ? q : null;
  } catch (e) { return null; }
}
const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";
const SAM_MODEL = "Xenova/slimsam-77-uniform";
async function loadSAM() {
  if (!SET.libs.sam || LIB.sam.state === "ok" || LIB.sam.state === "loading") return; LIB.sam.state = "loading"; updLib();
  try {
    const T = await import(TF_URL); LIB.sam.T = T;
    let model = null; for (const device of (navigator.gpu ? ["webgpu", "wasm"] : ["wasm"])) { try { model = await T.SamModel.from_pretrained(SAM_MODEL, { device }); LIB.sam.device = device; break; } catch (e) { console.warn("SAM", device, e); } }
    if (!model) throw new Error("no SAM"); LIB.sam.model = model; LIB.sam.proc = await T.AutoProcessor.from_pretrained(SAM_MODEL); LIB.sam.state = "ok";
  } catch (e) { console.warn("SAM", e); LIB.sam.state = "fail"; }
  updLib();
}
async function samEmbed(im) {
  if (LIB.sam.state !== "ok") return null; if (im.sam) return im.sam; if (im.samP) return im.samP;
  im.samP = (async () => {
    const { T, model, proc } = LIB.sam; const raw = await T.RawImage.read(im.canvas.toDataURL("image/jpeg", .92));
    const inputs = await proc(raw); const emb = await model.get_image_embeddings(inputs); im.sam = { inputs, emb }; return im.sam;
  })();
  try { return await im.samP; } catch (e) { console.warn(e); im.samP = null; return null; }
}
async function samMask(im, pos, neg = [], pick = "best") {
  const e = await samEmbed(im); if (!e) return null;
  try {
    const { T, model, proc } = LIB.sam; const rs = e.inputs.reshaped_input_sizes[0];
    const pts = [...pos.map(p => [p.x / im.W * rs[1], p.y / im.H * rs[0]]), ...neg.map(p => [p.x / im.W * rs[1], p.y / im.H * rs[0]])];
    const lab = [...pos.map(() => 1n), ...neg.map(() => 0n)];
    const out = await model({ ...e.emb, input_points: new T.Tensor("float32", pts.flat(), [1, 1, pts.length, 2]), input_labels: new T.Tensor("int64", lab, [1, 1, lab.length]) });
    const ms = await proc.post_process_masks(out.pred_masks, e.inputs.original_sizes, e.inputs.reshaped_input_sizes);
    let m = ms[0]; if (m.dims.length === 4) m = m[0]; const [k, H, W] = m.dims; const sc = out.iou_scores.data; const data = m.data;
    const cand = []; for (let j = 0; j < k; j++) { let a = 0; for (let i = 0; i < H * W; i++) if (data[j * H * W + i]) a++; cand.push({ j, iou: sc[j], area: a }); }
    let ch = cand.reduce((a, b) => b.iou > a.iou ? b : a);
    if (pick === "small") { const ok = cand.filter(c => c.iou > .75 && c.area > 30); if (ok.length) ch = ok.reduce((a, b) => b.area < a.area ? b : a); }
    if (W !== im.W || H !== im.H) return null;
    const mask = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) mask[i] = data[ch.j * H * W + i] ? 1 : 0;
    return { mask, iou: ch.iou };
  } catch (e) { console.warn("SAM mask", e); return null; }
}
const MP_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
async function loadHands() {
  if (!SET.libs.hands || LIB.hands.state === "ok" || LIB.hands.state === "loading") return; LIB.hands.state = "loading"; updLib();
  try {
    const mod = await import(MP_URL + "/vision_bundle.mjs"); const fs = await mod.FilesetResolver.forVisionTasks(MP_URL + "/wasm");
    const o = d => ({ baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate: d }, runningMode: "IMAGE", numHands: 2 });
    try { LIB.hands.lm = await mod.HandLandmarker.createFromOptions(fs, o("GPU")); } catch (e) { LIB.hands.lm = await mod.HandLandmarker.createFromOptions(fs, o("CPU")); }
    LIB.hands.state = "ok";
  } catch (e) { console.warn("Hands", e); LIB.hands.state = "fail"; }
  updLib();
}

/* ======================= mask utilities ======================= */
function cleanMask(im, mask, seeds) {
  const { W, H } = im, N = W * H, q = new Int32Array(N);
  // fill holes
  const out = new Uint8Array(N); let qh = 0, qt = 0;
  const push = i => { if (!mask[i] && !out[i]) { out[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); } for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (qh < qt) { const i = q[qh++], x = i % W, y = (i / W) | 0; if (x > 0) push(i - 1); if (x < W - 1) push(i + 1); if (y > 0) push(i - W); if (y < H - 1) push(i + W); }
  const m = new Uint8Array(N); for (let i = 0; i < N; i++) m[i] = out[i] ? 0 : 1;
  // keep component(s) touching seeds (or the largest)
  const keep = new Uint8Array(N); qh = 0; qt = 0;
  for (const sd of seeds) { const i = clamp(Math.round(sd.y), 0, H - 1) * W + clamp(Math.round(sd.x), 0, W - 1); if (m[i] && !keep[i]) { keep[i] = 1; q[qt++] = i; } }
  if (!qt) return { mask: m, area: m.reduce((a, b) => a + b, 0), touches: false };
  while (qh < qt) { const i = q[qh++], x = i % W, y = (i / W) | 0; for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) if (j >= 0 && m[j] && !keep[j]) { keep[j] = 1; q[qt++] = j; } }
  let area = 0, touches = false; for (let i = 0; i < N; i++) if (keep[i]) { area++; const x = i % W, y = (i / W) | 0; if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touches = true; }
  return { mask: keep, area, touches };
}
function ycc(px, i) { const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; return [.299 * r + .587 * g + .114 * b, 128 - .168736 * r - .331264 * g + .5 * b, 128 + .5 * r - .418688 * g - .081312 * b]; }
function segmentClassic(im, seeds, tol) {
  const { W, H, px, feat } = im; const N = W * H; const mask = new Uint8Array(N); const edgeThr = im.tmax * 0.18; const qbuf = new Int32Array(N);
  for (const sd of seeds) {
    const sx = clamp(Math.round(sd.x), 0, W - 1), sy = clamp(Math.round(sd.y), 0, H - 1); let mY = 0, mB = 0, mR = 0, n = 0;
    for (let y = Math.max(0, sy - 4); y <= Math.min(H - 1, sy + 4); y++) for (let x = Math.max(0, sx - 4); x <= Math.min(W - 1, sx + 4); x++) { const c = ycc(px, y * W + x); mY += c[0]; mB += c[1]; mR += c[2]; n++; }
    mY /= n; mB /= n; mR /= n; let qh = 0, qt = 0; const s0 = sy * W + sx; if (!mask[s0]) { mask[s0] = 1; qbuf[qt++] = s0; }
    while (qh < qt) {
      const i = qbuf[qh++], x = i % W, y = (i / W) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0 || mask[j]) continue; const c = ycc(px, j); const d = Math.sqrt(.35 * (c[0] - mY) ** 2 + (c[1] - mB) ** 2 + (c[2] - mR) ** 2);
        if (d > tol) continue; if (feat[j * 2 + 1] > edgeThr && d > tol * .5) continue; mask[j] = 1; qbuf[qt++] = j;
      }
    }
  }
  const morph = (m, dil) => { const o = new Uint8Array(N); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = dil ? 0 : 1; outer: for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; const mv = (xx < 0 || yy < 0 || xx >= W || yy >= H) ? 0 : m[yy * W + xx]; if (dil && mv) { v = 1; break outer; } if (!dil && !mv) { v = 0; break outer; } } o[y * W + x] = v; } return o; };
  return cleanMask(im, morph(morph(mask, true), false), seeds);
}
async function segment(im, pos, neg, tol, pick) {
  if (LIB.sam.state === "ok") { const r = await samMask(im, pos, neg, pick); if (r) { const c = cleanMask(im, r.mask, pos); c.engine = "SAM"; c.iou = r.iou; return c; } }
  const c = segmentClassic(im, pos, tol); c.engine = "สีและขอบ"; return c;
}
function boundary(im, mask) { const { W, H } = im, pts = []; for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (mask[i] && (!mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W])) pts.push({ x, y }); } return pts; }
function traceContour(im, mask) {
  // Moore-neighbour tracing of outer contour
  const { W, H } = im; let start = -1; for (let i = 0; i < W * H; i++) if (mask[i]) { start = i; break; } if (start < 0) return [];
  const dx = [1, 1, 0, -1, -1, -1, 0, 1], dy = [0, 1, 1, 1, 0, -1, -1, -1]; const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x];
  let x = start % W, y = (start / W) | 0, dir = 7; const sx = x, sy = y; const pts = []; let guard = 0;
  do { pts.push({ x, y }); let found = false; for (let k = 0; k < 8; k++) { const d = (dir + 6 + k) % 8; const nx = x + dx[d], ny = y + dy[d]; if (at(nx, ny)) { x = nx; y = ny; dir = d; found = true; break; } } if (!found) break; } while ((x !== sx || y !== sy) && ++guard < W * H);
  return pts;
}
function hull(pts) {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y); if (p.length < 3) return p; const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = []; for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function quadFromMask(im, mask) {
  let h = hull(boundary(im, mask)); if (h.length < 4) return null;
  const tri = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  while (h.length > 4) { let mi = 0, mv = 1e18; for (let i = 0; i < h.length; i++) { const v = tri(h[(i - 1 + h.length) % h.length], h[i], h[(i + 1) % h.length]); if (v < mv) { mv = v; mi = i; } } h.splice(mi, 1); }
  // order: clockwise starting so that first edge is a long side
  const c = { x: mean(h.map(p => p.x)), y: mean(h.map(p => p.y)) }; h.sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  if (dist(h[0], h[1]) < dist(h[1], h[2])) h = [h[1], h[2], h[3], h[0]];
  return h.map(p => { const q = cvSubPix(im, p) || p; return { x: q.x, y: q.y, snapped: "corner" }; });
}
function ellipseFromMask(im, mask) {
  const b = boundary(im, mask).filter(p => p.x > 2 && p.y > 2 && p.x < im.W - 3 && p.y < im.H - 3); if (b.length < 20) return null;
  const step = Math.max(1, Math.floor(b.length / 1500)); let e = fitEllipse(b.filter((_, i) => i % step === 0)); if (!e) return null;
  // one robust pass: drop points far from ellipse (e.g. shadow, knurl spikes)
  const res = p => { const dx = p.x - e.cx, dy = p.y - e.cy, c = Math.cos(e.ang), s = Math.sin(e.ang); const u = (dx * c + dy * s) / e.a, v = (-dx * s + dy * c) / e.b; return Math.abs(Math.hypot(u, v) - 1); };
  const keep = b.filter((p, i) => i % step === 0 && res(p) < .04); if (keep.length > 20) e = fitEllipse(keep) || e;
  e.rms = Math.sqrt(mean(b.filter((_, i) => i % step === 0).map(p => res(p) ** 2))); return e;
}

/* ======================= nail auto-detection ======================= */
function sat(px, i) { const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx ? (mx - mn) / mx : 0; }
function nailFromMask(im, mask, tipHint) {
  const pr = profileOf(im, mask, 80); if (!pr) return null; const { W, px } = im; const B = pr.bins;
  // orientation: which end is the tip
  let tipAtEnd = true;
  const endPt = t => ({ x: pr.cx + pr.u.x * (pr.tmin + pr.L * t), y: pr.cy + pr.u.y * (pr.tmin + pr.L * t) });
  if (tipHint) tipAtEnd = dist(endPt(1), tipHint) < dist(endPt(0), tipHint);
  // saturation per slice
  const NB = pr.NB, sS = new Float32Array(NB), sN = new Uint32Array(NB);
  for (let i = 0; i < mask.length; i++) if (mask[i]) { const dx = i % W - pr.cx, dy = ((i / W) | 0) - pr.cy, t = dx * pr.u.x + dy * pr.u.y; const b = clamp(Math.floor((t - pr.tmin) / pr.L * NB), 0, NB - 1); sS[b] += sat(px, i); sN[b]++; }
  const sv = Array.from(sS, (v, i) => sN[i] ? v / sN[i] : NaN);
  if (!tipHint) { const a = mean(sv.slice(0, 8).filter(isFinite)), b = mean(sv.slice(NB - 8).filter(isFinite)); tipAtEnd = b < a; }
  const ord = i => tipAtEnd ? i : NB - 1 - i; // index from cuticle(0) to tip(NB-1)
  const bed = []; for (let i = Math.floor(NB * .25); i < Math.floor(NB * .6); i++) if (isFinite(sv[ord(i)])) bed.push(sv[ord(i)]);
  const bedSat = mean(bed);
  let edgeIdx = NB - 1; for (let i = Math.floor(NB * .5); i < NB; i++) { const v = sv[ord(i)]; if (isFinite(v) && v < bedSat * .7) { edgeIdx = i; break; } }
  // widest slice in nail bed (between 20% and pink-edge)
  let bw = 0, bb = null; for (const b of B) { const k = Math.floor(b.t * NB); const i = tipAtEnd ? k : NB - 1 - k; if (i < NB * .2 || i > edgeIdx) continue; if (b.w > bw) { bw = b.w; bb = b; } }
  if (!bb) return null;
  const tc = pr.tmin + pr.L * bb.t; const c = { x: pr.cx + pr.u.x * tc + pr.v.x * bb.c, y: pr.cy + pr.u.y * tc + pr.v.y * bb.c };
  const w1 = { x: c.x - pr.v.x * bw / 2, y: c.y - pr.v.y * bw / 2 }, w2 = { x: c.x + pr.v.x * bw / 2, y: c.y + pr.v.y * bw / 2 };
  const tCut = tipAtEnd ? 0 : 1, tEdge = tipAtEnd ? (edgeIdx + .5) / NB : 1 - (edgeIdx + .5) / NB;
  const p3 = endPt(tCut), p4 = endPt(tEdge);
  const sn = p => { const d = { x: pr.v.x, y: pr.v.y }; return snapAlong(im, p, d, 4); };
  return { pts: [sn(w1), sn(w2), { ...p3, snapped: "auto" }, { ...p4, snapped: "auto" }], freeEdge: edgeIdx < NB - 3 };
}
async function autoNail(im, tap) {
  let tip = null, pos = tap ? [tap] : null, neg = [];
  if (!pos && LIB.hands.state === "ok") {
    try {
      const r = LIB.hands.lm.detect(im.canvas); const hs = r.landmarks || [];
      if (hs.length) { const L = hs[0].map(p => ({ x: p.x * im.W, y: p.y * im.H })); tip = L[4]; pos = [lerp(L[3], L[4], .62)]; neg = [L[3], L[2]]; im.handFound = true; }
    } catch (e) { console.warn(e); }
  }
  if (!pos) return false;
  const seg = await segment(im, pos, neg, 22, "small"); if (!seg || seg.area < 50) return false;
  const n = nailFromMask(im, seg.mask, tip); if (!n) return false;
  im.refPts = n.pts; im.refAuto = { engine: seg.engine + (tip ? " + Hands" : ""), mask: seg.mask, iou: seg.iou }; im.refOverlay = null; return true;
}

/* ======================= reference definitions ======================= */
const REF = {
  nail: { need: 2, max: 4, kind: "line", name: () => `เล็บนิ้วโป้ง ${fmt(SET.nail.w, 2)} ± ${fmt(SET.nail.sd, 2)} มม.`, auto: "แตะที่เล็บ 1 ครั้ง ระบบหาความกว้าง โคนเล็บ และขอบเนื้อปลายให้" },
  card: { need: 4, kind: "rect", a: 85.60, b: 53.98, sd: 0.05, name: () => "บัตร ID-1 85.60 × 53.98 มม.", auto: "แตะกลางบัตร 1 ครั้ง ระบบหามุมทั้ง 4" },
  a4: { need: 4, kind: "rect", a: 297, b: 210, sd: 0.5, name: () => "กระดาษ A4 297 × 210 มม.", auto: "แตะกลางกระดาษ 1 ครั้ง ระบบหามุมทั้ง 4" },
  rect: { need: 4, kind: "rect", name: () => `สี่เหลี่ยม ${fmt(SET.rect.a, 1)} × ${fmt(SET.rect.b, 1)} มม.`, auto: "แตะกลางสี่เหลี่ยม 1 ครั้ง ขอบแรกคือด้าน 'กว้าง' (ด้านยาว)" },
  circle: { need: 5, kind: "circle", name: () => `วงกลม ⌀ ${fmt(SET.circle.d, 2)} มม.`, auto: "แตะกลางวงกลม 1 ครั้ง ระบบ fit วงรีกับขอบทั้งเส้น" },
  line: { need: 2, kind: "line", name: () => `ระยะ ${fmt(SET.line.L, 1)} มม.`, auto: "แตะปลายทั้งสองของระยะที่รู้ (ดูดเข้าขีดอัตโนมัติ)" }
};
function refSize() {
  const t = SET.refType;
  if (t === "nail") return { a: SET.nail.w, sd: SET.nail.sd };
  if (t === "card" || t === "a4") return { a: REF[t].a, b: REF[t].b, sd: REF[t].sd };
  if (t === "rect") return { a: SET.rect.a, b: SET.rect.b, sd: SET.rect.sd };
  if (t === "circle") return { a: SET.circle.d, sd: SET.circle.sd };
  return { a: SET.line.L, sd: SET.line.sd };
}
async function autoRef(im, tap) {
  const t = SET.refType, k = REF[t].kind;
  if (t === "nail") return autoNail(im, tap);
  if (!tap || t === "line") return false;
  const seg = await segment(im, [tap], [], 26, "best"); if (!seg || seg.area < 100) return false;
  if (k === "rect") { const q = quadFromMask(im, seg.mask); if (!q) return false; im.refPts = q; }
  else { const e = ellipseFromMask(im, seg.mask); if (!e) return false; im.refPts = [0, 1, 2, 3, 4].map(i => ({ ...ellPt(e, i * 2 * Math.PI / 5), snapped: "auto" })); im.refEll = e; }
  im.refAuto = { engine: seg.engine, mask: seg.mask, iou: seg.iou }; im.refOverlay = null; return true;
}

/* ======================= tools ======================= */
const TOOLS = {
  obj: { n: "วัตถุ 3 มิติ", need: 1, hint: "แตะที่วัตถุ 1 ครั้ง ระบบแยกขอบ หาแกน และจัดรูปทรงให้ แตะเพิ่มเพื่อรวมส่วนที่ขาด เปิด 'จุดลบ' แล้วแตะเพื่อตัดส่วนเกิน" },
  dist: { n: "ระยะขอบถึงขอบ", need: 2, hint: "แตะใกล้ขอบทั้งสองฝั่ง ระบบเลื่อนจุดเข้าขอบจริงตามแนวเส้นให้" },
  curve: { n: "ความยาวตามขอบโค้ง", need: "var", min: 2, hint: "แตะจุดเริ่มบนขอบ แล้วแตะจุดถัดไป เส้นจะวิ่งตามขอบเอง กด 'จบเส้น' เมื่อเสร็จ" },
  area: { n: "พื้นที่ (แตะครั้งเดียว)", need: 1, hint: "แตะภายในพื้นที่ที่ต้องการวัด" },
  angle: { n: "มุม", need: 3, hint: "แตะ ปลายแขน 1 → จุดยอดมุม → ปลายแขน 2 (ดูดเข้ามุม)" },
  box: { n: "กล่อง", need: 4, hint: "แตะ มุมที่ใกล้กล้องที่สุด แล้วปลายขอบ 3 เส้นที่ออกจากมุมนั้น (ดูดเข้ามุมแบบ sub-pixel)" }
};

/* ======================= state ======================= */
const S = { imgs: [], cur: -1, items: [], task: null, view: { z: 1, ox: 0, oy: 0 }, drag: null, seq: 1, imgSeq: 1, negMode: false };
const curImg = () => S.imgs[S.cur];
const imgById = id => S.imgs.find(i => i.id === id);

/* ======================= images ======================= */
async function addImage(src, meta) {
  let exif = {}, bmp, name;
  if (src instanceof Blob) { name = src.name || "ภาพ"; exif = parseExif(await src.arrayBuffer()); try { bmp = await createImageBitmap(src); } catch (e) { bmp = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(src); }); } }
  else { bmp = src; name = meta.name; }
  const W0 = bmp.width, H0 = bmp.height, k = Math.min(1, 1800 / Math.max(W0, H0)), W = Math.round(W0 * k), H = Math.round(H0 * k);
  const c = document.createElement("canvas"); c.width = W; c.height = H; const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, W, H);
  const im = { id: S.imgSeq++, name, canvas: c, ctx, W, H, W0, H0, k, exif, gyro: meta && meta.gyro || null, inApp: !!(meta && meta.inApp), refPts: [], gyroPlane: false };
  im.px = ctx.getImageData(0, 0, W, H).data; await featureMap(im); featStats(im);
  S.imgs.push(im); S.cur = S.imgs.length - 1; S.view = { z: 1, ox: 0, oy: 0 };
  setTask({ type: "ref", img: im }); renderAll();
  if (LIB.sam.state === "ok") { setBusy("กำลังเตรียม SAM สำหรับภาพนี้…"); await samEmbed(im); setBusy(null); }
  if (SET.refType === "nail" && LIB.hands.state === "ok") { setBusy("กำลังหาเล็บอัตโนมัติ…"); const ok = await autoNail(im, null); setBusy(null); if (ok) setTask(null); }
  renderAll(); return im;
}
function setBusy(t) { S.busy = t; if (t) $("task").innerHTML = `<b>${t}</b>`; else setTask(S.task); }

/* ======================= lens & camera geometry ======================= */
function lensInfo(im) {
  const e = im.exif || {}; let f35 = e.f35 || null, src = "EXIF (เทียบ 35 มม.)", rel = 0.02;
  if (!f35 && im.inApp) { f35 = SET.f35app; src = "ค่าตั้งค่ากล้องในแอป"; rel = 0.05; }
  const cls = f => f == null ? "ไม่ทราบ" : f < 20 ? "กว้างพิเศษ (ultra-wide)" : f < 35 ? "กล้องหลัก มุมกว้าง" : f < 60 ? "ซูม ~2× หรือครอป" : "เทเล";
  const dk = f => f == null ? 0.004 : f < 20 ? 0.012 : f < 35 ? 0.003 : 0.0015;
  return { f35, src: f35 ? src : null, rel, cls: cls(f35), distK: dk(f35), fpx: f35 ? f35 * Math.hypot(im.W, im.H) / 43.27 : null, fov: f35 ? 2 * Math.atan(43.27 / (2 * f35)) * R2D : null, dz: e.dzoom || 1 };
}
function gyroPlaneFn(im, f, jb = 0, jg = 0) {
  const b = (im.gyro.beta + jb) / R2D, g = (im.gyro.gamma + jg) / R2D, cx = im.W / 2, cy = im.H / 2;
  const cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  return p => {
    const v = [(p.x - cx) / f, -(p.y - cy) / f, -1]; const y1 = [cg * v[0] + sg * v[2], v[1], -sg * v[0] + cg * v[2]]; const e = [y1[0], cb * y1[1] - sb * y1[2], sb * y1[1] + cb * y1[2]];
    if (e[2] >= -1e-6) return { x: NaN, y: NaN }; return { x: -e[0] / e[2], y: -e[1] / e[2] };
  };
}
function gyroTilt(im) { const b = im.gyro.beta / R2D, g = im.gyro.gamma / R2D; return Math.acos(clamp(Math.cos(b) * Math.cos(g), -1, 1)) * R2D; }
function buildMapper(im, P, size, opt = {}) {
  const kind = REF[SET.refType].kind;
  const jac = (toPlane, p) => { const o = toPlane(p), u = toPlane({ x: p.x + 1, y: p.y }), v = toPlane({ x: p.x, y: p.y + 1 }); const j = [u.x - o.x, v.x - o.x, u.y - o.y, v.y - o.y]; const A = j[0] * j[0] + j[2] * j[2], B = j[0] * j[1] + j[2] * j[3], C = j[1] * j[1] + j[3] * j[3]; return Math.sqrt(Math.max((A + C) / 2 - Math.sqrt(((A - C) / 2) ** 2 + B * B), 1e-12)); };
  if (kind === "rect") { const H = homog(P, [{ x: 0, y: 0 }, { x: size.a, y: 0 }, { x: size.a, y: size.b }, { x: 0, y: size.b }]); if (!H) return null; const toPlane = p => hApply(H, p); return { toPlane, sIso: p => jac(toPlane, p), H }; }
  if (kind === "circle") { const e = fitEllipse(P); if (!e) return null; const sa = size.a / (2 * e.a), sb = size.a / (2 * e.b), c = Math.cos(e.ang), s = Math.sin(e.ang); return { toPlane: p => { const dx = p.x - e.cx, dy = p.y - e.cy; return { x: (dx * c + dy * s) * sa, y: (-dx * s + dy * c) * sb }; }, sIso: () => sa, ell: e }; }
  if (im.gyro && im.gyroPlane && opt.f) { const pl = gyroPlaneFn(im, opt.f, opt.jb || 0, opt.jg || 0); const a = pl(P[0]), b = pl(P[1]); const dd = Math.hypot(a.x - b.x, a.y - b.y); if (!isFinite(dd) || dd <= 0) return null; const sc = size.a / dd; const toPlane = p => { const q = pl(p); return { x: q.x * sc, y: q.y * sc }; }; return { toPlane, sIso: p => jac(toPlane, p), gyro: true }; }
  const L = dist(P[0], P[1]); if (L < 1) return null; const sc = size.a / L; return { toPlane: p => ({ x: p.x * sc, y: p.y * sc }), sIso: () => sc };
}
function cameraModel(im, P, M) {
  const lens = lensInfo(im), kind = REF[SET.refType].kind; const cx = im.W / 2, cy = im.H / 2, sz = refSize();
  let f = lens.fpx, fsrc = lens.src, frel = lens.rel, pose = null;
  if (kind === "rect") {
    const h = homog([{ x: 0, y: 0 }, { x: sz.a, y: 0 }, { x: sz.a, y: sz.b }, { x: 0, y: sz.b }], P.map(p => ({ x: p.x - cx, y: p.y - cy })));
    if (h) {
      if (!f) { const f2 = -(h[0] * h[1] + h[3] * h[4]) / (h[6] * h[7]); if (f2 > 0 && isFinite(f2)) { const fe = Math.sqrt(f2), dg = Math.hypot(im.W, im.H); if (fe > dg * .3 && fe < dg * 6) { f = fe; fsrc = "ประมาณจากรูปทรงสี่เหลี่ยม"; frel = 0.08; } } }
      if (f) {
        const m1 = [h[0] / f, h[3] / f, h[6]], m2 = [h[1] / f, h[4] / f, h[7]], m3 = [h[2] / f, h[5] / f, h[8]]; const l = 1 / Math.hypot(...m1), r1 = m1.map(v => v * l), r2 = m2.map(v => v * l), t = m3.map(v => v * l);
        const n = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]]; const nn = Math.hypot(...n); n.forEach((v, i) => n[i] = v / nn);
        pose = { tilt: Math.acos(Math.min(1, Math.abs(n[2]))) * R2D, pitch: Math.atan2(n[1], Math.abs(n[2])) * R2D, yaw: Math.atan2(n[0], Math.abs(n[2])) * R2D, skew: Math.abs(r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2]) / Math.hypot(...r2) };
      }
    }
  }
  if (kind === "circle" && M.ell) pose = { tilt: Math.acos(clamp(M.ell.b / M.ell.a, 0, 1)) * R2D, tiltOnly: true };
  if (!f) { f = 26 * Math.hypot(im.W, im.H) / 43.27; fsrc = "สมมติเลนส์ 26 มม. (ไม่มี EXIF)"; frel = 0.2; }
  if (im.gyro) { const tl = gyroTilt(im); pose = Object.assign(pose || {}, { gyroTilt: tl }); }
  return { f, fsrc, frel, pose, lens };
}

/* ======================= depth correction ======================= */
// Δ (mm): object is this much FARTHER from the camera than the reference (negative = closer). k = (Z+Δ)/Z
function depthOf(it) {
  if (it.dMode === "heights") { const d = (it.refH ?? SET.nail.h) - (it.objH ?? 0); return { d, sd: Math.SQRT2 * (it.hSd ?? 2) }; }
  return { d: it.delta || 0, sd: it.deltaSd ?? 1 };
}
const kDepth = (Z, d) => (Z + d) / Z;

/* ======================= object profile & shape ======================= */
function profileOf(im, mask, NB = 120) {
  const { W, H } = im; let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < W * H; i++) if (mask[i]) { n++; sx += i % W; sy += (i / W) | 0; }
  if (n < 30) return null; const cx = sx / n, cy = sy / n; let xx = 0, yy = 0, xy = 0;
  for (let i = 0; i < W * H; i++) if (mask[i]) { const dx = i % W - cx, dy = ((i / W) | 0) - cy; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy), u = { x: Math.cos(ang), y: Math.sin(ang) }, v = { x: -u.y, y: u.x };
  let tmin = 1e9, tmax = -1e9; for (let i = 0; i < W * H; i++) if (mask[i]) { const t = (i % W - cx) * u.x + (((i / W) | 0) - cy) * u.y; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
  const L = tmax - tmin + 1, lo = new Float32Array(NB).fill(1e9), hi = new Float32Array(NB).fill(-1e9), cnt = new Uint32Array(NB);
  for (let i = 0; i < W * H; i++) if (mask[i]) { const dx = i % W - cx, dy = ((i / W) | 0) - cy, t = dx * u.x + dy * u.y, w = dx * v.x + dy * v.y; const b = clamp(Math.floor((t - tmin) / L * NB), 0, NB - 1); cnt[b]++; if (w < lo[b]) lo[b] = w; if (w > hi[b]) hi[b] = w; }
  const bins = []; for (let b = 0; b < NB; b++) if (cnt[b]) bins.push({ t: (b + .5) / NB, w: hi[b] - lo[b] + 1, c: (hi[b] + lo[b]) / 2 });
  return { cx, cy, u, v, L, tmin, bins, area: n, NB };
}
function fitShapes(pr) {
  const B = pr.bins, inner = B.filter(b => b.t > .06 && b.t < .94); if (inner.length < 8) return null;
  const ws = inner.map(b => b.w), mw = mean(ws), maxW = Math.max(...B.map(b => b.w)); const rel = arr => Math.sqrt(mean(arr.map(r => r * r)));
  const eCyl = rel(ws.map(w => (w - mw) / mw)); const mt = mean(inner.map(b => b.t)); let sxy = 0, sxx = 0; inner.forEach(b => { sxy += (b.t - mt) * (b.w - mw); sxx += (b.t - mt) ** 2; });
  const slope = sxy / sxx, icpt = mw - slope * mt; const eFr = rel(inner.map(b => (b.w - (icpt + slope * b.t)) / mw));
  const eEll = rel(B.map(b => (b.w - maxW * Math.sqrt(Math.max(0, 1 - (2 * b.t - 1) ** 2))) / maxW));
  const cands = [{ k: "cyl", n: "ทรงกระบอก", e: eCyl }, { k: "frustum", n: "กรวยตัด", e: Math.abs(slope) / mw > .08 ? eFr : eFr + .03 }, { k: "ellipsoid", n: "ทรงรี/จาน", e: eEll }, { k: "rev", n: "หั่นชั้น", e: .055 }]
    .map(c => ({ ...c, fit: clamp(100 * (1 - c.e / .15), 0, 100) })).sort((a, b) => a.e - b.e);
  const cs = B.map(b => b.c); const asym = (Math.max(...cs) - Math.min(...cs)) / pr.L; const cstd = Math.sqrt(mean(cs.map(c => (c - mean(cs)) ** 2))) / mw;
  const round = Math.abs(pr.L / maxW - 1) < .08 && eEll < .05;
  return { cands, best: cands[0].k, slope, icpt, mw, maxW, curved: asym > .1, asym: cstd, round };
}
function slices(pr, s, NB = 100, edgeBias = 0, noise = 0, lenJit = 0) {
  const B = pr.bins; const out = []; const L = (pr.L + lenJit) * s;
  for (let i = 0; i < NB; i++) { const t = (i + .5) / NB; let k = 0; while (k < B.length - 1 && B[k + 1].t < t) k++; let w; if (t <= B[0].t) w = B[0].w; else if (t >= B[B.length - 1].t) w = B[B.length - 1].w; else { const a = B[k], b = B[k + 1]; w = a.w + (b.w - a.w) * (t - a.t) / (b.t - a.t); } out.push(Math.max(0, (w + 2 * edgeBias + noise * rn()) * s)); }
  let arc = 0; for (let k = 1; k < B.length; k++) arc += Math.hypot((B[k].t - B[k - 1].t) * pr.L, B[k].c - B[k - 1].c); arc *= s;
  return { w: out, L, arc, dz: L / NB };
}
const SHAPE_N = { cyl: "ทรงกระบอก", frustum: "กรวยตัด", ellipsoid: "ทรงรี/จาน", rev: "หั่นชั้น", box: "แท่งเหลี่ยม" };
function measureObj(it, s1, s2, jit) {
  const j = jit || { e1: 0, e2: 0, n: 0, l1: 0, l2: 0 }; const A = slices(it.pr, s1, 100, j.e1, j.n, j.l1);
  const out = []; const L = (lb, v) => out.push({ lb, v, u: "มม." }), Ar = (lb, v) => out.push({ lb, v, u: "มม.²" }), V = (lb, v) => out.push({ lb, v: v / 1000, u: "มล." }), N = (lb, v, u = "") => out.push({ lb, v, u });
  const shape = it.shape || it.fit.best; const w = A.w, dz = A.dz, n = w.length; const wi = w.slice(6, n - 6), dMean = mean(wi), dMax = Math.max(...w);
  if (it.fit.round && !it.side) {
    // near-circular silhouette seen face-on (cap, coin, disc): report diameter from the ellipse fit of the outline
    const e = it.ell; if (e) { L("เส้นผ่านศูนย์กลาง (fit วงรีกับขอบ)", (e.a + j.e1) * 2 * s1); L("เส้นผ่านศูนย์กลางแกนสั้น", (e.b + j.e1) * 2 * s1); }
  }
  let Bw = null, Lside = null; if (it.side && it.side.pr && s2) { const Bs = slices(it.side.pr, s2, 100, j.e2, j.n, j.l2); Bw = Bs.w; Lside = Bs.L; }
  const Lm = Lside ? (A.L + Lside) / 2 : A.L;
  L("ความยาวตามแกน", Lm); if (it.fit.curved) L("ความยาวตามแนวโค้งกลาง", A.arc);
  L("ความกว้างมากสุด (ด้านหน้า)", dMax); L("ความกว้างเฉลี่ย (ด้านหน้า)", dMean);
  for (const q of [.25, .5, .75]) L(`ความกว้างที่ ${q * 100}% ของแกน`, w[Math.floor(q * n)]);
  if (Bw) {
    const bi = Bw.slice(6, n - 6); L("ความกว้างเฉลี่ย (ด้านข้าง)", mean(bi)); const g = w.map((a, i) => ramanujan(a / 2, Bw[i] / 2));
    L("รอบวงที่ 50% ของแกน", g[Math.floor(n / 2)]); L("รอบวงมากสุด", Math.max(...g.slice(3, n - 3)));
    let vol = 0, srf = 0; for (let i = 0; i < n; i++) { vol += Math.PI * (w[i] / 2) * (Bw[i] / 2) * (Lm / n); srf += g[i] * (Lm / n); }
    V("ปริมาตร (หน้าตัดวงรีจาก 2 มุม)", vol); Ar("พื้นที่ผิวด้านข้าง", srf); N("หน้าตัด ด้านหน้า ÷ ด้านข้าง", mean(wi) / mean(bi)); out.mode = "2view";
  } else {
    L("รอบวงที่ 50% (สมมติหน้าตัดกลม)", Math.PI * w[Math.floor(n / 2)]);
    let vRev = 0, sRev = 0; for (let i = 0; i < n; i++) { vRev += Math.PI * (w[i] / 2) ** 2 * dz; const dr = i ? (w[i] - w[i - 1]) / 2 : 0; sRev += Math.PI * w[i] * Math.hypot(dz, dr); }
    let vol, srf;
    if (shape === "cyl") { vol = Math.PI * dMean * dMean / 4 * Lm; srf = Math.PI * dMean * Lm + Math.PI * dMean * dMean / 2; }
    else if (shape === "frustum") { const r1 = it.fit.icpt * s1 / 2, r2 = (it.fit.icpt + it.fit.slope) * s1 / 2; vol = Math.PI * Lm * (r1 * r1 + r1 * r2 + r2 * r2) / 3; srf = Math.PI * (r1 + r2) * Math.hypot(Lm, r1 - r2) + Math.PI * (r1 * r1 + r2 * r2); }
    else if (shape === "ellipsoid") { const a = Lm / 2, b = dMax / 2, p = 1.6075; vol = 4 / 3 * Math.PI * a * b * b; srf = 4 * Math.PI * (((a * b) ** p * 2 + (b * b) ** p) / 3) ** (1 / p); }
    else if (shape === "box") { vol = Lm * dMean * dMean; srf = 2 * (Lm * dMean * 2 + dMean * dMean); }
    else { vol = vRev; srf = sRev; }
    if (!(it.fit.round && shape === "ellipsoid")) { V("ปริมาตร (" + SHAPE_N[shape] + ")", vol); Ar("พื้นที่ผิว (" + SHAPE_N[shape] + ")", srf); if (shape !== "rev") V("ปริมาตรแบบหั่นชั้น (เทียบ)", vRev); }
    out.mode = "1view";
  }
  if (Lside) N("ความยาวด้านหน้า ÷ ด้านข้าง", A.L / Lside);
  return out;
}

/* ======================= live-wire (edge following) ======================= */
function liveWire(im, a, b) {
  const pad = 40, x0 = Math.max(0, Math.floor(Math.min(a.x, b.x)) - pad), y0 = Math.max(0, Math.floor(Math.min(a.y, b.y)) - pad), x1 = Math.min(im.W - 1, Math.ceil(Math.max(a.x, b.x)) + pad), y1 = Math.min(im.H - 1, Math.ceil(Math.max(a.y, b.y)) + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, N = w * h; if (N > 1.2e6) return [a, b];
  const cost = new Float32Array(N); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const g = im.feat[((y + y0) * im.W + x + x0) * 2 + 1] / im.tmax; cost[y * w + x] = 1 - Math.sqrt(clamp(g, 0, 1)) + .02; }
  const D = new Float32Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const s = Math.round(a.y - y0) * w + Math.round(a.x - x0), tgt = Math.round(b.y - y0) * w + Math.round(b.x - x0);
  const heap = [[0, s]]; D[s] = 0; const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (; ;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  while (heap.length) {
    const [d, i] = pop(); if (done[i]) continue; done[i] = 1; if (i === tgt) break; const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const j = ny * w + nx; if (done[j]) continue; const nd = d + cost[j] * (dx && dy ? Math.SQRT2 : 1); if (nd < D[j]) { D[j] = nd; prev[j] = i; push(nd, j); } }
  }
  if (prev[tgt] < 0) return [a, b]; const path = []; for (let i = tgt; i >= 0; i = prev[i]) path.push({ x: i % w + x0, y: ((i / w) | 0) + y0 }); path.reverse();
  // smooth (moving average) to reduce pixel staircase length bias
  const sm = path.map((p, i) => { const q = path.slice(Math.max(0, i - 2), i + 3); return { x: mean(q.map(t => t.x)), y: mean(q.map(t => t.y)) }; });
  sm[0] = a; sm[sm.length - 1] = b; return sm;
}

/* ======================= measurement core ======================= */
function measureManual(it, M, k) {
  const P = it.pts, T = it.tool, tp = M.toPlane, out = [];
  const L = (lb, v) => out.push({ lb, v: v * k, u: "มม." }), A = (lb, v) => out.push({ lb, v: v * k * k, u: "มม.²" }), V = (lb, v) => out.push({ lb, v: v * k * k * k / 1000, u: "มล." }), D = (lb, v) => out.push({ lb, v, u: "°" });
  if (T === "dist") L("ระยะ", dist(tp(P[0]), tp(P[1])));
  else if (T === "curve") { const path = it.path || P; let s = 0; for (let i = 1; i < path.length; i++) s += dist(tp(path[i - 1]), tp(path[i])); L("ความยาวตามขอบ", s); L("ระยะตรงจากต้นถึงปลาย", dist(tp(P[0]), tp(P[P.length - 1]))); }
  else if (T === "area") { const q = it.contour.map(tp); let a = 0, p = 0; for (let i = 0; i < q.length; i++) { const j = (i + 1) % q.length; a += q[i].x * q[j].y - q[j].x * q[i].y; p += dist(q[i], q[j]); } A("พื้นที่", Math.abs(a) / 2); L("เส้นรอบรูป", p * .987); }
  else if (T === "angle") { const a = tp(P[0]), o = tp(P[1]), b = tp(P[2]); const u = sub(a, o), v = sub(b, o); D("มุม", Math.acos(clamp((u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)), -1, 1)) * R2D); }
  else if (T === "box") {
    const s = M.sIso(P[0]), v = [sub(P[1], P[0]), sub(P[2], P[0]), sub(P[3], P[0])], d = (i, j) => v[i].x * v[j].x + v[i].y * v[j].y;
    const ab = d(0, 1), ac = d(0, 2), bc = d(1, 2); let z = null; if (ab < 0 && ac < 0 && bc < 0) { const za = Math.sqrt(-ab * ac / bc); z = [za, -ab / za, -ac / za]; }
    const l = v.map((w, i) => Math.hypot(w.x, w.y, z ? z[i] : 0) * s); L("ด้านยาว", l[0]); L("ด้านกว้าง", l[1]); L("ด้านสูง", l[2]); V("ปริมาตร", l[0] * l[1] * l[2]); A("พื้นที่ผิว", 2 * (l[0] * l[1] + l[1] * l[2] + l[0] * l[2])); out.depthOK = !!z;
  }
  return out;
}
function imgModel(im) {
  if (!im) return null; const def = REF[SET.refType];
  if (im.refPts.length < def.need) return { err: `ยังไม่มีมาตราวัดในภาพนี้ · ${def.auto}` };
  const sz = refSize(); const P = im.refPts.slice(0, def.kind === "line" ? 2 : def.need);
  const lens0 = lensInfo(im); const fGuess = lens0.fpx || 26 * Math.hypot(im.W, im.H) / 43.27;
  const M = buildMapper(im, P, sz, { f: fGuess }); if (!M) return { err: "คำนวณจากมาตราวัดไม่ได้ ลองวางใหม่" };
  const cam = cameraModel(im, P, M);
  const c0 = def.kind === "rect" ? mid(mid(P[0], P[1]), mid(P[2], P[3])) : def.kind === "circle" ? { x: M.ell.cx, y: M.ell.cy } : mid(P[0], P[1]);
  const s0 = M.sIso(c0), Z = cam.f * s0; const refPx = def.kind === "circle" ? 2 * M.ell.a : dist(P[0], P[1]);
  const relRef = hyp(sz.sd / sz.a, (im.refPts[0].snapped ? 0.8 : 1.5) * Math.SQRT2 / refPx);
  let check = null; if (SET.refType === "nail" && im.refPts.length >= 4) { const meas = dist(im.refPts[2], im.refPts[3]) / dist(im.refPts[0], im.refPts[1]), exp = SET.nail.len / SET.nail.w; check = { meas, exp, ratio: meas / exp }; }
  return { M, cam, P, sz, c0, s0, Z, refPx, relRef, check, def };
}
function evaluateAll() {
  for (const im of S.imgs) im.model = imgModel(im);
  for (const it of S.items) {
    it.res = null; const im = imgById(it.imgId), md = im && im.model; if (!md || md.err) continue;
    if (it.tool === "obj") { evalObj(it, im, md); continue; }
    const T = TOOLS[it.tool]; if (it.tool === "area") { if (!it.contour) continue; } else if ((T.need === "var" && (!it.closed || it.pts.length < T.min)) || (T.need !== "var" && it.pts.length < T.need)) continue;
    const dp = depthOf(it), Z = md.Z, k0 = kDepth(Z, dp.d);
    const base = measureManual(it, md.M, k0); if (!base.length) continue;
    const lens = md.cam.lens, dg = Math.hypot(im.W, im.H);
    const sig = p => { const r = Math.hypot(p.x - im.W / 2, p.y - im.H / 2) / (dg / 2); return hyp(p.snapped ? .6 : 1.6, lens.distK * r * r * dg * .5); };
    const jp = pts => pts.map(p => { const s = sig(p); return { x: p.x + rn() * s, y: p.y + rn() * s, snapped: p.snapped }; });
    const jitItem = () => { const c = { ...it, pts: it.pts ? jp(it.pts) : null }; if (it.path) { const e = rn() * .8; c.path = it.path.map(p => ({ x: p.x + e, y: p.y + e })); } if (it.contour) { const e = rn() * 1; const cx = mean(it.contour.map(p => p.x)), cy = mean(it.contour.map(p => p.y)); c.contour = it.contour.map(p => { const d = Math.hypot(p.x - cx, p.y - cy) || 1; return { x: p.x + (p.x - cx) / d * e, y: p.y + (p.y - cy) / d * e }; }); } return c; };
    const acc = base.map(() => []); const rel = md.sz.sd / md.sz.a;
    for (let n = 0; n < 250; n++) {
      const sz = { a: md.sz.a * (1 + rel * rn()), b: md.sz.b ? md.sz.b * (1 + rel * rn()) : undefined }; const f2 = md.cam.f * (1 + md.cam.frel * rn());
      const M2 = buildMapper(im, jp(md.P), sz, { f: f2, jb: rn(), jg: rn() }); if (!M2) continue; const Z2 = f2 * M2.sIso(md.c0);
      const v = measureManual(jitItem(), M2, kDepth(Z2, dp.d + dp.sd * rn())); v.forEach((o, i) => { if (isFinite(o.v)) acc[i].push(o.v); });
    }
    base.forEach((o, i) => { o.sd = sdOf(acc[i]); });
    const src = []; const one = (name, fn) => { const vals = []; for (let n = 0; n < 60; n++) { const r = fn(); if (r && r[0] && isFinite(r[0].v)) vals.push(r[0].v); } const s = sdOf(vals); if (s != null) src.push({ name, rel: s / Math.abs(base[0].v || 1) }); };
    one("ตำแหน่งจุด/ขอบของวัตถุ", () => measureManual(jitItem(), md.M, k0));
    one("ตำแหน่งจุดมาตราวัด", () => { const M2 = buildMapper(im, jp(md.P), md.sz, { f: md.cam.f }); return M2 && measureManual(it, M2, k0); });
    one("ขนาดจริงของมาตราวัด", () => { const M2 = buildMapper(im, md.P, { a: md.sz.a * (1 + rel * rn()), b: md.sz.b }, { f: md.cam.f }); return M2 && measureManual(it, M2, k0); });
    if (dp.sd > 0) one("ความลึกต่างจากมาตราวัด (Δ)", () => measureManual(it, md.M, kDepth(Z, dp.d + dp.sd * rn())));
    src.sort((a, b) => b.rel - a.rel); it.res = { vals: base, src, depthOK: base.depthOK !== false, k: k0, Z };
  }
}
function evalObj(it, im, md) {
  if (!it.seg || !it.pr || !it.fit) return; let md2 = null, S2 = null; const dp = depthOf(it);
  if (it.side && it.side.pr) { const im2 = imgById(it.side.imgId); md2 = im2 && im2.model; if (!md2 || md2.err) md2 = null; }
  const c1 = { x: it.pr.cx, y: it.pr.cy }; const S1 = md.M.sIso(c1) * kDepth(md.Z, dp.d);
  if (md2) S2 = md2.M.sIso({ x: it.side.pr.cx, y: it.side.pr.cy }) * kDepth(md2.Z, dp.d);
  const base = measureObj(it, S1, S2); const acc = base.map(() => []); const r1 = md.relRef, r2 = md2 ? md2.relRef : 0; const eb = it.seg.engine === "SAM" ? 1.0 : 1.5;
  for (let n = 0; n < 200; n++) {
    const dd = dp.d + dp.sd * rn(); const s1 = md.M.sIso(c1) * (1 + r1 * rn()) * kDepth(md.Z, dd); const s2 = md2 ? md2.M.sIso({ x: it.side.pr.cx, y: it.side.pr.cy }) * (1 + r2 * rn()) * kDepth(md2.Z, dd) : null;
    const v = measureObj(it, s1, s2, { e1: rn() * eb, e2: rn() * eb, n: .8, l1: rn() * eb * 1.4, l2: rn() * eb * 1.4 }); v.forEach((o, i) => { if (isFinite(o.v)) acc[i].push(o.v); });
  }
  base.forEach((o, i) => { o.sd = sdOf(acc[i]); });
  const b0 = base[0].v, src = [];
  const vr = []; for (let n = 0; n < 50; n++) vr.push(measureObj(it, S1 * (1 + r1 * rn()), S2)[0].v);
  const ve = []; for (let n = 0; n < 50; n++) ve.push(measureObj(it, S1, S2, { e1: rn() * eb, e2: rn() * eb, n: .8, l1: rn() * eb * 1.4, l2: rn() * eb * 1.4 })[0].v);
  src.push({ name: "มาตราวัด", rel: sdOf(vr) / b0 }, { name: "ขอบวัตถุ (" + it.seg.engine + ")", rel: sdOf(ve) / b0 });
  if (dp.sd > 0) { const vd = []; for (let n = 0; n < 50; n++) vd.push(measureObj(it, md.M.sIso(c1) * kDepth(md.Z, dp.d + dp.sd * rn()), S2)[0].v); src.push({ name: "ความลึกต่างจากมาตราวัด (Δ)", rel: sdOf(vd) / b0 }); }
  src.sort((a, b) => b.rel - a.rel); it.res = { vals: base, src, k: kDepth(md.Z, dp.d), Z: md.Z };
}

/* ======================= tasks ======================= */
function setTask(t) {
  S.task = t; const el = $("task"); if (S.busy) return;
  $("done").hidden = !(t && t.type === "item" && TOOLS[t.item.tool].need === "var");
  const objLike = t && t.type === "item" && (t.item.tool === "obj" || t.item.tool === "area");
  $("segCtl").hidden = !objLike; $("neg").hidden = !objLike;
  if (!t) { el.innerHTML = curImg() ? "เลือกเครื่องมือวัด หรือลากจุดเพื่อปรับ" : "ถ่ายภาพหรือเลือกภาพที่มีมาตราวัดอยู่ใกล้วัตถุ"; return; }
  if (t.type === "ref") { const d = REF[SET.refType], n = t.img.refPts.length; el.innerHTML = `<b>มาตราวัด</b> · ${d.auto}${n ? ` (วางแล้ว ${n} จุด ลากปรับได้)` : ""}`; return; }
  if (t.type === "item") { const it = t.item, T = TOOLS[it.tool]; el.innerHTML = it.tool === "obj" && t.side ? `<b>#${it.id} ภาพด้านข้าง</b> · แตะที่วัตถุเดียวกันในภาพนี้` : `<b>#${it.id} ${T.n}</b> · ${T.hint}`; }
}
async function runSeg(it, side) {
  const tgt = side ? it.side : it; const im = imgById(tgt.imgId); if (!im || !tgt.seeds.length) return;
  setBusy(LIB.sam.state === "ok" ? "SAM กำลังแยกวัตถุ…" : "กำลังแยกวัตถุ…"); await new Promise(r => setTimeout(r, 20));
  tgt.seg = await segment(im, tgt.seeds, tgt.neg || [], tgt.tol, "best"); tgt.overlay = null; setBusy(null);
  if (it.tool === "area") { const c = traceContour(im, tgt.seg.mask); it.contour = c.filter((_, i) => i % 2 === 0); renderAll(); return; }
  tgt.pr = profileOf(im, tgt.seg.mask);
  if (!side) { it.fit = tgt.pr ? fitShapes(tgt.pr) : null; it.ell = it.fit && it.fit.round ? ellipseFromMask(im, tgt.seg.mask) : null; }
  setTask(S.task); renderAll();
}

/* ======================= nail calibration ======================= */
function calibrate(it, trueVal) {
  const v = it.res.vals[0].v; if (!(trueVal > 0) || !(v > 0)) return null;
  const w = SET.nail.w * trueVal / v; const relErr = (it.res.vals[0].sd || 0) / v;
  SET.nailCal.push({ w, rel: relErr, obj: it.label || TOOLS[it.tool].n, trueVal, meas: v, date: new Date().toISOString() }); saveSet(); return w;
}
function calSummary() {
  const c = SET.nailCal; if (!c.length) return null; const ws = c.map(x => x.w); const m = mean(ws), sd = sdOf(ws);
  return { n: c.length, mean: m, sd, se: sd != null ? sd / Math.sqrt(c.length) : null };
}

/* ======================= rendering ======================= */
function renderChips() {
  const b = $("imgChips"); b.innerHTML = "";
  S.imgs.forEach((im, i) => { const c = document.createElement("button"); c.className = "chip"; c.setAttribute("aria-pressed", i === S.cur); c.textContent = `${i + 1}. ${im.inApp ? "กล้อง" : (im.name.length > 12 ? im.name.slice(0, 10) + "…" : im.name)}${im.refPts.length >= REF[SET.refType].need ? "" : " ⚠"}`; c.onclick = () => { S.cur = i; S.view = { z: 1, ox: 0, oy: 0 }; setTask(im.refPts.length < REF[SET.refType].need ? { type: "ref", img: im } : null); renderAll(); }; b.appendChild(c); });
  if (S.imgs.length) { const d = document.createElement("button"); d.className = "chip"; d.textContent = "ลบภาพนี้"; d.onclick = () => { const im = curImg(); S.items = S.items.filter(x => x.imgId !== im.id); S.items.forEach(x => { if (x.side && x.side.imgId === im.id) x.side = null; }); if (im.cvGray) im.cvGray.delete(); S.imgs.splice(S.cur, 1); S.cur = S.imgs.length - 1; setTask(null); renderAll(); }; b.appendChild(d); }
}
function renderRefPanel() {
  const t = SET.refType; $("refType").value = t; $("refName").textContent = REF[t].name(); const show = (id, v) => $(id).hidden = !v;
  show("lA", t === "rect" || t === "circle" || t === "line"); show("lB", t === "rect"); show("lS", t !== "card" && t !== "a4" && t !== "nail");
  $("lA").firstChild.textContent = t === "circle" ? "เส้นผ่านศูนย์กลาง (มม.)" : t === "line" ? "ความยาว (มม.)" : "กว้าง (มม.)";
  if (t === "rect") { $("refA").value = SET.rect.a; $("refB").value = SET.rect.b; $("refS").value = SET.rect.sd; } if (t === "circle") { $("refA").value = SET.circle.d; $("refS").value = SET.circle.sd; } if (t === "line") { $("refA").value = SET.line.L; $("refS").value = SET.line.sd; }
  $("refHint").textContent = REF[t].auto + (t === "nail" ? ` · ค่าเล็บ: กว้าง ${SET.nail.w} ± ${SET.nail.sd} มม. ยาว ${SET.nail.len} มม. สูงจากพื้น ${SET.nail.h} มม. (แก้ในตั้งค่า)` : "");
  const im = curImg(); const g = $("gyroPlane"); g.hidden = !(im && im.gyro && REF[t].kind === "line"); if (im) g.setAttribute("aria-pressed", !!im.gyroPlane);
}
function depthUI(it) {
  const hm = it.dMode === "heights";
  return `<details${it.dOpen ? " open" : ""} data-dopen="${it.id}"><summary>ความลึกต่างจากมาตราวัด ${(() => { const d = depthOf(it); return d.d ? `(Δ = ${fmt(d.d, 1)} มม.)` : "(Δ = 0)"; })()}</summary>
    <div class="row" style="margin:6px 0"><button class="chip" data-dmode="${it.id}:delta" aria-pressed="${!hm}">กรอก Δ ตรงๆ</button><button class="chip" data-dmode="${it.id}:heights" aria-pressed="${hm}">กรอกความสูงจากพื้น (ถ่ายก้มลง)</button></div>
    ${hm ? `<div class="fgrid"><label class="f">มาตราวัดสูงจากพื้น (มม.)<input type="number" step="0.5" value="${it.refH ?? SET.nail.h}" data-f="${it.id}:refH"></label><label class="f">ขอบวัตถุที่วัดสูงจากพื้น (มม.)<input type="number" step="0.5" value="${it.objH ?? 0}" data-f="${it.id}:objH"></label><label class="f">± แต่ละค่า (มม.)<input type="number" step="0.5" min="0" value="${it.hSd ?? 2}" data-f="${it.id}:hSd"></label></div>`
      : `<div class="fgrid"><label class="f">Δ วัตถุไกลกว่ามาตราวัด (มม., ใกล้กว่าใส่ลบ)<input type="number" step="0.5" value="${it.delta || 0}" data-f="${it.id}:delta"></label><label class="f">± Δ (มม.)<input type="number" step="0.5" min="0" value="${it.deltaSd ?? 1}" data-f="${it.id}:deltaSd"></label></div>`}
    ${it.res ? `<p class="muted" style="margin:6px 0 0">ระยะกล้อง Z ≈ ${fmt(it.res.Z, 0)} มม. → ตัวคูณแก้ความลึก k = (Z+Δ)/Z = ${fmt(it.res.k, 4)} (${it.res.k >= 1 ? "+" : ""}${fmt((it.res.k - 1) * 100, 2)}%)</p>` : ""}</details>`;
}
function itemCard(it) {
  const T = TOOLS[it.tool]; const im = imgById(it.imgId); const md = im && im.model;
  let h = `<div class="item"><div class="item-h"><b>#${it.id} ${T.n}</b><div class="row"><button class="chip" data-save="${it.id}">บันทึก</button><button class="chip" data-del="${it.id}">ลบ</button></div></div>`;
  h += `<label class="f">ชื่อการวัด (ใช้จัดกลุ่มในประวัติ)<input type="text" value="${esc(it.label || "")}" data-label="${it.id}" placeholder="เช่น ฝาโค้ก"></label>`;
  if (it.tool === "obj" && it.fit) {
    const f = it.fit, cur = it.shape || f.best;
    h += `<div class="row">${f.cands.map(c => `<button class="chip" data-shape="${it.id}:${c.k}" aria-pressed="${c.k === cur}">${c.n} ${fmt(c.fit, 0)}%</button>`).join("")}<button class="chip" data-shape="${it.id}:box" aria-pressed="${cur === "box"}">แท่งเหลี่ยม</button></div>`;
    const warn = []; if (it.seg.touches) warn.push("พื้นที่แยกได้แตะขอบภาพ วัตถุอาจล้นเฟรมหรือรั่วไปพื้นหลัง");
    if (f.curved) warn.push("วัตถุโค้ง: ใช้ 'ความยาวตามแนวโค้งกลาง'"); if (f.asym > .08) warn.push("ซ้าย–ขวาไม่สมมาตร ควรเพิ่มภาพด้านข้าง"); if (f.cands[0].fit < 50 && !it.side) warn.push("รูปทรงไม่เข้ากับทรงสำเร็จรูป ใช้แบบหั่นชั้น และควรเพิ่มภาพด้านข้าง");
    if (f.round) warn.push("ขอบเกือบเป็นวงกลม: ใช้ค่า 'เส้นผ่านศูนย์กลาง (fit วงรีกับขอบ)' แม่นที่สุด");
    if (warn.length) h += `<p class="muted" style="margin:0;color:var(--amber)">${warn.join("<br>")}</p>`;
    h += `<div class="row">${it.side ? `<span class="tag ok">มีภาพด้านข้างแล้ว</span><button class="chip" data-side="${it.id}">เปลี่ยนภาพด้านข้าง</button>` : `<button class="btn" data-side="${it.id}">+ เพิ่มภาพด้านข้าง 90°</button>`}<span class="tag acc">${it.seg.engine}${it.seg.iou ? " IoU " + fmt(it.seg.iou, 2) : ""}</span></div>`;
  }
  if (!md || md.err) h += `<p class="muted" style="margin:0;color:var(--bad)">${md ? md.err : ""}</p>`;
  else if (!it.res) h += `<p class="muted" style="margin:0">${T.hint}</p>`;
  else {
    h += `<div class="tbl-wrap"><table><thead><tr><th>ค่า</th><th class="n">ผล</th><th class="n">± 1σ</th><th class="n">±%</th></tr></thead><tbody>${it.res.vals.map(o => `<tr><td>${o.lb}</td><td class="n">${fmt(o.v, o.u === "" ? 3 : o.v >= 100 ? 1 : 2)} ${o.u}</td><td class="n">${o.sd != null ? fmt(o.sd, o.sd >= 10 ? 1 : 2) : "—"}</td><td class="n">${o.sd != null && o.v ? fmt(o.sd / Math.abs(o.v) * 100, 1) : "—"}</td></tr>`).join("")}</tbody></table></div>`;
    if (it.res.src.length) h += `<p class="muted" style="margin:0">ความคลาดของค่าแรกมาจาก: ${it.res.src.map(s => `${s.name} ${fmt(s.rel * 100, 1)}%`).join(" · ")}</p>`;
    h += `<p class="muted" style="margin:0"><b>ส่วนที่ภาพไม่มี:</b> ${hiddenText(it)}</p>`;
    if (SET.refType === "nail" && it.tool !== "angle") h += `<div class="row"><label class="f" style="flex:1;min-width:140px">รู้ขนาดจริงของค่าแรก? (มม.)<input type="number" step="0.01" data-cal="${it.id}" placeholder="เช่น 30.00"></label><button class="chip" data-calgo="${it.id}">ใช้ปรับเทียบเล็บ</button></div>`;
  }
  h += depthUI(it);
  return h + `</div>`;
}
function hiddenText(it) {
  if (it.tool === "obj") return it.side && it.res && it.res.vals.mode === "2view" ? "ใช้ 2 มุม: หน้าตัดเป็นวงรีจากความกว้างด้านหน้าและด้านข้าง ส่วนเว้าที่ทั้งสองมุมไม่เห็นจะไม่ถูกนับ" : "ใช้มุมเดียว: ความลึกของวัตถุไม่มีในภาพ สมมติหน้าตัดกลม ด้านหลังสมมาตรกับด้านหน้า ถ้าแกนวัตถุเอียงเข้าหากล้อง ความยาวจะสั้นกว่าจริง ขอบเงาของวัตถุอาจอยู่คนละระดับกับผิวบน";
  return { dist: "เส้นตรงบนระนาบมาตราวัด ความนูนของผิวหายไป", curve: "ตามขอบที่เห็นในภาพ ส่วนโค้งเข้าหรือออกจากกล้องหายไป", area: "พื้นที่ภาพฉายบนระนาบ ถ้าผิวโค้ง พื้นที่จริงจะมากกว่า", angle: "มุมบนระนาบมาตราวัด", box: "3 หน้าด้านหลังถูกบัง สมมติทุกมุมเป็นมุมฉาก" }[it.tool];
}
function renderAll() {
  evaluateAll(); renderChips(); renderRefPanel(); const im = curImg();
  const list = S.items.filter(it => im && (it.imgId === im.id || (it.side && it.side.imgId === im.id)));
  let h = `<h2>ผลการวัด <small>± คือ 1σ จาก Monte Carlo</small></h2>` + (list.length ? list.map(itemCard).join("") : `<p class="muted" style="margin:0">${im ? "เลือกเครื่องมือวัดด้านบน" : "ยังไม่มีภาพ"}</p>`);
  $("outItems").innerHTML = h;
  const md = im && im.model; h = `<h2>มาตราวัดและมุมกล้อง</h2>`;
  if (!im) h += `<p class="muted" style="margin:0">—</p>`;
  else if (!md || md.err) h += `<p class="muted" style="margin:0">${md ? md.err : ""}</p>`;
  else {
    const c = md.cam, p = c.pose || {};
    h += `<div class="statrow"><div class="stat"><div class="v">${fmt(1 / md.s0, 2)}</div><div class="t">px ต่อ มม.</div></div><div class="stat"><div class="v">${fmt(md.Z / 10, 1)}</div><div class="t">ซม. ระยะกล้อง (Z)</div></div><div class="stat"><div class="v">${p.tilt != null ? fmt(p.tilt, 1) + "°" : p.gyroTilt != null ? fmt(p.gyroTilt, 1) + "°" : "—"}</div><div class="t">${p.tilt != null ? "ระนาบเอียง" : p.gyroTilt != null ? "เอียงจากแนวดิ่ง (ไจโร)" : "มุมเอียง"}</div></div></div>`;
    h += `<dl class="kv" style="margin-top:10px"><dt>มาตราวัด</dt><dd>${REF[SET.refType].name()}</dd>${im.refAuto ? `<dt>วางจุดอัตโนมัติด้วย</dt><dd>${im.refAuto.engine}</dd>` : ""}<dt>ความคลาดของมาตราส่วน</dt><dd>± ${fmt(md.relRef * 100, 1)}%</dd><dt>มาตราวัดกว้างในภาพ</dt><dd>${fmt(md.refPx, 0)} px${md.refPx < 150 ? " (ควร ≥ 150)" : ""}</dd><dt>ระยะโฟกัส</dt><dd>${fmt(c.f, 0)} px · ${c.fsrc}</dd>
      ${p.pitch != null ? `<dt>ก้ม/เงย · หันซ้าย/ขวา</dt><dd>${fmt(p.pitch, 1)}° · ${fmt(p.yaw, 1)}°</dd>` : ""}${im.gyro ? `<dt>ไจโรตอนถ่าย (β, γ)</dt><dd>${fmt(im.gyro.beta, 1)}°, ${fmt(im.gyro.gamma, 1)}°</dd>` : ""}
      ${md.check ? `<dt>เล็บ ยาว÷กว้าง ในภาพ / ค่าที่ตั้งไว้</dt><dd>${fmt(md.check.meas, 2)} / ${fmt(md.check.exp, 2)}</dd>` : ""}</dl>`;
    if (md.check && Math.abs(md.check.ratio - 1) > .12) h += `<p class="muted" style="margin:6px 0 0;color:var(--amber)">สัดส่วนเล็บในภาพต่างจากค่าที่ตั้งไว้ ${fmt((md.check.ratio - 1) * 100, 0)}% เล็บอาจเอียง หรือค่าความยาว/กว้างเล็บในตั้งค่าคลาด ใช้ 'ปรับเทียบเล็บ' กับวัตถุที่รู้ขนาดเพื่อแก้</p>`;
  }
  $("outRef").innerHTML = h;
  h = `<h2>กล้องและเลนส์</h2>`;
  if (im) {
    const e = im.exif, l = lensInfo(im);
    const rows = [["อุปกรณ์", [e.make, e.model].filter(Boolean).join(" ") || (im.inApp ? "กล้องในแอป" : null)], ["เลนส์ (EXIF)", e.lens], ["ระยะโฟกัสจริง", e.f ? fmt(e.f, 2) + " มม." : null], ["เทียบ 35 มม.", l.f35 ? l.f35 + " มม." + (e.f35 ? "" : " (ค่าตั้งค่า)") : null], ["ประเภทเลนส์", l.cls], ["มุมรับภาพทแยง", l.fov ? fmt(l.fov, 0) + "°" : null], ["ซูมดิจิทัล", e.dzoom ? fmt(e.dzoom, 2) + "×" : null], ["รูรับแสง", e.fnum ? "f/" + fmt(e.fnum, 2) : null], ["ชัตเตอร์", e.exp ? (e.exp < 1 ? "1/" + Math.round(1 / e.exp) : fmt(e.exp, 1)) + " วิ" : null], ["ISO", e.iso], ["ระยะวัตถุที่กล้องบันทึก", e.subjDist ? fmt(e.subjDist, 2) + " ม." : null], ["ขนาดภาพต้นฉบับ", im.W0 + " × " + im.H0 + " px"], ["ซอฟต์แวร์แก้ไขภาพ", e.software], ["วันที่ถ่าย", e.date]];
    h += `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v == null || v === "" ? '<span style="color:var(--muted)">ไม่มี</span>' : v}</dd>`).join("")}</dl>`;
    h += `<p class="muted" style="margin:8px 0 0">EXIF ${Object.keys(e).length ? Object.keys(e).length + " ฟิลด์" : "<b style='color:var(--amber)'>ไม่มี</b>"} · จุดเด่นที่ track ได้ ${im.corners} จุด · ประมวลผลขอบด้วย ${im.featEngine}${im.handFound ? " · พบมือด้วย MediaPipe" : ""}</p>`;
  } else h += `<p class="muted" style="margin:0">—</p>`;
  $("outLens").innerHTML = h;
  h = `<h2>ข้อมูลที่หายไปและสิ่งที่ต้องสมมติ</h2>`;
  if (im && md && !md.err) {
    const l = md.cam.lens, L = [];
    L.push(["ความลึก (แกน Z)", "ภาพเดียวไม่มีระยะของแต่ละจุด ใช้ช่อง 'ความลึกต่างจากมาตราวัด' ในแต่ละการวัด หรือวางมาตราวัดบนวัตถุ (Δ = 0)"]);
    L.push(["ผลของความลึกที่ระยะนี้", `Z ≈ ${fmt(md.Z / 10, 1)} ซม.: วัตถุไกลกว่ามาตราวัด 1 มม. ต้องแก้ +${fmt(1 / md.Z * 100, 2)}% ถ้า Δ คลาด ±2 มม. ผลจะคลาด ±${fmt(2 / md.Z * 100, 2)}%`]);
    if (REF[SET.refType].kind === "line" && !im.gyroPlane) L.push(["มุมเอียงของระนาบ", "มาตราวัดแบบเส้นบอกได้แค่มาตราส่วน ถ้าวัตถุเอียงจากหน้ากล้อง ความยาวจะหดตาม cos มุม"]);
    L.push(["ระยะโฟกัส", md.cam.fsrc]); L.push(["การบิดของเลนส์", `${l.cls}: ขอบภาพเลื่อนได้ราว ${fmt(l.distK * 50, 2)}% ของเส้นทแยง`]);
    if (l.dz > 1) L.push(["ซูมดิจิทัล", `${fmt(l.dz, 2)}× รายละเอียดจริงเหลือ ~${fmt(100 / l.dz, 0)}%`]);
    L.push(["การประมวลผลในมือถือ", "การแก้ภาพบิด ลดนอยส์ และเพิ่มความคม อาจเลื่อนขอบ 1–3 px"]);
    h += `<ul class="loss">${L.map(([a, b]) => `<li><b>${a}</b><br><span>${b}</span></li>`).join("")}</ul>`;
  } else h += `<p class="muted" style="margin:0">—</p>`;
  $("outLoss").innerHTML = h;
  bindItemUI(); draw();
}
function bindItemUI() {
  const find = id => S.items.find(i => i.id == id);
  const q = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
  q("[data-del]", b => b.onclick = () => { S.items = S.items.filter(i => i.id != b.dataset.del); setTask(null); renderAll(); });
  q("[data-label]", i => i.onchange = () => { find(i.dataset.label).label = i.value.trim(); });
  q("[data-dopen]", d => d.ontoggle = () => { find(d.dataset.dopen).dOpen = d.open; });
  q("[data-dmode]", b => b.onclick = () => { const [id, m] = b.dataset.dmode.split(":"); const it = find(id); it.dMode = m; it.dOpen = true; renderAll(); });
  q("[data-f]", i => i.onchange = () => { const [id, k] = i.dataset.f.split(":"); const it = find(id); it[k] = parseFloat(i.value) || 0; it.dOpen = true; renderAll(); });
  q("[data-shape]", b => b.onclick = () => { const [id, k] = b.dataset.shape.split(":"); find(id).shape = k; renderAll(); });
  q("[data-side]", b => b.onclick = () => { S.pendingSide = find(b.dataset.side); $("task").innerHTML = "<b>ภาพด้านข้าง</b> · ถ่ายหรือเลือกภาพวัตถุเดิมที่หมุนไป 90° โดยมีมาตราวัดในภาพด้วย"; window.scrollTo({ top: 0, behavior: "smooth" }); });
  q("[data-save]", b => b.onclick = () => { const ok = saveHistory(find(b.dataset.save)); b.textContent = ok ? "บันทึกแล้ว" : "บันทึกไม่ได้"; b.disabled = ok; });
  q("[data-calgo]", b => b.onclick = () => { const it = find(b.dataset.calgo); const v = parseFloat(document.querySelector(`[data-cal="${it.id}"]`).value); const w = calibrate(it, v); b.textContent = w ? `ได้เล็บกว้าง ${fmt(w, 2)} มม. (ดูในตั้งค่า)` : "กรอกค่าก่อน"; });
}

/* ======================= viewer ======================= */
const cv = $("cv"), vx = cv.getContext("2d");
const fitS = im => cv.width / im.W;
const toImg = (im, sx, sy) => { const s = fitS(im) * S.view.z; return { x: sx / s + S.view.ox, y: sy / s + S.view.oy }; };
function sizeCv() { const im = curImg(), w = $("viewer").clientWidth || 360, dpr = Math.min(2, window.devicePixelRatio || 1); let ch = im ? w * im.H / im.W : w * .75; ch = Math.min(ch, window.innerHeight * .62); cv.width = Math.round(w * dpr); cv.height = Math.round(ch * dpr); cv.style.height = ch + "px"; }
function clampV(im) { const vw = im.W / S.view.z, vh = cv.height / fitS(im) / S.view.z; S.view.ox = clamp(S.view.ox, 0, Math.max(0, im.W - vw)); S.view.oy = clamp(S.view.oy, 0, Math.max(0, im.H - vh)); }
function overlay(im, mask, colVar, key, holder) {
  if (holder[key]) return holder[key]; const c = document.createElement("canvas"); c.width = im.W; c.height = im.H; const x = c.getContext("2d"); const d = x.createImageData(im.W, im.H);
  const col = cssv(colVar) || "#0F6E7A"; const m = /#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(col) || [0, "0f", "6e", "7a"]; const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  for (let i = 0; i < mask.length; i++) if (mask[i]) { d.data[i * 4] = r; d.data[i * 4 + 1] = g; d.data[i * 4 + 2] = b; d.data[i * 4 + 3] = 95; }
  x.putImageData(d, 0, 0); holder[key] = c; return c;
}
function draw() {
  sizeCv(); const im = curImg(), dpr = Math.min(2, window.devicePixelRatio || 1);
  vx.setTransform(1, 0, 0, 1, 0, 0); vx.fillStyle = cssv("--sunk"); vx.fillRect(0, 0, cv.width, cv.height);
  if (!im) { vx.fillStyle = cssv("--muted"); vx.font = `${14 * dpr}px ${cssv("--f-body")}`; vx.textAlign = "center"; vx.fillText("ถ่ายภาพหรือเลือกภาพเพื่อเริ่มวัด", cv.width / 2, cv.height / 2); return; }
  const s = fitS(im) * S.view.z, px = 1 / s; vx.setTransform(s, 0, 0, s, -S.view.ox * s, -S.view.oy * s); vx.drawImage(im.canvas, 0, 0);
  const acc = cssv("--acc"), amb = cssv("--amber"), bad = cssv("--bad");
  const dot = (p, c, r = 4) => { vx.fillStyle = c; vx.beginPath(); vx.arc(p.x, p.y, r * px, 0, 7); vx.fill(); vx.lineWidth = 1.3 * px; vx.strokeStyle = "#fff"; vx.stroke(); if (p.snapped) { vx.strokeStyle = c; vx.beginPath(); vx.arc(p.x, p.y, (r + 3) * px, 0, 7); vx.stroke(); } };
  const path = (P, c, close, w = 2) => { if (P.length < 2) return; vx.strokeStyle = c; vx.lineWidth = w * px; vx.beginPath(); vx.moveTo(P[0].x, P[0].y); for (const p of P.slice(1)) vx.lineTo(p.x, p.y); if (close) vx.closePath(); vx.stroke(); };
  const label = (p, t, c) => { vx.font = `600 ${12 * px}px ${cssv("--f-mono")}`; const w = vx.measureText(t).width; vx.fillStyle = c; vx.fillRect(p.x + 6 * px, p.y - 16 * px, w + 8 * px, 16 * px); vx.fillStyle = "#fff"; vx.fillText(t, p.x + 10 * px, p.y - 4 * px); };
  if (im.refAuto && im.refAuto.mask) vx.drawImage(overlay(im, im.refAuto.mask, "--amber", "refOverlay", im), 0, 0);
  const R = im.refPts, kind = REF[SET.refType].kind;
  if (kind === "rect") path(R, amb, R.length === 4, 2.4); else if (kind === "line") { path(R.slice(0, 2), amb, false, 2.4); if (R.length >= 4) path(R.slice(2, 4), amb, false, 1.6); }
  else if (kind === "circle" && R.length >= 5) { const e = fitEllipse(R); if (e) { vx.strokeStyle = amb; vx.lineWidth = 2.4 * px; vx.beginPath(); vx.ellipse(e.cx, e.cy, e.a, e.b, e.ang, 0, 7); vx.stroke(); } }
  R.forEach((p, i) => { dot(p, amb, 5); label(p, String(i + 1), amb); });
  for (const it of S.items) {
    const isSide = it.side && it.side.imgId === im.id; if (it.imgId !== im.id && !isSide) continue;
    if (it.tool === "obj" || it.tool === "area") {
      const tgt = isSide ? it.side : it; (tgt.neg || []).forEach(p => dot(p, bad, 3)); if (!tgt.seg) { (tgt.seeds || []).forEach(p => dot(p, acc)); continue; }
      vx.drawImage(overlay(im, tgt.seg.mask, "--acc", "overlay", tgt), 0, 0);
      if (it.tool === "area") { if (it.contour) path(it.contour, acc, true, 1.6); const v = it.res && it.res.vals[0]; if (tgt.seeds[0]) label(tgt.seeds[0], `#${it.id}${v ? " " + fmt(v.v, 1) + " " + v.u : ""}`, acc); }
      const pr = tgt.pr; if (pr) { const a = { x: pr.cx + pr.u.x * pr.tmin, y: pr.cy + pr.u.y * pr.tmin }, b = { x: pr.cx + pr.u.x * (pr.tmin + pr.L), y: pr.cy + pr.u.y * (pr.tmin + pr.L) }; vx.setLineDash([8 * px, 6 * px]); path([a, b], acc, false, 2); vx.setLineDash([]); if (!isSide && it.ell) { vx.strokeStyle = amb; vx.lineWidth = 1.5 * px; vx.beginPath(); vx.ellipse(it.ell.cx, it.ell.cy, it.ell.a, it.ell.b, it.ell.ang, 0, 7); vx.stroke(); } const v0 = it.res && it.res.vals[0]; label(a, `#${it.id}${isSide ? " ข้าง" : ""}${v0 ? " " + fmt(v0.v, 1) + " มม." : ""}`, acc); }
      (tgt.seeds || []).forEach(p => dot(p, acc, 3)); continue;
    }
    const P = it.pts, c = acc;
    if (it.tool === "curve") { if (it.path) path(it.path, c, false, 2); } else if (it.tool === "box" && P.length > 1) { for (let i = 1; i < P.length; i++) path([P[0], P[i]], c, false); } else path(P, c, false);
    P.forEach(p => dot(p, c)); if (P.length) { const v = it.res && it.res.vals[0]; label(P[0], `#${it.id}${v ? " " + fmt(v.v, 1) + " " + v.u : ""}`, c); }
  }
  if (S.drag && S.drag.pt) {
    const p = S.drag.pt, Rr = 56 * dpr, cx = Rr + 8 * dpr, cy = Rr + 8 * dpr; vx.setTransform(1, 0, 0, 1, 0, 0); vx.save(); vx.beginPath(); vx.arc(cx, cy, Rr, 0, 7); vx.clip();
    const z = fitS(im) * S.view.z * 4; vx.setTransform(z, 0, 0, z, cx - p.x * z, cy - p.y * z); vx.drawImage(im.canvas, 0, 0); vx.restore(); vx.setTransform(1, 0, 0, 1, 0, 0);
    vx.strokeStyle = amb; vx.lineWidth = 1.5 * dpr; vx.beginPath(); vx.arc(cx, cy, Rr, 0, 7); vx.moveTo(cx - 10 * dpr, cy); vx.lineTo(cx + 10 * dpr, cy); vx.moveTo(cx, cy - 10 * dpr); vx.lineTo(cx, cy + 10 * dpr); vx.stroke();
  }
}
function evPos(e) { const b = cv.getBoundingClientRect(), k = cv.width / b.width; return { x: (e.clientX - b.left) * k, y: (e.clientY - b.top) * k }; }
function editable(im) { const L = [...im.refPts]; S.items.filter(i => i.imgId === im.id && i.pts).forEach(i => L.push(...i.pts)); return L; }
cv.addEventListener("pointerdown", async e => {
  const im = curImg(); if (!im || S.busy) return; const sp = evPos(e), ip = toImg(im, sp.x, sp.y), s = fitS(im) * S.view.z, dpr = cv.width / cv.getBoundingClientRect().width; const t = S.task;
  if (t && t.type === "item" && (t.item.tool === "obj" || t.item.tool === "area")) {
    const it = t.item, tgt = t.side ? it.side : it;
    if (tgt.imgId === im.id) { if (S.negMode) (tgt.neg = tgt.neg || []).push(ip); else tgt.seeds.push(ip); runSeg(it, !!t.side); return; }
  }
  let best = null, bd = 1e9; for (const p of editable(im)) { const d = Math.hypot(p.x - ip.x, p.y - ip.y) * s; if (d < bd) { bd = d; best = p; } }
  if (best && bd < 22 * dpr) { S.drag = { pt: best, off: { x: best.x - ip.x, y: best.y - ip.y } }; cv.setPointerCapture(e.pointerId); draw(); return; }
  if (t && t.type === "ref" && t.img === im) {
    const def = REF[SET.refType];
    if (def.kind !== "line" || SET.refType === "nail") { if (!im.refPts.length || SET.refType !== "nail") { setBusy("กำลังหามาตราวัดอัตโนมัติ…"); const ok = await autoRef(im, ip); setBusy(null); if (ok) { setTask(null); renderAll(); return; } $("task").innerHTML = `<b>หาอัตโนมัติไม่สำเร็จ</b> · แตะวางจุดเองได้ (${def.need} จุด)`; } }
    if (im.refPts.length < (def.max || def.need)) { const p = snapPoint(im, ip); im.refPts.push(p); S.drag = { pt: p, off: { x: 0, y: 0 } }; cv.setPointerCapture(e.pointerId); }
    draw(); return;
  }
  if (t && t.type === "item" && t.item.imgId === im.id) {
    const it = t.item, need = TOOLS[it.tool].need;
    if (need === "var" || it.pts.length < need) { const p = snapPoint(im, ip); it.pts.push(p); S.drag = { pt: p, off: { x: 0, y: 0 } }; cv.setPointerCapture(e.pointerId); draw(); return; }
  }
  if (S.view.z > 1) { S.drag = { pan: true, start: sp, ox: S.view.ox, oy: S.view.oy }; cv.setPointerCapture(e.pointerId); }
});
cv.addEventListener("pointermove", e => {
  const im = curImg(); if (!S.drag || !im) return; const sp = evPos(e);
  if (S.drag.pt) { const ip = toImg(im, sp.x, sp.y); S.drag.pt.x = ip.x + S.drag.off.x; S.drag.pt.y = ip.y + S.drag.off.y; S.drag.pt.snapped = false; S.drag.moved = true; }
  else { const s = fitS(im) * S.view.z; S.view.ox = S.drag.ox - (sp.x - S.drag.start.x) / s; S.view.oy = S.drag.oy - (sp.y - S.drag.start.y) / s; clampV(im); }
  draw();
});
function finishItemGeometry(it, im) {
  if (it.tool === "dist" && it.pts.length === 2) { const [a, b] = it.pts; const L = dist(a, b) || 1; const d = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }; const r = Math.max(6, Math.round(L * .06)); it.pts = [snapAlong(im, a, d, r), snapAlong(im, b, d, r)]; }
  if (it.tool === "curve" && it.pts.length >= 2) { let p = [it.pts[0]]; for (let i = 1; i < it.pts.length; i++) p = p.concat(liveWire(im, it.pts[i - 1], it.pts[i]).slice(1)); it.path = p; }
}
function endDrag() {
  const d = S.drag, im = curImg(); S.drag = null; if (!d || !d.pt) { draw(); return; }
  if (d.moved && im) Object.assign(d.pt, snapPoint(im, d.pt));
  const t = S.task;
  if (t && t.type === "ref") { const def = REF[SET.refType]; if (t.img.refPts.length >= (def.max || def.need)) setTask(null); else setTask(t); }
  else if (t && t.type === "item") { const need = TOOLS[t.item.tool].need; finishItemGeometry(t.item, im); if (need !== "var" && t.item.pts.length >= need) { t.item.closed = true; setTask(null); } else setTask(t); }
  else { for (const it of S.items) if (it.imgId === im.id && it.pts && it.pts.includes(d.pt)) finishItemGeometry(it, im); }
  renderAll();
}
cv.addEventListener("pointerup", endDrag); cv.addEventListener("pointercancel", endDrag);
$("undo").onclick = () => {
  const t = S.task;
  if (t && t.type === "item" && (t.item.tool === "obj" || t.item.tool === "area")) { const tg = t.side ? t.item.side : t.item; if (tg.neg && tg.neg.length && S.negMode) tg.neg.pop(); else if (tg.seeds.length) tg.seeds.pop(); if (tg.seeds.length) runSeg(t.item, !!t.side); else { tg.seg = null; tg.pr = null; t.item.contour = null; renderAll(); } return; }
  let pts = null; if (t && t.type === "ref") pts = t.img.refPts; else if (t && t.type === "item") { pts = t.item.pts; t.item.closed = false; } else { const im = curImg(); if (im && im.refPts.length) { pts = im.refPts; setTask({ type: "ref", img: im }); } }
  if (pts && pts.length) { pts.pop(); if (t && t.type === "ref") { t.img.refAuto = null; } if (t && t.type === "item") finishItemGeometry(t.item, curImg()); setTask(S.task); renderAll(); }
};
$("done").onclick = () => { const t = S.task; if (t && t.type === "item") { t.item.closed = true; finishItemGeometry(t.item, curImg()); setTask(null); renderAll(); } };
$("snap").onclick = () => { SNAP = !SNAP; $("snap").setAttribute("aria-pressed", SNAP); };
$("neg").onclick = () => { S.negMode = !S.negMode; $("neg").setAttribute("aria-pressed", S.negMode); };
const zoom = f => { const im = curImg(); if (!im) return; const c = toImg(im, cv.width / 2, cv.height / 2); S.view.z = clamp(S.view.z * f, 1, 12); const s = fitS(im) * S.view.z; S.view.ox = c.x - cv.width / 2 / s; S.view.oy = c.y - cv.height / 2 / s; clampV(im); draw(); };
$("zIn").onclick = () => zoom(1.6); $("zOut").onclick = () => zoom(1 / 1.6); $("zFit").onclick = () => { S.view = { z: 1, ox: 0, oy: 0 }; draw(); };
window.addEventListener("resize", draw);
$("tol").oninput = () => { $("tolV").textContent = $("tol").value; };
$("tol").onchange = () => { const t = S.task; if (!t || t.type !== "item") return; const it = t.item; const tg = t.side ? it.side : it; tg.tol = +$("tol").value; if (tg.seeds && tg.seeds.length) runSeg(it, t.side); };

/* ======================= tools & reference UI ======================= */
(function () {
  const b = $("tools");
  for (const k in TOOLS) {
    const c = document.createElement("button"); c.className = "chip"; c.textContent = TOOLS[k].n;
    c.onclick = () => { const im = curImg(); if (!im) { setTask(null); return; } const it = { id: S.seq++, tool: k, imgId: im.id, pts: (k === "obj" || k === "area") ? null : [], seeds: [], neg: [], tol: +$("tol").value, dMode: "delta", delta: 0, deltaSd: 1, closed: false, label: "" }; S.items.push(it); setTask({ type: "item", item: it }); $("toolHint").textContent = TOOLS[k].hint; renderAll(); };
    b.appendChild(c);
  }
})();
$("refBar").onclick = () => { $("refPanel").hidden = !$("refPanel").hidden; };
$("refType").onchange = () => { SET.refType = $("refType").value; saveSet(); for (const im of S.imgs) { im.refPts = []; im.refAuto = null; } const im = curImg(); if (im) setTask({ type: "ref", img: im }); renderAll(); };
["refA", "refB", "refS"].forEach(id => $(id).addEventListener("change", () => { const t = SET.refType, a = parseFloat($("refA").value), b = parseFloat($("refB").value), s = parseFloat($("refS").value); if (t === "rect") SET.rect = { a: a || 100, b: b || 100, sd: s >= 0 ? s : .5 }; if (t === "circle") SET.circle = { d: a || 20, sd: s >= 0 ? s : .1 }; if (t === "line") SET.line = { L: a || 100, sd: s >= 0 ? s : .5 }; saveSet(); renderAll(); }));
$("refPlace").onclick = () => { const im = curImg(); if (im) { im.refPts = []; im.refAuto = null; setTask({ type: "ref", img: im }); renderAll(); } };
$("refAuto").onclick = async () => { const im = curImg(); if (!im) return; if (SET.refType !== "nail") { setTask({ type: "ref", img: im }); $("task").innerHTML = `<b>มาตราวัด</b> · ${REF[SET.refType].auto}`; return; } setBusy("กำลังหาเล็บอัตโนมัติ…"); const ok = await autoNail(im, null); setBusy(null); if (!ok) $("task").innerHTML = "<b>หาเล็บอัตโนมัติไม่เจอ</b> · แตะที่เล็บ 1 ครั้ง"; else setTask(null); renderAll(); };
$("gyroPlane").onclick = () => { const im = curImg(); if (im) { im.gyroPlane = !im.gyroPlane; renderAll(); } };

/* ======================= files ======================= */
async function handleNewImage(src, meta) {
  try { const im = await addImage(src, meta); if (S.pendingSide) { const it = S.pendingSide; S.pendingSide = null; it.side = { imgId: im.id, seeds: [], neg: [], tol: it.tol }; S._afterRef = { type: "item", item: it, side: true }; } renderAll(); }
  catch (e) { console.error(e); $("task").innerHTML = `<b style="color:var(--bad)">เปิดภาพไม่ได้</b> ลองใช้ JPG หรือ PNG`; }
}
$("fileIn").onchange = async e => { const fs = [...e.target.files]; e.target.value = ""; for (const f of fs) await handleNewImage(f); };
const _setTask = setTask;
setTask = function (t) { if (t === null && S._afterRef) { const im = curImg(); if (im && im.refPts.length >= REF[SET.refType].need) { const nx = S._afterRef; S._afterRef = null; return _setTask(nx); } } return _setTask(t); };

/* ======================= camera ======================= */
const CAM = { stream: null, ori: null, mode: "down" };
function onOri(e) { if (e.beta == null) return; CAM.ori = { beta: e.beta, gamma: e.gamma }; drawCamUi(); }
function drawCamUi() {
  const c = $("camUi"), x = c.getContext("2d"), dpr = Math.min(2, devicePixelRatio || 1); c.width = innerWidth * dpr; c.height = innerHeight * dpr; x.clearRect(0, 0, c.width, c.height);
  const cx = c.width / 2, cy = c.height * .42, R = Math.min(c.width, c.height) * .18; x.strokeStyle = "rgba(255,255,255,.5)"; x.lineWidth = 1.5 * dpr;
  for (let i = 1; i < 3; i++) { x.beginPath(); x.moveTo(c.width * i / 3, 0); x.lineTo(c.width * i / 3, c.height); x.stroke(); x.beginPath(); x.moveTo(0, c.height * i / 3); x.lineTo(c.width, c.height * i / 3); x.stroke(); }
  x.beginPath(); x.arc(cx, cy, R, 0, 7); x.stroke(); let txt = "ไม่มีข้อมูลไจโร"; const o = CAM.ori;
  if (o) { const down = CAM.mode === "down"; const by = down ? o.beta : o.beta - 90, err = Math.hypot(by, o.gamma); const ok = err < 3; x.fillStyle = ok ? "#5FC484" : err < 8 ? "#E9A845" : "#F27560"; x.beginPath(); x.arc(cx + clamp(o.gamma / 30, -1, 1) * R, cy + clamp(by / 30, -1, 1) * R, 14 * dpr, 0, 7); x.fill(); txt = `${down ? "ก้มลงพื้น" : "ถ่ายตรงไปข้างหน้า"} · เอียง ${fmt(err, 1)}°${ok ? " · ตรงแล้ว" : ""}`; }
  $("camRead").textContent = txt;
}
async function openCam() {
  $("cam").hidden = false; $("camRead").textContent = "กำลังเปิดกล้อง…";
  try { CAM.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false }); $("vid").srcObject = CAM.stream; await $("vid").play(); if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) { try { await DeviceOrientationEvent.requestPermission(); } catch (e) { } } addEventListener("deviceorientation", onOri); drawCamUi(); }
  catch (e) { $("camRead").textContent = "เปิดกล้องไม่ได้: อนุญาตกล้องในเบราว์เซอร์ และต้องเปิดผ่าน https"; }
}
function closeCam() { removeEventListener("deviceorientation", onOri); if (CAM.stream) CAM.stream.getTracks().forEach(t => t.stop()); CAM.stream = null; $("cam").hidden = true; }
$("openCam").onclick = openCam; $("camClose").onclick = closeCam;
$("camMode").onclick = () => { CAM.mode = CAM.mode === "down" ? "front" : "down"; $("camMode").textContent = "เส้นระดับ: " + (CAM.mode === "down" ? "ก้มลงพื้น" : "ถ่ายตรงไปข้างหน้า"); drawCamUi(); };
$("shutter").onclick = async () => { const v = $("vid"); if (!v.videoWidth) return; const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0); const gyro = CAM.ori ? { ...CAM.ori } : null; closeCam(); await handleNewImage(c, { name: "กล้อง " + new Date().toLocaleTimeString("th-TH"), gyro, inApp: true }); const im = curImg(); if (im && gyro && gyroTilt(im) < 30 && REF[SET.refType].kind === "line") { im.gyroPlane = true; renderAll(); } };

/* ======================= history ======================= */
function thumb(im, it) { try { const c = document.createElement("canvas"), s = 160 / Math.max(im.W, im.H); c.width = Math.round(im.W * s); c.height = Math.round(im.H * s); const x = c.getContext("2d"); x.drawImage(im.canvas, 0, 0, c.width, c.height); if (it.seg) { x.globalAlpha = .5; x.drawImage(overlay(im, it.seg.mask, "--acc", "overlay", it), 0, 0, c.width, c.height); } return c.toDataURL("image/jpeg", .6); } catch (e) { return null; } }
function saveHistory(it) {
  if (!it || !it.res) return false; const im = imgById(it.imgId); const dp = depthOf(it);
  const rec = { id: Date.now() + "_" + it.id, date: new Date().toISOString(), label: it.label || TOOLS[it.tool].n, tool: it.tool, shape: it.tool === "obj" ? (it.shape || it.fit.best) : null, twoView: !!(it.side && it.side.pr), ref: { type: SET.refType, name: REF[SET.refType].name() }, delta: dp.d, vals: it.res.vals.map(o => ({ lb: o.lb, v: o.v, sd: o.sd, u: o.u })), thumb: thumb(im, it) };
  const H = store.get("pc_hist", []); H.unshift(rec); while (H.length > 300) H.pop(); if (!store.set("pc_hist", H)) { rec.thumb = null; H[0] = rec; return store.set("pc_hist", H); } return true;
}
function renderHistory() {
  const H = store.get("pc_hist", []); $("histCount").textContent = H.length + " รายการ"; const groups = {}; for (const r of H) (groups[r.label] = groups[r.label] || []).push(r);
  let g = `<h2>สรุปตามชื่อการวัด <small>ค่าเฉลี่ย, SD ระหว่างครั้ง, จำนวนครั้ง</small></h2>`; const keys = Object.keys(groups);
  if (!keys.length) g += `<p class="muted" style="margin:0">ยังไม่มีประวัติ กด "บันทึก" ในผลการวัดเพื่อเก็บ</p>`;
  for (const k of keys) { const rs = groups[k]; const lbs = [...new Set(rs.flatMap(r => r.vals.map(v => v.lb)))]; g += `<div class="item"><div class="item-h"><b>${esc(k)}</b><span class="tag acc">${rs.length} ครั้ง</span></div><div class="tbl-wrap"><table><thead><tr><th>ค่า</th><th class="n">เฉลี่ย</th><th class="n">SD</th><th class="n">n</th></tr></thead><tbody>`; for (const lb of lbs) { const vs = rs.map(r => r.vals.find(v => v.lb === lb)).filter(Boolean); const xs = vs.map(v => v.v); const sd = sdOf(xs); g += `<tr><td>${esc(lb)}</td><td class="n">${fmt(mean(xs), 2)} ${vs[0].u}</td><td class="n">${sd != null ? fmt(sd, 2) : "—"}</td><td class="n">${xs.length}</td></tr>`; } g += `</tbody></table></div></div>`; }
  $("histGroups").innerHTML = g;
  let l = `<h2>รายการทั้งหมด</h2>` + (H.length ? H.map(r => `<div class="hist-item">${r.thumb ? `<img src="${r.thumb}" alt="">` : `<div style="width:64px;height:64px;border-radius:6px;background:var(--sunk)"></div>`}<div style="min-width:0"><b>${esc(r.label)}</b><div class="muted">${new Date(r.date).toLocaleString("th-TH")} · ${esc(r.ref.name)}${r.shape ? " · " + SHAPE_N[r.shape] : ""}${r.twoView ? " · 2 มุม" : ""}${r.delta ? " · Δ " + fmt(r.delta, 1) + " มม." : ""}</div><div style="font-family:var(--f-mono);font-size:13px">${r.vals.slice(0, 3).map(v => `${esc(v.lb)}: ${fmt(v.v, 2)}${v.sd != null ? " ± " + fmt(v.sd, 2) : ""} ${v.u}`).join("<br>")}</div></div><button class="chip" data-hdel="${r.id}">ลบ</button></div>`).join("") : `<p class="muted" style="margin:0">—</p>`);
  $("histList").innerHTML = l; document.querySelectorAll("[data-hdel]").forEach(b => b.onclick = () => { store.set("pc_hist", store.get("pc_hist", []).filter(r => r.id !== b.dataset.hdel)); renderHistory(); });
}
function csvText() { const H = store.get("pc_hist", []); const rows = [["date", "label", "tool", "shape", "two_view", "reference", "delta_mm", "quantity", "value", "sd", "unit"]]; for (const r of H) for (const v of r.vals) rows.push([r.date, r.label, r.tool, r.shape || "", r.twoView ? 1 : 0, r.ref.name, r.delta ?? 0, v.lb, v.v, v.sd ?? "", v.u]); return "﻿" + rows.map(r => r.map(x => { const s = String(x); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\n"); }
$("csv").onclick = () => { const b = new Blob([csvText()], { type: "text/csv;charset=utf-8" }); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "photo-caliper-" + new Date().toISOString().slice(0, 10) + ".csv"; document.body.appendChild(a); a.click(); a.remove(); };
$("csvCopy").onclick = async () => { try { await navigator.clipboard.writeText(csvText()); $("csvCopy").textContent = "คัดลอกแล้ว"; } catch (e) { $("csvCopy").textContent = "คัดลอกไม่ได้"; } };

/* ======================= settings & tabs ======================= */
function renderSettings() {
  $("sW").value = SET.nail.w; $("sWsd").value = SET.nail.sd; $("sL").value = SET.nail.len; $("sH").value = SET.nail.h; $("sF").value = SET.f35app;
  $("libCv").checked = SET.libs.cv; $("libSam").checked = SET.libs.sam; $("libHands").checked = SET.libs.hands; updLib();
  const c = calSummary(); let h = "";
  if (!c) h = `<p class="muted" style="margin:0">ยังไม่มีการปรับเทียบ วัดวัตถุที่รู้ขนาด (บัตร ฝา ไม้บรรทัด) แล้วกด 'ใช้ปรับเทียบเล็บ' ในผลการวัด</p>`;
  else {
    h = `<dl class="kv"><dt>จำนวนครั้ง</dt><dd>${c.n}</dd><dt>ความกว้างเล็บเฉลี่ย</dt><dd>${fmt(c.mean, 3)} มม.</dd><dt>SD ระหว่างครั้ง</dt><dd>${c.sd != null ? fmt(c.sd, 3) : "—"} มม.</dd><dt>SE ของค่าเฉลี่ย</dt><dd>${c.se != null ? fmt(c.se, 3) : "—"} มม.</dd></dl>`;
    h += `<div class="tbl-wrap" style="margin-top:8px"><table><thead><tr><th>วัตถุ</th><th class="n">จริง</th><th class="n">วัดได้</th><th class="n">เล็บ</th><th></th></tr></thead><tbody>${SET.nailCal.map((x, i) => `<tr><td>${esc(x.obj)}</td><td class="n">${fmt(x.trueVal, 2)}</td><td class="n">${fmt(x.meas, 2)}</td><td class="n">${fmt(x.w, 3)}</td><td><button class="chip" data-caldel="${i}">ลบ</button></td></tr>`).join("")}</tbody></table></div>`;
    h += `<div class="row" style="margin-top:8px"><button class="btn pri" id="calApply">ใช้ค่าเฉลี่ยเป็นความกว้างเล็บ</button></div><p class="muted" style="margin:6px 0 0">± ที่ใช้ = √(SE² + ความคลาดเฉลี่ยของแต่ละครั้ง²) ยิ่งปรับเทียบหลายครั้งกับวัตถุต่างชนิด ยิ่งแม่น</p>`;
  }
  $("calBox").innerHTML = h;
  document.querySelectorAll("[data-caldel]").forEach(b => b.onclick = () => { SET.nailCal.splice(+b.dataset.caldel, 1); saveSet(); renderSettings(); });
  const ap = $("calApply"); if (ap) ap.onclick = () => { const c = calSummary(); const rel = mean(SET.nailCal.map(x => x.rel || 0)); SET.nail.w = +c.mean.toFixed(3); SET.nail.sd = +hyp(c.se || c.mean * .02, rel * c.mean).toFixed(3); saveSet(); renderSettings(); renderAll(); ap.textContent = "ใช้แล้ว"; };
}
["sW", "sWsd", "sL", "sH", "sF"].forEach(id => $(id).addEventListener("change", () => { SET.nail = { w: parseFloat($("sW").value) || 12, sd: Math.max(0, parseFloat($("sWsd").value) || .3), len: parseFloat($("sL").value) || 8.17, h: parseFloat($("sH").value) || 16 }; SET.f35app = parseFloat($("sF").value) || 27; saveSet(); renderAll(); }));
[["libCv", "cv", loadCV], ["libSam", "sam", loadSAM], ["libHands", "hands", loadHands]].forEach(([id, k, fn]) => $(id).addEventListener("change", () => { SET.libs[k] = $(id).checked; saveSet(); if (SET.libs[k]) fn(); }));
$("wipe").onclick = async () => {
  if ($("wipe").dataset.armed !== "1") { $("wipe").dataset.armed = "1"; $("wipe").textContent = "กดอีกครั้งเพื่อยืนยัน"; return; }
  try { localStorage.clear(); } catch (e) { } try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (e) { } try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); } catch (e) { }
  $("wipeMsg").textContent = "ล้างแล้ว กำลังโหลดใหม่…"; setTimeout(() => location.reload(), 600);
};
document.querySelectorAll(".tab").forEach(b => b.onclick = () => { document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x === b)); for (const k of ["measure", "history", "settings"]) $("tab-" + k).hidden = b.dataset.tab !== k; if (b.dataset.tab === "history") renderHistory(); if (b.dataset.tab === "settings") renderSettings(); if (b.dataset.tab === "measure") draw(); });

/* ======================= boot ======================= */
(async () => {
  $("tolV").textContent = $("tol").value; renderSettings();
  await initGPU(); $("engine").textContent = G.state;
  setTask(null); renderAll();
  if ("serviceWorker" in navigator && location.protocol === "https:") { try { await navigator.serviceWorker.register("sw.js"); } catch (e) { } }
  // optional libraries in the background; the app works without them
  loadCV(); loadSAM(); loadHands();
})();
