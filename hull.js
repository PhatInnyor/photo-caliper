// Photo Caliper — multi-view silhouette measurement (visual hull) on an A4 sheet with a hand-drawn grid.
// Everything runs locally. Core functions are pure (testable in node); UI wiring is at the bottom.
(function () {
  "use strict";
  const HV = {};
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const median = a => { const b = [...a].sort((x, y) => x - y); const n = b.length; return n ? (n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2) : NaN; };

  /* ---------- linear algebra ---------- */
  function solve(A, b) { // Gaussian elimination, A n×n (array of rows)
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-14) return null; [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  const mul3 = (A, B) => { const C = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j]; return C; };
  const inv3 = m => { const [a, b, c, d, e, f, g, h, i] = m; const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, D = a * A + b * B + c * C; if (Math.abs(D) < 1e-18) return null; return [A / D, -(b * i - c * h) / D, (b * f - c * e) / D, B / D, (a * i - c * g) / D, -(a * f - c * d) / D, C / D, -(a * h - b * g) / D, (a * e - b * d) / D]; };
  const applyH = (H, x, y) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };
  function normT(P) { const cx = mean(P.map(p => p[0])), cy = mean(P.map(p => p[1])); const d = mean(P.map(p => Math.hypot(p[0] - cx, p[1] - cy))) || 1; const s = Math.SQRT2 / d; return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1]; }
  function homog(src, dst) { // src -> dst, n>=4
    const Ts = normT(src), Td = normT(dst), A = Array.from({ length: 8 }, () => new Array(8).fill(0)), b = new Array(8).fill(0);
    for (let i = 0; i < src.length; i++) {
      const [x, y] = applyH(Ts, src[i][0], src[i][1]), [u, v] = applyH(Td, dst[i][0], dst[i][1]);
      const rows = [[x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]];
      for (const r of rows) for (let p = 0; p < 8; p++) { b[p] += r[p] * r[8]; for (let q = 0; q < 8; q++) A[p][q] += r[p] * r[q]; }
    }
    const h = solve(A, b); if (!h) return null; const Hn = [...h, 1];
    const H = mul3(mul3(inv3(Td), Hn), Ts); const s = H[8]; return H.map(v => v / s);
  }
  HV.homog = homog; HV.applyH = applyH;

  /* ---------- image helpers ---------- */
  function lumOf(img) { const { W, H, px } = img, Y = new Float32Array(W * H); for (let i = 0; i < W * H; i++) Y[i] = .299 * px[i * 4] + .587 * px[i * 4 + 1] + .114 * px[i * 4 + 2]; return Y; }
  function ycc(px, i) { const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; return [.299 * r + .587 * g + .114 * b, 128 - .168736 * r - .331264 * g + .5 * b, 128 + .5 * r - .418688 * g - .081312 * b]; }
  function otsu(Y) { const h = new Float64Array(256); for (const v of Y) h[clamp(v | 0, 0, 255)]++; const N = Y.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i]; let sB = 0, wB = 0, best = 0, thr = 128; for (let t = 0; t < 256; t++) { wB += h[t]; if (!wB) continue; const wF = N - wB; if (!wF) break; sB += t * h[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; thr = t; } } return thr; }
  function largestComp(mask, W, H, scoreFn) {
    const lab = new Int32Array(W * H), q = new Int32Array(W * H); let n = 0, best = -1, bestS = -1;
    for (let s = 0; s < W * H; s++) {
      if (!mask[s] || lab[s]) continue; n++; let qh = 0, qt = 0; q[qt++] = s; lab[s] = n; let sc = 0;
      while (qh < qt) { const i = q[qh++], x = i % W, y = (i / W) | 0; sc += scoreFn ? scoreFn(i) : 1; if (x > 0 && mask[i - 1] && !lab[i - 1]) { lab[i - 1] = n; q[qt++] = i - 1; } if (x < W - 1 && mask[i + 1] && !lab[i + 1]) { lab[i + 1] = n; q[qt++] = i + 1; } if (y > 0 && mask[i - W] && !lab[i - W]) { lab[i - W] = n; q[qt++] = i - W; } if (y < H - 1 && mask[i + W] && !lab[i + W]) { lab[i + W] = n; q[qt++] = i + W; } }
      if (sc > bestS) { bestS = sc; best = n; }
    }
    const out = new Uint8Array(W * H); if (best > 0) for (let i = 0; i < W * H; i++) out[i] = lab[i] === best ? 1 : 0; return out;
  }
  function fillHoles(mask, W, H) {
    const out = new Uint8Array(W * H), q = new Int32Array(W * H); let qh = 0, qt = 0;
    const push = i => { if (!mask[i] && !out[i]) { out[i] = 1; q[qt++] = i; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); } for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (qh < qt) { const i = q[qh++], x = i % W, y = (i / W) | 0; if (x > 0) push(i - 1); if (x < W - 1) push(i + 1); if (y > 0) push(i - W); if (y < H - 1) push(i + W); }
    const m = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) m[i] = out[i] ? 0 : 1; return m;
  }
  function morph(m, W, H, r, dil) { // separable square min/max
    if (r <= 0) return m; const t = new Uint8Array(W * H), o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = dil ? 0 : 1; for (let k = -r; k <= r; k++) { const xx = x + k; const mv = xx < 0 || xx >= W ? 0 : m[y * W + xx]; if (dil ? mv : !mv) { v = dil ? 1 : 0; break; } } t[y * W + x] = v; }
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) { let v = dil ? 0 : 1; for (let k = -r; k <= r; k++) { const yy = y + k; const mv = yy < 0 || yy >= H ? 0 : t[yy * W + x]; if (dil ? mv : !mv) { v = dil ? 1 : 0; break; } } o[y * W + x] = v; }
    return o;
  }
  function hull2(P) { const p = [...P].sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p; const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); const lo = [], up = []; for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); } for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); } return lo.slice(0, -1).concat(up.slice(0, -1)); }
  const perim = h => { let s = 0; for (let i = 0; i < h.length; i++) { const a = h[i], b = h[(i + 1) % h.length]; s += Math.hypot(a[0] - b[0], a[1] - b[1]); } return s; };
  HV.hull2 = hull2; HV.perim = perim;

  /* ---------- paper + grid detection ---------- */
  // cfg: {pw, ph, sp (grid spacing), mg (margin), mark:true}
  HV.detectPaper = function (img, cfg) {
    const { W, H } = img, Y = img.Y || (img.Y = lumOf(img));
    const thr = otsu(Y); const bright = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) bright[i] = Y[i] > thr ? 1 : 0;
    const rc = Math.max(2, Math.round(Math.min(W, H) / 300)); // close pen lines so the sheet is one region
    const paper = fillHoles(largestComp(morph(morph(bright, W, H, rc, true), W, H, rc, false), W, H), W, H);
    const bd = []; for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (paper[i] && (!paper[i - 1] || !paper[i + 1] || !paper[i - W] || !paper[i + W])) bd.push([x, y]); }
    let h = hull2(bd); if (h.length < 4) return { err: "หากระดาษไม่เจอ" };
    const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    while (h.length > 4) { let mi = 0, mv = Infinity; for (let i = 0; i < h.length; i++) { const v = tri(h[(i - 1 + h.length) % h.length], h[i], h[(i + 1) % h.length]); if (v < mv) { mv = v; mi = i; } } h.splice(mi, 1); }
    const c = [mean(h.map(p => p[0])), mean(h.map(p => p[1]))]; h.sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0])); // clockwise on screen
    // refine: fit a line to the middle part of each side (the mark notch at a corner must not bend the corner), then intersect
    const lines = [];
    for (let k = 0; k < 4; k++) {
      const a = h[k], b = h[(k + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; let o = a, d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], tol = Math.max(4, L * .03), ln = null;
      for (let it = 0; it < 3; it++) {
        const nrm = [-d[1], d[0]];
        const pts = bd.filter(p => { const t = (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1], e = (p[0] - o[0]) * nrm[0] + (p[1] - o[1]) * nrm[1]; return t > L * .15 && t < L * .85 && Math.abs(e) < tol; });
        if (pts.length < 10) { ln = null; break; }
        const mx = mean(pts.map(p => p[0])), my = mean(pts.map(p => p[1])); let sxx = 0, syy = 0, sxy = 0; for (const p of pts) { sxx += (p[0] - mx) ** 2; syy += (p[1] - my) ** 2; sxy += (p[0] - mx) * (p[1] - my); }
        const th = .5 * Math.atan2(2 * sxy, sxx - syy); let dd = [Math.cos(th), Math.sin(th)]; if (dd[0] * d[0] + dd[1] * d[1] < 0) dd = [-dd[0], -dd[1]];
        ln = { p: [mx, my], d: dd }; o = ln.p; d = dd; tol = Math.max(2, tol / 2);
      }
      lines.push(ln);
    }
    if (lines.every(Boolean)) {
      const X = (l1, l2) => { const den = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0]; if (Math.abs(den) < 1e-9) return null; const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / den; return [l1.p[0] + l1.d[0] * t, l1.p[1] + l1.d[1] * t]; };
      const nh = [0, 1, 2, 3].map(k => X(lines[(k + 3) % 4], lines[k])); if (HV.debug) console.log('h4', JSON.stringify(h.map(p => p.map(Math.round))), 'lines->', JSON.stringify(nh.map(p => p && p.map(Math.round)))); if (nh.every(Boolean)) h = nh;
    } else if (HV.debug) console.log('line fit failed', lines.map(Boolean));
    const PW = cfg.pw, PH = cfg.ph, paperPts = [[0, 0], [PW, 0], [PW, PH], [0, PH]];
    const at = (x, y) => { x = Math.round(x); y = Math.round(y); return x < 0 || y < 0 || x >= W || y >= H ? NaN : Y[y * W + x]; };
    const sampleMean = (Hm, x0, y0, x1, y1) => { const v = []; for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) { const p = applyH(Hm, x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * j / 6); const s = at(p[0], p[1]); if (isFinite(s)) v.push(s); } return v.length ? mean(v) : NaN; };
    const cands = [];
    for (let r = 0; r < 4; r++) { const q = [0, 1, 2, 3].map(k => h[(k + r) % 4]); const Hm = homog(paperPts, q); if (!Hm) continue; const mk = sampleMean(Hm, 4, 4, 11, 11), pp = sampleMean(Hm, cfg.mg + 5, cfg.mg + 5, cfg.mg + cfg.sp - 5, cfg.mg + cfg.sp - 5), sd1 = sampleMean(Hm, 4, 20, 11, 28), sd2 = sampleMean(Hm, 20, 4, 28, 11), wh = Math.min(pp, sd1, sd2); cands.push({ r, q, Hm, sc: (wh - mk) / (pp || 1) }); }
    if (!cands.length) return { err: "คำนวณมุมกระดาษไม่ได้" };
    cands.sort((a, b) => b.sc - a.sc); if (HV.debug) console.log("cands", cands.map(c => [c.r, c.sc.toFixed(3), c.q[0].map(v => v.toFixed(0)).join(",")])); const best = cands[0], markOK = best.sc > .3 && (cands[1] ? cands[1].sc < best.sc * .5 : true);
    let Hm = best.Hm, corners = best.q;
    // grid refinement
    const nx = Math.floor((PW - 2 * cfg.mg) / cfg.sp + 1e-6) + 1, ny = Math.floor((PH - 2 * cfg.mg) / cfg.sp + 1e-6) + 1, G = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) G.push([cfg.mg + i * cfg.sp, cfg.mg + j * cfg.sp]);
    const pxmm = Hm => { const a = applyH(Hm, PW / 2, PH / 2), b = applyH(Hm, PW / 2 + 1, PH / 2), d = applyH(Hm, PW / 2, PH / 2 + 1); return (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(d[0] - a[0], d[1] - a[1])) / 2; };
    let found = [], rms = NaN;
    for (const frac of cfg.noGrid ? [] : [.15, .08, .04]) {
      const ppm = pxmm(Hm), R = Math.max(2, Math.round(frac * cfg.sp * ppm)); found = [];
      for (const g of G) {
        const p = applyH(Hm, g[0], g[1]), ex = applyH(Hm, g[0] + 1, g[1]), ey = applyH(Hm, g[0], g[1] + 1);
        const ux = [ex[0] - p[0], ex[1] - p[1]], uy = [ey[0] - p[0], ey[1] - p[1]], arm = cfg.sp * .22;
        const crossAt = (x, y) => { let s = 0, n = 0; for (let k = -arm; k <= arm; k += .5) { const a = at(x + ux[0] * k, y + ux[1] * k), b = at(x + uy[0] * k, y + uy[1] * k); if (isFinite(a)) { s += a; n++; } if (isFinite(b)) { s += b; n++; } } return n ? s / n : NaN; };
        let bv = Infinity, bx = 0, by = 0; const sc = {};
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const v = crossAt(p[0] + dx, p[1] + dy); sc[dx + "," + dy] = v; if (v < bv) { bv = v; bx = dx; by = dy; } }
        if (!isFinite(bv)) continue;
        const ref = crossAt(p[0] + bx + (ux[0] + uy[0]) * cfg.sp * .5, p[1] + by + (ux[1] + uy[1]) * cfg.sp * .5);
        if (!(ref - bv > .08 * ref)) continue; // no dark cross here (occluded or not drawn)
        const sub = (a, b, c) => { const d = a - 2 * b + c; return d > 0 ? clamp(.5 * (a - c) / d, -.5, .5) : 0; };
        const g0 = k => sc[k] ?? bv; const ox = sub(g0((bx - 1) + "," + by), bv, g0((bx + 1) + "," + by)), oy = sub(g0(bx + "," + (by - 1)), bv, g0(bx + "," + (by + 1)));
        found.push({ g, p: [p[0] + bx + ox, p[1] + by + oy], c: (ref - bv) / ref });
      }
      if (found.length < 8) break;
      let use = found;
      for (let it = 0; it < 3; it++) {
        const Hn = homog(use.map(f => f.g), use.map(f => f.p)); if (!Hn) break; Hm = Hn;
        const res = found.map(f => { const q = applyH(Hm, f.g[0], f.g[1]); return Math.hypot(q[0] - f.p[0], q[1] - f.p[1]); });
        const md = median(res); use = found.filter((f, i) => res[i] <= Math.max(1, 3 * md)); rms = Math.sqrt(mean(use.map(f => { const q = applyH(Hm, f.g[0], f.g[1]); return (q[0] - f.p[0]) ** 2 + (q[1] - f.p[1]) ** 2; })));
      }
      found = use; if (HV.debug) console.log('iter', frac, 'found', use.length, 'rms', rms && rms.toFixed(2), 'c0', applyH(Hm, 0, 0).map(v => v.toFixed(1)).join(','));
    }
    corners = paperPts.map(p => applyH(Hm, p[0], p[1]));
    return { H: Hm, corners, markOK, markScore: best.sc, grid: found.length, gridPts: found.map(f => f.p), rms, ppm: pxmm(Hm), paperMask: paper };
  };

  /* ---------- silhouette ---------- */
  HV.silhouette = function (img, P, cfg) {
    const { W, H, px } = img, Hm = P.H, Hi = inv3(Hm), PW = cfg.pw, PH = cfg.ph, tol = cfg.tol || 18;
    const samp = (X, Y0) => { const p = applyH(Hm, X, Y0); const x = Math.round(p[0]), y = Math.round(p[1]); if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) return null; let a = [0, 0, 0], n = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const c = ycc(px, (y + dy) * W + x + dx); a[0] += c[0]; a[1] += c[1]; a[2] += c[2]; n++; } return { u: p[0], v: p[1], c: a.map(v => v / n) }; };
    // paper colour (cell centres) + illumination plane
    const ps = []; for (let X = cfg.mg + cfg.sp / 2; X < PW - cfg.mg; X += cfg.sp) for (let Y0 = cfg.mg + cfg.sp / 2; Y0 < PH - cfg.mg; Y0 += cfg.sp) { const s = samp(X, Y0); if (s) ps.push(s); }
    const Cb0 = median(ps.map(s => s.c[1])), Cr0 = median(ps.map(s => s.c[2])), Ym = median(ps.map(s => s.c[0]));
    const pc = ps.filter(s => Math.abs(s.c[1] - Cb0) + Math.abs(s.c[2] - Cr0) < 10 && s.c[0] > Ym * .7); // paper-like samples only
    let plane = [Ym, 0, 0];
    if (pc.length >= 6) { const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0]; for (const s of pc) { const r = [1, s.u, s.v]; for (let i = 0; i < 3; i++) { b[i] += r[i] * s.c[0]; for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; } } plane = solve(A, b) || plane; }
    // background colour (ring outside the sheet)
    const bs = []; for (let k = 0; k < 40; k++) { const t = k / 40; for (const [X, Y0] of [[t * PW, -14], [t * PW, PH + 14], [-14, t * PH], [PW + 14, t * PH]]) { const s = samp(X, Y0); if (s) bs.push(s.c); } }
    const bg = bs.length ? [median(bs.map(c => c[0])), median(bs.map(c => c[1])), median(bs.map(c => c[2]))] : null;
    const m = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, c = ycc(px, i), q = applyH(Hi, x, y), inP = q[0] >= 0 && q[1] >= 0 && q[0] <= PW && q[1] <= PH;
      if (inP && q[0] < 17 && q[1] < 17) continue; // orientation mark
      const Yl = Math.max(20, plane[0] + plane[1] * x + plane[2] * y);
      const chroma = Math.abs(c[1] - Cb0) + Math.abs(c[2] - Cr0), dark = (Yl - c[0]) / Yl;
      let ob = chroma > tol || dark > .45;
      if (ob && !inP) ob = !bg || (Math.abs(c[0] - bg[0]) * .5 + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2])) > tol * 1.3;
      m[i] = ob ? 1 : 0;
    }
    const rO = Math.max(1, Math.ceil(.6 * P.ppm)); // remove pen lines
    let s = morph(morph(m, W, H, rO, false), W, H, rO, true);
    const cx0 = cfg.mg, cy0 = cfg.mg;
    s = largestComp(s, W, H, i => { const q = applyH(Hi, i % W, (i / W) | 0); return q[0] > cx0 && q[1] > cy0 && q[0] < PW - cx0 && q[1] < PH - cy0 ? 1 : .02; });
    s = fillHoles(morph(morph(s, W, H, 2, true), W, H, 2, false), W, H);
    let area = 0, touch = false; for (let i = 0; i < W * H; i++) if (s[i]) { area++; const x = i % W, y = (i / W) | 0; if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touch = true; }
    return { mask: s, area, touch, paperY: Ym, bg };
  };

  /* ---------- calibration ---------- */
  HV.calibrate = function (views) { // views: [{H, W, Hh}] -> f (px), pose per view
    let num = 0, den = 0;
    for (const v of views) {
      const cx = v.W / 2, cy = v.H / 2, T = [1, 0, -cx, 0, 1, -cy, 0, 0, 1], Hc = mul3(T, v.Hm);
      const h1 = [Hc[0], Hc[3], Hc[6]], h2 = [Hc[1], Hc[4], Hc[7]], nrm = h1[0] ** 2 + h1[1] ** 2 + h2[0] ** 2 + h2[1] ** 2;
      const eq = [[h1[0] * h2[0] + h1[1] * h2[1], h1[2] * h2[2]], [h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2, h1[2] ** 2 - h2[2] ** 2]];
      for (const [A, B] of eq) { num += A * B / nrm ** 2; den += A * A / nrm ** 2; }
    }
    const a = -num / den; const f = a > 0 ? 1 / Math.sqrt(a) : null;
    return f;
  };
  HV.pose = function (Hm, f, W, H) {
    const cx = W / 2, cy = H / 2, T = [1, 0, -cx, 0, 1, -cy, 0, 0, 1], Hc = mul3(T, Hm);
    const b1 = [Hc[0] / f, Hc[3] / f, Hc[6]], b2 = [Hc[1] / f, Hc[4] / f, Hc[7]], b3 = [Hc[2] / f, Hc[5] / f, Hc[8]];
    let l = 2 / (Math.hypot(...b1) + Math.hypot(...b2)); if (l * b3[2] < 0) l = -l;
    const r1 = b1.map(v => v * l), r2 = b2.map(v => v * l), t = b3.map(v => v * l), r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
    let R = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
    for (let k = 0; k < 8; k++) { const Ri = inv3(R); if (!Ri) break; R = R.map((v, i) => .5 * (v + Ri[(i % 3) * 3 + ((i / 3) | 0)])); } // polar decomposition
    return { R, t, f, cx, cy };
  };
  const proj = (P, X, Y0, Z) => { const R = P.R, x = R[0] * X + R[1] * Y0 - R[2] * Z + P.t[0], y = R[3] * X + R[4] * Y0 - R[5] * Z + P.t[1], z = R[6] * X + R[7] * Y0 - R[8] * Z + P.t[2]; return z <= 0 ? null : [P.f * x / z + P.cx, P.f * y / z + P.cy]; };
  HV.proj = proj;

  /* ---------- carving ---------- */
  HV.carve = function (views, cfg) { // views: [{mask, W, H, pose}]
    const allow = cfg.allowMiss ?? (views.length >= 8 ? 1 : 0);
    const pass = (x0, y0, z0, x1, y1, z1, vox) => {
      const nx = Math.max(1, Math.ceil((x1 - x0) / vox)), ny = Math.max(1, Math.ceil((y1 - y0) / vox)), nz = Math.max(1, Math.ceil((z1 - z0) / vox)), occ = new Uint8Array(nx * ny * nz);
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const X = x0 + (i + .5) * vox, Y0 = y0 + (j + .5) * vox, Z = z0 + (k + .5) * vox; let miss = 0, seen = 0;
        for (const v of views) { const p = proj(v.pose, X, Y0, Z); if (!p) continue; const u = Math.round(p[0]), w = Math.round(p[1]); if (u < 0 || w < 0 || u >= v.W || w >= v.H) continue; seen++; if (!v.mask[w * v.W + u]) { miss++; if (miss > allow) break; } }
        occ[(k * ny + j) * nx + i] = miss <= allow && seen >= Math.min(3, views.length) ? 1 : 0;
      }
      return { occ, nx, ny, nz, vox, x0, y0, z0 };
    };
    const g1 = pass(-10, -10, 0, cfg.pw + 10, cfg.ph + 10, cfg.zmax || 250, 4);
    const k1 = keepLargest(g1); let bb = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9], n1 = 0;
    for (let k = 0; k < g1.nz; k++) for (let j = 0; j < g1.ny; j++) for (let i = 0; i < g1.nx; i++) if (k1[(k * g1.ny + j) * g1.nx + i]) { n1++; bb = [Math.min(bb[0], i), Math.min(bb[1], j), Math.min(bb[2], k), Math.max(bb[3], i), Math.max(bb[4], j), Math.max(bb[5], k)]; }
    if (!n1) return null;
    const X0 = g1.x0 + (bb[0] - 1) * 4, Y0 = g1.y0 + (bb[1] - 1) * 4, Z0 = 0, X1 = g1.x0 + (bb[3] + 2) * 4, Y1 = g1.y0 + (bb[4] + 2) * 4, Z1 = (bb[5] + 2) * 4;
    const vox = cfg.vox || clamp(Math.max(X1 - X0, Y1 - Y0, Z1 - Z0) / 220, .4, 1.5);
    const g2 = pass(X0, Y0, Z0, X1, Y1, Z1, vox); g2.occ = keepLargest(g2);
    let topTouch = false; for (let j = 0; j < g2.ny && !topTouch; j++) for (let i = 0; i < g2.nx; i++) if (g2.occ[((g2.nz - 1) * g2.ny + j) * g2.nx + i]) { topTouch = true; break; }
    g2.topTouch = topTouch && Z1 >= (cfg.zmax || 250) - 4;
    return g2;
  };
  function keepLargest(g) {
    const { occ, nx, ny, nz } = g, N = occ.length, lab = new Int32Array(N), q = new Int32Array(N); let best = 0, bs = 0, n = 0;
    for (let s = 0; s < N; s++) {
      if (!occ[s] || lab[s]) continue; n++; let qh = 0, qt = 0; q[qt++] = s; lab[s] = n;
      while (qh < qt) { const c = q[qh++], i = c % nx, j = ((c / nx) | 0) % ny, k = (c / (nx * ny)) | 0; const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1, k > 0 ? c - nx * ny : -1, k < nz - 1 ? c + nx * ny : -1]; for (const d of nb) if (d >= 0 && occ[d] && !lab[d]) { lab[d] = n; q[qt++] = d; } }
      if (qt > bs) { bs = qt; best = n; }
    }
    const o = new Uint8Array(N); for (let i = 0; i < N; i++) o[i] = lab[i] === best ? 1 : 0; return o;
  }

  /* ---------- analysis ---------- */
  const ramanujan = (a, b) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  function smooth(a, w) { return a.map((_, i) => { let s = 0, n = 0; for (let k = -w; k <= w; k++) { const j = i + k; if (j >= 0 && j < a.length && isFinite(a[j])) { s += a[j]; n++; } } return n ? s / n : a[i]; }); }
  // Fit an ellipse resting on the sheet (centre height = b) to the hull slice, using only the support directions that
  // are tangent to some camera ray (those are exact for a visual hull; other directions are only upper bounds).
  function fitRestingEllipse(Q, S0, N2, vox, cams, w0, h0, c0) {
    const obs = [], P0 = [S0[0] + N2[0] * c0, S0[1] + N2[1] * c0, h0 / 2];
    for (const C of cams) {
      const v = [C[0] - P0[0], C[1] - P0[1], C[2] - P0[2]], L = Math.hypot(...v), dN = v[0] * N2[0] + v[1] * N2[1], dZ = v[2], q = Math.hypot(dN, dZ);
      if (q / L < .3) continue;
      for (const sg of [1, -1]) {
        const nN = -dZ / q * sg, nZ = dN / q * sg; let m = -Infinity;
        for (const p of Q) { const s = ((p[0] - S0[0]) * N2[0] + (p[1] - S0[1]) * N2[1]) * nN + p[2] * nZ; if (s > m) m = s; }
        obs.push([nN, nZ, m + vox / 2 * (Math.abs(nN) + Math.abs(nZ)), q / L]);
      }
    }
    if (obs.length < 4) return null;
    let a = w0 / 2, b = Math.min(h0 / 2, w0 / 2), c = c0;
    for (let it = 0; it < 30; it++) {
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
      for (const [nN, nZ, Sh, w] of obs) {
        const rt = Math.sqrt(a * a * nN * nN + b * b * nZ * nZ) || 1e-9, Sm = c * nN + b * nZ + rt, e = Sh - Sm;
        const J = [a * nN * nN / rt, nZ + b * nZ * nZ / rt, nN];
        for (let i = 0; i < 3; i++) { r[i] += w * J[i] * e; for (let j = 0; j < 3; j++) A[i][j] += w * J[i] * J[j]; }
      }
      for (let i = 0; i < 3; i++) A[i][i] *= 1.001;
      const d = solve(A, r); if (!d) break; a = Math.max(.5, a + d[0]); b = Math.max(.5, b + d[1]); c += d[2];
      if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) < 1e-4) break;
    }
    return { a, b, c };
  }
  // horizontal slice of a standing object: ellipse (axes along the slice PCA) fitted to camera-tangent supports
  function fitSliceEllipse(Q, z, vox, cams) {
    const mx = mean(Q.map(p => p[0])), my = mean(Q.map(p => p[1])); let sxx = 0, syy = 0, sxy = 0; for (const p of Q) { sxx += (p[0] - mx) ** 2; syy += (p[1] - my) ** 2; sxy += (p[0] - mx) * (p[1] - my); }
    const th = .5 * Math.atan2(2 * sxy, sxx - syy), U = [Math.cos(th), Math.sin(th)], V = [-U[1], U[0]], obs = [];
    for (const C of cams) {
      const d = [C[0] - mx, C[1] - my], L = Math.hypot(d[0], d[1], C[2] - z), q = Math.hypot(d[0], d[1]); if (q / L < .3) continue;
      for (const sg of [1, -1]) {
        const m = [-d[1] / q * sg, d[0] / q * sg], nu = m[0] * U[0] + m[1] * U[1], nv = m[0] * V[0] + m[1] * V[1]; let mm = -Infinity;
        for (const p of Q) { const s = (p[0] - mx) * m[0] + (p[1] - my) * m[1]; if (s > mm) mm = s; }
        obs.push([nu, nv, mm + vox / 2 * (Math.abs(m[0]) + Math.abs(m[1])), 1]);
      }
    }
    if (obs.length < 6) return null;
    let eu = 0, ev = 0, ext = (n0, n1) => Math.max(...Q.map(p => (p[0] - mx) * n0 + (p[1] - my) * n1));
    let a = ext(U[0], U[1]), b = ext(V[0], V[1]);
    for (let it = 0; it < 30; it++) {
      const A = Array.from({ length: 4 }, () => [0, 0, 0, 0]), r = [0, 0, 0, 0];
      for (const [nu, nv, Sh, w] of obs) { const rt = Math.sqrt(a * a * nu * nu + b * b * nv * nv) || 1e-9, e = Sh - (eu * nu + ev * nv + rt), J = [a * nu * nu / rt, b * nv * nv / rt, nu, nv]; for (let i = 0; i < 4; i++) { r[i] += w * J[i] * e; for (let j = 0; j < 4; j++) A[i][j] += w * J[i] * J[j]; } }
      for (let i = 0; i < 4; i++) A[i][i] = A[i][i] * 1.001 + 1e-9; const dd = solve(A, r); if (!dd) break; a = Math.max(.3, a + dd[0]); b = Math.max(.3, b + dd[1]); eu += dd[2]; ev += dd[3]; if (dd.reduce((s, v) => s + Math.abs(v), 0) < 1e-4) break;
    }
    return { a, b, c: [mx + U[0] * eu + V[0] * ev, my + U[1] * eu + V[1] * ev], U, V };
  }
  HV.analyze = function (g, mode) {
    const { occ, nx, ny, nz, vox, x0, y0, z0 } = g, P = [];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (occ[(k * ny + j) * nx + i]) P.push([x0 + (i + .5) * vox, y0 + (j + .5) * vox, z0 + (k + .5) * vox]);
    const volHull = P.length * vox ** 3; let slices = [];
    if (mode === "stand") {
      const L = new Map(); for (const p of P) { const k = Math.round((p[2] - z0) / vox - .5); if (!L.has(k)) L.set(k, []); L.get(k).push(p); }
      const ks = [...L.keys()].sort((a, b) => a - b);
      for (const k of ks) {
        const Q = L.get(k), z = (k + .5) * vox, h = hull2(Q.map(p => [p[0], p[1]])); let area = Q.length * vox * vox, cx = mean(Q.map(p => p[0])), cy = mean(Q.map(p => p[1])), girth = h.length > 2 ? perim(h) + Math.PI * vox : Math.PI * vox, w = Math.sqrt(4 * area / Math.PI), d2 = w, ring = ringOf(Q, cx, cy, vox), U = null;
        const fe = g.cams && Q.length > 8 ? fitSliceEllipse(Q, z, vox, g.cams) : null;
        if (fe && Math.PI * fe.a * fe.b < area * 1.02) { area = Math.PI * fe.a * fe.b; girth = ramanujan(fe.a, fe.b); w = 2 * Math.max(fe.a, fe.b); d2 = 2 * Math.min(fe.a, fe.b); [cx, cy] = fe.c; U = fe.U; ring = Array.from({ length: 32 }, (_, j) => { const t = j / 32 * 2 * Math.PI, x = fe.a * Math.cos(t), y = fe.b * Math.sin(t), ph = Math.atan2(fe.U[1] * x + fe.V[1] * y, fe.U[0] * x + fe.V[0] * y); return { r: Math.hypot(x, y), ph }; }); }
        slices.push({ s: z, c: [cx, cy, z], area, girth, w, h: d2, ring });
      }
      { const ma = median(slices.map(s => s.area)); let f1 = slices.length - 1; while (f1 > 0 && slices[f1].area < .1 * ma) f1--; slices = slices.slice(0, f1 + 1); }
      const ctr = slices.map(sl => sl.c); let len = 0; /* centre path (handles a curved standing object) */ const sx = smooth(ctr.map(c => c[0]), 3), sy = smooth(ctr.map(c => c[1]), 3); for (let i = 1; i < ctr.length; i++) len += Math.hypot(sx[i] - sx[i - 1], sy[i] - sy[i - 1], vox);
      return finish(slices, vox, volHull, { length: len + vox, straight: slices.length * vox, height: slices.length * vox, mode });
    }
    // lying: curved centre line in the horizontal plane
    const mx = mean(P.map(p => p[0])), my = mean(P.map(p => p[1])); let sxx = 0, syy = 0, sxy = 0; for (const p of P) { sxx += (p[0] - mx) ** 2; syy += (p[1] - my) ** 2; sxy += (p[0] - mx) * (p[1] - my); }
    const th = .5 * Math.atan2(2 * sxy, sxx - syy), u = [Math.cos(th), Math.sin(th)], n = [-u[1], u[0]];
    const tOf = p => (p[0] - mx) * u[0] + (p[1] - my) * u[1], nOf = p => (p[0] - mx) * n[0] + (p[1] - my) * n[1];
    let tmin = Infinity, tmax = -Infinity; for (const p of P) { const t = tOf(p); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t); }
    const bw = 2, NB = Math.max(2, Math.ceil((tmax - tmin) / bw)), lo = new Array(NB).fill(Infinity), hi = new Array(NB).fill(-Infinity);
    for (const p of P) { const b = clamp(Math.floor((tOf(p) - tmin) / bw), 0, NB - 1), v = nOf(p); lo[b] = Math.min(lo[b], v); hi[b] = Math.max(hi[b], v); }
    const mid = smooth(lo.map((l, i) => isFinite(l) ? (l + hi[i]) / 2 : NaN), 6);
    let line = mid.map((m, i) => [mx + u[0] * (tmin + (i + .5) * bw) + n[0] * m, my + u[1] * (tmin + (i + .5) * bw) + n[1] * m]);
    // extend to the tips along the end tangents
    const ext = (a, b, d) => { const L = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; return [a[0] + (a[0] - b[0]) / L * d, a[1] + (a[1] - b[1]) / L * d]; };
    line = [ext(line[0], line[Math.min(2, line.length - 1)], bw), ...line, ext(line[line.length - 1], line[Math.max(0, line.length - 3)], bw)];
    const ds = Math.max(vox, 1); const S = [[...line[0]]]; let acc = 0;
    for (let i = 1; i < line.length; i++) { const a = line[i - 1], b = line[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); let pos = 0; while (acc + (L - pos) >= ds) { pos += ds - acc; acc = 0; S.push([a[0] + (b[0] - a[0]) * pos / L, a[1] + (b[1] - a[1]) * pos / L]); } acc += L - pos; }
    const T = S.map((_, i) => { const a = S[Math.max(0, i - 2)], b = S[Math.min(S.length - 1, i + 2)], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; });
    const st = S.map(p => tOf(p)), bins = S.map(() => []);
    for (const p of P) {
      const t = tOf(p); let lo2 = 0, hi2 = S.length - 1; while (hi2 - lo2 > 1) { const m = (lo2 + hi2) >> 1; if (st[m] < t) lo2 = m; else hi2 = m; }
      let bi = -1, bd = Infinity; for (let i = Math.max(0, lo2 - 12); i <= Math.min(S.length - 1, hi2 + 12); i++) { const a = (p[0] - S[i][0]) * T[i][0] + (p[1] - S[i][1]) * T[i][1]; if (Math.abs(a) > ds * .5 + 1e-6) continue; const d = Math.hypot(p[0] - S[i][0], p[1] - S[i][1]); if (d < bd) { bd = d; bi = i; } }
      if (bi < 0) { for (let i = Math.max(0, lo2 - 12); i <= Math.min(S.length - 1, hi2 + 12); i++) { const d = Math.hypot(p[0] - S[i][0], p[1] - S[i][1]); if (d < bd) { bd = d; bi = i; } } }
      if (bi >= 0) bins[bi].push(p);
    }
    let first = bins.findIndex(b => b.length), last = bins.length - 1 - [...bins].reverse().findIndex(b => b.length);
    for (let i = first; i <= last; i++) {
      const Q = bins[i]; if (!Q.length) { slices.push(null); continue; }
      const N2 = [-T[i][1], T[i][0]]; let h = 0; for (const p of Q) h = Math.max(h, p[2] + vox / 2);
      const band = Math.max(vox, h * .08); let a = Infinity, b = -Infinity; for (const p of Q) if (Math.abs(p[2] - h / 2) <= band) { const v = (p[0] - S[i][0]) * N2[0] + (p[1] - S[i][1]) * N2[1]; a = Math.min(a, v); b = Math.max(b, v); }
      if (!isFinite(a)) { for (const p of Q) { const v = (p[0] - S[i][0]) * N2[0] + (p[1] - S[i][1]) * N2[1]; a = Math.min(a, v); b = Math.max(b, v); } }
      let w = b - a + vox, cN = (a + b) / 2;
      const fe = g.cams && g.cams.length ? fitRestingEllipse(Q, S[i], N2, vox, g.cams, w, h, cN) : null;
      if (fe && fe.a < w && fe.b * 2 < h * 1.05) { w = 2 * fe.a; h = 2 * fe.b; cN = fe.c; }
      slices.push({ s: (i - first) * ds, c: [S[i][0] + N2[0] * cN, S[i][1] + N2[1] * cN, h / 2], T: T[i], N: N2, w, h, area: Math.PI * w * h / 4, girth: ramanujan(w / 2, h / 2), hullArea: Q.length * vox ** 3 / ds });
    }
    slices = slices.map((sl, i, A) => sl || { ...(A[i - 1] || A[i + 1]), s: i * ds });
    { const ma = median(slices.map(s => s.area)); let f0 = 0, f1 = slices.length - 1; while (f0 < f1 && slices[f0].area < .1 * ma) f0++; while (f1 > f0 && slices[f1].area < .1 * ma) f1--; slices = slices.slice(f0, f1 + 1).map((s, i) => ({ ...s, s: i * ds })); }
    let len = 0; for (let i = 1; i < slices.length; i++) len += Math.hypot(slices[i].c[0] - slices[i - 1].c[0], slices[i].c[1] - slices[i - 1].c[1]);
    const e0 = slices[0].c, e1 = slices[slices.length - 1].c;
    return finish(slices, ds, volHull, { length: len + ds, straight: Math.hypot(e1[0] - e0[0], e1[1] - e0[1]) + ds, height: Math.max(...slices.map(s => s.h)), mode });
  };
  function ringOf(Q, cx, cy, vox) { const K = 32, r = new Array(K).fill(0); for (const p of Q) { const dx = p[0] - cx, dy = p[1] - cy, k = ((Math.round(Math.atan2(dy, dx) / (2 * Math.PI) * K) % K) + K) % K; r[k] = Math.max(r[k], Math.hypot(dx, dy) + vox / 2); } for (let k = 0; k < K; k++) if (!r[k]) r[k] = (r[(k + K - 1) % K] + r[(k + 1) % K]) / 2 || vox / 2; return r; }
  function finish(slices, ds, volHull, meta) {
    const g = smooth(slices.map(s => s.girth), 2); slices.forEach((s, i) => s.gs = g[i]);
    const vol = slices.reduce((a, s) => a + s.area * ds, 0);
    const L = slices.length, splits = [], win = Math.max(3, Math.round(10 / ds));
    for (let i = Math.round(L * .08); i < L * .92; i++) {
      let isMin = true; for (let k = -win; k <= win; k++) { const j = i + k; if (j >= 0 && j < L && g[j] < g[i]) { isMin = false; break; } } if (!isMin) continue;
      const lm = Math.max(...g.slice(0, i)), rm = Math.max(...g.slice(i + 1)); if (g[i] < .92 * Math.min(lm, rm) && (!splits.length || (i - splits[splits.length - 1]) * ds > 15)) splits.push(i);
    }
    return { slices, ds, vol, volHull, splits: splits.map(i => +(slices[i].s.toFixed(1))), ...meta };
  }
  HV.segments = function (A, splitsMm) {
    const cuts = [0, ...splitsMm.filter(v => v > 0 && v < A.length).sort((a, b) => a - b), Infinity], out = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const S = A.slices.filter(s => s.s >= cuts[k] && s.s < cuts[k + 1]); if (!S.length) continue; const G = S.map(s => s.girth);
      out.push({ from: cuts[k], to: Math.min(cuts[k + 1], A.length), len: S.length * A.ds, gmax: Math.max(...G), gmin: Math.min(...G), gmean: mean(G), wmax: Math.max(...S.map(s => s.w)), hmax: Math.max(...S.map(s => s.h)), vol: S.reduce((a, s) => a + s.area * A.ds, 0) });
    }
    return out;
  };

  /* ---------- mesh ---------- */
  HV.mesh = function (A) {
    const K = 32, pos = [], idx = [], S = A.slices;
    for (const s of S) for (let k = 0; k < K; k++) {
      const t = k / K * 2 * Math.PI;
      if (A.mode === "stand") { const R = s.ring[k]; if (typeof R === "number") pos.push(s.c[0] + Math.cos(t) * R, s.c[1] + Math.sin(t) * R, s.c[2]); else pos.push(s.c[0] + Math.cos(R.ph) * R.r, s.c[1] + Math.sin(R.ph) * R.r, s.c[2]); }
      else { const a = s.w / 2, b = s.h / 2; pos.push(s.c[0] + s.N[0] * a * Math.cos(t), s.c[1] + s.N[1] * a * Math.cos(t), s.c[2] + b * Math.sin(t)); }
    }
    for (let i = 0; i + 1 < S.length; i++) for (let k = 0; k < K; k++) { const p = i * K + k, q = i * K + (k + 1) % K; idx.push(p, q, p + K, q, q + K, p + K); }
    const c0 = pos.length / 3, c1 = c0 + 1; pos.push(...S[0].c, ...S[S.length - 1].c);
    for (let k = 0; k < K; k++) { idx.push(c0, (k + 1) % K, k); const o = (S.length - 1) * K; idx.push(c1, o + k, o + (k + 1) % K); }
    return { pos, idx };
  };
  HV.stl = function (M) {
    const n = M.idx.length / 3, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf); dv.setUint32(80, n, true);
    for (let i = 0; i < n; i++) { const o = 84 + i * 50, v = [0, 1, 2].map(k => M.idx[i * 3 + k] * 3); for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) dv.setFloat32(o + 12 + k * 12 + c * 4, M.pos[v[k] + c], true); }
    return buf;
  };

  /* ---------- whole pipeline ---------- */
  HV.run = async function (imgs, cfg, progress = () => { }) {
    const views = [];
    for (let i = 0; i < imgs.length; i++) {
      progress(`หากระดาษและตาราง ภาพ ${i + 1}/${imgs.length}`); await tick();
      const P = HV.detectPaper(imgs[i], cfg); views.push({ img: imgs[i], P, W: imgs[i].W, H: imgs[i].H, use: !P.err && imgs[i].use !== false });
    }
    const ok = views.filter(v => v.use && v.P.H); if (ok.length < 3) return { err: "ภาพที่หากระดาษเจอมีไม่ถึง 3 ภาพ", views };
    let f = HV.calibrate(ok.map(v => ({ Hm: v.P.H, W: v.W, H: v.H })));
    const fExif = cfg.fGuess ? cfg.fGuess(ok[0]) : null; let fNote = "คำนวณจากตาราง";
    if (!f || !isFinite(f) || f < .4 * Math.max(ok[0].W, ok[0].H) || f > 3 * Math.max(ok[0].W, ok[0].H)) { f = fExif || .8 * Math.hypot(ok[0].W, ok[0].H); fNote = "คำนวณไม่ได้ ใช้ค่าประมาณ"; }
    for (const v of ok) v.pose = HV.pose(v.P.H, f * v.W / ok[0].W, v.W, v.H);
    for (let i = 0; i < ok.length; i++) { progress(`แยกเงาวัตถุ ภาพ ${i + 1}/${ok.length}`); await tick(); ok[i].sil = HV.silhouette(ok[i].img, ok[i].P, cfg); }
    const use = ok.filter(v => v.sil.area > 50); progress("แกะสลักรูปทรง 3 มิติ"); await tick();
    const g = HV.carve(use.map(v => ({ mask: v.sil.mask, W: v.W, H: v.H, pose: v.pose })), cfg); if (!g) return { err: "เงาจากแต่ละภาพไม่ตรงกัน สร้างรูปทรงไม่ได้", views };
    g.cams = use.map(v => { const R = v.pose.R, t = v.pose.t; return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), (R[2] * t[0] + R[5] * t[1] + R[8] * t[2])]; });
    progress("วิเคราะห์หน้าตัด"); await tick();
    const A = HV.analyze(g, cfg.mode); A.f = f; A.fNote = fNote; A.vox = g.vox; A.topTouch = g.topTouch; A.nViews = use.length;
    const ppm = mean(use.map(v => v.P.ppm)), rmsPx = mean(use.map(v => v.P.rms).filter(isFinite));
    A.scaleRel = isFinite(rmsPx) ? rmsPx / ppm / Math.hypot(cfg.pw, cfg.ph) * 3 : .01;
    return { A, views, grid: g };
  };
  const tick = () => new Promise(r => setTimeout(r, 0));

  if (typeof module !== "undefined") module.exports = HV;
  if (typeof window !== "undefined") window.HV = HV;
})();
