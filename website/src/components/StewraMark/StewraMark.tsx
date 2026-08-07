import React, { useId } from 'react';

interface StewraMarkProps {
  /** Rendered width and height in px. The artwork is square and scales cleanly from 16 to 1024. */
  readonly size?: number;
  readonly className?: string;
  /**
   * Set when the mark sits next to a visible wordmark, so a screen reader does not announce the
   * brand twice. Left off, it announces itself.
   */
  readonly decorative?: boolean;
}

/**
 * The Stewra mark: a message bubble mid-conversation, on a rounded tile.
 *
 * A placeholder in the sense that it is not the output of a brand exercise, but a real one in the
 * sense that it says what the product is — everything in Stewra happens through text messaging —
 * and it survives being shrunk. The three dots stay legible at 16px favicon size where a monogram
 * or anything finer turns to mush, which matters because this artwork is also the 1024×1024 icon
 * Meta shows clients in the Embedded Signup consent dialog.
 *
 * The gradient needs a document-unique id: two marks on one page sharing an id makes the second
 * one render with no fill in Safari. `useId` is what guarantees that per instance.
 *
 * `public/favicon.svg` and `public/icon-1024.png` carry the same geometry. Change one, change all
 * three — `scripts/render-icon.mjs` regenerates the PNG from the SVG.
 */
export const StewraMark: React.FC<StewraMarkProps> = ({ size = 32, className, decorative = true }) => {
  const gradientId = useId();

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : 'Stewra'}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6D5BF5" />
          <stop offset="1" stopColor="#B44BEA" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill={`url(#${gradientId})`} />
      {/* Tail first, so the seam where it meets the body is covered by the body. */}
      <polygon points="23,39 23,50 34,40" fill="#FFFFFF" />
      <rect x="13" y="14" width="38" height="26" rx="7" fill="#FFFFFF" />
      <circle cx="24.5" cy="27" r="3.1" fill="#6D5BF5" />
      <circle cx="32" cy="27" r="3.1" fill="#8B54F0" />
      <circle cx="39.5" cy="27" r="3.1" fill="#B44BEA" />
    </svg>
  );
};

export default StewraMark;
