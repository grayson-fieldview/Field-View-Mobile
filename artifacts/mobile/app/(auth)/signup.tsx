import { useRouter } from "expo-router";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

export default function SignupScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signUp } = useAuth();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignup = async () => {
    setError(null);
    setLoading(true);
    try {
      await signUp(firstName, lastName, email, password);
      router.replace("/(tabs)");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign up failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[
        styles.container,
        { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 },
      ]}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.title, { color: colors.foreground }]}>
        Create your account
      </Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        Capture, track, and share every field visit
      </Text>

      <View style={styles.form}>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Input
              label="First name"
              value={firstName}
              onChangeText={setFirstName}
              placeholder="Jane"
              autoCapitalize="words"
              autoComplete="given-name"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Input
              label="Last name"
              value={lastName}
              onChangeText={setLastName}
              placeholder="Carpenter"
              autoCapitalize="words"
              autoComplete="family-name"
            />
          </View>
        </View>
        <Input
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="you@company.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
        />
        <Input
          label="Password"
          value={password}
          onChangeText={setPassword}
          placeholder="At least 8 characters"
          secureTextEntry
          autoComplete="new-password"
        />
        {error ? (
          <Text
            style={{
              color: colors.destructive,
              fontFamily: "Inter_500Medium",
            }}
          >
            {error}
          </Text>
        ) : null}
        <Button
          title="Create account"
          onPress={handleSignup}
          loading={loading}
          size="lg"
        />
      </View>

      <View style={styles.footer}>
        <Text
          style={{
            color: colors.mutedForeground,
            fontFamily: "Inter_400Regular",
          }}
        >
          Already have an account?{" "}
        </Text>
        <Pressable onPress={() => router.push("/(auth)/login")} hitSlop={8}>
          <Text style={[styles.linkInline, { color: colors.primary }]}>
            Sign in
          </Text>
        </Pressable>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 24, gap: 8 },
  title: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.8,
  },
  subtitle: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    marginBottom: 28,
  },
  form: { gap: 14 },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 28 },
  linkInline: { fontFamily: "Inter_600SemiBold" },
});
