// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InstanceExperimentalSettings } from "./InstanceExperimentalSettings";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: () => ({
    data: {
      enableKnowledgePatternInjection: true,
      enableQaRebindRecoveryV1: false,
    },
    isLoading: false,
    error: null,
  }),
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
