/** @vitest-environment jsdom */
// [purpose] 내보내기 미리보기 effect가 응답 완료(isPending false)에 재실행되지 않는지 검증한다.
//   CompanyExport.tsx의 useEffect 의존성에 isPending이 있으면 응답이 끝날 때마다
//   setExportData(null)+mutate()가 반복되어 화면이 영구 스켈레톤에 머문다(2026-11-14 W2 표본).
//   실제 @tanstack/react-query로 isPending 토글이 effect 재실행을 유발하지 않음을 확인한다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CompanyExport } from "./CompanyExport";

const exportPreview = vi.fn();

vi.mock("../api/companies", () => ({
  companiesApi: {
    exportPreview: (...args: unknown[]) => exportPreview(...args),
    exportPackage: vi.fn(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Research Company" },
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/RES/company/export" }),
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function previewResult() {
  return {
    rootPath: "research-company",
    manifest: null,
    warnings: [] as string[],
    paperclipExtensionPath: null,
    files: {
      "COMPANY.md": "# Research Company",
    } as Record<string, string>,
  };
}

let container: HTMLElement | null = null;
let root: Root | null = null;

function mountPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <CompanyExport />
      </QueryClientProvider> satisfies ReactNode,
    );
  });
}

afterEach(async () => {
  await act(async () => {
    await root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  exportPreview.mockClear();
});

describe("CompanyExport — preview effect loop", () => {
  it("calls exportPreview once per company after the response settles", async () => {
    // 실제 표본에서는 미리보기가 약 18초 걸려 isPending=true 상태가 여러 커밋에 걸쳐 유지된 뒤
    // 응답 완료로 false로 토글됐다. 즉시 응답하는 mock으로는 재현되지 않으므로 지연을 둔다.
    exportPreview.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return previewResult();
    });
    mountPage();

    // 첫 요청이 발생하고 응답이 반영될 때까지 기다린다.
    await vi.waitFor(() => {
      expect(exportPreview).toHaveBeenCalledTimes(1);
    });

    // 응답 완료로 isPending이 false로 토글되어도 effect가 재실행되지 않아야 한다.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    expect(exportPreview).toHaveBeenCalledTimes(1);
  });
});
