#!/usr/bin/env python3
"""Photo Caliper: scale a COLMAP reconstruction to millimetres using refs.json.
For each image with a reference segment (p1,p2 in original image px, length_mm),
depth Z is taken as the median camera-space depth of 3D points observed near the
segment; scale = length_mm / (px_len * Z / f). Median over images.
Pure Python (no numpy)."""
import json, math, os, struct, sys, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
TXT = os.path.join(HERE, "sparse_txt")

def qrot(q, v):
    w, x, y, z = q
    R = [[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
         [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
         [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]]
    return [sum(R[i][j]*v[j] for j in range(3)) for i in range(3)]

def read_cameras(p):
    cams = {}
    for ln in open(p):
        if ln.startswith("#") or not ln.strip(): continue
        t = ln.split(); cid = int(t[0]); model = t[1]; w, h = int(t[2]), int(t[3]); par = list(map(float, t[4:]))
        if model in ("SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL", "SIMPLE_RADIAL_FISHEYE", "RADIAL_FISHEYE"): fx = fy = par[0]; cx, cy = par[1], par[2]
        else: fx, fy, cx, cy = par[0], par[1], par[2], par[3]
        cams[cid] = dict(w=w, h=h, f=(fx+fy)/2, cx=cx, cy=cy)
    return cams

def read_images(p):
    ims = {}; L = [l for l in open(p) if not l.startswith("#")]
    for i in range(0, len(L) - 1, 2):
        t = L[i].split()
        if len(t) < 10: continue
        q = list(map(float, t[1:5])); tr = list(map(float, t[5:8])); cid = int(t[8]); name = t[9]
        o = L[i+1].split(); obs = []
        for k in range(0, len(o) - 2, 3):
            pid = int(o[k+2])
            if pid >= 0: obs.append((float(o[k]), float(o[k+1]), pid))
        ims[name] = dict(q=q, t=tr, cam=cid, obs=obs)
    return ims

def read_points(p):
    P = {}
    for ln in open(p):
        if ln.startswith("#") or not ln.strip(): continue
        t = ln.split(); P[int(t[0])] = (float(t[1]), float(t[2]), float(t[3]))
    return P

def seg_dist(px, a, b):
    ax, ay = a; bx, by = b; dx, dy = bx-ax, by-ay; L2 = dx*dx+dy*dy or 1
    u = max(0, min(1, ((px[0]-ax)*dx+(px[1]-ay)*dy)/L2))
    return math.hypot(px[0]-ax-u*dx, px[1]-ay-u*dy)

def compute_scale(refs, cams, ims, pts):
    out = []
    for r in refs:
        im = ims.get(r["image"])
        if not im: print("  skip (not registered):", r["image"]); continue
        cam = cams[im["cam"]]; plen = math.dist(r["p1"], r["p2"])
        if plen < 5: continue
        zs = []
        for rad in (plen*0.6, plen*1.5, plen*4):
            zs = []
            for (x, y, pid) in im["obs"]:
                if seg_dist((x, y), r["p1"], r["p2"]) <= rad and pid in pts:
                    pc = qrot(im["q"], pts[pid]); z = pc[2] + im["t"][2]
                    if z > 0: zs.append(z)
            if len(zs) >= 5: break
        if len(zs) < 3: print("  skip (few 3D points near ref):", r["image"]); continue
        Z = statistics.median(zs)
        s = r["length_mm"] / (plen * Z / cam["f"])
        out.append(s); print(f"  {r['image']}: {s:.5g} mm/unit ({len(zs)} pts)")
    return out

def scale_ply(src, dst, s):
    with open(src, "rb") as f: data = f.read()
    end = data.index(b"end_header") + len(b"end_header")
    while data[end:end+1] in (b"\r", b"\n"): end += 1
    hdr = data[:end].decode("ascii", "replace"); lines = hdr.splitlines()
    fmt = next(l.split()[1] for l in lines if l.startswith("format"))
    elems = []; cur = None
    for l in lines:
        t = l.split()
        if t[:1] == ["element"]: cur = [t[1], int(t[2]), []]; elems.append(cur)
        elif t[:1] == ["property"] and cur: cur[2].append(t[1:])
    TY = {"char":"b","int8":"b","uchar":"B","uint8":"B","short":"h","int16":"h","ushort":"H","uint16":"H","int":"i","int32":"i","uint":"I","uint32":"I","float":"f","float32":"f","double":"d","float64":"d"}
    body = bytearray(data[end:])
    if fmt == "ascii":
        rows = body.decode().split("\n"); v = elems[0]; names = [p[-1] for p in v[2]]
        ix = [names.index(c) for c in ("x", "y", "z")]
        for i in range(v[1]):
            t = rows[i].split()
            for k in ix: t[k] = repr(float(t[k]) * s)
            rows[i] = " ".join(t)
        open(dst, "wb").write(data[:end] + "\n".join(rows).encode()); return
    bo = "<" if "little" in fmt else ">"
    v = elems[0]
    if v[0] != "vertex" or any(p[0] == "list" for p in v[2]): raise SystemExit("unsupported PLY layout")
    st = struct.Struct(bo + "".join(TY[p[0]] for p in v[2])); names = [p[-1] for p in v[2]]
    ix = [names.index(c) for c in ("x", "y", "z")]
    for i in range(v[1]):
        o = i * st.size; vals = list(st.unpack_from(body, o))
        for k in ix: vals[k] *= s
        st.pack_into(body, o, *vals)
    open(dst, "wb").write(data[:end] + bytes(body))

def main():
    refs = json.load(open(os.path.join(HERE, "refs.json")))["refs"]
    if not refs: raise SystemExit("refs.json has no reference - model stays unscaled")
    cams = read_cameras(os.path.join(TXT, "cameras.txt")); ims = read_images(os.path.join(TXT, "images.txt")); pts = read_points(os.path.join(TXT, "points3D.txt"))
    S = compute_scale(refs, cams, ims, pts)
    if not S: raise SystemExit("could not compute scale")
    s = statistics.median(S); spread = (statistics.stdev(S) / s * 100) if len(S) > 1 else None
    print(f"scale = {s:.6g} mm/unit" + (f" (spread {spread:.1f}% over {len(S)} images)" if spread is not None else " (1 image)"))
    for name in ("dense/meshed-poisson.ply", "dense/fused.ply"):
        p = os.path.join(HERE, name)
        if os.path.exists(p): scale_ply(p, p[:-4] + "_mm.ply", s); print("wrote", p[:-4] + "_mm.ply")
    json.dump({"mm_per_unit": s, "per_image": S, "spread_pct": spread}, open(os.path.join(HERE, "scale.json"), "w"), indent=1)

if __name__ == "__main__": main()
