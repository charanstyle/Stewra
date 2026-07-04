import palette from './palette.json';

/**
 * Stewra's single source of truth for color literals lives in `./palette.json`. The
 * color-literal-enforcer hook blocks any hex/named/rgb literal in a StyleSheet color
 * property outside of this file, so every screen/component must reference
 * `theme.colors.*` instead of hardcoding a value. The raw values live in JSON (not
 * inline here) so `app.config.ts` — evaluated by Expo's plain-Node config loader,
 * which cannot resolve nested `.ts` imports at prebuild time — can import the exact
 * same palette (`.json` is natively resolvable) without duplicating any literal.
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

export const colors: ThemeColors = palette;

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
