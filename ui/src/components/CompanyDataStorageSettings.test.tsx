// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompanyDataStorageSettings } from "./CompanyDataStorageSettings";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => ({
    data: queryKey[0] === "company-data-storage"
      ? {
          provider: "s3",
          endpoint: "https://storage.example.test",
          region: "us-east-1",
          bucket: "shared-data",
          keyPrefix: "gazua",
          forcePathStyle: true,
          accessKeySecretId: "access-key-secret",
          secretAccessKeySecretId: "secret-access-key-secret",
        }
      : [
          { id: "access-key-secret", name: "S3 shared-data access key" },
          { id: "secret-access-key-secret", name: "S3 shared-data secret access key" },
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

describe("CompanyDataStorageSettings", () => {
  it("renders normalized cumulative data boundaries without exposing credentials", () => {
    const html = renderToStaticMarkup(<CompanyDataStorageSettings companyId="company-1" />);

    expect(html).toContain("Shared Data Storage");
    expect(html).toContain("Normalized, cumulative source data");
    expect(html).toContain("raw responses in a separate incoming store");
    expect(html).toContain("Example layout:");
    expect(html).toContain("Final deliverables belong in Work-product Storage, not here.");
    expect(html).toContain("The key prefix is the company data root.");
    expect(html).toContain("Key prefix (required company data root)");
    expect(html).toContain("Operators must choose a unique prefix per company.");
    expect(html).toContain('value="https://storage.example.test"');
    expect(html).toContain('value="shared-data"');
    expect(html).toContain('value="gazua"');
    expect(html).toContain("Test saved shared-data connection");
    expect(html).not.toContain("AKIA");
    expect(html).not.toContain("super-secret");
  });
});
