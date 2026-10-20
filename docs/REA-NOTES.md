# REA analysis notes

PCBian was asked to be built "using REA" ([morluto/rea](https://github.com/morluto/rea)), a reverse-engineering toolkit. We used it only for public, passive analysis of Flux.ai's marketing page, to inform technology choices. No proprietary code, assets, UI copy, branding or private API details were extracted or reused. Every line of PCBian is original.

## What was run

- Target: `https://www.flux.ai/` (public landing page, redirected to `/p`, not logged in).
- Chromium attached over CDP, then `rea analyze-web-bundle <endpoint> <target> --observation-ms 3000` (REA 6.7.0, no source maps, no script source export).

## Findings

| Observation | Result |
| --- | --- |
| Scripts observed / analyzed | 35 / 35 |
| Bundle runtime inference | **Vite** (medium confidence, `vite-runtime` detector) |
| Statically recovered routes / endpoints | none |
| WebMCP declarations | none |

## How this influenced PCBian

It confirmed that a Vite-bundled single-page web app is a sensible architecture for a browser PCB editor, so PCBian uses React + Vite on the front end. Everything else (data model, CRDT collaboration with Yjs, the router, DRC, Gerber export and the copilot's tool design) was designed from public knowledge of PCB tooling and file formats.
