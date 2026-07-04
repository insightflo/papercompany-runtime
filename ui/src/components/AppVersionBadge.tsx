export function AppVersionBadge({ version }: { readonly version?: string }) {
  if (!version) return null;

  const label = `Paperclip version v${version}`;

  return (
    <span
      aria-label={label}
      className="shrink-0 cursor-default px-2 font-mono text-xs tabular-nums text-muted-foreground"
      title={label}
    >
      v{version}
    </span>
  );
}
