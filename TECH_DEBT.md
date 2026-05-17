# Tech Debt

Things we shipped knowing we'd want to revisit later. Each entry: what,
why it exists, blast radius, suggested follow-up.

## Mobile

### Orphaned media rows + S3 files from pre-BUILD 14 "delete photo"

Before the photo-delete server wiring shipped, `DataContext.deletePhoto`
on mobile was local-only — it filtered the photo out of AsyncStorage and
cancelled any pending upload, but never hit `DELETE /api/media/:id`.

Every photo a mobile user "deleted" before this fix is still present in
the database (as a `media` row) and in S3 (as the underlying object).
The references join tables (`checklist_item_photos`,
`report_section_photos`) are unaffected because the photo was uploaded
before any attachment happened in the typical flow — so most orphans
are truly orphaned, with no inbound FK references.

Suggested follow-up: write a one-shot cleanup script that finds `media`
rows that no client has uploaded reference to, OR just accept the
orphan storage cost (S3 is cheap; the row count is low). Don't try to
infer from mobile state — there's no way to ask "which photos did the
user think they deleted." A safer signal is `media` rows with no
inbound FK references AND no recent activity (created > 30 days ago,
never attached).

### Multi-photo delete on mobile skips the references check

`deleteSelected` in `artifacts/mobile/app/project/[id].tsx` (Photos tab
batch delete) runs `api.deleteMedia` server-first per selected photo
without first calling `getMediaReferences`. This means users
batch-deleting photos that are attached to shared reports will silently
break those shared links — no "this is a shared report" warning, no
"will be removed from N reports" copy.

Why we shipped it this way: per-item references checks in batch mode
either spam dialogs (one per photo) or aggregate into a multi-paragraph
"you are deleting 3 photos from 5 reports and 2 checklists, 1 of which
is shared" mega-dialog that users will dismiss without reading.

Re-evaluate after launch if anyone hits the shared-link foot-gun. A
reasonable middle ground is to do a *single* aggregated refs fetch for
the batch and show one summary line ("This will affect N shared
reports").
