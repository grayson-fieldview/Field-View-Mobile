---
name: Grid memory / bounded decode
description: Photo grid + covers must never hand expo-image an original source; thumbnail cache + virtualization contract
---

Rule: any surface showing many photos (project grid, project-list covers) must render the on-device ~400px thumbnail cache (`services/thumbnails.ts` → `ThumbImage`), never the original local file or S3 URL. Grid is a FlashList that OWNS the scroll container (photos tab only; other tabs keep the shared-header ScrollView).

**Why:** prod watchdog kills at ~1.5 GiB — 98 full-res decodes from a non-virtualized `photos.map` in a ScrollView; remote tiles were ORIGINAL S3 URLs (no server thumbnail tier exists). expo-image downscaling hints (B2) could not be verified to prevent full decode, so B1 (manipulator thumbs) was chosen deliberately.

**How to apply:**
- Thumb disk cache keyed by media id (stable across pending→remote uri swap); per-run memo keyed by (key, uri) so a failed pending-file attempt retries once the uri becomes remote.
- Failure falls back to the original uri (correctness over memory) — never render the original while the thumb is generating; show placeholder bg.
- FlashList v2 (2.0.2): no `estimatedItemSize` prop; date headers can't mix with numColumns, so items are header rows + explicit 2-photo pair rows; `extraData={{selectMode, selected}}` works because selection Sets are replaced immutably.
- Web: FileSystem/manipulator pipeline may fail → falls back to originals; accepted caveat.
