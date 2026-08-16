import Constants from "expo-constants";
import * as Updates from "expo-updates";

import { sentryDsnPresent, sentryEnabled } from "@/services/sentry";

/**
 * Bundle self-identification for on-device diagnostics (Settings row +
 * ErrorFallback details modal). Answers "which JS bundle is this device
 * actually running?" — embedded vs OTA, which update, and whether the
 * Sentry DSN made it into the bundle.
 *
 * Every expo-updates read is individually guarded: getBuildInfo() must
 * NEVER throw (it renders inside the error fallback itself).
 */

export interface BuildInfo {
  updateId: string;
  isEmbeddedLaunch: string;
  createdAt: string;
  channel: string;
  runtimeVersion: string;
  appVersion: string;
  sentryDsnPresent: boolean;
  sentryEnabled: boolean;
}

function readUpdates<T>(read: () => T): string {
  try {
    const v = read();
    if (v === null || v === undefined) return "unavailable";
    if (v instanceof Date) return v.toISOString();
    return String(v);
  } catch {
    return "unavailable";
  }
}

export function getBuildInfo(): BuildInfo {
  let appVersion = "unavailable";
  try {
    appVersion = Constants.expoConfig?.version ?? "unavailable";
  } catch {
    /* keep fallback */
  }
  return {
    updateId: readUpdates(() => Updates.updateId),
    isEmbeddedLaunch: readUpdates(() => Updates.isEmbeddedLaunch),
    createdAt: readUpdates(() => Updates.createdAt),
    channel: readUpdates(() => Updates.channel),
    runtimeVersion: readUpdates(() => Updates.runtimeVersion),
    appVersion,
    sentryDsnPresent,
    sentryEnabled,
  };
}

/** Plain-text block for clipboard/bug-report use. */
export function formatBuildInfo(info: BuildInfo = getBuildInfo()): string {
  return [
    `updateId: ${info.updateId}`,
    `isEmbeddedLaunch: ${info.isEmbeddedLaunch}`,
    `createdAt: ${info.createdAt}`,
    `channel: ${info.channel}`,
    `runtimeVersion: ${info.runtimeVersion}`,
    `appVersion: ${info.appVersion}`,
    `sentryDsnPresent: ${info.sentryDsnPresent}`,
    `sentryEnabled: ${info.sentryEnabled}`,
  ].join("\n");
}
