---
name: Thumbnail annotation overlay basis
description: Web grid thumbnails stretch the normalized unit square (preserveAspectRatio="none"); mobile must match, not crop-compensate.
---

The prod web bundle's photo-grid tile (`data-testid="annotation-overlay"`) cover-crops the `<img>` but renders the stroke overlay with viewBox `0 0 1000 1000`, `preserveAspectRatio="none"`, points at `nx*1000, ny*1000`, absolutely filling the tile — i.e. it STRETCHES the unit square onto the tile box with no crop compensation. It also skips `text` strokes on thumbnails (text renders only in the full viewer).

**Why:** Cross-client parity in the grids beats pixel-faithfulness to the cropped image. A "correct" `xMidYMid slice` overlay on mobile places/clips edge strokes differently from web — exactly the divergence class eliminated in the fitted-rect work. User explicitly chose "match web".

**How to apply:** Any thumbnail/tile stroke overlay on mobile uses stretch basis (viewBox 0 0 1000 1000, preserveAspectRatio="none", denormalize with w=h=1000) and drops text strokes. Full-screen edit/read views keep the exact fitted-contain-rect basis. If web ever changes its tile overlay, re-verify against the live bundle (fetch app JS, grep annotation-overlay) rather than assuming.
