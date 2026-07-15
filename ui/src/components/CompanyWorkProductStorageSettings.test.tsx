// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompanyWorkProductStorageSettings } from "./CompanyWorkProductStorageSettings";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => ({
    data: queryKey[0] === "company-work-product-storage"
      ? {
          provider: "s3",
          endpoint: "https://storage.example.test",
          region: "us-east-1",
          bucket: "work-products",
          keyPrefix: "research-company",
          forcePathStyle: true,
          accessKeySecretId: "access-key-secret",
          secretAccessKeySecretId: "secret-access-key-secret",
        }
      : [
          {
            id: "access-key-secret",
            name: "S3 work-product access key",
          },
          {
            id: "secret-access-key-secret",
            name: "S3 work-product secret access key",
          },
        ],
    isPending: false,
    isError: false,
  }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

describe("CompanyWorkProductStorageSettings", () => {
  it("renders a saved S3-compatible configuration without exposing credential values", () => {
    const html = renderToStaticMarkup(
      <CompanyWorkProductStorageSettings companyId="company-1" />,
    );

    expect(html).toContain("Work-product storage");
    expect(html).toContain("S3-compatible");
    expect(html).toContain('value="https://storage.example.test"');
    expect(html).toContain('value="work-products"');
    expect(html).toContain("S3 work-product access key");
    expect(html).toContain("S3 work-product secret access key");
    expect(html).toContain("Test saved connection");
    expect(html).not.toContain("AKIA");
    expect(html).not.toContain("super-secret");
  });
});
