// @vitest-environment node

import { beforeAll, describe, expect, it, vi } from "vitest";

let buttonVariants: (() => string) | undefined;

beforeAll(async () => {
  vi.mock("@/lib/utils", () => ({ cn: (...values: Array<string | null | undefined | false>) => values.filter(Boolean).join(" ") }));
  vi.mock("radix-ui", () => ({ Slot: { Root: "div" } }));
  const module = await import("./button");
  buttonVariants = module.buttonVariants;
});

describe("Button", () => {
  it("uses the pointer cursor for clickable buttons", () => {
    expect(buttonVariants?.()).toContain("cursor-pointer");
  });
});
