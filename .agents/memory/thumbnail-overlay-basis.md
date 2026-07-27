---
name: Thumbnail annotation overlay basis
description: Web grid thumbnails stretch the normalized unit square (preserveAspectRatio="none"); mobile must match, not crop-compensate.
---

The prod web bundle's photo-grid tile (`data-testid="annotation-overlay"`) cover-crops the `<img>` but renders the stroke overlay with viewBox `0 0 1000 1000`, `preserveAspectRatio="none"`, points at `nx*1000, ny*1000`, absolutely filling the tile — i.e. it STRETCHES the unit square onto the tile box with no crop compensation. Text strokes DO render on thumbnails since the web thumbnail-text fix (mirrored on mobile): fontSize is resolved via `resolveFontSize(fs, renderedHeightPx)` with `FONT_REFERENCE_HEIGHT = 1000` (identity in the 1000-unit thumbnail space), anchored with the explicit `y + fontSize*0.8` offset (no baseline attributes — unreliable across Safari/Android/PDF renderers), and haloed by double-rendering (stroke-only under fill-only; paintOrder is NOT honored by react-native-svg).

**Why:** Cross-client parity in the grids beats pixel-faithfulness to the cropped image. A "correct" `xMidYMid slice` overlay on mobile places/clips edge strokes differently from web — exactly the divergence class eliminated in the fitted-rect work. User explicitly chose "match web".

**How to apply:** Any thumbnail/tile stroke overlay on mobile uses stretch basis (viewBox 0 0 1000 1000, preserveAspectRatio="none", denormalize with w=h=1000); text renders there like every other stroke type. Full-screen edit/read views keep the exact fitted-contain-rect basis. If web ever changes its tile overlay, re-verify against the live bundle (fetch app JS, grep annotation-overlay) rather than assuming.
