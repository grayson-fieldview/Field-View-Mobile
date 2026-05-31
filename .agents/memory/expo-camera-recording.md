---
name: expo-camera recording knobs (SDK 54 / v17.0.10)
description: Where to set video resolution and size/duration caps in expo-camera 17, and a corrected iOS assumption.
---

# expo-camera 17 (Expo SDK 54) video recording caps

The shipped `.d.ts` in node_modules is **minified** (identifiers collapsed to `n`),
so property names are NOT readable there. Recover real names from the build
sourcemaps' `sourcesContent` (e.g. `build/CameraView.js.map`) and from
`Camera.types.d.ts` JSDoc comments (comments survive minification).

- **Resolution / quality**: a `CameraView` **prop** `videoQuality` (type
  `VideoQuality = '2160p' | '1080p' | '720p' | '480p' | '4:3'`). Pin 1080p with
  `videoQuality="1080p"`. It is NOT a `recordAsync` option.
- **Caps**: `recordAsync({ maxDuration, maxFileSize })`. `maxDuration` is seconds,
  `maxFileSize` is bytes.

**Corrected assumption — `maxFileSize` is honored on iOS too, not Android-only.**
**Why:** the iOS native code sets `videoFileOutput.maxRecordedFileSize` (see
`ios/Current/CameraVideoRecording.swift`). Common lore says it's Android-only;
that's wrong for v17. Apply `maxFileSize` on BOTH platforms for a true hard cap.
**How to apply:** when you must keep a clip under a server upload cap, set both
`maxDuration` (UX cap) and `maxFileSize` (hard cap), and size the byte value
below the cap in BOTH MiB (×1024²) and decimal (×1000³) terms if the server's
unit is unknown.
