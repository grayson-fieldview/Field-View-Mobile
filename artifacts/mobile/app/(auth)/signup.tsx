import { Feather } from "@expo/vector-icons";
import * as AppleAuthentication from "expo-apple-authentication";
import { useRouter } from "expo-router";
import React, { useState } from "react";
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
import { useOAuthSignIn } from "@/components/auth/useOAuthSignIn";
import { Button } from "@/components/Button";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useColors } from "@/hooks/useColors";

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

  const { oauthLoading, signedIn, handleOAuth } = useOAuthSignIn({
    setError,
    // Evaluated at press time; anyInFlight is screen-computed below.
    isBlocked: () => anyInFlight,
  });

  // All buttons share this: disabled while any sign-in is in flight
  // or after any success.
  const anyInFlight = oauthLoading !== null || signedIn;

  const passwordChecks = PASSWORD_RULES.map((r) => r.test(password));
  const canSubmitEmail =
    email.trim().length > 0 && passwordChecks.every(Boolean);

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
          onPress={handleEmailSignup}
          disabled={!canSubmitEmail || anyInFlight}
          size="lg"
          style={{ marginTop: 16, backgroundColor: BRAND_ORANGE }}
        />

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
