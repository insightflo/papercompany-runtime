export const SOCIAL_AUTH_PROVIDER_IDS = ["google", "kakao", "naver"] as const;

export type SocialAuthProviderId = (typeof SOCIAL_AUTH_PROVIDER_IDS)[number];

export type SocialAuthProvider = {
  id: SocialAuthProviderId;
  label: string;
  clientId: string;
  clientSecret: string;
};

export type PublicSocialAuthProvider = Pick<SocialAuthProvider, "id" | "label">;

export type BetterAuthSocialProviders = Partial<Record<
  SocialAuthProviderId,
  {
    clientId: string;
    clientSecret: string;
    disableSignUp: boolean;
  }
>>;

type SocialAuthEnvironment = Readonly<Record<string, string | undefined>>;

const PROVIDER_DEFINITIONS: ReadonlyArray<{
  id: SocialAuthProviderId;
  label: string;
  clientIdEnvironmentKey: string;
  clientSecretEnvironmentKey: string;
}> = [
  {
    id: "google",
    label: "Google",
    clientIdEnvironmentKey: "PAPERCLIP_AUTH_GOOGLE_CLIENT_ID",
    clientSecretEnvironmentKey: "PAPERCLIP_AUTH_GOOGLE_CLIENT_SECRET",
  },
  {
    id: "kakao",
    label: "Kakao",
    clientIdEnvironmentKey: "PAPERCLIP_AUTH_KAKAO_CLIENT_ID",
    clientSecretEnvironmentKey: "PAPERCLIP_AUTH_KAKAO_CLIENT_SECRET",
  },
  {
    id: "naver",
    label: "Naver",
    clientIdEnvironmentKey: "PAPERCLIP_AUTH_NAVER_CLIENT_ID",
    clientSecretEnvironmentKey: "PAPERCLIP_AUTH_NAVER_CLIENT_SECRET",
  },
];

function readCredential(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

export function loadSocialAuthProviders(environment: SocialAuthEnvironment = process.env): SocialAuthProvider[] {
  const providers: SocialAuthProvider[] = [];

  for (const definition of PROVIDER_DEFINITIONS) {
    const clientId = readCredential(environment[definition.clientIdEnvironmentKey]);
    const clientSecret = readCredential(environment[definition.clientSecretEnvironmentKey]);
    if (!clientId || !clientSecret) continue;

    providers.push({
      id: definition.id,
      label: definition.label,
      clientId,
      clientSecret,
    });
  }

  return providers;
}

export function toPublicSocialAuthProviders(
  providers: readonly SocialAuthProvider[],
): PublicSocialAuthProvider[] {
  return providers.map(({ id, label }) => ({ id, label }));
}

export function buildBetterAuthSocialProviders(
  providers: readonly SocialAuthProvider[],
  disableSignUp: boolean,
): BetterAuthSocialProviders {
  const configured: BetterAuthSocialProviders = {};

  for (const provider of providers) {
    configured[provider.id] = {
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      disableSignUp,
    };
  }

  return configured;
}
