"use strict";
/* Photo Caliper — on-device photogrammetry measuring tool. No AI, no uploads. */

/* ======================= helpers ======================= */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const R2D = 180 / Math.PI;
const fmt = (v, d = 1) => (v == null || !isFinite(v)) ? "—" : v.toFixed(d);
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const hyp = (...a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0));
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
function rn() { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function sdOf(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
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
  const q = pts.map(p => ({ x: (p.x - mx) / sc, y: (p.y - my) / sc }));
  // least squares when >5 points
  const M = Array.from({ length: 5 }, () => Array(5).fill(0)), r = Array(5).fill(0);
  for (const p of q) { const row = [p.x * p.x, p.x * p.y, p.y * p.y, p.x, p.y]; for (let i = 0; i < 5; i++) { r[i] += -row[i]; for (let j = 0; j < 5; j++) M[i][j] += row[i] * row[j]; } }
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
const ramanujan = (a, b) => { const h = ((a - b) / (a + b || 1)) ** 2; return Math.PI * (a + b) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h))); };

/* ======================= storage ======================= */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
};
const DEF_SET = { refType: "nail", nail: { w: 12.0, sd: 0.3, len: 8.17 }, rect: { a: 100, b: 100, sd: 0.5 }, circle: { d: 20, sd: 0.1 }, line: { L: 100, sd: 0.5 }, f35app: 27 };
let SET = Object.assign({}, DEF_SET, store.get("pc_set", {}));
SET.nail = Object.assign({}, DEF_SET.nail, SET.nail || {});
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
  const px = im.ctx.getImageData(0, 0, W, H).data, gr = new Float32Array(W * H);
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
  im.corners = n; im.fmax = mx; im.tmax = tm;
}
let SNAP = true;
function snapPoint(im, p) {
  if (!im.feat || !SNAP) return { x: p.x, y: p.y, snapped: false };
  const r = Math.max(6, Math.round(Math.max(im.W, im.H) / 180)); let best = null, bv = 0, bt = null, btv = 0;
  for (let y = Math.max(0, p.y - r | 0); y <= Math.min(im.H - 1, p.y + r | 0); y++) for (let x = Math.max(0, p.x - r | 0); x <= Math.min(im.W - 1, p.x + r | 0); x++) {
    if ((x - p.x) ** 2 + (y - p.y) ** 2 > r * r) continue; const i = (y * im.W + x) * 2, R = im.feat[i], T = im.feat[i + 1];
    if (R > bv) { bv = R; best = { x, y }; } if (T > btv) { btv = T; bt = { x, y }; }
  }
  if (best && bv > im.fmax * .02) return { ...best, snapped: "corner" };
  if (bt && btv > im.tmax * .08) return { ...bt, snapped: "edge" };
  return { x: p.x, y: p.y, snapped: false };
}

/* ======================= reference definitions ======================= */
const REF = {
  nail: { need: 2, max: 4, kind: "line", name: () => `เล็บนิ้วโป้ง ${fmt(SET.nail.w, 1)} ± ${fmt(SET.nail.sd, 1)} มม.`,
    hint: "แตะขอบซ้ายและขวาของเล็บ (ช่วงกลาง ส่วนที่ติดเนื้อ) ถ้าอยากให้ตรวจมุมเอียงของเล็บ แตะเพิ่ม: โคนเล็บ แล้วขอบเนื้อปลาย ให้นิ้วอยู่ระยะเดียวกับวัตถุ" },
  card: { need: 4, kind: "rect", a: 85.60, b: 53.98, sd: 0.05, name: () => "บัตร ID-1 85.60 × 53.98 มม.", hint: "แตะมุมบัตร 4 มุมตามลำดับรอบ เริ่มจากมุมที่ทำให้ขอบแรก (1→2) เป็นด้านยาว" },
  a4: { need: 4, kind: "rect", a: 297, b: 210, sd: 0.5, name: () => "กระดาษ A4 297 × 210 มม.", hint: "แตะมุมกระดาษ 4 มุมตามลำดับรอบ ขอบแรก (1→2) คือด้านยาว" },
  rect: { need: 4, kind: "rect", name: () => `สี่เหลี่ยม ${fmt(SET.rect.a, 1)} × ${fmt(SET.rect.b, 1)} มม.`, hint: "แตะ 4 มุมตามลำดับรอบ ขอบแรก (1→2) คือด้าน 'กว้าง'" },
  circle: { need: 5, kind: "circle", name: () => `วงกลม ⌀ ${fmt(SET.circle.d, 2)} มม.`, hint: "แตะ 5 จุดกระจายรอบขอบวงกลม" },
  line: { need: 2, kind: "line", name: () => `ระยะ ${fmt(SET.line.L, 1)} มม.`, hint: "แตะปลายทั้งสองของระยะที่รู้ เช่น ขีด 0 และ 10 ซม." }
};
function refSize() {
  const t = SET.refType;
  if (t === "nail") return { a: SET.nail.w, sd: SET.nail.sd };
  if (t === "card" || t === "a4") return { a: REF[t].a, b: REF[t].b, sd: REF[t].sd };
  if (t === "rect") return { a: SET.rect.a, b: SET.rect.b, sd: SET.rect.sd };
  if (t === "circle") return { a: SET.circle.d, sd: SET.circle.sd };
  return { a: SET.line.L, sd: SET.line.sd };
}

/* ======================= tools ======================= */
const TOOLS = {
  obj: { n: "วัตถุ 3 มิติ (อัตโนมัติ)", need: 1, hint: "แตะที่วัตถุ 1 ครั้ง ระบบแยกขอบ หาแกน และจัดรูปทรงให้ ปรับความไวได้ด้านล่างภาพ" },
  dist: { n: "ระยะ", need: 2, hint: "แตะ 2 จุด" },
  poly: { n: "ความยาวตามเส้นโค้ง", need: "var", min: 2, hint: "แตะทีละจุดตามแนวโค้ง แล้วกด 'จบเส้น'" },
  area: { n: "พื้นที่", need: "var", min: 3, hint: "แตะรอบขอบรูปทีละจุด แล้วกด 'จบเส้น'" },
  angle: { n: "มุม", need: 3, hint: "แตะ ปลายแขน 1 → จุดยอดมุม → ปลายแขน 2" },
  cyl: { n: "ทรงกระบอก (วางเอง)", need: 5, hint: "แตะ ขอบบนซ้าย → บนขวา → ล่างซ้าย → ล่างขวา → จุดหน้าสุดของวงรีด้านบน" },
  box: { n: "กล่อง", need: 4, hint: "แตะ มุมที่ใกล้กล้องที่สุด แล้วปลายขอบ 3 เส้นที่ออกจากมุมนั้น" },
  sphere: { n: "ทรงรี (วางเอง)", need: 5, hint: "แตะ 5 จุดรอบขอบวัตถุ" }
};

/* ======================= state ======================= */
const S = { imgs: [], cur: -1, items: [], task: null, view: { z: 1, ox: 0, oy: 0 }, drag: null, seq: 1, imgSeq: 1 };
const curImg = () => S.imgs[S.cur];
const imgById = id => S.imgs.find(i => i.id === id);

/* ======================= images ======================= */
async function addImage(src, meta) {
  // src: File or canvas
  let exif = {}, bmp, name;
  if (src instanceof File || src instanceof Blob) {
    name = src.name || "ภาพ"; const buf = await src.arrayBuffer(); exif = parseExif(buf);
    try { bmp = await createImageBitmap(src); } catch (e) { bmp = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(src); }); }
  } else { bmp = src; name = meta.name; }
  const W0 = bmp.width, H0 = bmp.height, k = Math.min(1, 1800 / Math.max(W0, H0)), W = Math.round(W0 * k), H = Math.round(H0 * k);
  const c = document.createElement("canvas"); c.width = W; c.height = H; const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, W, H);
  const im = { id: S.imgSeq++, name, canvas: c, ctx, W, H, W0, H0, k, exif, gyro: meta && meta.gyro || null, inApp: !!(meta && meta.inApp), refPts: [], gyroPlane: false };
  await featureMap(im); featStats(im);
  im.px = ctx.getImageData(0, 0, W, H).data;
  S.imgs.push(im); S.cur = S.imgs.length - 1; S.view = { z: 1, ox: 0, oy: 0 };
  setTask({ type: "ref", img: im });
  renderAll();
  return im;
}

/* ======================= lens & camera geometry ======================= */
function lensInfo(im) {
  const e = im.exif || {}; let f35 = e.f35 || null, src = "EXIF (เทียบ 35 มม.)", rel = 0.02;
  if (!f35 && im.inApp) { f35 = SET.f35app; src = "ค่าตั้งค่ากล้องในแอป"; rel = 0.05; }
  const cls = f => f == null ? "ไม่ทราบ" : f < 20 ? "กว้างพิเศษ (ultra-wide)" : f < 35 ? "กล้องหลัก มุมกว้าง" : f < 60 ? "ซูม ~2× หรือครอป" : "เทเล";
  const dk = f => f == null ? 0.004 : f < 20 ? 0.012 : f < 35 ? 0.003 : 0.0015;
  return { f35, src: f35 ? src : null, rel, cls: cls(f35), distK: dk(f35), fpx: f35 ? f35 * Math.hypot(im.W, im.H) / 43.27 : null, fov: f35 ? 2 * Math.atan(43.27 / (2 * f35)) * R2D : null, dz: e.dzoom || 1 };
}
// ray -> point on horizontal plane using device orientation (beta, gamma in degrees)
function gyroPlaneFn(im, f, jb = 0, jg = 0) {
  const b = (im.gyro.beta + jb) / R2D, g = (im.gyro.gamma + jg) / R2D, cx = im.W / 2, cy = im.H / 2;
  const cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  return p => {
    const v = [(p.x - cx) / f, -(p.y - cy) / f, -1];
    const y1 = [cg * v[0] + sg * v[2], v[1], -sg * v[0] + cg * v[2]];
    const e = [y1[0], cb * y1[1] - sb * y1[2], sb * y1[1] + cb * y1[2]];
    if (e[2] >= -1e-6) return { x: NaN, y: NaN };
    return { x: -e[0] / e[2], y: -e[1] / e[2] };
  };
}
function gyroTilt(im) { const b = im.gyro.beta / R2D, g = im.gyro.gamma / R2D; const z = -Math.cos(b) * Math.cos(g); return Math.acos(clamp(-z, -1, 1)) * R2D; }

function buildMapper(im, P, size, opt = {}) {
  const t = SET.refType, kind = REF[t].kind;
  const jac = (toPlane, p) => {
    const o = toPlane(p), u = toPlane({ x: p.x + 1, y: p.y }), v = toPlane({ x: p.x, y: p.y + 1 });
    const j = [u.x - o.x, v.x - o.x, u.y - o.y, v.y - o.y]; const A = j[0] * j[0] + j[2] * j[2], B = j[0] * j[1] + j[2] * j[3], C = j[1] * j[1] + j[3] * j[3];
    return Math.sqrt(Math.max((A + C) / 2 - Math.sqrt(((A - C) / 2) ** 2 + B * B), 1e-12));
  };
  if (kind === "rect") {
    const H = homog(P, [{ x: 0, y: 0 }, { x: size.a, y: 0 }, { x: size.a, y: size.b }, { x: 0, y: size.b }]); if (!H) return null;
    const toPlane = p => hApply(H, p); return { toPlane, sIso: p => jac(toPlane, p), H };
  }
  if (kind === "circle") {
    const e = fitEllipse(P); if (!e) return null; const sa = size.a / (2 * e.a), sb = size.a / (2 * e.b), c = Math.cos(e.ang), s = Math.sin(e.ang);
    return { toPlane: p => { const dx = p.x - e.cx, dy = p.y - e.cy; return { x: (dx * c + dy * s) * sa, y: (-dx * s + dy * c) * sb }; }, sIso: () => sa, ell: e };
  }
  // line-type reference (nail, ruler)
  if (im.gyro && im.gyroPlane && opt.f) {
    const pl = gyroPlaneFn(im, opt.f, opt.jb || 0, opt.jg || 0); const a = pl(P[0]), b = pl(P[1]); const dd = Math.hypot(a.x - b.x, a.y - b.y);
    if (!isFinite(dd) || dd <= 0) return null; const sc = size.a / dd;
    const toPlane = p => { const q = pl(p); return { x: q.x * sc, y: q.y * sc }; }; return { toPlane, sIso: p => jac(toPlane, p), gyro: true };
  }
  const L = dist(P[0], P[1]); if (L < 1) return null; const sc = size.a / L;
  return { toPlane: p => ({ x: p.x * sc, y: p.y * sc }), sIso: () => sc };
}
function cameraModel(im, P, M) {
  const lens = lensInfo(im), kind = REF[SET.refType].kind; const cx = im.W / 2, cy = im.H / 2, sz = refSize();
  let f = lens.fpx, fsrc = lens.src, frel = lens.rel, pose = null;
  if (kind === "rect") {
    const H2 = homog([{ x: 0, y: 0 }, { x: sz.a, y: 0 }, { x: sz.a, y: sz.b }, { x: 0, y: sz.b }], P.map(p => ({ x: p.x - cx, y: p.y - cy })));
    if (H2) {
      const h = H2;
      if (!f) { const f2 = -(h[0] * h[1] + h[3] * h[4]) / (h[6] * h[7]); if (f2 > 0 && isFinite(f2)) { const fe = Math.sqrt(f2), dg = Math.hypot(im.W, im.H); if (fe > dg * .3 && fe < dg * 6) { f = fe; fsrc = "ประมาณจากรูปทรงสี่เหลี่ยม"; frel = 0.08; } } }
      if (f) {
        const m1 = [h[0] / f, h[3] / f, h[6]], m2 = [h[1] / f, h[4] / f, h[7]], m3 = [h[2] / f, h[5] / f, h[8]];
        const l = 1 / Math.hypot(...m1), r1 = m1.map(v => v * l), r2 = m2.map(v => v * l), t = m3.map(v => v * l);
        const n = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]]; const nn = Math.hypot(...n); n.forEach((v, i) => n[i] = v / nn);
        pose = { src: "สี่เหลี่ยมอ้างอิง", tilt: Math.acos(Math.min(1, Math.abs(n[2]))) * R2D, pitch: Math.atan2(n[1], Math.abs(n[2])) * R2D, yaw: Math.atan2(n[0], Math.abs(n[2])) * R2D, Z: Math.hypot(...t), skew: Math.abs(r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2]) / Math.hypot(...r2) };
      }
    }
  }
  if (kind === "circle" && M.ell) pose = { src: "วงรีของวงกลมอ้างอิง", tilt: Math.acos(clamp(M.ell.b / M.ell.a, 0, 1)) * R2D, tiltOnly: true };
  if (!f) { f = 26 * Math.hypot(im.W, im.H) / 43.27; fsrc = "สมมติเลนส์ 26 มม. (ไม่มี EXIF)"; frel = 0.2; }
  if (im.gyro) { const tl = gyroTilt(im); if (!pose || pose.tiltOnly) pose = Object.assign(pose || {}, { gyroTilt: tl, gyroSrc: true }); else pose.gyroTilt = tl; }
  return { f, fsrc, frel, pose, lens };
}
function refCheck(im, M) {
  // nail length check (points 3,4)
  if (SET.refType !== "nail" || im.refPts.length < 4) return null;
  const P = im.refPts; const w = dist(P[0], P[1]), l = dist(P[2], P[3]); const meas = l / w, exp = SET.nail.len / SET.nail.w;
  return { meas, exp, ratio: meas / exp };
}

/* ======================= segmentation & shape ======================= */
function ycc(px, i) { const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; return [.299 * r + .587 * g + .114 * b, 128 - .168736 * r - .331264 * g + .5 * b, 128 + .5 * r - .418688 * g - .081312 * b]; }
function segment(im, seeds, tol) {
  const { W, H, px, feat } = im; const N = W * H; const mask = new Uint8Array(N);
  const edgeThr = im.tmax * 0.18;
  const qbuf = new Int32Array(N);
  for (const sd of seeds) {
    const sx = clamp(Math.round(sd.x), 0, W - 1), sy = clamp(Math.round(sd.y), 0, H - 1);
    let mY = 0, mB = 0, mR = 0, n = 0;
    for (let y = Math.max(0, sy - 4); y <= Math.min(H - 1, sy + 4); y++) for (let x = Math.max(0, sx - 4); x <= Math.min(W - 1, sx + 4); x++) { const c = ycc(px, y * W + x); mY += c[0]; mB += c[1]; mR += c[2]; n++; }
    mY /= n; mB /= n; mR /= n;
    let qh = 0, qt = 0; const s0 = sy * W + sx; if (!mask[s0]) { mask[s0] = 1; qbuf[qt++] = s0; }
    while (qh < qt) {
      const i = qbuf[qh++], x = i % W, y = (i / W) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const j of nb) {
        if (j < 0 || mask[j]) continue;
        const c = ycc(px, j); const d = Math.sqrt(.35 * (c[0] - mY) ** 2 + (c[1] - mB) ** 2 + (c[2] - mR) ** 2);
        if (d > tol) continue; if (feat[j * 2 + 1] > edgeThr && d > tol * .5) continue;
        mask[j] = 1; qbuf[qt++] = j;
      }
    }
  }
  // close: dilate then erode (2 px)
  const morph = (m, dil) => { const o = new Uint8Array(N); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = dil ? 0 : 1; for (let dy = -2; dy <= 2 && (dil ? !v : v); dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; const mv = (xx < 0 || yy < 0 || xx >= W || yy >= H) ? 0 : m[yy * W + xx]; if (dil && mv) { v = 1; break; } if (!dil && !mv) { v = 0; break; } } o[y * W + x] = v; } return o; };
  let m = morph(morph(mask, true), false);
  // fill holes
  const out = new Uint8Array(N); let qh = 0, qt = 0;
  const push = i => { if (!m[i] && !out[i]) { out[i] = 1; qbuf[qt++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); } for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (qh < qt) { const i = qbuf[qh++], x = i % W, y = (i / W) | 0; if (x > 0) push(i - 1); if (x < W - 1) push(i + 1); if (y > 0) push(i - W); if (y < H - 1) push(i + W); }
  for (let i = 0; i < N; i++) m[i] = out[i] ? 0 : 1;
  // keep component(s) touching seeds
  const keep = new Uint8Array(N); qh = 0; qt = 0;
  for (const sd of seeds) { const i = clamp(Math.round(sd.y), 0, H - 1) * W + clamp(Math.round(sd.x), 0, W - 1); if (m[i] && !keep[i]) { keep[i] = 1; qbuf[qt++] = i; } }
  while (qh < qt) { const i = qbuf[qh++], x = i % W, y = (i / W) | 0; for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) if (j >= 0 && m[j] && !keep[j]) { keep[j] = 1; qbuf[qt++] = j; } }
  let area = 0, touches = false; for (let i = 0; i < N; i++) if (keep[i]) { area++; const x = i % W, y = (i / W) | 0; if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touches = true; }
  return { mask: keep, area, touches };
}
function profileOf(im, mask, NB = 120) {
  const { W, H } = im; let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < W * H; i++) if (mask[i]) { n++; sx += i % W; sy += (i / W) | 0; }
  if (n < 50) return null; const cx = sx / n, cy = sy / n; let xx = 0, yy = 0, xy = 0;
  for (let i = 0; i < W * H; i++) if (mask[i]) { const dx = i % W - cx, dy = ((i / W) | 0) - cy; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy), u = { x: Math.cos(ang), y: Math.sin(ang) }, v = { x: -u.y, y: u.x };
  let tmin = 1e9, tmax = -1e9;
  for (let i = 0; i < W * H; i++) if (mask[i]) { const t = (i % W - cx) * u.x + (((i / W) | 0) - cy) * u.y; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
  const L = tmax - tmin + 1, lo = new Float32Array(NB).fill(1e9), hi = new Float32Array(NB).fill(-1e9), cnt = new Uint32Array(NB);
  for (let i = 0; i < W * H; i++) if (mask[i]) {
    const dx = i % W - cx, dy = ((i / W) | 0) - cy, t = dx * u.x + dy * u.y, w = dx * v.x + dy * v.y; const b = clamp(Math.floor((t - tmin) / L * NB), 0, NB - 1);
    cnt[b]++; if (w < lo[b]) lo[b] = w; if (w > hi[b]) hi[b] = w;
  }
  const bins = []; for (let b = 0; b < NB; b++) if (cnt[b]) bins.push({ t: (b + .5) / NB, w: hi[b] - lo[b] + 1, c: (hi[b] + lo[b]) / 2 });
  // fill gaps by interpolation
  return { cx, cy, u, v, L, tmin, bins, area: n, NB };
}
function fitShapes(pr) {
  const B = pr.bins, inner = B.filter(b => b.t > .06 && b.t < .94); if (inner.length < 8) return null;
  const ws = inner.map(b => b.w), mw = mean(ws), maxW = Math.max(...B.map(b => b.w));
  const rel = arr => Math.sqrt(mean(arr.map(r => r * r)));
  const eCyl = rel(ws.map(w => (w - mw) / mw));
  const ts = inner.map(b => b.t), mt = mean(ts); let sxy = 0, sxx = 0; inner.forEach(b => { sxy += (b.t - mt) * (b.w - mw); sxx += (b.t - mt) ** 2; });
  const slope = sxy / sxx, icpt = mw - slope * mt; const eFr = rel(inner.map(b => (b.w - (icpt + slope * b.t)) / mw));
  const eEll = rel(B.map(b => (b.w - maxW * Math.sqrt(Math.max(0, 1 - (2 * b.t - 1) ** 2))) / maxW));
  const cands = [
    { k: "cyl", n: "ทรงกระบอก", e: eCyl },
    { k: "frustum", n: "กรวยตัด", e: Math.abs(slope) / mw > .08 ? eFr : eFr + .03 },
    { k: "ellipsoid", n: "ทรงรี", e: eEll },
    { k: "rev", n: "ทรงหมุนรอบแกน (หั่นชั้น)", e: .055 }
  ].map(c => ({ ...c, fit: clamp(100 * (1 - c.e / .15), 0, 100) })).sort((a, b) => a.e - b.e);
  const cs = B.map(b => b.c); const asym = (Math.max(...cs) - Math.min(...cs)) / pr.L; const cstd = Math.sqrt(mean(cs.map(c => (c - mean(cs)) ** 2))) / mw;
  return { cands, best: cands[0].k, slope, icpt, mw, maxW, curved: asym > .1, asym: cstd, eCyl, eFr, eEll };
}
// widths per slice in mm from a profile and a scale
function slices(pr, s, NB = 100, edgeBias = 0, noise = 0, lenJit = 0) {
  const B = pr.bins; const out = []; const L = (pr.L + lenJit) * s;
  for (let i = 0; i < NB; i++) {
    const t = (i + .5) / NB; let k = 0; while (k < B.length - 1 && B[k + 1].t < t) k++;
    let w; if (t <= B[0].t) w = B[0].w; else if (t >= B[B.length - 1].t) w = B[B.length - 1].w; else { const a = B[k], b = B[k + 1]; w = a.w + (b.w - a.w) * (t - a.t) / (b.t - a.t); }
    out.push(Math.max(0, (w + 2 * edgeBias + noise * rn()) * s));
  }
  // centerline arc length
  let arc = 0; for (let k = 1; k < B.length; k++) arc += Math.hypot((B[k].t - B[k - 1].t) * pr.L, B[k].c - B[k - 1].c); arc *= s;
  return { w: out, L, arc, dz: L / NB };
}

/* ======================= measurement core ======================= */
function measureManual(it, M, k) {
  const P = it.pts, T = it.tool, tp = M.toPlane, out = [];
  const L = (lb, v) => out.push({ lb, v: v * k, u: "มม." }), A = (lb, v) => out.push({ lb, v: v * k * k, u: "มม.²" }), V = (lb, v) => out.push({ lb, v: v * k * k * k / 1000, u: "มล." }), D = (lb, v) => out.push({ lb, v, u: "°" });
  if (T === "dist") L("ระยะ", dist(tp(P[0]), tp(P[1])));
  else if (T === "poly") { let s = 0; for (let i = 1; i < P.length; i++) s += dist(tp(P[i - 1]), tp(P[i])); L("ความยาวตามเส้น", s); }
  else if (T === "area") { const q = P.map(tp); let a = 0, p = 0; for (let i = 0; i < q.length; i++) { const j = (i + 1) % q.length; a += q[i].x * q[j].y - q[j].x * q[i].y; p += dist(q[i], q[j]); } A("พื้นที่", Math.abs(a) / 2); L("เส้นรอบรูป", p); }
  else if (T === "angle") { const a = tp(P[0]), o = tp(P[1]), b = tp(P[2]); const u = sub(a, o), v = sub(b, o); D("มุม", Math.acos(clamp((u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)), -1, 1)) * R2D); }
  else if (T === "cyl") {
    const s = M.sIso(mid(P[0], P[3])), wT = dist(P[0], P[1]), wB = dist(P[2], P[3]), cT = mid(P[0], P[1]), cB = mid(P[2], P[3]);
    const ax = sub(cB, cT), al = Math.hypot(ax.x, ax.y), minor = Math.abs((P[4].x - cT.x) * ax.x / al + (P[4].y - cT.y) * ax.y / al);
    const phi = Math.asin(clamp(2 * minor / wT, 0, .999)), D1 = wT * s, D2 = wB * s, Hh = al * s / Math.cos(phi);
    L("เส้นผ่านศูนย์กลางบน", D1); L("เส้นผ่านศูนย์กลางล่าง", D2); L("ความสูง", Hh); D("มุมกล้องมองลง", phi * R2D);
    const r1 = D1 / 2, r2 = D2 / 2, sl = Math.hypot(Hh, r1 - r2); V("ปริมาตร", Math.PI * Hh * (r1 * r1 + r1 * r2 + r2 * r2) / 3); A("พื้นที่ผิวรวม", Math.PI * (r1 + r2) * sl + Math.PI * (r1 * r1 + r2 * r2));
  } else if (T === "box") {
    const s = M.sIso(P[0]), v = [sub(P[1], P[0]), sub(P[2], P[0]), sub(P[3], P[0])], d = (i, j) => v[i].x * v[j].x + v[i].y * v[j].y;
    const ab = d(0, 1), ac = d(0, 2), bc = d(1, 2); let z = null; if (ab < 0 && ac < 0 && bc < 0) { const za = Math.sqrt(-ab * ac / bc); z = [za, -ab / za, -ac / za]; }
    const l = v.map((w, i) => Math.hypot(w.x, w.y, z ? z[i] : 0) * s);
    L("ด้านยาว", l[0]); L("ด้านกว้าง", l[1]); L("ด้านสูง", l[2]); V("ปริมาตร", l[0] * l[1] * l[2]); A("พื้นที่ผิว", 2 * (l[0] * l[1] + l[1] * l[2] + l[0] * l[2])); out.depthOK = !!z;
  } else if (T === "sphere") {
    const e = fitEllipse(P); if (!e) return out; const s = M.sIso({ x: e.cx, y: e.cy }), a = e.a * s, b = e.b * s, c = b;
    L("แกนยาว", 2 * a); L("แกนสั้น", 2 * b); L("แกนลึก (สมมติ = แกนสั้น)", 2 * c); V("ปริมาตร", 4 / 3 * Math.PI * a * b * c);
    const p = 1.6075; A("พื้นที่ผิว", 4 * Math.PI * (((a * b) ** p + (a * c) ** p + (b * c) ** p) / 3) ** (1 / p));
  }
  return out;
}
function measureObj(it, s1, s2, jit) {
  // s1: scale front (mm/px), s2: scale side or null. jit: perturbation
  const j = jit || { e1: 0, e2: 0, n: 0, l1: 0, l2: 0 };
  const A = slices(it.pr, s1, 100, j.e1, j.n, j.l1);
  const out = []; const L = (lb, v) => out.push({ lb, v, u: "มม." }), Ar = (lb, v) => out.push({ lb, v, u: "มม.²" }), V = (lb, v) => out.push({ lb, v: v / 1000, u: "มล." }), N = (lb, v, u = "") => out.push({ lb, v, u });
  const shape = it.shape || it.fit.best; const w = A.w, dz = A.dz, n = w.length;
  const wi = w.slice(6, n - 6), dMean = mean(wi), dMax = Math.max(...w), dMin = Math.min(...wi);
  let Bw = null, Lside = null;
  if (it.side && it.side.pr && s2) { const Bs = slices(it.side.pr, s2, 100, j.e2, j.n, j.l2); Bw = Bs.w; Lside = Bs.L; }
  const Lm = Lside ? (A.L + Lside) / 2 : A.L;
  L("ความยาวตามแกน", Lm);
  if (it.fit.curved) L("ความยาวตามแนวโค้งกลาง", A.arc);
  L("ความกว้างมากสุด (ด้านหน้า)", dMax); L("ความกว้างเฉลี่ย (ด้านหน้า)", dMean);
  for (const q of [.25, .5, .75]) L(`ความกว้างที่ ${q * 100}% ของแกน`, w[Math.floor(q * n)]);
  if (Bw) {
    const bi = Bw.slice(6, n - 6); L("ความกว้างเฉลี่ย (ด้านข้าง)", mean(bi));
    const g = w.map((a, i) => ramanujan(a / 2, Bw[i] / 2)); L("รอบวงที่ 50% ของแกน", g[Math.floor(n / 2)]); L("รอบวงมากสุด", Math.max(...g.slice(3, n - 3)));
    let vol = 0, srf = 0; for (let i = 0; i < n; i++) { vol += Math.PI * (w[i] / 2) * (Bw[i] / 2) * (Lm / n); srf += g[i] * (Lm / n); }
    V("ปริมาตร (หน้าตัดวงรีจาก 2 มุม)", vol); Ar("พื้นที่ผิวด้านข้าง", srf); N("หน้าตัด ด้านหน้า ÷ ด้านข้าง", mean(wi) / mean(bi));
    out.mode = "2view";
  } else {
    const g = w.map(a => Math.PI * a); L("รอบวงที่ 50% (สมมติหน้าตัดกลม)", g[Math.floor(n / 2)]);
    let vRev = 0, sRev = 0; for (let i = 0; i < n; i++) { vRev += Math.PI * (w[i] / 2) ** 2 * dz; const dr = i ? (w[i] - w[i - 1]) / 2 : 0; sRev += Math.PI * w[i] * Math.hypot(dz, dr); }
    let vol, srf;
    if (shape === "cyl") { vol = Math.PI * dMean * dMean / 4 * Lm; srf = Math.PI * dMean * Lm + Math.PI * dMean * dMean / 2; }
    else if (shape === "frustum") { const r1 = (it.fit.icpt) * s1 / 2, r2 = (it.fit.icpt + it.fit.slope) * s1 / 2; vol = Math.PI * Lm * (r1 * r1 + r1 * r2 + r2 * r2) / 3; srf = Math.PI * (r1 + r2) * Math.hypot(Lm, r1 - r2) + Math.PI * (r1 * r1 + r2 * r2); }
    else if (shape === "ellipsoid") { const a = Lm / 2, b = dMax / 2, p = 1.6075; vol = 4 / 3 * Math.PI * a * b * b; srf = 4 * Math.PI * (((a * b) ** p * 2 + (b * b) ** p) / 3) ** (1 / p); }
    else if (shape === "box") { vol = Lm * dMean * dMean; srf = 2 * (Lm * dMean * 2 + dMean * dMean); }
    else { vol = vRev; srf = sRev; }
    V("ปริมาตร (" + SHAPE_N[shape] + ")", vol); Ar("พื้นที่ผิว (" + SHAPE_N[shape] + ")", srf);
    if (shape !== "rev") V("ปริมาตรแบบหั่นชั้น (เทียบ)", vRev);
    out.mode = "1view";
  }
  if (Lside) N("ความยาวด้านหน้า ÷ ด้านข้าง", A.L / Lside);
  return out;
}
const SHAPE_N = { cyl: "ทรงกระบอก", frustum: "กรวยตัด", ellipsoid: "ทรงรี", rev: "หั่นชั้น", box: "แท่งเหลี่ยม" };

/* ======================= evaluate one image ======================= */
function imgModel(im) {
  if (!im) return null; const def = REF[SET.refType];
  if (im.refPts.length < def.need) return { err: `วางจุดมาตราวัดให้ครบ (${im.refPts.length}/${def.need})` };
  const sz = refSize(); const P = im.refPts.slice(0, def.kind === "line" ? 2 : def.need);
  const lens0 = lensInfo(im); const fGuess = lens0.fpx || 26 * Math.hypot(im.W, im.H) / 43.27;
  const M = buildMapper(im, P, sz, { f: fGuess }); if (!M) return { err: "คำนวณจากจุดมาตราวัดไม่ได้ ลองวางใหม่" };
  const cam = cameraModel(im, P, M);
  const c0 = def.kind === "rect" ? mid(mid(P[0], P[1]), mid(P[2], P[3])) : def.kind === "circle" ? { x: M.ell.cx, y: M.ell.cy } : mid(P[0], P[1]);
  const s0 = M.sIso(c0), Z = cam.f * s0;
  const refPx = def.kind === "line" ? dist(P[0], P[1]) : def.kind === "circle" ? 2 * M.ell.a : dist(P[0], P[1]);
  const relRef = hyp(sz.sd / sz.a, 1.5 * Math.SQRT2 / refPx);
  return { M, cam, P, sz, c0, s0, Z, refPx, relRef, check: refCheck(im, M), def };
}
function evaluateAll() {
  for (const im of S.imgs) im.model = imgModel(im);
  for (const it of S.items) {
    it.res = null; const im = imgById(it.imgId), md = im && im.model; if (!md || md.err) continue;
    if (it.tool === "obj") { evalObj(it, im, md); continue; }
    const need = TOOLS[it.tool].need; if ((need === "var" && (!it.closed || it.pts.length < TOOLS[it.tool].min)) || (need !== "var" && it.pts.length < need)) continue;
    const d0 = (it.depth || 0) * 10, ds = (it.depthSd || 0) * 10, Z = md.Z, k0 = (Z - d0) / Z;
    const base = measureManual(it, md.M, k0); if (!base.length) continue;
    const lens = md.cam.lens, dg = Math.hypot(im.W, im.H);
    const sig = p => { const r = Math.hypot(p.x - im.W / 2, p.y - im.H / 2) / (dg / 2); return hyp(p.snapped ? .7 : 1.6, lens.distK * r * r * dg * .5); };
    const jp = pts => pts.map(p => { const s = sig(p); return { x: p.x + rn() * s, y: p.y + rn() * s, snapped: p.snapped }; });
    const acc = base.map(() => []); const rel = md.sz.sd / md.sz.a;
    for (let n = 0; n < 300; n++) {
      const sz = { a: md.sz.a * (1 + rel * rn()), b: md.sz.b ? md.sz.b * (1 + rel * rn()) : undefined };
      const f2 = md.cam.f * (1 + md.cam.frel * rn()); const M2 = buildMapper(im, jp(md.P), sz, { f: f2, jb: rn(), jg: rn() }); if (!M2) continue;
      const Z2 = f2 * M2.sIso(md.c0), d2 = d0 + ds * rn(); const v = measureManual({ ...it, pts: jp(it.pts) }, M2, (Z2 - d2) / Z2);
      v.forEach((o, i) => { if (isFinite(o.v)) acc[i].push(o.v); });
    }
    base.forEach((o, i) => { o.sd = sdOf(acc[i]); });
    const src = [];
    const one = (name, fn) => { const vals = []; for (let n = 0; n < 80; n++) { const r = fn(); if (r && r[0] && isFinite(r[0].v)) vals.push(r[0].v); } const s = sdOf(vals); if (s != null) src.push({ name, rel: s / Math.abs(base[0].v || 1) }); };
    one("ตำแหน่งจุดของวัตถุ", () => measureManual({ ...it, pts: jp(it.pts) }, md.M, k0));
    one("ตำแหน่งจุดมาตราวัด", () => { const M2 = buildMapper(im, jp(md.P), md.sz, { f: md.cam.f }); return M2 && measureManual(it, M2, k0); });
    one("ขนาดจริงของมาตราวัด", () => { const M2 = buildMapper(im, md.P, { a: md.sz.a * (1 + rel * rn()), b: md.sz.b }, { f: md.cam.f }); return M2 && measureManual(it, M2, k0); });
    if (ds > 0) one("ระยะลึกจากมาตราวัด", () => measureManual(it, md.M, (Z - (d0 + ds * rn())) / Z));
    src.sort((a, b) => b.rel - a.rel);
    it.res = { vals: base, src, depthOK: base.depthOK !== false };
  }
}
function evalObj(it, im, md) {
  if (!it.seg || !it.pr || !it.fit) return;
  let s2 = null, md2 = null;
  if (it.side && it.side.pr) { const im2 = imgById(it.side.imgId); md2 = im2 && im2.model; if (md2 && !md2.err) s2 = md2.s0; }
  const d0 = (it.depth || 0) * 10, ds = (it.depthSd || 0) * 10;
  const sc = (md, c, d) => md.M.sIso(c) * (md.Z - d) / md.Z;
  const c1 = { x: it.pr.cx, y: it.pr.cy }; const S1 = sc(md, c1, d0); const S2 = s2 ? sc(md2, { x: it.side.pr.cx, y: it.side.pr.cy }, d0) : null;
  const base = measureObj(it, S1, S2);
  const acc = base.map(() => []);
  const r1 = md.relRef, r2 = md2 ? md2.relRef : 0;
  for (let n = 0; n < 200; n++) {
    const dd = d0 + ds * rn(); const f1 = 1 + r1 * rn(); const f2 = 1 + r2 * rn();
    const s1 = md.M.sIso(c1) * f1 * (md.Z - dd) / md.Z; const ss2 = S2 ? md2.M.sIso({ x: it.side.pr.cx, y: it.side.pr.cy }) * f2 * (md2.Z - dd) / md2.Z : null;
    const v = measureObj(it, s1, ss2, { e1: rn() * 1.2, e2: rn() * 1.2, n: .8, l1: rn() * 2.1, l2: rn() * 2.1 });
    v.forEach((o, i) => { if (isFinite(o.v)) acc[i].push(o.v); });
  }
  base.forEach((o, i) => { o.sd = sdOf(acc[i]); });
  const src = [];
  const vRef = []; for (let n = 0; n < 60; n++) vRef.push(measureObj(it, S1 * (1 + r1 * rn()), S2)[0].v);
  const vEdge = []; for (let n = 0; n < 60; n++) vEdge.push(measureObj(it, S1, S2, { e1: rn() * 1.2, e2: rn() * 1.2, n: .8, l1: rn() * 2.1, l2: rn() * 2.1 })[0].v);
  src.push({ name: "มาตราวัด (ขนาดและตำแหน่งจุด)", rel: sdOf(vRef) / base[0].v }, { name: "ขอบวัตถุจากการแยกภาพ", rel: sdOf(vEdge) / base[0].v });
  if (ds > 0) { const vd = []; for (let n = 0; n < 60; n++) { const dd = d0 + ds * rn(); vd.push(measureObj(it, md.M.sIso(c1) * (md.Z - dd) / md.Z, S2)[0].v); } src.push({ name: "ระยะลึกจากมาตราวัด", rel: sdOf(vd) / base[0].v }); }
  src.sort((a, b) => b.rel - a.rel);
  it.res = { vals: base, src };
}

/* ======================= tasks ======================= */
function setTask(t) {
  S.task = t; const el = $("task");
  $("done").hidden = !(t && t.type === "item" && TOOLS[t.item.tool].need === "var");
  $("segCtl").hidden = !(t && t.type === "item" && t.item.tool === "obj") && !(S.selObj);
  if (!t) { el.innerHTML = curImg() ? "เลือกเครื่องมือวัด หรือลากจุดที่วางแล้วเพื่อปรับ" : "ถ่ายภาพหรือเลือกภาพที่มีวัตถุมาตราวัดอยู่ใกล้วัตถุที่จะวัด"; return; }
  if (t.type === "ref") { const d = REF[SET.refType], n = t.img.refPts.length; el.innerHTML = `<b>มาตราวัด ${Math.min(n, d.max || d.need)}/${d.max || d.need}${d.max && n >= d.need ? " (ครบแล้ว จุดที่เหลือไม่บังคับ)" : ""}</b> · ${d.hint}`; return; }
  if (t.type === "item") {
    const it = t.item, T = TOOLS[it.tool];
    if (it.tool === "obj") el.innerHTML = t.side ? `<b>#${it.id} ภาพด้านข้าง</b> · แตะที่วัตถุเดียวกันในภาพนี้ (ต้องวางมาตราวัดในภาพนี้ด้วย)` : `<b>#${it.id} ${T.n}</b> · ${T.hint}`;
    else el.innerHTML = `<b>${T.n} #${it.id} · ${it.pts.length}${T.need === "var" ? "" : "/" + T.need}</b> · ${T.hint}`;
  }
}
async function runSeg(it, side) {
  const tgt = side ? it.side : it; const im = imgById(tgt.imgId); if (!im) return;
  $("task").innerHTML = "<b>กำลังแยกวัตถุ…</b>";
  await new Promise(r => setTimeout(r, 20));
  tgt.seg = segment(im, tgt.seeds, tgt.tol); tgt.overlay = null;
  tgt.pr = profileOf(im, tgt.seg.mask);
  if (!side) { it.fit = tgt.pr ? fitShapes(tgt.pr) : null; if (!it.shape && it.fit) it.shapeAuto = it.fit.best; }
  setTask(S.task); renderAll();
}

/* ======================= rendering ======================= */
function renderChips() {
  const b = $("imgChips"); b.innerHTML = "";
  S.imgs.forEach((im, i) => {
    const c = document.createElement("button"); c.className = "chip"; c.setAttribute("aria-pressed", i === S.cur);
    c.textContent = `${i + 1}. ${im.inApp ? "กล้อง" : (im.name.length > 12 ? im.name.slice(0, 10) + "…" : im.name)}${im.refPts.length >= REF[SET.refType].need ? "" : " ⚠"}`;
    c.onclick = () => { S.cur = i; S.view = { z: 1, ox: 0, oy: 0 }; setTask(im.refPts.length < REF[SET.refType].need ? { type: "ref", img: im } : null); renderAll(); };
    b.appendChild(c);
  });
  if (S.imgs.length) { const d = document.createElement("button"); d.className = "chip"; d.textContent = "ลบภาพนี้"; d.onclick = () => { const im = curImg(); S.items = S.items.filter(x => x.imgId !== im.id); S.items.forEach(x => { if (x.side && x.side.imgId === im.id) x.side = null; }); S.imgs.splice(S.cur, 1); S.cur = S.imgs.length - 1; setTask(null); renderAll(); }; b.appendChild(d); }
}
function renderRefPanel() {
  const t = SET.refType; $("refType").value = t; $("refName").textContent = REF[t].name();
  const show = (id, v) => $(id).hidden = !v;
  show("lA", t === "rect" || t === "circle" || t === "line"); show("lB", t === "rect"); show("lS", t !== "card" && t !== "a4" && t !== "nail");
  $("lA").firstChild.textContent = t === "circle" ? "เส้นผ่านศูนย์กลาง (มม.)" : t === "line" ? "ความยาว (มม.)" : "กว้าง (มม.)";
  if (t === "rect") { $("refA").value = SET.rect.a; $("refB").value = SET.rect.b; $("refS").value = SET.rect.sd; }
  if (t === "circle") { $("refA").value = SET.circle.d; $("refS").value = SET.circle.sd; }
  if (t === "line") { $("refA").value = SET.line.L; $("refS").value = SET.line.sd; }
  $("refHint").textContent = REF[t].hint + (t === "nail" ? ` · ใช้ค่าจากหน้าตั้งค่า: กว้าง ${SET.nail.w} ± ${SET.nail.sd} มม., ยาว ${SET.nail.len} มม.` : "");
  const im = curImg(); const g = $("gyroPlane"); g.hidden = !(im && im.gyro && REF[t].kind === "line"); if (im) g.setAttribute("aria-pressed", !!im.gyroPlane);
}
function itemCard(it) {
  const T = TOOLS[it.tool]; const im = imgById(it.imgId); const md = im && im.model;
  let h = `<div class="item"><div class="item-h"><b>#${it.id} ${T.n}</b><div class="row">`;
  h += `<button class="chip" data-save="${it.id}">บันทึก</button><button class="chip" data-del="${it.id}">ลบ</button></div></div>`;
  h += `<div class="fgrid"><label class="f">ชื่อการวัด (ใช้จัดกลุ่มในประวัติ)<input type="text" value="${(it.label || "").replace(/"/g, "&quot;")}" data-label="${it.id}" placeholder="เช่น วัตถุ A"></label>
    <label class="f">ใกล้กล้องกว่ามาตราวัด (ซม.)<input type="number" step="0.5" value="${it.depth || 0}" data-depth="${it.id}"></label>
    <label class="f">± ระยะนี้ (ซม.)<input type="number" step="0.5" min="0" value="${it.depthSd ?? 0.5}" data-dsd="${it.id}"></label></div>`;
  if (it.tool === "obj" && it.fit) {
    const f = it.fit, cur = it.shape || f.best;
    h += `<div class="row">${f.cands.map(c => `<button class="chip" data-shape="${it.id}:${c.k}" aria-pressed="${c.k === cur}">${c.n} ${fmt(c.fit, 0)}%</button>`).join("")}<button class="chip" data-shape="${it.id}:box" aria-pressed="${cur === "box"}">แท่งเหลี่ยม</button></div>`;
    const warn = [];
    if (it.seg.touches) warn.push("พื้นที่ที่แยกได้แตะขอบภาพ วัตถุอาจล้นเฟรมหรือรั่วไปพื้นหลัง");
    if (f.curved) warn.push("วัตถุโค้ง: ใช้ 'ความยาวตามแนวโค้งกลาง' แทนความยาวตามแกนตรง ความกว้างแต่ละชั้นอาจเพี้ยนเล็กน้อย");
    if (f.asym > .08) warn.push("ซ้าย–ขวาไม่สมมาตร: การสมมติหน้าตัดกลมอาจคลาดมาก ควรเพิ่มภาพด้านข้าง");
    if (f.cands[0].fit < 50 && !it.side) warn.push("รูปทรงไม่เข้ากับทรงสำเร็จรูปใด ใช้แบบหั่นชั้นแทน และควรเพิ่มภาพด้านข้าง");
    if (warn.length) h += `<p class="muted" style="margin:0;color:var(--amber)">${warn.join("<br>")}</p>`;
    h += `<div class="row">${it.side ? `<span class="tag ok">มีภาพด้านข้างแล้ว</span><button class="chip" data-side="${it.id}">เปลี่ยนภาพด้านข้าง</button>` : `<button class="btn" data-side="${it.id}">+ เพิ่มภาพด้านข้าง 90° (วัดรอบวงจริง)</button>`}
      <button class="chip" data-reseg="${it.id}">แตะเพิ่มส่วนที่ขาด</button></div>`;
  }
  if (!md || md.err) h += `<p class="muted" style="margin:0;color:var(--bad)">${md ? md.err : ""}</p>`;
  else if (!it.res) h += `<p class="muted" style="margin:0">${it.tool === "obj" ? (it.seeds && it.seeds.length ? "ยังแยกวัตถุไม่ได้ ลองแตะใหม่หรือปรับความไว" : "แตะที่วัตถุในภาพ") : "วางจุดให้ครบก่อน"}</p>`;
  else {
    h += `<div class="tbl-wrap"><table><thead><tr><th>ค่า</th><th class="n">ผล</th><th class="n">± 1σ</th><th class="n">±%</th></tr></thead><tbody>${it.res.vals.map(o => `<tr><td>${o.lb}</td><td class="n">${fmt(o.v, o.u === "" ? 3 : o.v >= 100 ? 1 : 2)} ${o.u}</td><td class="n">${o.sd != null ? fmt(o.sd, o.sd >= 10 ? 1 : 2) : "—"}</td><td class="n">${o.sd != null && o.v ? fmt(o.sd / Math.abs(o.v) * 100, 1) : "—"}</td></tr>`).join("")}</tbody></table></div>`;
    if (it.res.src.length) h += `<p class="muted" style="margin:0">ความคลาดของค่าแรกมาจาก: ${it.res.src.map(s => `${s.name} ${fmt(s.rel * 100, 1)}%`).join(" · ")}</p>`;
    h += `<p class="muted" style="margin:0"><b>ส่วนที่ภาพไม่มี:</b> ${hiddenText(it)}</p>`;
  }
  return h + `</div>`;
}
function hiddenText(it) {
  const T = it.tool;
  if (T === "obj") {
    const two = it.side && it.res && it.res.vals.mode === "2view";
    return two ? "ใช้ 2 มุม: หน้าตัดถูกประมาณเป็นวงรีจากความกว้างด้านหน้าและด้านข้าง ส่วนเว้าที่ทั้งสองมุมมองไม่เห็นจะไม่ถูกนับ และถ้าวัตถุเปลี่ยนรูประหว่างสองภาพ ค่าจะคลาด"
      : "ใช้มุมเดียว: ความลึกของวัตถุไม่มีในภาพ ระบบสมมติว่าหน้าตัดเป็นวงกลม (หรือเท่ากับความกว้างสำหรับแท่งเหลี่ยม) ด้านหลังถูกสมมติว่าสมมาตรกับด้านหน้า ถ้าแกนวัตถุเอียงเข้าหาหรือออกจากกล้อง ความยาวจะสั้นกว่าจริง";
  }
  return { dist: "วัดเป็นเส้นตรงบนระนาบของมาตราวัด ความนูนของผิวหายไป", poly: "ระหว่างจุดเป็นเส้นตรง แตะถี่ขึ้นเพื่อเก็บส่วนโค้ง", area: "เป็นพื้นที่ภาพฉาย ถ้าผิวโค้ง พื้นที่จริงจะมากกว่า", angle: "เป็นมุมบนระนาบมาตราวัด", cyl: "ครึ่งหลังและก้นถูกบัง สมมติหน้าตัดกลม ผนังตรง", box: "3 หน้าด้านหลังถูกบัง สมมติทุกมุมเป็นมุมฉาก", sphere: "แกนลึกไม่มีในภาพ สมมติเท่าแกนสั้น" }[T];
}
function renderAll() {
  evaluateAll(); renderChips(); renderRefPanel();
  const im = curImg();
  // items for current image (plus objects whose side view is current)
  const list = S.items.filter(it => im && (it.imgId === im.id || (it.side && it.side.imgId === im.id)));
  let h = `<h2>ผลการวัด <small>± คือ 1σ จาก Monte Carlo</small></h2>`;
  h += list.length ? list.map(itemCard).join("") : `<p class="muted" style="margin:0">${im ? "เลือกเครื่องมือวัดด้านบน" : "ยังไม่มีภาพ"}</p>`;
  $("outItems").innerHTML = h;
  // reference / camera
  const md = im && im.model;
  h = `<h2>มาตราวัดและมุมกล้อง</h2>`;
  if (!im) h += `<p class="muted" style="margin:0">—</p>`;
  else if (!md || md.err) h += `<p class="muted" style="margin:0">${md ? md.err : ""}</p>`;
  else {
    const c = md.cam, p = c.pose || {};
    h += `<div class="statrow"><div class="stat"><div class="v">${fmt(1 / md.s0, 2)}</div><div class="t">px ต่อ มม.</div></div><div class="stat"><div class="v">${fmt(md.Z / 10, 0)}</div><div class="t">ซม. ระยะกล้อง</div></div><div class="stat"><div class="v">${p.tilt != null ? fmt(p.tilt, 1) + "°" : p.gyroTilt != null ? fmt(p.gyroTilt, 1) + "°" : "—"}</div><div class="t">${p.tilt != null ? "ระนาบเอียงจากหน้ากล้อง" : p.gyroTilt != null ? "กล้องเอียงจากแนวดิ่ง (ไจโร)" : "มุมเอียง"}</div></div></div>`;
    h += `<dl class="kv" style="margin-top:10px"><dt>มาตราวัด</dt><dd>${REF[SET.refType].name()}</dd><dt>ความคลาดของมาตราส่วน</dt><dd>± ${fmt(md.relRef * 100, 1)}%</dd>
      <dt>ระยะโฟกัส</dt><dd>${fmt(c.f, 0)} px · ${c.fsrc}</dd>
      ${p.pitch != null ? `<dt>ก้ม/เงย · หันซ้าย/ขวา</dt><dd>${fmt(p.pitch, 1)}° · ${fmt(p.yaw, 1)}°</dd><dt>มุมฉากของสี่เหลี่ยม (0 = ดี)</dt><dd>${fmt(p.skew, 3)}</dd>` : ""}
      ${im.gyro ? `<dt>ไจโรตอนถ่าย (β, γ)</dt><dd>${fmt(im.gyro.beta, 1)}°, ${fmt(im.gyro.gamma, 1)}°</dd>` : ""}
      ${im.gyroPlane ? `<dt>แก้ระนาบพื้นราบ</dt><dd>ใช้ไจโร</dd>` : ""}
      ${md.check ? `<dt>เล็บ ยาว÷กว้าง ในภาพ / ค่าจริง</dt><dd>${fmt(md.check.meas, 2)} / ${fmt(md.check.exp, 2)}</dd>` : ""}</dl>`;
    if (md.check && Math.abs(md.check.ratio - 1) > .12) h += `<p class="muted" style="margin:6px 0 0;color:var(--amber)">สัดส่วนเล็บในภาพต่างจากค่าจริง ${fmt((md.check.ratio - 1) * 100, 0)}% เล็บอาจเอียงจากหน้ากล้อง หรือค่าความยาวเล็บในตั้งค่าคลาด ผลวัดอาจคลาดเพิ่ม</p>`;
  }
  $("outRef").innerHTML = h;
  // lens
  h = `<h2>กล้องและเลนส์</h2>`;
  if (im) {
    const e = im.exif, l = lensInfo(im);
    const rows = [["อุปกรณ์", [e.make, e.model].filter(Boolean).join(" ") || (im.inApp ? "กล้องในแอป" : null)], ["เลนส์ (EXIF)", e.lens], ["ระยะโฟกัสจริง", e.f ? fmt(e.f, 2) + " มม." : null], ["เทียบ 35 มม.", l.f35 ? l.f35 + " มม." + (e.f35 ? "" : " (ค่าตั้งค่า)") : null],
      ["ประเภทเลนส์", l.cls], ["มุมรับภาพทแยง", l.fov ? fmt(l.fov, 0) + "°" : null], ["ซูมดิจิทัล", e.dzoom ? fmt(e.dzoom, 2) + "×" : null], ["รูรับแสง", e.fnum ? "f/" + fmt(e.fnum, 2) : null],
      ["ชัตเตอร์", e.exp ? (e.exp < 1 ? "1/" + Math.round(1 / e.exp) : fmt(e.exp, 1)) + " วิ" : null], ["ISO", e.iso], ["ระยะวัตถุที่กล้องบันทึก", e.subjDist ? fmt(e.subjDist, 2) + " ม." : null],
      ["ขนาดภาพต้นฉบับ", im.W0 + " × " + im.H0 + " px"], ["ซอฟต์แวร์แก้ไขภาพ", e.software], ["วันที่ถ่าย", e.date]];
    h += `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v == null || v === "" ? '<span style="color:var(--muted)">ไม่มี</span>' : v}</dd>`).join("")}</dl>`;
    const nE = Object.keys(e).length;
    h += `<p class="muted" style="margin:8px 0 0">EXIF ${nE ? nE + " ฟิลด์" : "<b style='color:var(--amber)'>ไม่มี</b>" + (im.inApp ? " (ปกติของภาพจากกล้องในแอป ใช้ค่าตั้งค่าและไจโรแทน)" : " (ภาพอาจผ่านแอปแชตหรือโซเชียล)")} · จุดเด่นที่ track ได้ ${im.corners} จุด · จุดที่วางในภาพนี้ ${countPts(im)} จุด ดูดเข้ามุม/ขอบ ${countPts(im, true)} จุด · ประมวลผลด้วย ${im.featEngine}</p>`;
  } else h += `<p class="muted" style="margin:0">—</p>`;
  $("outLens").innerHTML = h;
  // losses
  h = `<h2>ข้อมูลที่หายไปและสิ่งที่ต้องสมมติ</h2>`;
  if (im && md && !md.err) {
    const l = md.cam.lens, L = [];
    L.push(["ความลึก (แกน Z)", "ภาพเดียวไม่มีระยะของแต่ละจุด ระบบรู้ได้เฉพาะบนระนาบมาตราวัดและในรูปทรงที่สมมติไว้ ภาพด้านข้างช่วยเติมมิติที่ขาดได้"]);
    L.push(["มาตราส่วนเปลี่ยนตามระยะ", `ระยะกล้อง ~${fmt(md.Z / 10, 0)} ซม. วัตถุที่อยู่ใกล้กว่ามาตราวัด 1 ซม. จะดูใหญ่ขึ้น ${fmt(10 / (md.Z - 10) * 100, 1)}% ให้กรอกระยะนี้ในแต่ละการวัด หรือวางมาตราวัดชิดวัตถุ`]);
    if (REF[SET.refType].kind === "line" && !im.gyroPlane) L.push(["มุมเอียงของระนาบ", "มาตราวัดแบบเส้น (เล็บ ไม้บรรทัด) บอกได้แค่มาตราส่วน ถ้าวัตถุเอียงจากหน้ากล้อง ความยาวจะหดตาม cos มุม ถ่ายให้หน้ากล้องขนานกับวัตถุ หรือใช้กล้องในแอปกับโหมดพื้นราบ"]);
    L.push(["ระยะโฟกัส", md.cam.fsrc]);
    L.push(["การบิดของเลนส์", `${l.cls}: ขอบภาพเลื่อนได้ราว ${fmt(l.distK * 50, 2)}% ของเส้นทแยง วางวัตถุไว้กลางภาพ`]);
    if (l.dz > 1) L.push(["ซูมดิจิทัล", `${fmt(l.dz, 2)}× รายละเอียดจริงเหลือ ~${fmt(100 / l.dz, 0)}%`]);
    if (im.exif.software) L.push(["ภาพผ่านการแก้ไข", `"${im.exif.software}" ถ้าถูกครอป ระยะโฟกัสจาก EXIF จะไม่ตรงกับภาพ`]);
    L.push(["การประมวลผลในมือถือ", "การแก้ภาพบิด ลดนอยส์ และเพิ่มความคม อาจเลื่อนขอบวัตถุ 1–3 px ระบบตรวจไม่ได้"]);
    h += `<ul class="loss">${L.map(([a, b]) => `<li><b>${a}</b><br><span>${b}</span></li>`).join("")}</ul>`;
  } else h += `<p class="muted" style="margin:0">—</p>`;
  $("outLoss").innerHTML = h;
  bindItemUI(); draw();
}
function countPts(im, snapped) { let n = 0; const add = p => { if (!snapped || p.snapped) n++; }; im.refPts.forEach(add); S.items.filter(i => i.imgId === im.id && i.pts).forEach(i => i.pts.forEach(add)); return n; }
function bindItemUI() {
  const find = id => S.items.find(i => i.id == id);
  document.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { S.items = S.items.filter(i => i.id != b.dataset.del); setTask(null); renderAll(); });
  document.querySelectorAll("[data-label]").forEach(i => i.onchange = () => { find(i.dataset.label).label = i.value.trim(); });
  document.querySelectorAll("[data-depth]").forEach(i => i.onchange = () => { find(i.dataset.depth).depth = parseFloat(i.value) || 0; renderAll(); });
  document.querySelectorAll("[data-dsd]").forEach(i => i.onchange = () => { find(i.dataset.dsd).depthSd = Math.max(0, parseFloat(i.value) || 0); renderAll(); });
  document.querySelectorAll("[data-shape]").forEach(b => b.onclick = () => { const [id, k] = b.dataset.shape.split(":"); find(id).shape = k; renderAll(); });
  document.querySelectorAll("[data-reseg]").forEach(b => b.onclick = () => { const it = find(b.dataset.reseg); S.cur = S.imgs.findIndex(x => x.id === it.imgId); S.selObj = it; setTask({ type: "item", item: it }); renderAll(); });
  document.querySelectorAll("[data-side]").forEach(b => b.onclick = () => { const it = find(b.dataset.side); S.pendingSide = it; $("task").innerHTML = "<b>ภาพด้านข้าง</b> · ถ่ายหรือเลือกภาพวัตถุเดิมจากมุมที่หมุนไป 90° โดยมีมาตราวัดอยู่ในภาพด้วย"; window.scrollTo({ top: 0, behavior: "smooth" }); });
  document.querySelectorAll("[data-save]").forEach(b => b.onclick = () => { const it = find(b.dataset.save); if (saveHistory(it)) { b.textContent = "บันทึกแล้ว"; b.disabled = true; } else b.textContent = "บันทึกไม่ได้"; });
}

/* ======================= viewer ======================= */
const cv = $("cv"), vx = cv.getContext("2d");
const fitS = im => cv.width / im.W;
const toImg = (im, sx, sy) => { const s = fitS(im) * S.view.z; return { x: sx / s + S.view.ox, y: sy / s + S.view.oy }; };
function sizeCv() { const im = curImg(), w = $("viewer").clientWidth || 360, dpr = Math.min(2, window.devicePixelRatio || 1); let ch = im ? w * im.H / im.W : w * .75; ch = Math.min(ch, window.innerHeight * .62); cv.width = Math.round(w * dpr); cv.height = Math.round(ch * dpr); cv.style.height = ch + "px"; }
function clampV(im) { const vw = im.W / S.view.z, vh = cv.height / fitS(im) / S.view.z; S.view.ox = clamp(S.view.ox, 0, Math.max(0, im.W - vw)); S.view.oy = clamp(S.view.oy, 0, Math.max(0, im.H - vh)); }
function overlayFor(im, tgt) {
  if (tgt.overlay) return tgt.overlay; const c = document.createElement("canvas"); c.width = im.W; c.height = im.H; const x = c.getContext("2d"); const d = x.createImageData(im.W, im.H);
  const col = cssv("--acc") || "#0F6E7A"; const m = /#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(col) || [0, "0f", "6e", "7a"]; const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  const mk = tgt.seg.mask; for (let i = 0; i < mk.length; i++) if (mk[i]) { d.data[i * 4] = r; d.data[i * 4 + 1] = g; d.data[i * 4 + 2] = b; d.data[i * 4 + 3] = 100; }
  x.putImageData(d, 0, 0); tgt.overlay = c; return c;
}
function draw() {
  sizeCv(); const im = curImg(), dpr = Math.min(2, window.devicePixelRatio || 1);
  vx.setTransform(1, 0, 0, 1, 0, 0); vx.fillStyle = cssv("--sunk"); vx.fillRect(0, 0, cv.width, cv.height);
  if (!im) { vx.fillStyle = cssv("--muted"); vx.font = `${14 * dpr}px ${cssv("--f-body")}`; vx.textAlign = "center"; vx.fillText("ถ่ายภาพหรือเลือกภาพเพื่อเริ่มวัด", cv.width / 2, cv.height / 2); return; }
  const s = fitS(im) * S.view.z, px = 1 / s; vx.setTransform(s, 0, 0, s, -S.view.ox * s, -S.view.oy * s); vx.drawImage(im.canvas, 0, 0);
  const acc = cssv("--acc"), amb = cssv("--amber");
  const dot = (p, c, r = 4) => { vx.fillStyle = c; vx.beginPath(); vx.arc(p.x, p.y, r * px, 0, 7); vx.fill(); vx.lineWidth = 1.3 * px; vx.strokeStyle = "#fff"; vx.stroke(); if (p.snapped) { vx.strokeStyle = c; vx.beginPath(); vx.arc(p.x, p.y, (r + 3) * px, 0, 7); vx.stroke(); } };
  const path = (P, c, close, w = 2) => { if (P.length < 2) return; vx.strokeStyle = c; vx.lineWidth = w * px; vx.beginPath(); vx.moveTo(P[0].x, P[0].y); for (const p of P.slice(1)) vx.lineTo(p.x, p.y); if (close) vx.closePath(); vx.stroke(); };
  const label = (p, t, c) => { vx.font = `600 ${12 * px}px ${cssv("--f-mono")}`; const w = vx.measureText(t).width; vx.fillStyle = c; vx.fillRect(p.x + 6 * px, p.y - 16 * px, w + 8 * px, 16 * px); vx.fillStyle = "#fff"; vx.fillText(t, p.x + 10 * px, p.y - 4 * px); };
  // reference
  const R = im.refPts, kind = REF[SET.refType].kind;
  if (kind === "rect") path(R, amb, R.length === 4, 2.4); else if (kind === "line") { path(R.slice(0, 2), amb, false, 2.4); if (R.length >= 4) path(R.slice(2, 4), amb, false, 1.6); }
  else if (kind === "circle" && R.length >= 5) { const e = fitEllipse(R); if (e) { vx.strokeStyle = amb; vx.lineWidth = 2.4 * px; vx.beginPath(); vx.ellipse(e.cx, e.cy, e.a, e.b, e.ang, 0, 7); vx.stroke(); } }
  R.forEach((p, i) => { dot(p, amb, 5); label(p, String(i + 1), amb); });
  // items
  for (const it of S.items) {
    const isSide = it.side && it.side.imgId === im.id; if (it.imgId !== im.id && !isSide) continue;
    if (it.tool === "obj") {
      const tgt = isSide ? it.side : it; if (!tgt.seg) { (tgt.seeds || []).forEach(p => dot(p, acc)); continue; }
      vx.drawImage(overlayFor(im, tgt), 0, 0);
      const pr = tgt.pr; if (pr) { const a = { x: pr.cx + pr.u.x * pr.tmin, y: pr.cy + pr.u.y * pr.tmin }, b = { x: pr.cx + pr.u.x * (pr.tmin + pr.L), y: pr.cy + pr.u.y * (pr.tmin + pr.L) }; vx.setLineDash([8 * px, 6 * px]); path([a, b], acc, false, 2); vx.setLineDash([]);
        const v0 = it.res && it.res.vals[0]; label(a, `#${it.id}${isSide ? " ข้าง" : ""}${v0 ? " " + fmt(v0.v, 1) + " มม." : ""}`, acc); }
      (tgt.seeds || []).forEach(p => dot(p, acc, 3));
      continue;
    }
    const P = it.pts, c = acc;
    if (it.tool === "area") path(P, c, it.closed); else if (it.tool === "box" && P.length > 1) { for (let i = 1; i < P.length; i++) path([P[0], P[i]], c, false); }
    else if (it.tool === "cyl") { if (P.length >= 2) path([P[0], P[1]], c); if (P.length >= 4) { path([P[2], P[3]], c); path([P[0], P[2]], c); path([P[1], P[3]], c); } }
    else if (it.tool === "sphere" && P.length >= 5) { const e = fitEllipse(P); if (e) { vx.strokeStyle = c; vx.lineWidth = 2 * px; vx.beginPath(); vx.ellipse(e.cx, e.cy, e.a, e.b, e.ang, 0, 7); vx.stroke(); } }
    else path(P, c, false);
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
cv.addEventListener("pointerdown", e => {
  const im = curImg(); if (!im) return; const sp = evPos(e), ip = toImg(im, sp.x, sp.y), s = fitS(im) * S.view.z, dpr = cv.width / cv.getBoundingClientRect().width;
  const t = S.task;
  // object tool: tap = seed
  if (t && t.type === "item" && t.item.tool === "obj") {
    const it = t.item, tgt = t.side ? it.side : it;
    if (tgt.imgId === im.id) { tgt.seeds = S.selObj === it ? [...(tgt.seeds || []), ip] : [ip]; S.selObj = it; runSeg(it, !!t.side); return; }
  }
  let best = null, bd = 1e9; for (const p of editable(im)) { const d = Math.hypot(p.x - ip.x, p.y - ip.y) * s; if (d < bd) { bd = d; best = p; } }
  if (best && bd < 22 * dpr) S.drag = { pt: best, off: { x: best.x - ip.x, y: best.y - ip.y } };
  else {
    let pts = null, need = 0;
    if (t && t.type === "ref" && t.img === im) { pts = im.refPts; need = REF[SET.refType].max || REF[SET.refType].need; }
    else if (t && t.type === "item" && t.item.imgId === im.id && t.item.tool !== "obj") { pts = t.item.pts; need = TOOLS[t.item.tool].need; }
    if (pts && (need === "var" || pts.length < need)) { const p = snapPoint(im, ip); pts.push(p); S.drag = { pt: p, off: { x: 0, y: 0 }, fresh: true }; }
    else if (S.view.z > 1) S.drag = { pan: true, start: sp, ox: S.view.ox, oy: S.view.oy }; else return;
  }
  cv.setPointerCapture(e.pointerId); draw();
});
cv.addEventListener("pointermove", e => {
  const im = curImg(); if (!S.drag || !im) return; const sp = evPos(e);
  if (S.drag.pt) { const ip = toImg(im, sp.x, sp.y); S.drag.pt.x = ip.x + S.drag.off.x; S.drag.pt.y = ip.y + S.drag.off.y; S.drag.pt.snapped = false; S.drag.moved = true; }
  else { const s = fitS(im) * S.view.z; S.view.ox = S.drag.ox - (sp.x - S.drag.start.x) / s; S.view.oy = S.drag.oy - (sp.y - S.drag.start.y) / s; clampV(im); }
  draw();
});
function endDrag() {
  const d = S.drag, im = curImg(); S.drag = null; if (!d || !d.pt) { draw(); return; }
  if (d.moved && im) Object.assign(d.pt, snapPoint(im, d.pt));
  const t = S.task;
  if (t && t.type === "ref") { const def = REF[SET.refType]; if (t.img.refPts.length >= (def.max || def.need)) setTask(null); else setTask(t); }
  else if (t && t.type === "item") { const need = TOOLS[t.item.tool].need; if (need !== "var" && t.item.pts.length >= need) { t.item.closed = true; setTask(null); } else setTask(t); }
  renderAll();
}
cv.addEventListener("pointerup", endDrag); cv.addEventListener("pointercancel", endDrag);
$("undo").onclick = () => { const t = S.task; let pts = null; if (t && t.type === "ref") pts = t.img.refPts; else if (t && t.type === "item") { if (t.item.tool === "obj") { const tg = t.side ? t.item.side : t.item; if (tg.seeds && tg.seeds.length > 1) { tg.seeds.pop(); runSeg(t.item, !!t.side); } return; } pts = t.item.pts; t.item.closed = false; } else { const im = curImg(); if (im && im.refPts.length) { pts = im.refPts; setTask({ type: "ref", img: im }); } } if (pts && pts.length) { pts.pop(); setTask(S.task); renderAll(); } };
$("done").onclick = () => { const t = S.task; if (t && t.type === "item") { t.item.closed = true; setTask(null); renderAll(); } };
$("snap").onclick = () => { SNAP = !SNAP; $("snap").setAttribute("aria-pressed", SNAP); };
const zoom = f => { const im = curImg(); if (!im) return; const c = toImg(im, cv.width / 2, cv.height / 2); S.view.z = clamp(S.view.z * f, 1, 12); const s = fitS(im) * S.view.z; S.view.ox = c.x - cv.width / 2 / s; S.view.oy = c.y - cv.height / 2 / s; clampV(im); draw(); };
$("zIn").onclick = () => zoom(1.6); $("zOut").onclick = () => zoom(1 / 1.6); $("zFit").onclick = () => { S.view = { z: 1, ox: 0, oy: 0 }; draw(); };
window.addEventListener("resize", draw);
$("tol").oninput = () => { $("tolV").textContent = $("tol").value; };
$("tol").onchange = () => { const it = S.selObj || (S.task && S.task.item); if (!it || it.tool !== "obj") return; const side = S.task && S.task.side; const tg = side ? it.side : it; tg.tol = +$("tol").value; if (tg.seeds && tg.seeds.length) runSeg(it, side); };

/* ======================= tools & reference UI ======================= */
(function () {
  const b = $("tools");
  for (const k in TOOLS) {
    const c = document.createElement("button"); c.className = "chip"; c.textContent = TOOLS[k].n;
    c.onclick = () => {
      const im = curImg(); if (!im) { setTask(null); return; }
      const it = { id: S.seq++, tool: k, imgId: im.id, pts: k === "obj" ? null : [], seeds: [], tol: +$("tol").value, depth: 0, depthSd: 0.5, closed: false, label: "" };
      S.items.push(it); S.selObj = k === "obj" ? it : null; setTask({ type: "item", item: it }); $("toolHint").textContent = TOOLS[k].hint; renderAll();
    };
    b.appendChild(c);
  }
})();
$("refBar").onclick = () => { $("refPanel").hidden = !$("refPanel").hidden; };
$("refType").onchange = () => { SET.refType = $("refType").value; saveSet(); for (const im of S.imgs) { im.refPts = []; } const im = curImg(); if (im) setTask({ type: "ref", img: im }); renderAll(); };
["refA", "refB", "refS"].forEach(id => $(id).addEventListener("change", () => {
  const t = SET.refType, a = parseFloat($("refA").value), b = parseFloat($("refB").value), s = parseFloat($("refS").value);
  if (t === "rect") SET.rect = { a: a || 100, b: b || 100, sd: s >= 0 ? s : .5 }; if (t === "circle") SET.circle = { d: a || 20, sd: s >= 0 ? s : .1 }; if (t === "line") SET.line = { L: a || 100, sd: s >= 0 ? s : .5 };
  saveSet(); renderAll();
}));
$("refPlace").onclick = () => { const im = curImg(); if (im) setTask({ type: "ref", img: im }); };
$("refClear").onclick = () => { const im = curImg(); if (im) { im.refPts = []; setTask({ type: "ref", img: im }); renderAll(); } };
$("gyroPlane").onclick = () => { const im = curImg(); if (im) { im.gyroPlane = !im.gyroPlane; renderAll(); } };

/* ======================= files ======================= */
async function handleNewImage(src, meta) {
  try {
    const im = await addImage(src, meta);
    if (S.pendingSide) { const it = S.pendingSide; S.pendingSide = null; it.side = { imgId: im.id, seeds: [], tol: it.tol }; S.selObj = it; S._afterRef = { type: "item", item: it, side: true }; }
    renderAll();
  } catch (e) { console.error(e); $("task").innerHTML = `<b style="color:var(--bad)">เปิดภาพไม่ได้</b> ลองใช้ JPG หรือ PNG`; }
}
$("fileIn").onchange = async e => { const fs = [...e.target.files]; e.target.value = ""; for (const f of fs) await handleNewImage(f); };
// after reference is complete on a side image, continue to object tap
const _setTask = setTask;
setTask = function (t) { if (t === null && S._afterRef) { const im = curImg(); const def = REF[SET.refType]; if (im && im.refPts.length >= def.need) { const nx = S._afterRef; S._afterRef = null; return _setTask(nx); } } return _setTask(t); };

/* ======================= camera ======================= */
const CAM = { stream: null, ori: null, mode: "down" };
function onOri(e) { if (e.beta == null) return; CAM.ori = { beta: e.beta, gamma: e.gamma }; drawCamUi(); }
function drawCamUi() {
  const c = $("camUi"), x = c.getContext("2d"), dpr = Math.min(2, devicePixelRatio || 1); c.width = innerWidth * dpr; c.height = innerHeight * dpr; x.clearRect(0, 0, c.width, c.height);
  const cx = c.width / 2, cy = c.height * .42, R = Math.min(c.width, c.height) * .18;
  x.strokeStyle = "rgba(255,255,255,.5)"; x.lineWidth = 1.5 * dpr;
  for (let i = 1; i < 3; i++) { x.beginPath(); x.moveTo(c.width * i / 3, 0); x.lineTo(c.width * i / 3, c.height); x.stroke(); x.beginPath(); x.moveTo(0, c.height * i / 3); x.lineTo(c.width, c.height * i / 3); x.stroke(); }
  x.beginPath(); x.arc(cx, cy, R, 0, 7); x.stroke();
  let txt = "ไม่มีข้อมูลไจโร"; const o = CAM.ori;
  if (o) {
    let dx, dy, err;
    if (CAM.mode === "down") { dx = clamp(o.gamma / 30, -1, 1); dy = clamp(o.beta / 30, -1, 1); err = Math.hypot(o.beta, o.gamma); txt = `ก้มลงพื้น · เอียงจากแนวดิ่ง ${fmt(err, 1)}°`; }
    else { dx = clamp(o.gamma / 30, -1, 1); dy = clamp((o.beta - 90) / 30, -1, 1); err = Math.hypot(o.beta - 90, o.gamma); txt = `ถ่ายตรงไปข้างหน้า · เอียง ${fmt(err, 1)}°`; }
    const ok = err < 3; x.fillStyle = ok ? "#5FC484" : err < 8 ? "#E9A845" : "#F27560";
    x.beginPath(); x.arc(cx + dx * R, cy + dy * R, 14 * dpr, 0, 7); x.fill(); txt += ok ? " · ตรงแล้ว" : "";
  }
  $("camRead").textContent = txt;
}
async function openCam() {
  $("cam").hidden = false; $("camRead").textContent = "กำลังเปิดกล้อง…";
  try {
    CAM.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
    $("vid").srcObject = CAM.stream; await $("vid").play();
    if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) { try { await DeviceOrientationEvent.requestPermission(); } catch (e) { } }
    addEventListener("deviceorientation", onOri); drawCamUi();
  } catch (e) { $("camRead").textContent = "เปิดกล้องไม่ได้: อนุญาตกล้องในเบราว์เซอร์ และต้องเปิดผ่าน https"; }
}
function closeCam() { removeEventListener("deviceorientation", onOri); if (CAM.stream) CAM.stream.getTracks().forEach(t => t.stop()); CAM.stream = null; $("cam").hidden = true; }
$("openCam").onclick = openCam; $("camClose").onclick = closeCam;
$("camMode").onclick = () => { CAM.mode = CAM.mode === "down" ? "front" : "down"; $("camMode").textContent = "เส้นระดับ: " + (CAM.mode === "down" ? "ก้มลงพื้น" : "ถ่ายตรงไปข้างหน้า"); drawCamUi(); };
$("shutter").onclick = async () => {
  const v = $("vid"); if (!v.videoWidth) return; const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0);
  const gyro = CAM.ori ? { ...CAM.ori } : null; closeCam();
  await handleNewImage(c, { name: "กล้อง " + new Date().toLocaleTimeString("th-TH"), gyro, inApp: true });
  const im = curImg(); if (im && gyro && gyroTilt(im) < 30 && REF[SET.refType].kind === "line") { im.gyroPlane = true; renderAll(); }
};

/* ======================= history ======================= */
function thumb(im, it) {
  try {
    const c = document.createElement("canvas"), s = 160 / Math.max(im.W, im.H); c.width = Math.round(im.W * s); c.height = Math.round(im.H * s); const x = c.getContext("2d"); x.drawImage(im.canvas, 0, 0, c.width, c.height);
    if (it.seg) { x.globalAlpha = .5; x.drawImage(overlayFor(im, it), 0, 0, c.width, c.height); }
    return c.toDataURL("image/jpeg", .6);
  } catch (e) { return null; }
}
function saveHistory(it) {
  if (!it.res) return false; const im = imgById(it.imgId);
  const rec = { id: Date.now() + "_" + it.id, date: new Date().toISOString(), label: it.label || TOOLS[it.tool].n, tool: it.tool, shape: it.tool === "obj" ? (it.shape || it.fit.best) : null, twoView: !!(it.side && it.side.pr),
    ref: { type: SET.refType, name: REF[SET.refType].name() }, depth: it.depth || 0, vals: it.res.vals.map(o => ({ lb: o.lb, v: o.v, sd: o.sd, u: o.u })), thumb: thumb(im, it) };
  const H = store.get("pc_hist", []); H.unshift(rec); while (H.length > 300) H.pop();
  if (!store.set("pc_hist", H)) { rec.thumb = null; H[0] = rec; return store.set("pc_hist", H); }
  return true;
}
function renderHistory() {
  const H = store.get("pc_hist", []); $("histCount").textContent = H.length + " รายการ";
  // groups
  const groups = {}; for (const r of H) (groups[r.label] = groups[r.label] || []).push(r);
  let g = `<h2>สรุปตามชื่อการวัด <small>ค่าเฉลี่ย, SD ระหว่างครั้ง, จำนวนครั้ง</small></h2>`;
  const keys = Object.keys(groups);
  if (!keys.length) g += `<p class="muted" style="margin:0">ยังไม่มีประวัติ กด "บันทึก" ในผลการวัดเพื่อเก็บ</p>`;
  for (const k of keys) {
    const rs = groups[k]; const lbs = [...new Set(rs.flatMap(r => r.vals.map(v => v.lb)))];
    g += `<div class="item"><div class="item-h"><b>${esc(k)}</b><span class="tag acc">${rs.length} ครั้ง</span></div><div class="tbl-wrap"><table><thead><tr><th>ค่า</th><th class="n">เฉลี่ย</th><th class="n">SD</th><th class="n">n</th></tr></thead><tbody>`;
    for (const lb of lbs) { const vs = rs.map(r => r.vals.find(v => v.lb === lb)).filter(Boolean); const u = vs[0].u; const xs = vs.map(v => v.v); const sd = sdOf(xs); g += `<tr><td>${esc(lb)}</td><td class="n">${fmt(mean(xs), 2)} ${u}</td><td class="n">${sd != null ? fmt(sd, 2) : "—"}</td><td class="n">${xs.length}</td></tr>`; }
    g += `</tbody></table></div></div>`;
  }
  $("histGroups").innerHTML = g;
  let l = `<h2>รายการทั้งหมด</h2>`;
  l += H.length ? H.map(r => `<div class="hist-item">${r.thumb ? `<img src="${r.thumb}" alt="">` : `<div style="width:64px;height:64px;border-radius:6px;background:var(--sunk)"></div>`}<div style="min-width:0"><b>${esc(r.label)}</b><div class="muted">${new Date(r.date).toLocaleString("th-TH")} · ${r.ref.name}${r.shape ? " · " + SHAPE_N[r.shape] : ""}${r.twoView ? " · 2 มุม" : ""}</div><div style="font-family:var(--f-mono);font-size:13px">${r.vals.slice(0, 3).map(v => `${esc(v.lb)}: ${fmt(v.v, 2)}${v.sd != null ? " ± " + fmt(v.sd, 2) : ""} ${v.u}`).join("<br>")}</div></div><button class="chip" data-hdel="${r.id}">ลบ</button></div>`).join("") : `<p class="muted" style="margin:0">—</p>`;
  $("histList").innerHTML = l;
  document.querySelectorAll("[data-hdel]").forEach(b => b.onclick = () => { store.set("pc_hist", store.get("pc_hist", []).filter(r => r.id !== b.dataset.hdel)); renderHistory(); });
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function csvText() {
  const H = store.get("pc_hist", []); const rows = [["date", "label", "tool", "shape", "two_view", "reference", "depth_cm", "quantity", "value", "sd", "unit"]];
  for (const r of H) for (const v of r.vals) rows.push([r.date, r.label, r.tool, r.shape || "", r.twoView ? 1 : 0, r.ref.name, r.depth, v.lb, v.v, v.sd ?? "", v.u]);
  return "﻿" + rows.map(r => r.map(x => { const s = String(x); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\n");
}
$("csv").onclick = () => { const b = new Blob([csvText()], { type: "text/csv;charset=utf-8" }); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "photo-caliper-" + new Date().toISOString().slice(0, 10) + ".csv"; document.body.appendChild(a); a.click(); a.remove(); };
$("csvCopy").onclick = async () => { try { await navigator.clipboard.writeText(csvText()); $("csvCopy").textContent = "คัดลอกแล้ว"; } catch (e) { $("csvCopy").textContent = "คัดลอกไม่ได้"; } };

/* ======================= settings & tabs ======================= */
function renderSettings() { $("sW").value = SET.nail.w; $("sWsd").value = SET.nail.sd; $("sL").value = SET.nail.len; $("sF").value = SET.f35app; }
["sW", "sWsd", "sL", "sF"].forEach(id => $(id).addEventListener("change", () => {
  SET.nail = { w: parseFloat($("sW").value) || 12, sd: Math.max(0, parseFloat($("sWsd").value) || .3), len: parseFloat($("sL").value) || 8.17 }; SET.f35app = parseFloat($("sF").value) || 27; saveSet(); renderAll();
}));
$("wipe").onclick = async () => {
  if ($("wipe").dataset.armed !== "1") { $("wipe").dataset.armed = "1"; $("wipe").textContent = "กดอีกครั้งเพื่อยืนยัน"; return; }
  try { localStorage.clear(); } catch (e) { }
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (e) { }
  try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); } catch (e) { }
  $("wipeMsg").textContent = "ล้างแล้ว กำลังโหลดใหม่…"; setTimeout(() => location.reload(), 600);
};
document.querySelectorAll(".tab").forEach(b => b.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x === b));
  for (const k of ["measure", "history", "settings"]) $("tab-" + k).hidden = b.dataset.tab !== k;
  if (b.dataset.tab === "history") renderHistory(); if (b.dataset.tab === "settings") renderSettings(); if (b.dataset.tab === "measure") draw();
});

/* ======================= boot ======================= */
(async () => {
  $("tolV").textContent = $("tol").value; renderSettings();
  await initGPU(); $("engine").textContent = G.state + " · ไม่มี AI";
  setTask(null); renderAll();
  if ("serviceWorker" in navigator && location.protocol === "https:") { try { await navigator.serviceWorker.register("sw.js"); } catch (e) { } }
})();
