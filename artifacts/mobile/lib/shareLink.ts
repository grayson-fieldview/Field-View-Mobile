import { Platform, Share } from "react-native";

/**
 * Share a public link (project share, gallery share, report share) via
 * the native share sheet.
 *
 * React Native's `Share.share({ url })` is iOS-ONLY — Android ignores
 * the `url` field entirely, so a url-only call fires an effectively
 * empty share intent on Android (the symptom: tapping share lands you
 * in an app like Outlook with no link attached). Android only reads
 * `message`.
 *
 * Never send both `url` and `message` on iOS: some share targets pick
 * one and drop the other, which changes what recipients see (e.g.
 * iMessage/Mail render a double link preview when both are present).
 */
export async function shareLink(url: string): Promise<void> {
  try {
    if (Platform.OS === "android") {
      await Share.share({ message: url });
    } else {
      await Share.share({ url });
    }
  } catch {
    /* user cancelled */
  }
}
