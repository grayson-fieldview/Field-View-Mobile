const palette = {
  amber: "#f59e0b",
  amberDark: "#b45309",
  charcoal: "#111418",
  charcoalLight: "#1b1f25",
  charcoalMuted: "#262b33",
  white: "#ffffff",
  off: "#f5f5f4",
  slate: "#9ca3af",
  slateDark: "#6b7280",
  border: "#2a2f38",
  borderLight: "#e5e7eb",
  success: "#10b981",
  danger: "#ef4444",
};

const colors = {
  light: {
    text: "#111418",
    tint: palette.amber,

    background: "#fafaf9",
    foreground: "#111418",

    card: "#ffffff",
    cardForeground: "#111418",

    primary: palette.amber,
    primaryForeground: "#111418",

    secondary: "#f5f5f4",
    secondaryForeground: "#111418",

    muted: "#f5f5f4",
    mutedForeground: "#6b7280",

    accent: "#fef3c7",
    accentForeground: "#78350f",

    destructive: palette.danger,
    destructiveForeground: "#ffffff",

    border: "#e7e5e4",
    input: "#e7e5e4",

    success: palette.success,
  },

  dark: {
    text: "#f5f5f4",
    tint: palette.amber,

    background: palette.charcoal,
    foreground: "#f5f5f4",

    card: palette.charcoalLight,
    cardForeground: "#f5f5f4",

    primary: palette.amber,
    primaryForeground: "#111418",

    secondary: palette.charcoalMuted,
    secondaryForeground: "#f5f5f4",

    muted: palette.charcoalMuted,
    mutedForeground: palette.slate,

    accent: "#3a2a0f",
    accentForeground: palette.amber,

    destructive: palette.danger,
    destructiveForeground: "#ffffff",

    border: palette.border,
    input: palette.border,

    success: palette.success,
  },

  radius: 14,
};

export default colors;
