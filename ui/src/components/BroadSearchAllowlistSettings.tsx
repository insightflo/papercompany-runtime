import { useState } from "react";
import type { InstanceExperimentalSettings, PatchInstanceExperimentalSettings } from "@paperclipai/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { agentsApi } from "../api/agents";
import { companiesApi } from "../api/companies";
import { missionsApi, type MissionListFilters } from "../api/missions";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";

type AllowlistField =
  | "broadSearchAllowedCompanyIdsV1"
  | "broadSearchAllowedMissionIdsV1"
  | "broadSearchAllowedAgentIdsV1";
type Allowlists = Pick<InstanceExperimentalSettings, AllowlistField>;
interface Props {
  settings: InstanceExperimentalSettings | undefined;
  pending: boolean;
  onSave: (patch: PatchInstanceExperimentalSettings) => Promise<unknown>;
}

interface Choice { id: string; name: string }

// Mission picker shows the most recently updated missions; older saved IDs still resolve via GET /missions/:id.
const RECENT_MISSIONS: MissionListFilters = { sortBy: "updatedAt", sortOrder: "desc", limit: 100 };
const SELECT_CLASS =
  "h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50";

function shortId(id: string) {
  return id.slice(0, 8);
}

interface ListProps {
  label: string;
  ids: string[];
  pending: boolean;
  resolve: Resolver;
  onChange: (ids: string[]) => void;
}

/** Returns the display name, LOADING while lookups are in flight, or undefined when the ID is unknown. */
type Resolver = (id: string) => string | typeof LOADING | undefined;
const LOADING = Symbol("loading");

function AllowlistChips({ label, ids, pending, resolve, onChange }: ListProps) {
  return (
    <>
      <ul aria-label={`${label} 허용 목록`} className="flex flex-wrap gap-2">
        {ids.map((id) => {
          const name = resolve(id);
          return (
            <li key={id} className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted px-2 py-1 text-xs">
              {name === LOADING ? (
                <span className="break-all text-muted-foreground">불러오는 중... ({shortId(id)})</span>
              ) : name ? (
                <span className="break-all">
                  {name} <span className="font-mono text-muted-foreground" title={id}>{shortId(id)}</span>
                </span>
              ) : (
                <span className="break-all text-muted-foreground">알 수 없음 ({id})</span>
              )}
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`${label} ${id} 제거`}
                disabled={pending} onClick={() => onChange(ids.filter((value) => value !== id))}>
                <X aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
      {ids.length === 0 && <p className="text-xs text-muted-foreground">허용된 {label} 없음</p>}
    </>
  );
}

interface SelectProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  choices: Choice[];
  disabled: boolean;
  onChange: (value: string) => void;
}

function LabeledSelect({ id, label, value, placeholder, choices, disabled, onChange }: SelectProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
      <select id={id} value={value} disabled={disabled} className={SELECT_CLASS}
        onChange={(event) => onChange(event.target.value)}>
        <option value="">{placeholder}</option>
        {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
      </select>
    </div>
  );
}

interface PickerProps {
  field: AllowlistField;
  label: string;
  ids: string[];
  pending: boolean;
  companies: Choice[];
  /** Present for agent/mission pickers: choices are loaded per selected company. */
  useScopedChoices?: (companyId: string) => { choices: Choice[]; loading: boolean };
  resolve: Resolver;
  onChange: (ids: string[]) => void;
}

function AllowlistPicker({ field, label, ids, pending, companies, useScopedChoices, resolve, onChange }: PickerProps) {
  const [companyId, setCompanyId] = useState("");
  const [selected, setSelected] = useState("");
  const scoped = useScopedChoices?.(companyId);
  const taken = new Set(ids);
  const available = (scoped ? scoped.choices : companies).filter((choice) => !taken.has(choice.id));
  const baseId = `broad-search-${field}`;
  function add() {
    if (!selected || taken.has(selected)) return;
    onChange([...ids, selected]);
    setSelected("");
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex flex-wrap items-end gap-2">
        {scoped && (
          <LabeledSelect id={`${baseId}-company`} label={`${label} 소속 회사`} value={companyId}
            placeholder="회사를 선택하세요" choices={companies} disabled={pending}
            onChange={(value) => { setCompanyId(value); setSelected(""); }} />
        )}
        <LabeledSelect id={`${baseId}-item`} label={`${label} 선택`} value={selected}
          placeholder={scoped && !companyId ? "먼저 회사를 선택하세요" : scoped?.loading ? "불러오는 중..." : `${label}을(를) 선택하세요`}
          choices={available} disabled={pending || (scoped !== undefined && !companyId)}
          onChange={setSelected} />
        <Button type="button" variant="outline" size="sm" aria-label={`${label} 추가`}
          disabled={pending || !selected} onClick={add}>추가</Button>
      </div>
      <AllowlistChips label={label} ids={ids} pending={pending} resolve={resolve} onChange={onChange} />
    </div>
  );
}

function useAgentChoices(companyId: string) {
  const query = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const choices = (query.data ?? [])
    .filter((agent) => agent.status !== "terminated")
    .map((agent) => ({ id: agent.id, name: agent.name }));
  return { choices, loading: query.isLoading && Boolean(companyId) };
}

function useMissionChoices(companyId: string) {
  const query = useQuery({
    queryKey: queryKeys.missions.list(companyId, RECENT_MISSIONS),
    queryFn: () => missionsApi.list(companyId, RECENT_MISSIONS),
    enabled: Boolean(companyId),
  });
  const choices = (query.data ?? []).map((mission) => ({ id: mission.id, name: mission.title }));
  return { choices, loading: query.isLoading && Boolean(companyId) };
}

export function BroadSearchAllowlistSettings({ settings, pending, onSave }: Props) {
  const [draft, setDraft] = useState<Allowlists | null>(null);
  const lists = draft ?? {
    broadSearchAllowedCompanyIdsV1: settings?.broadSearchAllowedCompanyIdsV1 ?? [],
    broadSearchAllowedMissionIdsV1: settings?.broadSearchAllowedMissionIdsV1 ?? [],
    broadSearchAllowedAgentIdsV1: settings?.broadSearchAllowedAgentIdsV1 ?? [],
  };
  const companiesQuery = useQuery({ queryKey: queryKeys.companies.all, queryFn: () => companiesApi.list() });
  const companies: Choice[] = (companiesQuery.data ?? []).map((company) => ({ id: company.id, name: company.name }));
  const companyName = new Map(companies.map((company) => [company.id, company.name]));
  const withCompany = (name: string, companyId: string) =>
    `${name} (${companyName.get(companyId) ?? "알 수 없는 회사"})`;

  // Agent chips need every company's roster (instance page has no company context).
  const agentQueries = useQueries({
    queries: companies.map((company) => ({
      queryKey: queryKeys.agents.list(company.id),
      queryFn: () => agentsApi.list(company.id),
    })),
  });
  const agentLabel = new Map<string, string>();
  for (const query of agentQueries) {
    for (const agent of query.data ?? []) agentLabel.set(agent.id, withCompany(agent.name, agent.companyId));
  }

  // Saved missions may be outside the recent picker window, so resolve each saved ID directly.
  const missionQueries = useQueries({
    queries: lists.broadSearchAllowedMissionIdsV1.map((id) => ({
      queryKey: queryKeys.missions.detail(id),
      queryFn: () => missionsApi.get(id),
      retry: false,
    })),
  });
  const missionLabel = new Map<string, string>();
  for (const query of missionQueries) {
    if (query.data) missionLabel.set(query.data.id, withCompany(query.data.title, query.data.companyId));
  }
  const missionLoading = new Set(
    lists.broadSearchAllowedMissionIdsV1.filter((_, index) => missionQueries[index]?.isLoading),
  );
  const companiesLoading = companiesQuery.isLoading;
  const agentsLoading = companiesLoading || agentQueries.some((query) => query.isLoading);
  const resolveCompany: Resolver = (id) => companyName.get(id) ?? (companiesLoading ? LOADING : undefined);
  const resolveAgent: Resolver = (id) => agentLabel.get(id) ?? (agentsLoading ? LOADING : undefined);
  const resolveMission: Resolver = (id) =>
    missionLabel.get(id) ?? (missionLoading.has(id) ? LOADING : undefined);

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
        <p className="text-xs text-muted-foreground">목록에서 이름으로 선택해 추가하거나 제거한 뒤 목록을 저장하세요. 새 실행부터 반영되며, 이미 실행 중인 권한은 바뀌지 않습니다.</p>
      </div>
      <AllowlistPicker field="broadSearchAllowedCompanyIdsV1" label="회사" ids={lists.broadSearchAllowedCompanyIdsV1}
        pending={pending} companies={companies} resolve={resolveCompany}
        onChange={(ids) => setDraft({ ...lists, broadSearchAllowedCompanyIdsV1: ids })} />
      <AllowlistPicker field="broadSearchAllowedMissionIdsV1" label="미션" ids={lists.broadSearchAllowedMissionIdsV1}
        pending={pending} companies={companies} useScopedChoices={useMissionChoices} resolve={resolveMission}
        onChange={(ids) => setDraft({ ...lists, broadSearchAllowedMissionIdsV1: ids })} />
      <AllowlistPicker field="broadSearchAllowedAgentIdsV1" label="에이전트" ids={lists.broadSearchAllowedAgentIdsV1}
        pending={pending} companies={companies} useScopedChoices={useAgentChoices} resolve={resolveAgent}
        onChange={(ids) => setDraft({ ...lists, broadSearchAllowedAgentIdsV1: ids })} />
      <Button type="button" size="sm" disabled={pending || draft === null} onClick={() => void save()}>
        {pending ? "저장 중..." : "광역 탐색 허용 목록 저장"}
      </Button>
    </section>
  );
}
