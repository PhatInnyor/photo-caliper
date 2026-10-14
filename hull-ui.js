// UI for the multi-view silhouette tool (hull.js). Classic script; uses window.HV and window.PC.
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  if (!$("hvPanel") || !window.HV) return;
  const HV = window.HV, IM = []; let R = null, A = null;
  const f1 = (v, d = 1) => (v == null || !isFinite(v)) ? "–" : (+v).toFixed(d);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const KEY = "pc_hv";
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } };
  const save = o => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { } };
  const ids = ["hvMode", "hvSheet", "hvPW", "hvPH", "hvSP", "hvMG", "hvTol", "hvDens"];
  const st0 = load(); for (const k of ids) if (st0[k] != null && $(k)) $(k).value = st0[k]; $("hvTolV").textContent = $("hvTol").value;
  const persist = () => { const o = {}; for (const k of ids) o[k] = $(k).value; save(o); };
  ids.forEach(k => $(k).addEventListener("change", persist));
  $("hvTol").addEventListener("input", () => { $("hvTolV").textContent = $("hvTol").value; });
  const status = t => { $("hvStatus").textContent = t; };
  const cfg = () => ({ pw: +$("hvPW").value || 210, ph: +$("hvPH").value || 297, sp: +$("hvSP").value || 30, mg: +$("hvMG").value || 15, mode: $("hvMode").value, noGrid: $("hvSheet").value === "blank", sheet: $("hvSheet").value, coins: Object.assign({ coin1: 20, coin2: 21.75, coin5: 24, coin10: 26 }, (window.PC && PC.SET && PC.SET.coins) || {}), tol: +$("hvTol").value, allowMiss: $("hvAllow").checked ? 1 : 0, zmax: 300 });

  async function addFiles(files) {
    for (const f of files) {
      status("โหลด " + f.name);
      const bmp = await createImageBitmap(f); const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
      const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(bmp, 0, 0, W, H);
      IM.push({ name: f.name, W, H, px: x.getImageData(0, 0, W, H).data, canvas: c, use: true });
    }
    status(`${IM.length} ภาพ · กด "คำนวณ"`); R = null; A = null; drawThumbs(); render();
  }
  function drawThumbs() {
    const box = $("hvThumbs"); box.innerHTML = "";
    IM.forEach((im, i) => {
      const v = R && R.views && R.views[i], tw = 168, th = Math.round(tw * im.H / im.W), c = document.createElement("canvas"); c.width = tw; c.height = th; const x = c.getContext("2d"); x.drawImage(im.canvas, 0, 0, tw, th);
      const s = tw / im.W;
      if (v && v.sil) { const m = v.sil.mask, o = x.getImageData(0, 0, tw, th); for (let y = 0; y < th; y++) for (let xx = 0; xx < tw; xx++) { const sx = Math.min(im.W - 1, Math.round(xx / s)), sy = Math.min(im.H - 1, Math.round(y / s)); if (m[sy * im.W + sx]) { const j = (y * tw + xx) * 4; o.data[j] = o.data[j] * .4 + 40; o.data[j + 1] = o.data[j + 1] * .4 + 200 * .6; o.data[j + 2] = o.data[j + 2] * .4 + 230 * .6; } } x.putImageData(o, 0, 0); }
      if (v && v.P && v.P.corners) { x.strokeStyle = v.P.markOK ? "#5FC484" : "#E9A845"; x.lineWidth = 2; x.beginPath(); v.P.corners.forEach((p, k) => k ? x.lineTo(p[0] * s, p[1] * s) : x.moveTo(p[0] * s, p[1] * s)); x.closePath(); x.stroke(); x.fillStyle = "#F27560"; const p0 = v.P.corners[0]; x.beginPath(); x.arc(p0[0] * s, p0[1] * s, 4, 0, 7); x.fill(); }
      if (!im.use) { x.fillStyle = "rgba(0,0,0,.6)"; x.fillRect(0, 0, tw, th); x.fillStyle = "#fff"; x.font = "bold 14px sans-serif"; x.fillText("ไม่ใช้", 8, 20); }
      const fig = document.createElement("figure"); c.style.width = "100%"; c.style.display = "block"; fig.appendChild(c);
      const cap = document.createElement("figcaption"); cap.style.cssText = "font-size:11px;padding:2px 4px"; cap.textContent = v ? (v.P.err ? "✗ " + v.P.err : `${cfg().sheet === "coins" ? `เหรียญ 4 ✓ · ขนาดต่าง ${f1(v.P.rms, 1)}%` : cfg().noGrid ? "ขอบกระดาษ" : `ตาราง ${v.P.grid} จุด · ${f1(v.P.rms, 2)} px`}${v.P.markOK ? "" : " · ไม่เห็นเครื่องหมายมุม"}`) : `${i + 1}. ${im.name}`; fig.appendChild(cap);
      fig.onclick = () => { im.use = !im.use; drawThumbs(); status(im.use ? "ใช้ภาพนี้" : "ไม่ใช้ภาพนี้ · กดคำนวณใหม่"); };
      box.appendChild(fig);
    });
  }
  async function run() {
    if (IM.filter(i => i.use).length < 3) { status("ต้องมีอย่างน้อย 3 ภาพ (แนะนำ 8–12)"); return; }
    $("hvRun").disabled = true; persist();
    try {
      const imgs = IM.filter(i => i.use); R = await HV.run(imgs, cfg(), status);
      // map views back to IM order for thumbnails
      if (R.views) { const all = []; let j = 0; IM.forEach(im => { all.push(im.use ? R.views[j++] : null); }); R.views = all; }
      if (R.err) { status("✗ " + R.err); A = null; } else { A = R.A; $("hvSplits").value = A.splits.join(", "); status(`เสร็จ · ใช้ ${A.nViews} ภาพ · voxel ${f1(A.vox, 2)} มม.`); }
    } catch (e) { console.error(e); status("ผิดพลาด: " + e.message); }
    $("hvRun").disabled = false; drawThumbs(); render();
  }
  function warnings() {
    const w = [], vs = (R && R.views || []).filter(Boolean);
    const noMark = vs.filter(v => v.P && !v.P.err && !v.P.markOK).length; if (noMark) w.push(`${noMark} ภาพไม่เห็นสี่เหลี่ยมทึบที่มุม ทิศของกระดาษอาจสลับ ทำให้รูปทรงผิด`);
    const coinsMode = cfg().sheet === "coins"; const badRms = coinsMode ? 0 : vs.filter(v => v.P && v.P.rms > 1.5).length; if (coinsMode) { w.push("ใช้เหรียญ 4 เหรียญ: มุมกล้องมาจากจุดกลางเหรียญ 4 จุด (ทดสอบภาพจำลอง: รอบวง +4%, ปริมาตร +7%)"); if (A.coinFrontal < .97) w.push(`ไม่มีภาพที่ถ่ายตรงจากด้านบนพอ (วงกลมที่กลมที่สุด ${f1(A.coinFrontal * 100, 0)}%) ตำแหน่งเหรียญอาจคลาด ควรมีภาพตรงลงมา 1 ภาพ`); } if (cfg().noGrid) w.push("ใช้ A4 เปล่า: มุมกล้องมาจากขอบกระดาษ 4 มุมเท่านั้น ค่าจะคลาดมากกว่าแบบตารางเล็กน้อย"); if (badRms) w.push(`${badRms} ภาพหาเส้นตารางได้ไม่แม่น (> 1.5 px) ควรถ่ายให้กระดาษใหญ่ขึ้นหรือคมขึ้น`);
    const touch = vs.filter(v => v.sil && v.sil.touch).length; if (touch) w.push(`${touch} ภาพเงาวัตถุชนขอบภาพ`);
    if (A.nViews < 6) w.push("ใช้น้อยกว่า 6 ภาพ ค่าเส้นรอบวงและปริมาตรจะเกินจริงมากขึ้น");
    if (A.fNote !== "คำนวณจากตาราง") w.push("คำนวณทางยาวโฟกัสจากตารางไม่ได้ ความสูงอาจคลาดมาก ถ่ายให้เอียงหลายแบบมากขึ้น");
    if (A.topTouch) w.push("รูปทรงชนเพดานการคำนวณ 300 มม.");
    if (A.mode === "stand") w.push("ส่วนปลายบนอาจสูงเกินจริงถ้าไม่มีภาพมุมต่ำ (15–30°)");
    else w.push("ปลายทั้งสองข้างอาจยาวเกินจริงเล็กน้อย (ราว 1–3 มม.) ด้านที่แนบกระดาษสมมติว่าเป็นวงรี");
    return w;
  }
  function render() {
    const out = $("hvOut"), more = $("hvMore"), ch = $("hvChart");
    if (!A) { out.innerHTML = ""; more.hidden = true; ch.hidden = true; return; }
    const S = A.slices, gmax = Math.max(...S.map(s => s.girth)), imax = S.findIndex(s => s.girth === gmax), wmax = Math.max(...S.map(s => s.w)), hmax = Math.max(...S.map(s => s.h));
    const rel = Math.hypot(A.scaleRel || 0, .02), vrel = Math.hypot(A.scaleRel * 3 || 0, .05);
    const row = (k, v, u, sd) => `<tr><td>${k}</td><td style="text-align:right"><b>${v}</b> ${u}${sd ? ` <span class="muted">± ${sd}</span>` : ""}</td></tr>`;
    let h = `<table class="tbl" style="width:100%"><tbody>`;
    h += row(A.mode === "stand" ? "ความสูง" : "ความยาวตามแนวโค้ง", f1(A.length), "มม.", f1(A.length * rel + A.vox, 1));
    h += row("ความยาวเส้นตรง (ปลายถึงปลาย)", f1(A.straight), "มม.", f1(A.straight * rel + A.vox, 1));
    h += row(A.mode === "stand" ? "ความกว้างมากสุด" : "ความกว้างมากสุด", f1(wmax), "มม.", f1(wmax * rel + A.vox, 1));
    h += row(A.mode === "stand" ? "ความหนามากสุด" : "ความหนา/สูงมากสุด", f1(hmax), "มม.", f1(hmax * rel + A.vox, 1));
    h += row(`เส้นรอบวงมากสุด (ที่ ${f1(S[imax].s, 0)} มม.)`, f1(gmax), "มม.", f1(gmax * rel + Math.PI * A.vox / 2, 1));
    h += row("ปริมาตร (หน้าตัดวงรี)", f1(A.vol / 1000, 1), "ซม³ (มล.)", f1(A.vol / 1000 * vrel, 1));
    h += row("ปริมาตรเปลือกเงา (ขอบบน)", f1(A.volHull / 1000, 1), "ซม³", "");
    h += `</tbody></table><p class="muted" style="margin:6px 0">ค่า ± เป็นค่าประมาณจากความแม่นของตารางและขนาด voxel · วิธีนี้มักให้ค่าเกินจริงเล็กน้อย (ทดสอบกับรูปทรงจำลอง: รอบวง +1–3%, ปริมาตร +2–7%) · โฟกัส ${f1(A.f, 0)} px (${A.fNote})</p>`;
    const w = warnings(); if (w.length) h += `<div class="warnbox">${w.map(esc).join("<br>")}</div>`;
    out.innerHTML = h; more.hidden = false; ch.hidden = false; drawChart(); renderSeg();
  }
  function splits() { return $("hvSplits").value.split(/[,\s]+/).map(Number).filter(v => isFinite(v) && v > 0); }
  function renderSeg() {
    const sg = HV.segments(A, splits()), wt = +$("hvWeight").value, dn = +$("hvDens").value || 1.15;
    let h = `<table class="tbl" style="width:100%"><thead><tr><th>ส่วน</th><th>ช่วง (มม.)</th><th>ยาว</th><th>รอบวง ต่ำ/เฉลี่ย/สูง</th><th>ปริมาตร</th></tr></thead><tbody>`;
    sg.forEach((g, i) => { h += `<tr><td>${i + 1}</td><td>${f1(g.from, 0)}–${f1(g.to, 0)}</td><td>${f1(g.len)}</td><td>${f1(g.gmin)} / ${f1(g.gmean)} / ${f1(g.gmax)}</td><td>${f1(g.vol / 1000, 1)} ซม³</td></tr>`; });
    h += `</tbody></table>`;
    if (wt > 0) { const vw = wt / dn, d = (A.vol / 1000 - vw) / vw * 100; h += `<p style="margin:8px 0">จากน้ำหนัก: ${f1(wt)} g ÷ ${f1(dn, 2)} = <b>${f1(vw, 1)} ซม³</b> · ภาพให้ ${f1(A.vol / 1000, 1)} ซม³ (${d >= 0 ? "+" : ""}${f1(d, 1)}%)${Math.abs(d) > 10 ? " · ต่างเกิน 10%: ตรวจความหนาแน่นวัสดุ ส่วนกลวงภายใน หรือภาพที่แยกเงาไม่ดี" : ""}</p>${window.PC && PC.addValidExternal ? "" : ""}`; }
    $("hvSeg").innerHTML = h; drawChart();
  }
  function drawChart() {
    const c = $("hvChart"), x = c.getContext("2d"), W = c.width, H = c.height, S = A.slices; x.clearRect(0, 0, W, H);
    const cs = getComputedStyle(document.documentElement), col = n => cs.getPropertyValue(n).trim() || "#888";
    const L = S[S.length - 1].s || 1, gm = Math.max(...S.map(s => s.girth)) * 1.1, pl = 54, pr = 14, pt = 14, pb = 40;
    const X = s => pl + (W - pl - pr) * s / L, Y = g => H - pb - (H - pt - pb) * g / gm;
    x.strokeStyle = col("--line"); x.fillStyle = col("--muted"); x.font = "20px sans-serif"; x.lineWidth = 1;
    for (let k = 0; k <= 4; k++) { const g = gm * k / 4; x.beginPath(); x.moveTo(pl, Y(g)); x.lineTo(W - pr, Y(g)); x.stroke(); x.fillText(f1(g, 0), 4, Y(g) + 6); }
    for (let k = 0; k <= 5; k++) { const s = L * k / 5; x.fillText(f1(s, 0), X(s) - 12, H - 12); }
    x.strokeStyle = col("--acc"); x.lineWidth = 3; x.beginPath(); S.forEach((s, i) => i ? x.lineTo(X(s.s), Y(s.girth)) : x.moveTo(X(s.s), Y(s.girth))); x.stroke();
    x.strokeStyle = col("--amber"); x.setLineDash([8, 6]); x.lineWidth = 2; for (const sp of splits()) { x.beginPath(); x.moveTo(X(sp), pt); x.lineTo(X(sp), H - pb); x.stroke(); } x.setLineDash([]);
    x.fillStyle = col("--muted"); x.fillText("รอบวง (มม.) ตามตำแหน่งจากปลาย (มม.)", pl + 6, pt + 18);
  }
  const dl = (blob, name) => { if (window.PC && PC.download) return PC.download(blob, name); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); };
  $("hvFiles").addEventListener("change", e => { addFiles([...e.target.files]); e.target.value = ""; });
  $("hvRun").addEventListener("click", run);
  $("hvClear").addEventListener("click", () => { IM.length = 0; R = null; A = null; drawThumbs(); render(); status("ล้างแล้ว"); });
  ["hvSplits", "hvWeight", "hvDens"].forEach(k => $(k).addEventListener("input", () => A && renderSeg()));
  $("hvSTL").addEventListener("click", () => { if (A) dl(new Blob([HV.stl(HV.mesh(A))], { type: "model/stl" }), "multiview_mm.stl"); });
  $("hv3D").addEventListener("click", () => { if (!A) return; const M = HV.mesh(A); if (window.PC3D && PC3D.loadMesh) { PC3D.loadMesh(M.pos, M.idx, "จากเงาหลายมุม"); document.getElementById("stage3d").scrollIntoView({ behavior: "smooth" }); } });
  $("hvCSV").addEventListener("click", () => { if (!A) return; const t = "s_mm,girth_mm,width_mm,height_mm,area_mm2\n" + A.slices.map(s => [s.s, s.girth, s.w, s.h, s.area].map(v => (+v).toFixed(2)).join(",")).join("\n"); navigator.clipboard && navigator.clipboard.writeText(t).then(() => status("คัดลอกโปรไฟล์แล้ว"), () => status("คัดลอกไม่ได้")); });
})();
