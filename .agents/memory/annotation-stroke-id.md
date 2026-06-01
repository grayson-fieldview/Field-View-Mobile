---
name: Annotation stroke cross-platform wire contract
description: The id + coordinate contract mobile must satisfy for web to accept/render annotations
---

# Annotation stroke wire contract (mobile <-> web)

The web backend validates each stroke in `media_annotations.strokes` with a Zod **union** (vector + text variants); **`id: z.string()` is REQUIRED on every stroke**. A single stroke missing `id` 400s the ENTIRE annotation row (POST /api/media/:id/annotations, PUT /api/annotations/:id) — mobile annotations then silently never persist / never show on web.

**Rules:**
- Every stroke must carry a stable per-stroke `id`. Assign once at creation; **preserve** an incoming id on every later save; **never regenerate**. Web-authored strokes round-tripped through mobile already carry an id — keep it.
- Coordinates: `points[{x,y}]` are normalized **0–1 fractions** (NOT pixels). `width` is in **1000-virtual-canvas units** (NOT px, NOT 0–1). Web multiplies by its render box; mobile divides by the captured canvas box. Don't "fix" one side's scaling without the other.
- Mobile renderer is **pencil-only**: it preserves but does not draw text/arrow/rect/circle/line strokes (filtered by `isRenderablePencilStroke`). Saves must round-trip ALL stroke kinds, never strip unknown types.

**Why:** the id gap was the root cause of "mobile annotations don't show on web" (validation reject, not a coordinate bug). Coordinates were already correct.
**How to apply:** any change to stroke construction (services/annotations.ts converters, services/types.ts CanonicalStroke) must keep `id` required + stable and leave the 0–1 / 1000-unit scaling intact.
