#!/usr/bin/env python3
"""Verify a PCBian ODB++ job against the design, with a reader written from the ODB++ v8 spec.

Reads matrix/matrix (layer rows, types, drill spans), the step profile and each layer's features
file (symbol table; P pads, L lines, A arcs, S surfaces with OB/OS/OC/OE contours; P/N polarity
applied in order), rebuilds the copper with shapely, and runs the same checks as gerber_check.py
(probes covered, no opens, no shorts, drills, outline). It also checks that the EDA data lists
every net of the design.

Usage: odb_check.py <dir written by make.ts>      (exit status 1 on any failure)
"""
import math
import re
import sys
from pathlib import Path

from shapely.affinity import rotate as srotate
from shapely.affinity import scale, translate
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from common import load_expect, pieces, verify


def blocks(text):
    """KEY { ... } blocks of a structured text file (the matrix)."""
    out = []
    for m in re.finditer(r"(\w+)\s*\{([^}]*)\}", text):
        fields = dict(l.strip().split("=", 1) for l in m.group(2).splitlines() if "=" in l)
        out.append((m.group(1), fields))
    return out


def symbol_shape(name, units_mm):
    """Standard symbol at the origin, sizes in microns (metric) or mils."""
    k = 0.001 if units_mm else 0.0254

    def nums(s):
        return [float(v) * k for v in s.split("x")]

    if m := re.fullmatch(r"r([\d.]+)", name):
        return ("round", float(m.group(1)) * k)
    if m := re.fullmatch(r"s([\d.]+)", name):
        d = float(m.group(1)) * k
        return ("shape", box(-d / 2, -d / 2, d / 2, d / 2))
    if m := re.fullmatch(r"rect([\d.]+x[\d.]+)(?:xr([\d.]+))?", name):
        w, h = nums(m.group(1))
        r = float(m.group(2)) * k if m.group(2) else 0
        b = box(-w / 2 + r, -h / 2 + r, w / 2 - r, h / 2 - r)
        return ("shape", b.buffer(r, quad_segs=16) if r else b)
    if m := re.fullmatch(r"oval([\d.]+x[\d.]+)", name):
        w, h = nums(m.group(1))
        r = min(w, h) / 2
        seg = LineString([(-w / 2 + r, 0), (w / 2 - r, 0)]) if w >= h else LineString([(0, -h / 2 + r), (0, h / 2 - r)])
        return ("shape", seg.buffer(r, quad_segs=16))
    raise ValueError(f"unsupported symbol {name}")


def orient_shape(shape, orient, angle):
    """Apply an ODB++ pad orientation (0-7: 90° steps, 4-7 mirrored; 8/9: any angle)."""
    if orient in (8, 9):
        mirror, rot = orient == 9, angle
    else:
        mirror, rot = orient >= 4, (orient % 4) * 90
    if mirror:
        shape = scale(shape, -1, 1, origin=(0, 0))
    # ODB++ rotation is clockwise.
    return srotate(shape, -rot, origin=(0, 0)) if rot else shape


def arc_points(xs, ys, xe, ye, xc, yc, cw, n=32):
    a0 = math.atan2(ys - yc, xs - xc)
    a1 = math.atan2(ye - yc, xe - xc)
    r = math.hypot(xs - xc, ys - yc)
    sweep = (a1 - a0) % (2 * math.pi)
    if cw:
        sweep -= 2 * math.pi
    if abs(sweep) < 1e-12:
        sweep = -2 * math.pi if cw else 2 * math.pi
    return [(xc + r * math.cos(a0 + sweep * i / n), yc + r * math.sin(a0 + sweep * i / n)) for i in range(1, n + 1)]


def read_features(path):
    """A layer's image: list of (polarity_dark, geometry) in drawing order, and pad hits (for drills)."""
    text = path.read_text()
    units_mm = "UNITS=MM" in text.upper()
    k = 1.0 if units_mm else 25.4  # coordinates: mm or inches
    syms = {}
    objs, pads = [], []
    lines = iter(text.splitlines())
    for raw in lines:
        line = raw.split(";")[0].strip()
        if not line or line.startswith("#") or line.startswith("@") or line.startswith("&") or line.startswith("UNITS") or line.startswith("ID="):
            continue
        if line.startswith("$"):
            i, name = line[1:].split(None, 1)
            syms[int(i)] = name.strip()
            continue
        f = line.split()
        t = f[0]
        if t == "P":
            x, y, s, pol = float(f[1]) * k, float(f[2]) * k, int(f[3]), f[4]
            orient = int(f[6]) if len(f) > 6 else 0
            angle = float(f[7]) if orient in (8, 9) and len(f) > 7 else 0
            kind, g = symbol_shape(syms[s], units_mm)
            if kind == "round":
                pads.append((x, y, g))
                shape = Point(x, y).buffer(g / 2, quad_segs=16)
            else:
                shape = translate(orient_shape(g, orient, angle), x, y)
            objs.append((pol == "P", shape))
        elif t == "L":
            xs, ys, xe, ye, s, pol = float(f[1]) * k, float(f[2]) * k, float(f[3]) * k, float(f[4]) * k, int(f[5]), f[6]
            kind, d = symbol_shape(syms[s], units_mm)
            if kind != "round":
                raise ValueError(f"line with non-round symbol {syms[s]}")
            objs.append((pol == "P", LineString([(xs, ys), (xe, ye)]).buffer(d / 2, quad_segs=16)))
        elif t == "A":
            xs, ys, xe, ye, xc, yc = (float(v) * k for v in f[1:7])
            s, pol, cw = int(f[7]), f[8], f[10].upper() == "Y"
            kind, d = symbol_shape(syms[s], units_mm)
            pts = [(xs, ys)] + arc_points(xs, ys, xe, ye, xc, yc, cw)
            objs.append((pol == "P", LineString(pts).buffer(d / 2, quad_segs=16)))
        elif t == "S":
            pol = f[1]
            islands, holes, ring, kind = [], [], [], None
            for raw2 in lines:
                g = raw2.split(";")[0].split()
                if not g:
                    continue
                if g[0] == "OB":
                    ring, kind = [(float(g[1]) * k, float(g[2]) * k)], g[3]
                elif g[0] == "OS":
                    ring.append((float(g[1]) * k, float(g[2]) * k))
                elif g[0] == "OC":
                    xe, ye, xc, yc = (float(v) * k for v in g[1:5])
                    ring.extend(arc_points(ring[-1][0], ring[-1][1], xe, ye, xc, yc, g[5].upper() == "Y", 16))
                elif g[0] == "OE":
                    (islands if kind == "I" else holes).append(Polygon(ring).buffer(0))
                elif g[0] == "SE":
                    break
            shape = unary_union(islands)
            if holes:
                shape = shape.difference(unary_union(holes))
            objs.append((pol == "P", shape))
        else:
            raise ValueError(f"unknown feature record {t!r} in {path}")
    return objs, pads


def image(objs):
    geom = Polygon()
    run, dark = [], True
    for d, g in objs:
        if d != dark and run:
            u = unary_union(run)
            geom = geom.union(u) if dark else geom.difference(u)
            run = []
        dark = d
        run.append(g)
    if run:
        u = unary_union(run)
        geom = geom.union(u) if dark else geom.difference(u)
    return geom


def main(root):
    root = Path(root)
    expect = load_expect(root)
    jobs = [p for p in (root / "odb").iterdir() if (p / "matrix" / "matrix").exists()]
    if len(jobs) != 1:
        print("ODB CHECK FAILED: expected one job directory with matrix/matrix")
        return 1
    job = jobs[0]
    matrix = blocks((job / "matrix" / "matrix").read_text())
    steps = [f["NAME"].lower() for kind, f in matrix if kind == "STEP"]
    rows = sorted((f for kind, f in matrix if kind == "LAYER"), key=lambda f: int(f["ROW"]))
    step = job / "steps" / steps[0]
    signal = [r["NAME"].lower() for r in rows if r.get("TYPE") in ("SIGNAL", "POWER_GROUND", "MIXED")]

    copper = {}
    for i, name in enumerate(signal):
        objs, _ = read_features(step / "layers" / name / "features")
        copper[i] = pieces(image(objs))

    holes = []
    for r in rows:
        if r.get("TYPE") != "DRILL":
            continue
        start, end = r.get("START_NAME", "").lower(), r.get("END_NAME", "").lower()
        span = (signal.index(start), signal.index(end)) if start in signal and end in signal else (0, len(signal) - 1)
        through = span == (0, len(signal) - 1)
        _, pads = read_features(step / "layers" / r["NAME"].lower() / "features")
        for x, y, d in pads:
            holes.append({"x": x, "y": y, "d": d, "from": None if through else span[0], "to": None if through else span[1]})

    objs, _ = read_features(step / "profile")
    prof = image(objs)
    bounds = prof.bounds if not prof.is_empty else None

    status = verify(expect, copper, holes, bounds, "ODB++")

    # EDA data: every net the design routes must be present.
    eda = step / "eda" / "data"
    if eda.exists():
        listed = {l.split()[1] for l in eda.read_text().splitlines() if l.startswith("NET ")}
        wanted = {p["net"].replace(" ", "_") for l in expect["copper"] for p in l["probes"] if p.get("net")}
        missing = sorted(wanted - listed)
        if missing:
            print(f"  - EDA data lacks {len(missing)} net(s): {', '.join(missing[:5])}")
            status = 1
        else:
            print(f"  EDA data lists all {len(wanted)} routed nets")
    else:
        print("  - no EDA data (steps/<step>/eda/data)")
        status = 1
    return status


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
