import { afterEach, describe, expect, it, vi } from "vitest";
import { findScrollContainer, readScrollMetrics, scrollToContainerBottom } from "./agent-detail-scroll";

afterEach(() => vi.unstubAllGlobals());

describe("agent detail log scrolling", () => {
  it("finds the closest scrolling parent and measures and scrolls it", () => {
    const scrollTo = vi.fn();
    const element = { parentElement: null, scrollHeight: 70, scrollTop: 20, clientHeight: 30, scrollTo } as unknown as HTMLElement;
    vi.stubGlobal("window", { getComputedStyle: () => ({ overflowY: "auto" }) });
    expect(findScrollContainer({ parentElement: element } as HTMLElement)).toBe(element);
    expect(readScrollMetrics(element)).toEqual({ scrollHeight: 70, distanceFromBottom: 20 });
    scrollToContainerBottom(element);
    expect(scrollTo).toHaveBeenCalledWith({ top: 70, behavior: "auto" });
  });
});
