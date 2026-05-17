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

### Server-side checklist-item-photo attach response should include joined media url

The bulk-attach endpoint `POST /api/checklist-items/:itemId/photos`
(body `{ mediaIds: number[] }`) returns junction rows that omit the
joined media `url` field. Mobile compensates client-side by merging the
known URL at the call sites:

- `components/PhotoPickerModal.tsx` — merges from the candidate's
  `remoteUrl ?? uri` before passing to `attachPhotoLocal`.
- `services/uploadQueue.ts` `attachWithRetry` — merges from
  `created.url` (the just-uploaded media row), threaded in as an
  optional 3rd arg from `processItem`.
- `components/ChecklistItemRow.tsx` — safety-net renders a muted
  square instead of a broken image if `url` is ever missing at render.

The robust long-term fix is server-side: the bulk-attach response
should re-join the `media` table per inserted row and return the
`{ id, itemId, mediaId, url, createdAt }` shape that the singular
endpoint used to return — matching the existing
`BackendChecklistItemPhoto` type contract. Once that ships, the three
client-side merges above can be removed (the safety net in
ChecklistItemRow is worth keeping regardless).

### Signup screen has no T&C / Privacy Policy consent footer

`artifacts/mobile/app/(auth)/signup.tsx` collects email + password +
name and creates an account, but does not surface any "By creating an
account you agree to our Terms and Privacy Policy" copy or inline
links. Legal links are currently only reachable post-login via the
Profile tab (`app/(tabs)/profile.tsx` "Legal" section), which satisfies
the strict letter of Apple's in-app-accessibility guideline.

Some App Store reviewers expect signup-time disclosure for apps that
collect accounts, so a rejection on this basis is possible (not
guaranteed). Holding for post-launch — will address if rejected.

Follow-up: add a small footer below the signup CTA reading roughly
"By creating an account you agree to our [Terms](https://www.field-view.com/legal/terms-and-conditions)
and [Privacy Policy](https://www.field-view.com/legal/privacy-policy)"
with the same `openExternal()` helper used in `profile.tsx`. Keep the
text muted (`colors.textSecondary`) and the links underlined in the
brand accent color for clarity.
