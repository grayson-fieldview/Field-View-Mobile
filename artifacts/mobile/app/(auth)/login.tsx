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
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { oauthLoading, signedIn, handleOAuth } = useOAuthSignIn({
    setError,
    // Evaluated at press time; anyInFlight is screen-computed below.
    isBlocked: () => anyInFlight,
  });

  // All three buttons share this: disabled while any sign-in is in
  // flight or after any success.
  const anyInFlight = loading || oauthLoading !== null || signedIn;

  const handleLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      await signIn(email, password);
      router.replace("/(tabs)");
      // Deliberately NOT re-enabling here: the login screen stays
      // mounted while navigation commits, and a re-armed button in that
      // window lets a second tap POST /api/login carrying the fresh sid
      // — passport regenerate() then destroys it (the double-login bug).
      // The screen unmounts moments later; if navigation somehow fails,
      // the auth gate re-renders this screen fresh with loading=false.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed.");
      setLoading(false);
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
          Welcome Back
        </Text>
        <Text style={[shared.subtitle, { color: colors.mutedForeground }]}>
          Log in to your account
        </Text>

        <OAuthButtons
          appleButtonType={
            AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
          }
          googleLabel="Sign in with Google"
          oauthLoading={oauthLoading}
          anyInFlight={anyInFlight}
          onPress={(provider) => void handleOAuth(provider)}
        />

        <View style={shared.dividerRow}>
          <View style={[shared.dividerLine, { backgroundColor: colors.border }]} />
          <Text style={[shared.dividerText, { color: colors.mutedForeground }]}>
            OR
          </Text>
          <View style={[shared.dividerLine, { backgroundColor: colors.border }]} />
        </View>

        <FieldLabel>Email</FieldLabel>
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
            placeholder="Enter your password"
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry={!showPassword}
            autoComplete="password"
            style={[
              shared.inputText,
              { color: colors.foreground, flex: 1 },
            ]}
          />
          <Pressable
            onPress={() => setShowPassword((v) => !v)}
            hitSlop={10}
            accessibilityLabel={showPassword ? "Hide password" : "Show password"}
          >
            <Feather
              name={showPassword ? "eye-off" : "eye"}
              size={18}
              color={colors.mutedForeground}
            />
          </Pressable>
        </View>

        {/*
          TODO(post-launch): Re-enable Forgot password once mobile password reset is wired up.
          Hidden for App Store submission to avoid the "isn't wired up yet" error path being visible to reviewers.
        */}
        {false && (
          <Pressable
            onPress={() => router.push("/(auth)/forgot")}
            hitSlop={8}
            style={{ alignSelf: "flex-end", marginTop: 10 }}
          >
            <Text style={[styles.link, { color: colors.primary }]}>
              Forgot password?
            </Text>
          </Pressable>
        )}

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
          title="Log In"
          onPress={handleLogin}
          loading={loading}
          disabled={oauthLoading !== null || signedIn}
          size="lg"
          style={{ marginTop: 16, backgroundColor: BRAND_ORANGE }}
        />

        <Text
          style={[shared.footerText, { color: colors.mutedForeground }]}
        >
          Don&apos;t have an account?{" "}
          <Text
            style={{
              color: colors.mutedForeground,
              textDecorationLine: "underline",
            }}
            onPress={() => router.replace("/(auth)/signup")}
          >
            Get started
          </Text>
        </Text>

      </View>

      <PrivacyPolicyLink />
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  link: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
});
