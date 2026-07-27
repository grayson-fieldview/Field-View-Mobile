---
name: Upload queue attach step is persisted
description: Post-upload checklist/task attach must survive app relaunch; terminal alert is at-most-once via awaited persist before emit
---

The mobile upload queue's post-upload attach step (checklist item AND task) is a **persisted** queue state, not fire-and-forget memory.

**The rule:** any upload carrying an attach target parks in status `uploaded_pending_attach` (with `uploadedMediaId`, `attachAttemptCount`, per-target `checklistAttached`/`taskAttached` flags) and only becomes `uploaded` when the attach succeeds or terminally fails after MAX_ATTACH_ROUNDS (3 rounds × [0,2s,8s] ladder = 9 HTTP attempts). The tick loop resumes pending attaches after relaunch; reconnect resets their retry timers like `failed` items.

**Why:** an unattached task photo blocks task completion (422 PHOTOS_REQUIRED) with no visible cause — the exact failure mode the photo-hints work was built to kill. In-memory retry died with the process.

**How to apply:**
- Terminal failure must persist the settled state with an *awaited* flush (`persistNow()`) BEFORE emitting the error event → alert is at-most-once across kills, never repeated per launch.
- `uploaded_pending_attach` must stay in the "bytes already on S3" set in migrate/sweep (its local file is deleted post-create; missing-file checks must not mark it unrecoverable) and must NOT be status-clobbered to `uploading` by tick.
- DataContext reconcile removes only `status === "uploaded"` items — keep it that way or pending attaches lose their retry record.
- Checklist and task paths share this one mechanism; never fork them. Intermediate round failures emit no events — only success and terminal failure.
- Attach endpoints are idempotent per (target, media), so re-running an ambiguous round is safe; success events are deduped via the per-target attached flags.
