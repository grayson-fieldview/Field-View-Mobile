import { Feather } from "@expo/vector-icons";
import * as AppleAuthentication from "expo-apple-authentication";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";

import { Button } from "@/components/Button";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { ApiError } from "@/services/api";
import {
  isAppleSignInAvailable,
  signInWithAppleNative,
  signInWithGoogleNative,
  SocialAuthError,
} from "@/services/socialAuth";

const BRAND_ORANGE = "#f09004";

type OAuthProvider = "apple" | "google";

/**
 * Map an OAuth sign-in failure to inline error copy. Replicated from
 * login.tsx (that screen's logic is sealed; do not import from it).
 */
function oauthErrorMessage(e: unknown): string {
  if (e instanceof SocialAuthError) return e.message;
  if (e instanceof ApiError) {
    const code =
      e.body && typeof e.body === "object" && "error" in e.body
        ? (e.body as { error?: unknown }).error
        : undefined;
    if (
      code === "email_unverified_or_missing" ||
      code === "invite_email_mismatch" ||
      code === "account_deleted" ||
      code === "invite_invalid"
    ) {
      return e.message;
    }
    if (e.status === 401)
      return "We couldn't verify your sign-in. Please try again.";
    if (e.status === 503)
      return "Sign-in with Google isn't available right now. Please use your email and password.";
  }
  return "Sign in failed.";
}

/** Live password rules shown under the password field. */
const PASSWORD_RULES: { label: string; test: (pw: string) => boolean }[] = [
  { label: "At least 10 characters", test: (pw) => pw.length >= 10 },
  { label: "1 uppercase letter", test: (pw) => /[A-Z]/.test(pw) },
  { label: "1 lowercase letter", test: (pw) => /[a-z]/.test(pw) },
];

export default function SignupScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signInWithApple, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);
  // Which OAuth button is currently in flight (spinner on that one).
  const [oauthLoading, setOauthLoading] = useState<OAuthProvider | null>(null);
  // Once ANY sign-in succeeds, ALL buttons stay disabled — same
  // deliberate guard as login.tsx (the passport session-regenerate
  // double-login bug).
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let mounted = true;
    void isAppleSignInAvailable().then((ok) => {
      if (mounted) setAppleAvailable(ok);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // All buttons share this: disabled while any sign-in is in flight
  // or after any success.
  const anyInFlight = oauthLoading !== null || signedIn;

  const passwordChecks = PASSWORD_RULES.map((r) => r.test(password));
  const canSubmitEmail =
    email.trim().length > 0 && passwordChecks.every(Boolean);

  const handleOAuth = async (provider: OAuthProvider) => {
    if (anyInFlight) return;
    setError(null);
    setOauthLoading(provider);
    try {
      const result =
        provider === "apple"
          ? await signInWithAppleNative()
          : await signInWithGoogleNative();
      if (result.status === "cancelled") {
        // No error UI on cancellation — buttons simply re-enable.
        setOauthLoading(null);
        return;
      }
      // No inviteToken: there is no deep link handling in the app;
      // the server resolves pending invitations by verified email.
      if (provider === "apple") {
        await signInWithApple({
          idToken: result.idToken,
          firstName: result.firstName,
          lastName: result.lastName,
        });
      } else {
        await signInWithGoogle({ idToken: result.idToken });
      }
      setSignedIn(true); // keep everything disabled — see guard note
      router.replace("/(tabs)");
      setOauthLoading(null);
    } catch (e) {
      setError(oauthErrorMessage(e));
      setOauthLoading(null);
    }
  };

  const handleEmailSignup = () => {
    // INTEGRATION POINT: mobile email/password signup backend does not
    // exist yet (POST /api/register requires reCAPTCHA, which a native
    // app cannot supply). When a mobile signup endpoint ships, replace
    // the setError line below with the real API call + success
    // navigation; the form state (email, password) and validation are
    // already in place.
    setError(
      "Email signup is coming soon. Please use Google or Apple to get started.",
    );
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.muted }}
      contentContainerStyle={[
        styles.page,
        {
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 24,
        },
      ]}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
    >
      <Pressable
        onPress={() => router.back()}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.backChevron}
      >
        <Feather name="chevron-left" size={28} color={colors.foreground} />
      </Pressable>

      {/* No card container — content sits directly on colors.muted,
          matching welcome.tsx (white is reserved for inputs and the
          photo-grid card). */}
      <View>
        <BrandHeader />

        <Text style={[styles.title, { color: colors.foreground }]}>
          Welcome to Field View
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Try free with your team for 14 days.
        </Text>

        {appleAvailable ? (
          oauthLoading === "apple" ? (
            // AppleAuthenticationButton has no loading state; while the
            // Apple flow is in flight we swap in a same-size black
            // placeholder with a spinner so the layout doesn't jump.
            <View style={[styles.oauthButton, styles.applePlaceholder]}>
              <ActivityIndicator color="#FFFFFF" />
            </View>
          ) : (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={
                AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP
              }
              buttonStyle={
                AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
              }
              cornerRadius={10}
              style={[styles.oauthButton, anyInFlight && { opacity: 0.5 }]}
              onPress={() => {
                if (!anyInFlight) void handleOAuth("apple");
              }}
            />
          )
        ) : null}

        <Pressable
          onPress={() => void handleOAuth("google")}
          disabled={anyInFlight}
          accessibilityRole="button"
          accessibilityLabel="Sign up with Google"
          style={({ pressed }) => [
            styles.oauthButton,
            styles.googleButton,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              opacity: anyInFlight && oauthLoading !== "google" ? 0.5 : 1,
            },
            pressed && { opacity: 0.7 },
          ]}
        >
          {oauthLoading === "google" ? (
            <ActivityIndicator color={colors.foreground} />
          ) : (
            <>
              <GoogleGMark />
              <Text style={[styles.googleText, { color: colors.foreground }]}>
                Sign up with Google
              </Text>
            </>
          )}
        </Pressable>

        <View style={styles.dividerRow}>
          <View
            style={[styles.dividerLine, { backgroundColor: colors.border }]}
          />
          <Text
            style={[styles.dividerText, { color: colors.mutedForeground }]}
          >
            OR
          </Text>
          <View
            style={[styles.dividerLine, { backgroundColor: colors.border }]}
          />
        </View>

        <FieldLabel>Work Email</FieldLabel>
        <View
          style={[
            styles.input,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@company.com"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            style={[styles.inputText, { color: colors.foreground }]}
          />
        </View>

        <FieldLabel style={{ marginTop: 14 }}>Password</FieldLabel>
        <View
          style={[
            styles.input,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              flexDirection: "row",
              alignItems: "center",
            },
          ]}
        >
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Create a password"
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry={!showPassword}
            autoComplete="password-new"
            style={[styles.inputText, { color: colors.foreground, flex: 1 }]}
          />
          <Pressable
            onPress={() => setShowPassword((v) => !v)}
            hitSlop={10}
            accessibilityLabel={
              showPassword ? "Hide password" : "Show password"
            }
          >
            <Feather
              name={showPassword ? "eye-off" : "eye"}
              size={18}
              color={colors.mutedForeground}
            />
          </Pressable>
        </View>

        <View style={styles.rulesBlock}>
          {PASSWORD_RULES.map((rule, i) => {
            const ok = passwordChecks[i];
            return (
              <View key={rule.label} style={styles.ruleRow}>
                <Feather
                  name={ok ? "check-circle" : "circle"}
                  size={14}
                  color={ok ? "#22a06b" : colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.ruleText,
                    { color: ok ? colors.foreground : colors.mutedForeground },
                  ]}
                >
                  {rule.label}
                </Text>
              </View>
            );
          })}
        </View>

        {error ? (
          <Text
            style={{
              color: colors.destructive,
              fontFamily: "Inter_500Medium",
              marginTop: 10,
            }}
          >
            {error}
          </Text>
        ) : null}

        <Button
          title="Get Started"
          onPress={handleEmailSignup}
          disabled={!canSubmitEmail || anyInFlight}
          size="lg"
          style={{ marginTop: 16, backgroundColor: BRAND_ORANGE }}
        />

        <Text
          style={[styles.crossLink, { color: colors.mutedForeground }]}
        >
          Already have an account?{" "}
          <Text
            style={{
              color: colors.mutedForeground,
              textDecorationLine: "underline",
            }}
            onPress={() => router.replace("/(auth)/login")}
          >
            Log in
          </Text>
        </Text>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

/**
 * Official multicolor Google "G" mark — replicated from login.tsx
 * (sealed file), same four brand hex values per Google's guidelines.
 */
function GoogleGMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 48 48">
      <Path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <Path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <Path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <Path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </Svg>
  );
}

function BrandHeader() {
  const colors = useColors();
  return (
    <View style={styles.brandRow}>
      <Image
        source={require("@/assets/images/icon.png")}
        style={styles.brandLogo}
        contentFit="contain"
      />
      <Text style={[styles.brandWord, { color: colors.foreground }]}>
        Field View
      </Text>
    </View>
  );
}

function FieldLabel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: object;
}) {
  const colors = useColors();
  return (
    <Text style={[styles.label, { color: colors.foreground }, style]}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  page: {
    paddingHorizontal: 16,
    flexGrow: 1,
    justifyContent: "center",
  },
  backChevron: {
    position: "absolute",
    left: 12,
    zIndex: 1,
    top: 0, // paddingTop of the scroll content puts this below the inset
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginBottom: 16,
  },
  brandLogo: { width: 32, height: 32, borderRadius: 7 },
  brandWord: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.4,
  },
  title: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.6,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 6,
    marginBottom: 18,
  },
  label: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  inputText: { fontSize: 15, fontFamily: "Inter_500Medium" },
  rulesBlock: { marginTop: 10, gap: 6 },
  ruleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  ruleText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginVertical: 16,
  },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  oauthButton: {
    height: 48,
    borderRadius: 10,
    marginBottom: 10,
  },
  applePlaceholder: {
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
  },
  googleButton: {
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginBottom: 0,
  },
  googleText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  // Matches login.tsx's signupFooter footer-text style.
  crossLink: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 16,
  },
});
