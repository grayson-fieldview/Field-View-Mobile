import { PostHog } from "posthog-react-native";
import { Platform } from "react-native";

const POSTHOG_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST =
  process.env.EXPO_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

export const mobilePlatform = Platform.OS === "ios" ? "ios" : "android";

let client: PostHog | null = null;
let initialized = false;

/**
 * Initializes PostHog only for native builds. The session replay native
 * module is auto-discovered by posthog-react-native when
 * @posthog/react-native-plugin is installed.
 */
export function initPostHog(): PostHog | null {
  if (initialized) return client;
  initialized = true;

  if (!POSTHOG_KEY) {
    console.warn("[posthog] EXPO_PUBLIC_POSTHOG_KEY not set — PostHog disabled");
    return null;
  }

  if (Platform.OS === "web") {
    console.warn("[posthog] web runtime — mobile analytics disabled");
    return null;
  }

  try {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      // Autocapture is a PostHogProvider-only feature. This direct client
      // uses our explicit Expo Router screen tracker instead.
      captureAppLifecycleEvents: false,
      enableSessionReplay: true,
      sessionReplayConfig: {
        maskAllTextInputs: true,
      },
    });
    // Persistent super property so every mobile client event is
    // funnel-segmentable, including SDK-generated lifecycle events.
    client.register({ platform: mobilePlatform });
    console.log("[posthog] initialized");
  } catch (error) {
    console.warn("[posthog] initialization failed — PostHog disabled", error);
    client = null;
  }

  return client;
}

function getClient(): PostHog | null {
  return client ?? initPostHog();
}

export function capturePostHogEvent(name: string): void {
  void getClient()?.capture(name, { platform: mobilePlatform });
}

export function capturePostHogScreen(pathname: string): void {
  void getClient()?.screen(pathname, { platform: mobilePlatform });
}

export function identifyPostHogUser(
  userId: string,
  accountId?: string,
): void {
  const personProperties =
    accountId === undefined ? undefined : { account_id: accountId };
  getClient()?.identify(userId, personProperties);
}

export function resetPostHog(): void {
  const posthog = getClient();
  if (!posthog) return;
  posthog.reset();
  // PostHog reset clears registered properties; retain the event
  // segmentation property for the next anonymous session.
  posthog.register({ platform: mobilePlatform });
}