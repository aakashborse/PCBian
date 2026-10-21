#!/usr/bin/env python3
"""Verify PCBian Gerber/Excellon output against the design, with independent parsers.

Reads the copper layers with gerbonara (layer order from each file's X2 FileFunction attribute),
rebuilds their copper as shapely geometry in drawing order (dark adds, clear removes), joins the
islands of different layers through plated drill hits, and compares with expect.json written by
make.ts:

  * every probe (pad centre, via, trace segment midpoint) is covered by copper;
  * opens: everything the design connects ends up in one piece of copper;
  * shorts: no piece of copper carries two nets;
  * drills: same holes (position and size) as the design, nothing extra;
  * outline: the profile layer matches the board outline's extent.

Usage: gerber_check.py <dir written by make.ts>      (exit status 1 on any failure)
"""
import math
import re
import sys
from pathlib import Path

from gerbonara import ExcellonFile, GerberFile
from gerbonara import graphic_primitives as gp
from gerbonara.utils import MM
from shapely.geometry import LineString, Point, Polygon, box
from shapely.affinity import rotate as srotate
from shapely.ops import unary_union

from common import load_expect, pieces, verify

def prim_shape(p):
    """A gerbonara graphic primitive as shapely geometry."""
    if isinstance(p, gp.Circle):
        return Point(p.x, p.y).buffer(p.r, quad_segs=16)
    if isinstance(p, gp.Rectangle):
        r = box(p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2)
        return srotate(r, p.rotation, origin=(p.x, p.y), use_radians=True) if p.rotation else r
    if isinstance(p, gp.Line):
        return LineString([(p.x1, p.y1), (p.x2, p.y2)]).buffer(p.width / 2, quad_segs=16)
    if isinstance(p, gp.Arc):
        a0 = math.atan2(p.y1 - p.cy, p.x1 - p.cx)
        a1 = math.atan2(p.y2 - p.cy, p.x2 - p.cx)
        r = math.hypot(p.x1 - p.cx, p.y1 - p.cy)
        sweep = (a1 - a0) % (2 * math.pi)
        if p.clockwise:
            sweep -= 2 * math.pi
        pts = [(p.cx + r * math.cos(a0 + sweep * k / 32), p.cy + r * math.sin(a0 + sweep * k / 32)) for k in range(33)]
        return LineString(pts).buffer(p.width / 2, quad_segs=16)
    if isinstance(p, gp.ArcPoly):
        pts = [tuple(q) for q in p.outline]
        return Polygon(pts).buffer(0) if len(pts) >= 3 else None
    raise TypeError(f"unhandled primitive {type(p).__name__}")


def layer_geometry(path):
    """Copper of a Gerber file, applying dark and clear objects in order."""
    g = GerberFile.open(path)
    geom = Polygon()
    run, dark = [], True
    for obj in g.objects:
        for p in obj.to_primitives(unit=MM):
            if p.polarity_dark != dark and run:
                u = unary_union(run)
                geom = geom.union(u) if dark else geom.difference(u)
                run = []
            dark = p.polarity_dark
            s = prim_shape(p)
            if s is not None and not s.is_empty:
                run.append(s)
    if run:
        u = unary_union(run)
        geom = geom.union(u) if dark else geom.difference(u)
    return geom


def file_function(path):
    m = re.search(r"%TF\.FileFunction,([^*]*)\*%", path.read_text(errors="replace"))
    return m.group(1).split(",") if m else []


def main(root):
    root = Path(root)
    expect = load_expect(root)
    gdir = root / "gerber"
    copper, outline = {}, None
    for f in sorted(gdir.iterdir()):
        ff = file_function(f) if f.suffix.lower() not in (".drl", ".txt") else []
        if ff[:1] == ["Copper"]:
            copper[int(ff[1][1:]) - 1] = pieces(layer_geometry(f))
        elif ff[:1] == ["Profile"]:
            outline = f

    holes = []
    for f in sorted(gdir.iterdir()):
        if f.suffix.lower() != ".drl":
            continue
        span = re.search(r"Layer pair (\S+)", f.read_text(errors="replace"))
        for obj in ExcellonFile.open(f).objects:
            for p in obj.to_primitives(unit=MM):
                if isinstance(p, gp.Circle):
                    # Span files only need to be told apart from through holes here.
                    holes.append({"x": p.x, "y": p.y, "d": 2 * p.r, "from": 0 if span else None})

    bounds = None
    if outline:
        g = layer_geometry(outline)
        # The profile is stroked: its centre line is the outline.
        w = (g.bounds[2] - g.bounds[0] - (max(p["x"] for p in expect["outline"]) - min(p["x"] for p in expect["outline"]))) / 2
        bounds = (g.bounds[0] + w, g.bounds[1] + w, g.bounds[2] - w, g.bounds[3] - w)
    return verify(expect, copper, holes, bounds, "GERBER")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
