import { Feather } from "@expo/vector-icons";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BackChevron } from "@/components/auth/BackChevron";
import { BrandHeader } from "@/components/auth/BrandHeader";
import { FieldLabel } from "@/components/auth/FieldLabel";
import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { PrivacyPolicyLink } from "@/components/auth/PrivacyPolicyLink";
import {
  authScreenStyles as shared,
  BRAND_ORANGE,
} from "@/components/auth/authScreenStyles";
import { signupErrorMessage } from "@/components/auth/signupErrorMessage";
import { useOAuthSignIn } from "@/components/auth/useOAuthSignIn";
import { Button } from "@/components/Button";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { capturePostHogEvent } from "@/services/posthog";

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signUpWithEmail } = useAuth();
  // Email-path in-flight / post-success lockout, mirroring the OAuth
  // hook's oauthLoading/signedIn pair: spinner while the request is in
  // flight; once signup succeeds, ALL buttons stay disabled permanently
  // (same non-re-enable guard as OAuth — the passport
  // session-regenerate double-login bug).
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailSignedIn, setEmailSignedIn] = useState(false);
  // Synchronous submit lock: state-based guards (anyInFlight) don't
  // commit until the next render, so a second tap in the same frame
  // would see stale `false` and start a second session-creating
  // request. The ref flips immediately at press time. Acquired by the
  // email path; checked by BOTH paths via isBlocked (evaluated at
  // press time). Released only on email failure — success keeps it
  // held, same permanent lockout as the state guards.
  const submitLockRef = useRef(false);

  useEffect(() => {
    capturePostHogEvent("signup_started");
  }, []);

  const { oauthLoading, signedIn, handleOAuth } = useOAuthSignIn({
    setError,
    // Evaluated at press time; anyInFlight is screen-computed below.
    isBlocked: () => anyInFlight || submitLockRef.current,
    registrationFlow: true,
  });

  // All buttons share this: disabled while any sign-in is in flight
  // or after any success.
  const anyInFlight =
    oauthLoading !== null || signedIn || emailLoading || emailSignedIn;

  const passwordChecks = PASSWORD_RULES.map((r) => r.test(password));
  const canSubmitEmail =
    email.trim().length > 0 && passwordChecks.every(Boolean);

  const handleEmailSignup = async () => {
    if (anyInFlight || submitLockRef.current) return;
    submitLockRef.current = true; // sync — closes the pre-commit window
    setError(null);
    setEmailLoading(true);
    try {
      // termsAccepted: true — the caption below the button is the
      // consent mechanism, same legal basis the web OAuth buttons use
      // for stamping termsAcceptedAt. No inviteToken: the app has no
      // deep link handling yet.
      await signUpWithEmail({
        email: email.trim(),
        password,
        termsAccepted: true,
      });
      setEmailSignedIn(true); // keep everything disabled — see guard note
      // AuthGate routes to onboarding from here (profileCompletedAt is
      // null); this replace is identical to handleOAuth's — the gate
      // owns the onboarding redirect, never this screen.
      router.replace("/(tabs)");
      setEmailLoading(false);
      // Deliberately NOT releasing submitLockRef — success is a
      // permanent lockout, matching signedIn/emailSignedIn.
    } catch (e) {
      setError(signupErrorMessage(e));
      setEmailLoading(false);
      submitLockRef.current = false; // failure re-arms the form
    }
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.muted }}
      contentContainerStyle={[
        shared.page,
        {
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 24,
        },
      ]}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
    >
      <BackChevron />

      {/* No card container — content sits directly on colors.muted,
          matching welcome.tsx (white is reserved for inputs and the
          photo-grid card). */}
      <View style={shared.content}>
        <BrandHeader />

        <Text style={[shared.title, { color: colors.foreground }]}>
          Welcome to Field View
        </Text>
        <Text style={[shared.subtitle, { color: colors.mutedForeground }]}>
          Try free with your team for 14 days.
        </Text>

        <OAuthButtons
          appleButtonType={
            AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP
          }
          googleLabel="Sign up with Google"
          oauthLoading={oauthLoading}
          anyInFlight={anyInFlight}
          onPress={(provider) => void handleOAuth(provider)}
        />

        <View style={shared.dividerRow}>
          <View
            style={[shared.dividerLine, { backgroundColor: colors.border }]}
          />
          <Text
            style={[shared.dividerText, { color: colors.mutedForeground }]}
          >
            OR
          </Text>
          <View
            style={[shared.dividerLine, { backgroundColor: colors.border }]}
          />
        </View>

        <FieldLabel>Work Email</FieldLabel>
        <View
          style={[
            shared.input,
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
            style={[shared.inputText, { color: colors.foreground }]}
          />
        </View>

        <FieldLabel style={{ marginTop: 14 }}>Password</FieldLabel>
        <View
          style={[
            shared.input,
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
            style={[shared.inputText, { color: colors.foreground, flex: 1 }]}
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
          onPress={() => void handleEmailSignup()}
          disabled={!canSubmitEmail || anyInFlight}
          loading={emailLoading}
          size="lg"
          style={{ marginTop: 16, backgroundColor: BRAND_ORANGE }}
        />

        {/* Consent caption for BOTH the email path and the OAuth
            buttons above — the client always sends termsAccepted:
            true on email signup, mirroring the web OAuth buttons. */}
        <Text style={[styles.termsCaption, { color: colors.mutedForeground }]}>
          By continuing, you agree to the{" "}
          <Text
            style={styles.termsLink}
            onPress={() => {
              void Linking.openURL("https://www.field-view.com/legal/terms-and-conditions");
            }}
          >
            Terms of Service
          </Text>{" "}
          and{" "}
          <Text
            style={styles.termsLink}
            onPress={() => {
              void Linking.openURL(
                "https://www.field-view.com/legal/privacy-policy",
              );
            }}
          >
            Privacy Policy
          </Text>
          .
        </Text>

        <Text
          style={[shared.footerText, { color: colors.mutedForeground }]}
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

      <PrivacyPolicyLink />
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  // Legal caption: smaller/more muted than the cross-link below so it
  // reads as boilerplate (matches PrivacyPolicyLink's treatment);
  // underline only on the two link phrases.
  termsCaption: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    opacity: 0.8,
    marginTop: 12,
  },
  termsLink: { textDecorationLine: "underline" },
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
});
