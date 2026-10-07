import { useState } from "react";
import type { InstanceExperimentalSettings, PatchInstanceExperimentalSettings } from "@paperclipai/shared";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const scopes = [
  { field: "broadSearchAllowedCompanyIdsV1", label: "회사" },
  { field: "broadSearchAllowedMissionIdsV1", label: "미션" },
  { field: "broadSearchAllowedAgentIdsV1", label: "에이전트" },
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AllowlistField = typeof scopes[number]["field"];
type Allowlists = Pick<InstanceExperimentalSettings, AllowlistField>;
interface Props {
  settings: InstanceExperimentalSettings | undefined;
  pending: boolean;
  onSave: (patch: PatchInstanceExperimentalSettings) => Promise<unknown>;
}

interface EditorProps {
  field: AllowlistField;
  label: string;
  ids: string[];
  pending: boolean;
  onChange: (ids: string[]) => void;
}

function AllowlistEditor({ field, label, ids, pending, onChange }: EditorProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = `broad-search-${field}`;
  const errorId = `${inputId}-error`;
  function addId() {
    const id = input.trim().toLowerCase();
    if (!id) return;
    // Server validates z.string().uuid(); reject early with an inline message instead of a page-level error.
    if (!UUID_PATTERN.test(id)) {
      setError(`${label} ID는 UUID 형식이어야 합니다.`);
      return;
    }
    setError(null);
    onChange(ids.some((value) => value.toLowerCase() === id) ? ids : [...ids, id]);
    setInput("");
  }
  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-sm font-medium">{label} ID</label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={input}
          disabled={pending}
          placeholder={`${label} ID를 입력하세요`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => { setInput(event.target.value); setError(null); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); addId(); }
          }}
        />
        <Button type="button" variant="outline" size="sm" aria-label={`${label} ID 추가`}
          disabled={pending || !input.trim()} onClick={addId}>추가</Button>
      </div>
      {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
      <ul aria-label={`${label} 허용 목록`} className="flex flex-wrap gap-2">
        {ids.map((id) => (
          <li key={id} className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted px-2 py-1 text-xs">
            <span className="break-all">{id}</span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`${label} ${id} 제거`}
              disabled={pending} onClick={() => onChange(ids.filter((value) => value !== id))}>
              <X aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      {ids.length === 0 && <p className="text-xs text-muted-foreground">허용된 {label} 없음</p>}
    </div>
  );
}

export function BroadSearchAllowlistSettings({ settings, pending, onSave }: Props) {
  const [draft, setDraft] = useState<Allowlists | null>(null);
  const lists = draft ?? {
    broadSearchAllowedCompanyIdsV1: settings?.broadSearchAllowedCompanyIdsV1 ?? [],
    broadSearchAllowedMissionIdsV1: settings?.broadSearchAllowedMissionIdsV1 ?? [],
    broadSearchAllowedAgentIdsV1: settings?.broadSearchAllowedAgentIdsV1 ?? [],
  };
  async function save() {
    try {
      await onSave(lists);
      setDraft(null);
    } catch {
      // The page's existing mutation displays the error; retain edits for retry.
    }
  }
  return (
    <section aria-labelledby="broad-search-heading" className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="space-y-1.5">
        <h2 id="broad-search-heading" className="text-sm font-semibold">광역 탐색 허용 (실험)</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          기본 목록은 비어 있으며 광역 탐색을 기본적으로 허용하지 않습니다.
          회사·미션·실행 에이전트 중 하나라도 허용 목록에 해당하면 미션 탐색 범위 제한과 광역 탐색 차단을 모두 해제합니다.
          PLAN(계획), PLAN-QA(계획 검토), 복구 실행에도 적용됩니다.
        </p>
        <p className="text-xs text-muted-foreground">ID를 추가하거나 제거한 뒤 목록을 저장하세요. 새 실행부터 반영되며, 이미 실행 중인 권한은 바뀌지 않습니다.</p>
      </div>
      {scopes.map(({ field, label }) => (
        <AllowlistEditor key={field} field={field} label={label} ids={lists[field]} pending={pending}
          onChange={(ids) => setDraft({ ...lists, [field]: ids })} />
      ))}
      <Button type="button" size="sm" disabled={pending || draft === null} onClick={() => void save()}>
        {pending ? "저장 중..." : "광역 탐색 허용 목록 저장"}
      </Button>
    </section>
  );
}
