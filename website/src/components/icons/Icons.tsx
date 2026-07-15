/**
 * Hand-authored inline SVG icons used across the messaging/call UI. Inline (not an icon dependency) to
 * keep the no-new-deps stance, and SVG (not emoji) so icons render consistently and are styleable via
 * `currentColor` + CSS sizing. Each takes an optional `size`/`className`; color follows `currentColor`.
 */
interface IconProps {
  readonly size?: number;
  readonly className?: string;
}

function svgProps({ size = 20, className }: IconProps): React.SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className,
    'aria-hidden': true,
  };
}

export function PhoneIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export function VideoIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="m23 7-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

export function VideoOffIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export function MicIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

export function MicOffIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

export function PlayIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

export function PhoneOffIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export function EyeIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

/** "needs_reply" nudge kind — a reply arrow. */
export function ReplyIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

/** "important_unread" nudge kind — an envelope. */
export function MailIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 5L2 7" />
    </svg>
  );
}

/** "follow_up" nudge kind — a clock, for "haven't heard back yet". */
export function ClockIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 16 14" />
    </svg>
  );
}

/** "calendar_prep" nudge kind — a calendar. */
export function CalendarIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

/** "other" nudge kind — a generic sparkle/attention mark. */
export function SparkleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3.5 3.5M14.5 14.5 18 18M18 6l-3.5 3.5M9.5 14.5 6 18" />
    </svg>
  );
}

/** "Chat with Stewra about this" — a speech bubble. */
export function ChatBubbleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Expand/collapse affordance on the nudge card header. */
export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** Single check — a message that has been sent (one tick). */
export function CheckIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Double check — delivered (grey) or read (accent), the WhatsApp-style two ticks. */
export function CheckCheckIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M18 6 7 17l-5-5" />
      <path d="m22 10-7.5 7.5L13 16" />
    </svg>
  );
}

/** Warning triangle — the WhatsApp-personal ban-risk notice. */
export function AlertTriangleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

/** Laptop — a Stewra Bridge device row (the bridge runs on the user's own computer). */
export function LaptopIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(props)}>
      <rect x="3" y="4" width="18" height="12" rx="2" ry="2" />
      <line x1="1" y1="20" x2="23" y2="20" />
    </svg>
  );
}
