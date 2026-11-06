import { describe, expect, it } from "vitest";
import { companyPortabilityService } from "../services/company-portability.js";

async function preview(company: string, agent?: string) {
  return companyPortabilityService({} as never).previewImport({
    source: {
      type: "inline",
      files: {
        "COMPANY.md": company,
        ...(agent ? { "agents/owner/AGENTS.md": agent } : {}),
      },
    },
    include: { company: true, agents: true, projects: false, issues: false },
    target: { mode: "new_company", newCompanyName: "Example" },
    agents: "all",
    collisionStrategy: "rename",
  });
}

async function agentDiagnostics(agent: string) {
  try {
    const result = await preview("---\nname: Example\n---\n\nCompany\n", agent);
    return [...result.errors, ...result.warnings].join("\n");
  } catch (error) {
    expect(error).toMatchObject({ status: 422 });
    return error instanceof Error ? error.message : "";
  }
}

describe("company import YAML preview", () => {
  it("preserves flow-style skill references and warns when the referenced skills are missing", async () => {
    const result = await preview(
      "---\nname: Example\n---\n\nCompany\n",
      "---\nname: Owner\nskills: [plan, review]\n---\n\nAgent\n",
    );

    expect(result.manifest.agents[0]?.skills).toEqual(["plan", "review"]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("references skill plan"),
      expect.stringContaining("references skill review"),
    ]));
  });

  it("excludes YAML comments from the company name", async () => {
    const result = await preview("---\nname: Example # a comment\n---\n\nCompany\n");
    expect(result.manifest.company?.name).toBe("Example");
  });

  it("does not warn when frontmatter contains only comments", async () => {
    const result = await preview("---\n# draft notes\n---\n\nCompany\n");
    expect(result.warnings.filter((warning) => warning.includes("not a mapping"))).toEqual([]);
  });

  it("warns when the company frontmatter is not a mapping", async () => {
    const result = await preview("---\n- one\n- two\n---\n\nCompany\n");
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("not a mapping")]));
  });

  it("preserves a multi-line company description", async () => {
    const result = await preview(
      "---\nname: Example\ndescription: |\n  First line\n  Second line\n---\n\nCompany\n",
    );
    expect(result.manifest.company?.description).toBe("First line\nSecond line");
  });

  it("does not silently omit malformed YAML skill references", async () => {
    const message = await agentDiagnostics("---\nname: Owner\nskills: [plan, review\n---\n\nAgent\n");
    expect(message).toMatch(/yaml|frontmatter/i);
  });

  it.each([
    ["a scalar", "skills: plan"],
    ["a non-string entry", 'skills: ["plan", 42]'],
  ])("reports invalid skills represented by %s", async (_description, skills) => {
    const message = await agentDiagnostics(`---\nname: Owner\n${skills}\n---\n\nAgent\n`);
    expect(message).toMatch(/skill/i);
    expect(message).toMatch(/invalid|must|expected|array|list/i);
  });
});
