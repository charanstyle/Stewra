/**
 * Stewra's single source of truth for color literals. The color-literal-enforcer
 * hook blocks any hex/named/rgb literal in a StyleSheet color property outside of
 * this file, so every screen/component must reference `theme.colors.*` instead of
 * hardcoding a value.
 */
export interface ThemeColors {
  readonly background: string;
  readonly surface: string;
  readonly surfaceAlt: string;
  readonly border: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textInverse: string;
  readonly primary: string;
  readonly primaryPressed: string;
  readonly onPrimary: string;
  readonly success: string;
  readonly danger: string;
  readonly dangerPressed: string;
  readonly warning: string;
  readonly bubbleOutgoing: string;
  readonly bubbleIncoming: string;
  readonly overlay: string;
  readonly shadow: string;
  readonly online: string;
  readonly offline: string;
}

export const colors: ThemeColors = {
  background: '#0B0F14',
  surface: '#141B22',
  surfaceAlt: '#1C2530',
  border: '#26313D',
  textPrimary: '#F5F7FA',
  textSecondary: '#9AA7B4',
  textInverse: '#0B0F14',
  primary: '#3D8BFD',
  primaryPressed: '#2E6FD1',
  onPrimary: '#FFFFFF',
  success: '#31C48D',
  danger: '#E5484D',
  dangerPressed: '#C13A3E',
  warning: '#F5A524',
  bubbleOutgoing: '#215D8F',
  bubbleIncoming: '#1C2530',
  overlay: 'rgba(11, 15, 20, 0.72)',
  shadow: '#000',
  online: '#31C48D',
  offline: '#5C6773',
} as const;

export const theme = {
  colors,
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
  },
  radius: {
    sm: 8,
    md: 12,
    lg: 20,
    pill: 999,
  },
} as const;

export type Theme = typeof theme;
