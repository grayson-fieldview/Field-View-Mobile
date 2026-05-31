---
name: Mobile annotation cross-platform sync
description: How Field View mobile annotations sync with the external web backend — row model, canonical coords, save/load lifecycle.
---

# Field View mobile annotation sync

The mobile app (artifacts/mobile, Expo) syncs pencil annotations with the live
Field View web backend at `https://app.field-view.com` — a separate product NOT
in this monorepo. The endpoint contract below was confirmed empirically; you
cannot rediscover it from code in this repo.

## Row + render model
- Each user owns **exactly one** annotation row per media (`media_annotations`).
- The render set for a photo is the **UNION** of every user's strokes
  (`Photo.annotations` holds this union; the editable buffer holds only the
  current user's own strokes).
- Conflict policy on the own row: **last-write-wins** (no per-stroke merge).

## Canonical wire contract (LOCKED — do not change)
- `points`: normalized `0..1` vs the displayed canvas box.
- `width`: in **1000-virtual-canvas units** (NOT px, NOT 0..1); default 3.
- `type`: required enum `pencil|line|arrow|rectangle|circle`; `text` strokes
  carry no points (`{x,y,content,color,fontSize}`).
- Non-pencil/text strokes the mobile renderer can't draw must be **preserved**
  on save (round-trip the full row), and filtered out only at render time.

## Endpoints (external backend)
- `GET  /api/media/:id/annotations` — list all rows (the union).
- `POST /api/media/:id/annotations` — create caller's row; returns row (carry `id`).
- `PUT  /api/annotations/:id` — replace caller's row strokes.
- `DELETE /api/annotations/:id` — delete caller's row (empty/204 body).

## Save/load lifecycle gotchas (caused real bugs — keep these invariants)
- **Late load must not clobber unsaved edits:** if the photo is dirty (user drew
  before the fetch resolved), the local buffer wins; don't overwrite it with the
  server response.
- **Clear the dirty flag only AFTER a successful server write.** A swallowed
  network error that clears dirty = silent loss of cross-platform sync.
- **Own-row id must stay in lockstep with the server:** clear the cached id when
  the server has no row for the user, and on a failed PUT drop the id and fall
  back to POST — otherwise a deleted/stale row id blocks syncing forever.

**Why:** these three are the failure modes a code review caught; all three are
data-loss or sync-stall risks that typecheck won't surface.
