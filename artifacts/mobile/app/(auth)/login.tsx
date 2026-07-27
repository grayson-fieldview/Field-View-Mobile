import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
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
        styles.page,
        {
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 24,
        },
      ]}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={[
          styles.card,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <BrandHeader />

        <Text style={[styles.title, { color: colors.foreground }]}>
          Welcome back
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Sign in to your account to continue
        </Text>

        <FieldLabel>Email</FieldLabel>
        <View
          style={[
            styles.input,
            { backgroundColor: colors.muted, borderColor: colors.border },
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
              backgroundColor: colors.muted,
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
              styles.inputText,
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
          title="Sign In"
          onPress={handleLogin}
          loading={loading}
          size="lg"
          style={{ marginTop: 16 }}
        />
      </View>
    </KeyboardAwareScrollViewCompat>
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
  card: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 24,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 18,
    elevation: 3,
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
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  inputText: { fontSize: 15, fontFamily: "Inter_500Medium" },
  link: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
});
