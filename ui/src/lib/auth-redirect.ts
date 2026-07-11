export function resolveAuthRedirectPath(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/";
}
