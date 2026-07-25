import type { SVGProps } from "react";

export type IconName =
  | "panel-left"
  | "panel-right"
  | "plus"
  | "search"
  | "folder"
  | "folder-open"
  | "branch"
  | "computer"
  | "sun"
  | "moon"
  | "settings"
  | "spark"
  | "paperclip"
  | "arrow-up"
  | "stop"
  | "chevron-down"
  | "check"
  | "clock"
  | "shield"
  | "plan"
  | "plugin"
  | "activity"
  | "context"
  | "download"
  | "undo"
  | "command"
  | "file"
  | "image"
  | "code"
  | "x"
  | "more"
  | "terminal"
  | "eye"
  | "copy"
  | "refresh"
  | "external"
  | "pin"
  | "archive"
  | "edit"
  | "trash"
  | "mail"
  | "id"
  | "zoom-in"
  | "zoom-out";

const paths: Record<IconName, JSX.Element> = {
  "panel-left": <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></>,
  "panel-right": <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></>,
  plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
  search: <><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></>,
  folder: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/>,
  "folder-open": <><path d="M3 8V6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h7.5A1.5 1.5 0 0 1 20 8.5V10"/><path d="M4 10h17l-2.4 8.2A1.2 1.2 0 0 1 17.4 19H5.6a1.2 1.2 0 0 1-1.2-1L3 11.4A1.2 1.2 0 0 1 4 10Z"/></>,
  branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 12h4a6 6 0 0 0 6-3"/></>,
  computer: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  moon: <path d="M20 15.2A8.2 8.2 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z"/>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  spark: <><path d="M4 15.5h2.2c3.8 0 3.6-7 7.2-7 3.1 0 3.4 5.4 6.6 5.4"/><path d="M5.5 8.2h2.2c3.4 0 3.5 7.6 7.1 7.6h3.7"/><circle cx="4" cy="15.5" r="1" fill="currentColor" stroke="none"/><circle cx="20" cy="13.9" r="1" fill="currentColor" stroke="none"/></>,
  paperclip: <path d="m8 12.5 6.5-6.4a3.2 3.2 0 0 1 4.5 4.5l-8.3 8.2a5 5 0 0 1-7.1-7.1l8-7.9"/>,
  "arrow-up": <><path d="m6 11 6-6 6 6"/><path d="M12 5v14"/></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>,
  "chevron-down": <path d="m7 10 5 5 5-5"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  shield: <path d="M12 3 5 6v5c0 4.6 2.9 8.2 7 10 4.1-1.8 7-5.4 7-10V6z"/>,
  plan: <><path d="M4 6h5l2.1 3H20M4 12h3.5l2.1 3H20M4 18h8l2-3"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="20" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="20" cy="15" r="1" fill="currentColor" stroke="none"/></>,
  plugin: <><path d="M5 5h5v5H5zM14 5h5v5h-5zM9.5 14h5v5h-5z"/><path d="M10 7.5h4M7.5 10v2.5L10 15M16.5 10v2.5L14 15"/></>,
  activity: <><path d="M3 16h3.5c3.3 0 3.1-8 6.4-8 3 0 3.2 7 6.1 7H21"/><path d="M4 10h2.2c2.5 0 2.8 5 5.4 5" opacity=".45"/></>,
  context: <><path d="M12 3a9 9 0 0 1 8.2 5.3M21 12a9 9 0 0 1-7 8.8M10 20.8A9 9 0 0 1 3 14M3.2 10A9 9 0 0 1 8 3.9"/><path d="m12 8 4 4-4 4-4-4Z"/></>,
  download: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/></>,
  undo: <><path d="m9 7-5 5 5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/></>,
  command: <path d="M9 7V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z"/>,
  file: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 4"/></>,
  code: <><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/></>,
  x: <><path d="m6 6 12 12M18 6 6 18"/></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 16h4"/></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
  refresh: <><path d="M20 6v5h-5"/><path d="M18.5 16a8 8 0 1 1 .8-7.2L20 11"/></>,
  external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/></>,
  pin: <><path d="m9 3 6 6"/><path d="m12 6 5 5-3 1-3 3-1 3-5-5 3-1 3-3Z"/><path d="m8 16-4 4"/></>,
  archive: <><rect x="3" y="5" width="18" height="4" rx="1"/><path d="M5 9v11h14V9M9 13h6"/></>,
  edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></>,
  trash: <><path d="M4 7h16M9 3h6l1 4H8zM7 7l1 14h8l1-14"/><path d="M10 11v6M14 11v6"/></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
  id: <><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5.5 16c.6-1.5 1.4-2 2.5-2s1.9.5 2.5 2M13 10h5M13 14h5"/></>,
  "zoom-in": <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5M10.5 7.5v6M7.5 10.5h6"/></>,
  "zoom-out": <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5M7.5 10.5h6"/></>,
};

export function Icon({ name, size = 18, ...props }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

export function ReasoningDepthGlyph({ level, size = 18 }: { level: 1 | 2 | 3; size?: number }) {
  return (
    <svg
      className="reasoning-depth-glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 17h3.2c3.2 0 3.1-10 6.3-10 2.7 0 2.9 7 6.5 7" opacity={level >= 1 ? 1 : 0.2} />
      <path d="M4 12h2.6c3.1 0 3.2 5 6.2 5H20" opacity={level >= 2 ? 1 : 0.2} />
      <path d="M4 7h2.8c2.8 0 3 4 5.9 4H20" opacity={level >= 3 ? 1 : 0.2} />
      <circle cx="4" cy={level === 1 ? 17 : level === 2 ? 12 : 7} r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand-mark${compact ? " brand-mark--compact" : ""}`} aria-hidden="true">
      <span className="brand-mark__image" />
    </span>
  );
}
