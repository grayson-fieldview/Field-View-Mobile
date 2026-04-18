import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
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

const TRIAL_BENEFITS = [
  "Unlimited photo documentation",
  "Project & task management",
  "Team collaboration tools",
  "Shareable photo galleries",
  "Analytics dashboard",
];

export default function SignupScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signUp } = useAuth();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignup = async () => {
    setError(null);
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
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
          Start your free trial
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          14 days free — add a payment method to get started
        </Text>

        <GoogleButton
          onPress={() =>
            Alert.alert(
              "Google sign-up",
              "Available soon — please use your email to create your account.",
            )
          }
        />
        <OrDivider />

        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <FieldLabel>First name</FieldLabel>
            <TextField
              value={firstName}
              onChangeText={setFirstName}
              placeholder="John"
              autoCapitalize="words"
              autoComplete="given-name"
            />
          </View>
          <View style={{ flex: 1 }}>
            <FieldLabel>Last name</FieldLabel>
            <TextField
              value={lastName}
              onChangeText={setLastName}
              placeholder="Smith"
              autoCapitalize="words"
              autoComplete="family-name"
            />
          </View>
        </View>

        <FieldLabel style={{ marginTop: 14 }}>Work email</FieldLabel>
        <TextField
          value={email}
          onChangeText={setEmail}
          placeholder="john@company.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
        />

        <FieldLabel style={{ marginTop: 14 }}>Password</FieldLabel>
        <PasswordField
          value={password}
          onChangeText={setPassword}
          placeholder="Min. 8 characters"
          show={showPassword}
          onToggleShow={() => setShowPassword((v) => !v)}
          autoComplete="new-password"
        />

        <FieldLabel style={{ marginTop: 14 }}>Confirm password</FieldLabel>
        <PasswordField
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholder="Confirm your password"
          show={showPassword}
          onToggleShow={() => setShowPassword((v) => !v)}
          autoComplete="new-password"
        />

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
          title="Create Account & Start Trial"
          onPress={handleSignup}
          loading={loading}
          size="lg"
          style={{ marginTop: 16 }}
        />

        <View
          style={[
            styles.benefits,
            { backgroundColor: colors.muted, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.benefitsTitle, { color: colors.foreground }]}>
            Your trial includes:
          </Text>
          {TRIAL_BENEFITS.map((b) => (
            <View key={b} style={styles.benefitRow}>
              <Feather name="check-circle" size={16} color={colors.success} />
              <Text
                style={[styles.benefitText, { color: colors.foreground }]}
              >
                {b}
              </Text>
            </View>
          ))}
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

function GoogleButton({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.googleBtn,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.9 : 1,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel="Continue with Google"
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          borderWidth: 2,
          borderColor: "#5f6368",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          style={{
            color: "#5f6368",
            fontFamily: "Inter_700Bold",
            fontSize: 11,
            marginTop: -1,
          }}
        >
          G
        </Text>
      </View>
      <Text style={[styles.googleText, { color: colors.foreground }]}>
        Continue with Google
      </Text>
    </Pressable>
  );
}

function OrDivider() {
  const colors = useColors();
  return (
    <View style={styles.divider}>
      <View style={[styles.divLine, { backgroundColor: colors.border }]} />
      <Text
        style={{
          color: colors.mutedForeground,
          fontFamily: "Inter_500Medium",
          fontSize: 12,
          letterSpacing: 1,
        }}
      >
        OR
      </Text>
      <View style={[styles.divLine, { backgroundColor: colors.border }]} />
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

function TextField(
  props: React.ComponentProps<typeof TextInput>,
) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.input,
        { backgroundColor: colors.muted, borderColor: colors.border },
      ]}
    >
      <TextInput
        placeholderTextColor={colors.mutedForeground}
        {...props}
        style={[styles.inputText, { color: colors.foreground }, props.style]}
      />
    </View>
  );
}

function PasswordField({
  value,
  onChangeText,
  placeholder,
  show,
  onToggleShow,
  autoComplete,
}: {
  value: string;
  onChangeText: (s: string) => void;
  placeholder: string;
  show: boolean;
  onToggleShow: () => void;
  autoComplete?: React.ComponentProps<typeof TextInput>["autoComplete"];
}) {
  const colors = useColors();
  return (
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
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        secureTextEntry={!show}
        autoComplete={autoComplete}
        style={[styles.inputText, { color: colors.foreground, flex: 1 }]}
      />
      <Pressable
        onPress={onToggleShow}
        hitSlop={10}
        accessibilityLabel={show ? "Hide password" : "Show password"}
      >
        <Feather
          name={show ? "eye-off" : "eye"}
          size={18}
          color={colors.mutedForeground}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    paddingHorizontal: 16,
    flexGrow: 1,
    justifyContent: "center",
    paddingVertical: 24,
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
  googleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 12,
  },
  googleText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 16,
  },
  divLine: { flex: 1, height: StyleSheet.hairlineWidth },
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
  benefits: {
    marginTop: 18,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  benefitsTitle: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    marginBottom: 4,
  },
  benefitRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  benefitText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    flexWrap: "wrap",
    marginTop: 18,
  },
  linkInline: { fontFamily: "Inter_600SemiBold" },
});
