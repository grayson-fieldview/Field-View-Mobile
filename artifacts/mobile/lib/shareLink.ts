import { Platform, Share } from "react-native";

import { Sentry } from "@/services/sentry";

/**
 * Share a public link (project share, gallery share, report share) via
 * the native share sheet.
 *
 * React Native's `Share.share({ url })` is iOS-ONLY — Android ignores
 * the `url` field entirely, so a url-only call fires an effectively
 * empty share intent on Android (the symptom: tapping share lands you
 * in an app like Outlook with no link attached). Android only reads
 * `message`, so `title` (when given) is prefixed into that message —
 * Android has no separate title-in-content affordance for this API.
 *
 * Never send both `url` and `message` on iOS: some share targets pick
 * one and drop the other, which changes what recipients see (e.g.
 * iMessage/Mail render a double link preview when both are present).
 * `title` is Android-only for the same reason — iOS keeps the bare
 * `{ url }` shape unchanged.
 */
export async function shareLink(url: string, title?: string): Promise<void> {
  try {
    if (Platform.OS === "android") {
      await Share.share({ message: title ? `${title} — ${url}` : url });
    } else {
      await Share.share({ url });
    }
  } catch (e) {
    // Share.share never rejects for a user cancel/dismiss on either
    // platform: iOS resolves with { action: dismissedAction } when the
    // sheet is closed without sharing, and Android always resolves
    // with sharedAction (Android has no dismiss signal at all — see
    // react-native's Share.js). So anything landing in this catch is a
    // genuine failure (missing native module, OS-level share error,
    // etc.), never a cancel — report it instead of swallowing it.
    Sentry.captureException(e instanceof Error ? e : new Error(String(e)), {
      extra: { url, platform: Platform.OS },
    });
  }
}
