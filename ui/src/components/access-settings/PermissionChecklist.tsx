import { PERMISSION_KEYS, type PermissionKey } from "@paperclipai/shared";
import {
  hasGrant,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  type GrantLike,
} from "./utils";

export function PermissionChecklist({
  grants,
  disabled,
  onToggle,
}: {
  grants: readonly GrantLike[] | undefined;
  disabled: boolean;
  onToggle: (permissionKey: PermissionKey, checked: boolean) => void;
}) {
  return (
    <div className="grid gap-2 xl:grid-cols-2">
      {PERMISSION_KEYS.map((permissionKey) => (
        <label
          key={permissionKey}
          className="flex min-h-10 items-start gap-2 rounded-md px-1 py-1 text-sm"
        >
          <input
            className="mt-1"
            type="checkbox"
            checked={hasGrant(grants, permissionKey)}
            disabled={disabled}
            onChange={(event) => onToggle(permissionKey, event.target.checked)}
          />
          <span className="min-w-0">
            <span className="block font-medium">{PERMISSION_LABELS[permissionKey]}</span>
            <span className="block text-xs text-muted-foreground">
              {PERMISSION_DESCRIPTIONS[permissionKey]}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
