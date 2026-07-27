---
name: Thumbnail annotation overlay basis
description: Web grid thumbnails stretch the normalized unit square (preserveAspectRatio="none"); mobile must match, not crop-compensate.
---

The prod web bundle's photo-grid tile (`data-testid="annotation-overlay"`) cover-crops the `<img>` but renders the stroke overlay with viewBox `0 0 1000 1000`, `preserveAspectRatio="none"`, points at `nx*1000, ny*1000`, absolutely filling the tile — i.e. it STRETCHES the unit square onto the tile box with no crop compensation. Text strokes DO render on thumbnails since the web thumbnail-text fix (mirrored on mobile). Font-size basis rule (user-decided after a partial revert): `resolveFontSize(fs, renderedHeightPx)` / `FONT_REFERENCE_HEIGHT = 1000` applies ONLY in the thumbnail overlay (1000-unit basis, identity today); every other surface — full viewer, editor, live preview — renders raw stored px in the fitted-rect authoring basis. Do NOT put resolveFontSize inside strokeToRenderShape/renderShape: it shrinks full-viewer text ~2x. Anchoring is the explicit `y + fontSize*0.8` offset everywhere (no baseline attributes — unreliable across Safari/Android/PDF renderers); halo by double-rendering text (stroke-only under fill-only; paintOrder NOT honored by react-native-svg).

**Why:** Cross-client parity in the grids beats pixel-faithfulness to the cropped image. A "correct" `xMidYMid slice` overlay on mobile places/clips edge strokes differently from web — exactly the divergence class eliminated in the fitted-rect work. User explicitly chose "match web".

**How to apply:** Any thumbnail/tile stroke overlay on mobile uses stretch basis (viewBox 0 0 1000 1000, preserveAspectRatio="none", denormalize with w=h=1000); text renders there like every other stroke type. Full-screen edit/read views keep the exact fitted-contain-rect basis. If web ever changes its tile overlay, re-verify against the live bundle (fetch app JS, grep annotation-overlay) rather than assuming.
