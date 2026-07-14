import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { Sentry } from "./sentry";

/**
 * Cross-platform secure storage.
 * - Native (iOS/Android): expo-secure-store (Keychain / Keystore).
 * - Web: AsyncStorage (localStorage-backed). Web is dev/preview only;
 *   production auth runs on real iOS devices where Keychain is used.
 */
export const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === "web") return AsyncStorage.getItem(key);
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") {
      await AsyncStorage.setItem(key, value);
      return;
    }
    try {
      await SecureStore.setItemAsync(key, value);
    } catch (e) {
      // Non-throwing by design (callers treat persistence as
      // best-effort), but a swallowed Keychain write failure means
      // silent session loss on next cold start — make it visible.
      // Log key name only, never the value.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[secureStorage] setItem FAILED for key "${key}": ${msg}`);
      Sentry.addBreadcrumb({
        category: "storage",
        level: "error",
        message: "SecureStore.setItemAsync failed",
        data: { key },
      });
      Sentry.captureException(
        e instanceof Error ? e : new Error(`SecureStore setItem failed: ${msg}`),
        { extra: { key } },
      );
    }
  },
  async removeItem(key: string): Promise<void> {
    if (Platform.OS === "web") {
      await AsyncStorage.removeItem(key);
      return;
    }
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      /* ignore */
    }
  },
};
