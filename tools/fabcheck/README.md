# Fabrication output checks

Independent verification of PCBian's Gerber/Excellon and ODB++ output. The files are read back
with parsers that share no code with the writers ([gerbonara](https://gitlab.com/gerbolyze/gerbonara)
for Gerber/Excellon, and a reader written from the ODB++ v8 specification), the copper is rebuilt
with [shapely](https://shapely.readthedocs.io), and the result is compared with what the design
says the board must contain:

- every pad, via and trace segment is covered by copper on its layers;
- **opens**: copper the design connects is one piece (layers joined through plated holes);
- **shorts**: no piece of copper carries two nets;
- drills: same holes, positions and sizes, nothing extra; blind/buried spans counted;
- the board outline's extent;
- ODB++ only: the EDA data lists every routed net.

This is a bare-board electrical test on the artwork, before anything goes to a fab.

## Use

```sh
python3 -m venv .venv && .venv/bin/pip install -r tools/fabcheck/requirements.txt

# Write the outputs and expectations for a design (KiCad, EAGLE or Altium files, or a PCBian
# project's data/projects/<id>.ydoc):
npx tsx tools/fabcheck/make.ts out/board path/to/board.kicad_pcb path/to/*.kicad_sch

.venv/bin/python tools/fabcheck/gerber_check.py out/board
.venv/bin/python tools/fabcheck/odb_check.py out/board
```

Or `npm run fabcheck -- out/board <design files…>` to do all three steps (expects the venv above).
Each checker exits with status 1 and lists the problems when something is wrong.
