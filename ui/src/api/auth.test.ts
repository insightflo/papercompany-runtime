// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { authApi } from "./auth";

type FetchMock = ReturnType<typeof vi.fn>;

function mockResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload),
  } as unknown as Response;
}

function setFetchMock(impl: FetchMock) {
  Object.defineProperty(globalThis, "fetch", {
    value: impl,
    configurable: true,
  });
}

describe("authApi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when getSession receives 401", async () => {
    const fetchMock = vi.fn(async () => mockResponse(401, null));
    setFetchMock(fetchMock);

    await expect(authApi.getSession()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/get-session", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  });

  it("returns nested session payload from getSession", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse(200, {
        data: {
          session: { id: "session-1", userId: "user-1" },
          user: { id: "user-1", email: "u@example.com", name: "User" },
        },
      }),
    );
    setFetchMock(fetchMock);

    await expect(authApi.getSession()).resolves.toEqual({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "u@example.com", name: "User" },
    });
  });

  it("posts sign-in credentials to the auth endpoint", async () => {
    const fetchMock = vi.fn(async () => mockResponse(200, { ok: true }));
    setFetchMock(fetchMock);

    await authApi.signInEmail({ email: "u@example.com", password: "secret" });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-in/email", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "u@example.com", password: "secret" }),
    });
  });

  it("throws server error message for failed auth posts", async () => {
    const fetchMock = vi.fn(async () => mockResponse(400, { error: { message: "Invalid credentials" } }));
    setFetchMock(fetchMock);

    await expect(authApi.signInEmail({ email: "u@example.com", password: "bad" })).rejects.toThrow(
      "Invalid credentials",
    );
  });
});
