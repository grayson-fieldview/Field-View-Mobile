import { useRouter } from "expo-router";
import * as Linking from "expo-linking";
import React, { useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BrandHeader } from "@/components/auth/BrandHeader";
import { CheckboxRow } from "@/components/auth/CheckboxRow";
import { FieldLabel } from "@/components/auth/FieldLabel";
import {
  authScreenStyles as shared,
  BRAND_ORANGE,
} from "@/components/auth/authScreenStyles";
import { Button } from "@/components/Button";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

/**
 * Onboarding screen 1 of 2 — identity + consent. NO back chevron (the
 * user is already signed in; back has nowhere to go). NO PATCH here:
 * values are carried to screen 2 via router params and submitted
 * there in a single flow.
 */
export default function OnboardingProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, signOut } = useAuth();
  const isOwner = user?.isOwner === true;

  // Prefill first/last from the current user (OAuth-provided when
  // available). Company name deliberately prefills EMPTY — never the
  // synthesized "<name>'s Team" placeholder.
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [companyName, setCompanyName] = useState("");
  const [phone, setPhone] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [tcpaAccepted, setTcpaAccepted] = useState(false);

  const phoneOk = phone.trim().length >= 10 && phone.trim().length <= 20;
  const canContinue =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    phoneOk &&
    (!isOwner || companyName.trim().length > 0) &&
    termsAccepted;

  const onSignOut = () => {
    Alert.alert(
      "Sign out?",
      "You’ll need to sign in again to access your projects.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: signOut },
      ],
    );
  };

  const handleContinue = () => {
    router.push({
      pathname: "/(auth)/onboarding-details",
      params: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        companyName: isOwner ? companyName.trim() : "",
        phone: phone.trim(),
        tcpaAccepted: tcpaAccepted ? "1" : "0",
      },
    });
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
      <View style={shared.content}>
        <BrandHeader />

        <Text style={[shared.title, { color: colors.foreground }]}>
          Tell us about yourself
        </Text>
        <Text style={[shared.subtitle, { color: colors.mutedForeground }]}>
          Just a few details to set up your account.
        </Text>

        <FieldLabel>First Name</FieldLabel>
        <View
          style={[
            shared.input,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <TextInput
            value={firstName}
            onChangeText={setFirstName}
            placeholder="First name"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="words"
            autoComplete="given-name"
            style={[shared.inputText, { color: colors.foreground }]}
          />
        </View>

        <FieldLabel style={{ marginTop: 14 }}>Last Name</FieldLabel>
        <View
          style={[
            shared.input,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <TextInput
            value={lastName}
            onChangeText={setLastName}
            placeholder="Last name"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="words"
            autoComplete="family-name"
            style={[shared.inputText, { color: colors.foreground }]}
          />
        </View>

        {isOwner ? (
          <>
            <FieldLabel style={{ marginTop: 14 }}>Company Name</FieldLabel>
            <View
              style={[
                shared.input,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <TextInput
                value={companyName}
                onChangeText={setCompanyName}
                placeholder="Your company name"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="words"
                autoComplete="organization"
                style={[shared.inputText, { color: colors.foreground }]}
              />
            </View>
          </>
        ) : null}

        <FieldLabel style={{ marginTop: 14 }}>Phone</FieldLabel>
        <View
          style={[
            shared.input,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <TextInput
            value={phone}
            onChangeText={setPhone}
            placeholder="(555) 555-1234"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="phone-pad"
            autoComplete="tel"
            style={[shared.inputText, { color: colors.foreground }]}
          />
        </View>

        <CheckboxRow
          checked={termsAccepted}
          onToggle={() => setTermsAccepted((v) => !v)}
        >
          <Text
            style={{
              fontSize: 13,
              fontFamily: "Inter_400Regular",
              color: colors.mutedForeground,
              lineHeight: 18,
            }}
          >
            I agree to the{" "}
            <Text
              style={{
                textDecorationLine: "underline",
                color: colors.foreground,
              }}
              onPress={() => {
                void Linking.openURL(
                  "https://www.field-view.com/legal/terms-and-conditions",
                );
              }}
            >
              Terms of Service
            </Text>{" "}
            and{" "}
            <Text
              style={{
                textDecorationLine: "underline",
                color: colors.foreground,
              }}
              onPress={() => {
                void Linking.openURL(
                  "https://www.field-view.com/legal/privacy-policy",
                );
              }}
            >
              Privacy Policy
            </Text>
          </Text>
        </CheckboxRow>

        <CheckboxRow
          checked={tcpaAccepted}
          onToggle={() => setTcpaAccepted((v) => !v)}
        >
          <Text
            style={{
              fontSize: 13,
              fontFamily: "Inter_400Regular",
              color: colors.mutedForeground,
              lineHeight: 18,
            }}
          >
            I agree to receive product updates and SMS from Field View at
            the phone number provided. Message and data rates may apply.
            Reply STOP to opt out.
          </Text>
        </CheckboxRow>

        <Button
          title="Continue"
          onPress={handleContinue}
          disabled={!canContinue}
          size="lg"
          style={{ marginTop: 20, backgroundColor: BRAND_ORANGE }}
        />

        {/* Escape hatch: a user who abandons signup mid-onboarding and
            relaunches is signed in with profileCompletedAt null, so
            AuthGate routes here with no back chevron (nowhere to go).
            Sign out clears the session; AuthGate then routes to
            welcome. Same confirm-Alert pattern as settings. */}
        <Text
          onPress={onSignOut}
          accessibilityRole="button"
          style={{
            marginTop: 16,
            textAlign: "center",
            fontSize: 14,
            fontFamily: "Inter_500Medium",
            textDecorationLine: "underline",
            color: colors.mutedForeground,
          }}
        >
          Sign out
        </Text>
      </View>
    </KeyboardAwareScrollViewCompat>
  );
}
