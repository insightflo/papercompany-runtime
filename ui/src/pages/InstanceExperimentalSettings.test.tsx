// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InstanceExperimentalSettings } from "./InstanceExperimentalSettings";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  // Only the experimental-settings query returns data; allowlist name lookups (companies etc.) stay empty.
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: queryKey[0] === "instance"
      ? {
        enableKnowledgePatternInjection: true,
        enableQaRebindRecoveryV1: false,
      }
      : undefined,
    isLoading: false,
    error: null,
  }),
  useQueries: ({ queries }: { queries: unknown[] }) => queries.map(() => ({ data: undefined, isLoading: false })),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

describe("InstanceExperimentalSettings", () => {
  it("renders toggles for knowledge pattern injection and QA rebind recovery with current state", () => {
    const html = renderToStaticMarkup(<InstanceExperimentalSettings />);

    expect(html).toContain("실험 기능");
    expect(html).toContain("Knowledge Pattern Injection");
    expect(html).toContain("QA Rebind Recovery V1");
    expect(html).toMatch(/aria-label="Toggle knowledge pattern injection"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/aria-label="Toggle QA rebind recovery v1"[^>]*aria-pressed="false"/);
  });
});
