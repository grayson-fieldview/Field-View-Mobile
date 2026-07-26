---
name: Annotation wire contract quirks
description: Cross-client stroke wire-format facts reverse-engineered from the production web bundle (width units, circle geometry, arrowhead, text anchoring)
---

Facts confirmed by reading the deployed web client bundle (July 2026), since API endpoints are auth-gated:

- **Width units are ambiguous on the wire.** Web writes/reads raw display px (integer slider 1–8, default 3, `ctx.lineWidth = width` unscaled). Legacy mobile wrote 1000-virtual-canvas units (virtually always non-integer, e.g. 14.925 = 5px/335px canvas).
  **Rule:** read-time heuristic only — integer → px, non-integer → 1000-units scaled by box width (`widthToPx` in mobile services/annotations.ts). Never rewrite stored widths; new mobile strokes write integer px.
- **Circle wire = `points: [center, radiusPoint]`** rendered as a perfect circle with r = px distance — NOT bounding-box ellipse, contradicting an earlier stated contract. Follow the web renderer.
- **Arrow head is derived, never stored:** length `max(12, widthPx*4)` px, half-angle π/6 off the shaft.
- **Text:** top-level normalized x/y (no points), fontSize raw px, canvas `textBaseline="top"` on web. Mobile SVG approximates with baseline offset ≈ 0.8·fontSize.
- Web internal type "freehand" serializes as wire "pencil". line/arrow/rectangle = `points:[start,end]`.
- **Why:** mobile↔web strokes were mutually mis-rendered/invisible; these conventions make them interoperate.
- **How to apply:** any change to mobile stroke converters/renderers must match these; re-verify against the current web bundle if behavior looks off.

Testing note: mobile has no test framework; `pnpm --filter @workspace/mobile test` runs `node --test` with native type stripping — requires explicit `.ts` extensions on relative imports in files the tests pull in (Metro resolves them fine; verified via bundle fetch), plus `allowImportingTsExtensions`+`noEmit` in mobile tsconfig.
