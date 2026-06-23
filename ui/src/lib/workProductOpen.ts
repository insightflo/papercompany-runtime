import { issuesApi } from "../api/issues";

type WorkProductOpenResponse = Awaited<ReturnType<typeof issuesApi.openWorkProduct>>;

function absoluteBrowserUrl(value: string): string {
  if (typeof window === "undefined") return value;
  return new URL(value, window.location.origin).toString();
}

export async function openWorkProductInBrowser(productId: string): Promise<WorkProductOpenResponse> {
  const pendingWindow = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;

  try {
    const response = await issuesApi.openWorkProduct(productId);
    const url = absoluteBrowserUrl(response.target.value);
    if (pendingWindow) {
      pendingWindow.opener = null;
      pendingWindow.location.href = url;
    } else if (typeof window !== "undefined") {
      const openedWindow = window.open(url, "_blank", "noopener,noreferrer");
      if (!openedWindow) window.location.assign(url);
    }
    return response;
  } catch (error) {
    pendingWindow?.close();
    throw error;
  }
}
