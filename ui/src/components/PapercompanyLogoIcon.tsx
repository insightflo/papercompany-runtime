import { cn } from "../lib/utils";

interface PapercompanyLogoIconProps {
  className?: string;
}

export function PapercompanyLogoIcon({ className }: PapercompanyLogoIconProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn("block", className)}
    >
      <path d="M12 4.5h32.5L59 19v40.5H12z" fill="#fafafa" />
      <path d="M44.5 4.5V19H59" fill="#e4e4e7" />
      <path
        d="M12 4.5h32.5L59 19v40.5H12z"
        stroke="#27272a"
        strokeWidth="3.2"
        strokeLinejoin="round"
      />
      <path
        d="M44.5 4.5V19H59"
        stroke="#27272a"
        strokeWidth="3.2"
        strokeLinejoin="round"
      />
      <path
        d="M30 18 10 38 10 48 19 57 29 57 48 38 48 28 42 22 33 22 14 41 14 47 19 52 26 52 45 33"
        stroke="#71717a"
        strokeWidth="6.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M30 18 10 38 10 48 19 57 29 57 48 38 48 28 42 22 33 22 14 41 14 47 19 52 26 52 45 33"
        stroke="#d4d4d8"
        strokeWidth="3.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
