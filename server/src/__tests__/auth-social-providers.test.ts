import { describe, expect, it } from "vitest";
import {
  buildBetterAuthSocialProviders,
  loadSocialAuthProviders,
  toPublicSocialAuthProviders,
} from "../auth/social-providers.js";

describe("social auth providers", () => {
  it("loads only providers with a complete client credential pair", () => {
    const providers = loadSocialAuthProviders({
      PAPERCLIP_AUTH_GOOGLE_CLIENT_ID: " google-client-id ",
      PAPERCLIP_AUTH_GOOGLE_CLIENT_SECRET: " google-client-secret ",
      PAPERCLIP_AUTH_KAKAO_CLIENT_ID: "kakao-client-id",
      PAPERCLIP_AUTH_NAVER_CLIENT_ID: "naver-client-id",
      PAPERCLIP_AUTH_NAVER_CLIENT_SECRET: "naver-client-secret",
    });

    expect(providers).toEqual([
      {
        id: "google",
        label: "Google",
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      },
      {
        id: "naver",
        label: "Naver",
        clientId: "naver-client-id",
        clientSecret: "naver-client-secret",
      },
    ]);
  });

  it("keeps credentials out of the public provider list", () => {
    const publicProviders = toPublicSocialAuthProviders([
      {
        id: "kakao",
        label: "Kakao",
        clientId: "kakao-client-id",
        clientSecret: "kakao-client-secret",
      },
    ]);

    expect(publicProviders).toEqual([{ id: "kakao", label: "Kakao" }]);
  });

  it("passes the instance signup policy to every configured provider", () => {
    const providers = buildBetterAuthSocialProviders(
      [
        {
          id: "google",
          label: "Google",
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
        },
      ],
      true,
    );

    expect(providers).toEqual({
      google: {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
        disableSignUp: true,
      },
    });
  });
});
