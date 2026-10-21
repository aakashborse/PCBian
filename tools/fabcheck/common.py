"""Checks shared by the Gerber and ODB++ verifiers: given the copper islands of each layer, the
drill hits and the outline read back from the fabrication files, compare them with expect.json."""
import json
from pathlib import Path

from shapely.geometry import Point
from shapely.strtree import STRtree

TOL = 0.01  # mm


def pieces(geom):
    """Separate polygons of a (multi)polygon."""
    if geom.is_empty:
        return []
    return list(geom.geoms) if hasattr(geom, "geoms") else [geom]


def load_expect(root):
    return json.loads((Path(root) / "expect.json").read_text())


def verify(expect, copper, holes, outline_bounds, label):
    """copper: {layer index: [polygons]}; holes: [{x, y, d, from, to}] (from/to None = through);
    outline_bounds: (x0, y0, x1, y1) of the board outline read back, or None. Returns exit status."""
    failures, notes = [], []
    n_layers = len(expect["copper"])
    if len(copper) != n_layers:
        failures.append(f"copper layers: found {len(copper)}, expected {n_layers}")
    trees = {i: STRtree(p) for i, p in copper.items()}
    for i, p in sorted(copper.items()):
        notes.append(f"L{i + 1}: {len(p)} copper islands")

    def island_at(layer, x, y):
        if layer not in trees:
            return None
        pt = Point(x, y)
        for k in trees[layer].query(pt.buffer(TOL)):
            if copper[layer][k].distance(pt) <= TOL:
                return (layer, int(k))
        return None

    parent = {}

    def find(k):
        parent.setdefault(k, k)
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    def union(a, b):
        parent[find(a)] = find(b)

    # ---- drills ----
    through = [h for h in holes if h.get("from") is None]
    partial = [h for h in holes if h.get("from") is not None]
    unmatched = list(through)
    for w in expect["drills"]:
        hit = next((h for h in unmatched if abs(h["x"] - w["x"]) <= TOL and abs(h["y"] - w["y"]) <= TOL and abs(h["d"] - w["d"]) <= 0.002), None)
        if hit:
            unmatched.remove(hit)
        else:
            failures.append(f"missing drill {w['d']}mm at ({w['x']}, {w['y']})")
    for h in unmatched[:10]:
        failures.append(f"unexpected drill {h['d']:.3f}mm at ({h['x']:.3f}, {h['y']:.3f})")
    if len(partial) != len(expect["partialHoles"]):
        failures.append(f"blind/buried holes: found {len(partial)}, expected {len(expect['partialHoles'])}")
    notes.append(f"drills: {len(through)} through, {len(partial)} blind/buried")

    # Plated holes join the copper they pass through.
    for w in expect["drills"]:
        if w["plated"]:
            ks = [k for k in (island_at(l, w["x"], w["y"]) for l in range(n_layers)) if k]
            for k in ks[1:]:
                union(ks[0], k)
    for h in expect["partialHoles"]:
        ks = [k for k in (island_at(l, h["x"], h["y"]) for l in range(h["from"], h["to"] + 1)) if k]
        for k in ks[1:]:
            union(ks[0], k)

    # ---- probes: coverage, opens, shorts ----
    piece_of_cluster, nets_of_piece, uncovered = {}, {}, 0
    for layer in expect["copper"]:
        for p in layer["probes"]:
            k = island_at(layer["index"], p["x"], p["y"])
            if not k:
                uncovered += 1
                if uncovered <= 10:
                    failures.append(f"no copper under {p['what']} on L{layer['index'] + 1} at ({p['x']}, {p['y']})")
                continue
            piece_of_cluster.setdefault(p["cluster"], set()).add(k)
            if p.get("net"):
                nets_of_piece.setdefault(k, set()).add(p["net"])
    if uncovered > 10:
        failures.append(f"... {uncovered - 10} more uncovered probes")
    opens = 0
    for cluster, ks in piece_of_cluster.items():
        roots = {find(k) for k in ks}
        if len(roots) > 1:
            opens += 1
            if opens <= 10:
                failures.append(f"open: connected copper ({cluster}) is split into {len(roots)} pieces")
    merged = {}
    for k, nets in nets_of_piece.items():
        merged.setdefault(find(k), set()).update(nets)
    shorts = [nets for nets in merged.values() if len(nets) > 1]
    for nets in shorts[:10]:
        failures.append(f"short: one piece of copper carries {', '.join(sorted(nets)[:4])}")
    notes.append(f"probes: {sum(len(l['probes']) for l in expect['copper'])}, clusters: {len(piece_of_cluster)}, opens: {opens}, shorts: {len(shorts)}")

    # ---- outline ----
    xs = [p["x"] for p in expect["outline"]]
    ys = [p["y"] for p in expect["outline"]]
    if outline_bounds is None:
        failures.append("no board outline found")
    elif any(abs(a - b) > 0.05 for a, b in zip(outline_bounds, (min(xs), min(ys), max(xs), max(ys)))):
        failures.append(f"outline extent {tuple(round(v, 3) for v in outline_bounds)} differs from the board {(min(xs), min(ys), max(xs), max(ys))}")

    for n in notes:
        print(f"  {n}")
    if failures:
        print(f"{label} CHECK FAILED ({len(failures)} problems):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"{label} CHECK PASSED")
    return 0
