import { useRouter } from "expo-router";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      await signIn(email, password);
      router.replace("/(tabs)");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed.");
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
      <View
        style={[
          styles.brandBadge,
          { backgroundColor: colors.primary },
        ]}
      >
        <Feather name="camera" size={22} color={colors.primaryForeground} />
      </View>
      <Text style={[styles.title, { color: colors.foreground }]}>
        Welcome back
      </Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        Sign in to your Field View account
      </Text>

      <View style={styles.form}>
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
          placeholder="Your password"
          secureTextEntry
          autoComplete="password"
        />
        {error ? (
          <Text style={{ color: colors.destructive, fontFamily: "Inter_500Medium" }}>
            {error}
          </Text>
        ) : null}
        <Button
          title="Sign in"
          onPress={handleLogin}
          loading={loading}
          size="lg"
        />
        <Pressable onPress={() => router.push("/(auth)/forgot")} hitSlop={8}>
          <Text style={[styles.link, { color: colors.primary }]}>
            Forgot password?
          </Text>
        </Pressable>
      </View>

      <View style={styles.footer}>
        <Text style={{ color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
          New to Field View?{" "}
        </Text>
        <Pressable onPress={() => router.push("/(auth)/signup")} hitSlop={8}>
          <Text style={[styles.linkInline, { color: colors.primary }]}>
            Create account
          </Text>
        </Pressable>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 24, gap: 8 },
  brandBadge: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
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
  link: {
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
    marginTop: 4,
    paddingVertical: 6,
  },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 28 },
  linkInline: { fontFamily: "Inter_600SemiBold" },
});
