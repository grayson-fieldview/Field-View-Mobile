import { useRouter } from "expo-router";
import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

export default function ForgotScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    setError(null);
    setLoading(true);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ flex: 1, backgroundColor: colors.muted }}
      contentContainerStyle={[
        styles.container,
        { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 },
      ]}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.title, { color: colors.foreground }]}>
        Reset your password
      </Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        We’ll send a reset link to your email
      </Text>

      {sent ? (
        <View style={styles.form}>
          <View
            style={[
              styles.successBox,
              { backgroundColor: colors.accent, borderColor: colors.border },
            ]}
          >
            <Text style={{ color: colors.accentForeground, fontFamily: "Inter_500Medium" }}>
              If an account exists for {email.trim()}, a reset link is on its way.
            </Text>
          </View>
          <Button title="Back to sign in" onPress={() => router.back()} size="lg" />
        </View>
      ) : (
        <View style={styles.form}>
          <Input
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@company.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {error ? (
            <Text style={{ color: colors.destructive, fontFamily: "Inter_500Medium" }}>
              {error}
            </Text>
          ) : null}
          <Button title="Send reset link" onPress={handleSend} loading={loading} size="lg" />
          <Button title="Back" variant="ghost" onPress={() => router.back()} />
        </View>
      )}
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
  successBox: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
});
