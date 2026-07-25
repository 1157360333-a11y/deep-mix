import type { Session } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ fromPartition: vi.fn() }));

vi.mock("electron", () => ({
  session: { fromPartition: electronMock.fromPartition },
}));

import { createElectronToolNetworkService, electronProxyUrl } from "./network-service.js";
import { classifySafeNetworkFailure } from "../../../../packages/tool-runtime/src/network/safe-http.js";

function fakeSession(input: {
  resolvedProxy: () => string;
  body: string;
}): Session {
  return {
    setProxy: vi.fn().mockResolvedValue(undefined),
    resolveProxy: vi.fn().mockImplementation(async () => input.resolvedProxy()),
    fetch: vi.fn().mockResolvedValue(new Response(input.body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    })),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
}

describe("desktop Electron tool network service", () => {
  beforeEach(() => {
    electronMock.fromPartition.mockReset();
  });

  it("uses isolated system and direct sessions and deduplicates a DIRECT system plan", async () => {
    let proxyDecision = "PROXY 127.0.0.1:10808; DIRECT";
    const systemSession = fakeSession({ resolvedProxy: () => proxyDecision, body: "system" });
    const directSession = fakeSession({ resolvedProxy: () => "DIRECT", body: "direct" });
    electronMock.fromPartition
      .mockReturnValueOnce(systemSession)
      .mockReturnValueOnce(directSession);

    const service = await createElectronToolNetworkService();
    expect(systemSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(directSession.setProxy).toHaveBeenCalledWith({ mode: "direct" });
    expect(electronMock.fromPartition).toHaveBeenNthCalledWith(
      1,
      "deep-mix:web-search-system",
      { cache: false },
    );

    const proxied = await service.plan(new URL("https://api.search.brave.com/search"));
    expect(proxied).toMatchObject({
      systemRouteDistinct: true,
      routes: [{ route: "system" }, { route: "direct" }],
    });
    expect(JSON.stringify(proxied)).not.toContain("10808");

    proxyDecision = "DIRECT";
    await expect(service.plan(new URL("https://api.search.brave.com/search"))).resolves.toMatchObject({
      systemRouteDistinct: false,
      routes: [{ route: "direct" }],
    });
    await service.dispose();
    expect(systemSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(directSession.closeAllConnections).toHaveBeenCalledOnce();
  });

  it("routes requests through the selected session without credentials or persistent cookies", async () => {
    const systemSession = fakeSession({ resolvedProxy: () => "PROXY proxy.local:8080", body: "system-response" });
    const directSession = fakeSession({ resolvedProxy: () => "DIRECT", body: "direct-response" });
    electronMock.fromPartition
      .mockReturnValueOnce(systemSession)
      .mockReturnValueOnce(directSession);
    const service = await createElectronToolNetworkService();
    const url = new URL("https://api.search.brave.com/search");

    const systemResponse = await service.request(url, { headers: { Accept: "text/plain" } }, {
      route: "system",
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    });
    const directResponse = await service.request(url, {}, {
      route: "direct",
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    });

    expect(Buffer.from(systemResponse.body).toString("utf8")).toBe("system-response");
    expect(Buffer.from(directResponse.body).toString("utf8")).toBe("direct-response");
    expect(systemSession.fetch).toHaveBeenCalledWith(url.toString(), expect.objectContaining({
      credentials: "omit",
      bypassCustomProtocolHandlers: true,
    }));
    expect(directSession.fetch).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it("honors only the first PAC instruction for DIRECT and unsupported plans", async () => {
    let proxyDecision = "DIRECT; PROXY proxy.local:8080";
    const systemSession = fakeSession({ resolvedProxy: () => proxyDecision, body: "system" });
    const directSession = fakeSession({ resolvedProxy: () => "DIRECT", body: "direct" });
    electronMock.fromPartition
      .mockReturnValueOnce(systemSession)
      .mockReturnValueOnce(directSession);
    const service = await createElectronToolNetworkService();
    const url = new URL("https://example.com/first-pac-instruction");

    expect(electronProxyUrl(proxyDecision)).toBeUndefined();
    await expect(service.plan(url)).resolves.toMatchObject({
      systemRouteDistinct: false,
      routes: [{ route: "direct" }],
    });

    proxyDecision = "UNSUPPORTED proxy-mode; PROXY proxy.local:8080";
    expect(electronProxyUrl(proxyDecision)).toBeUndefined();
    await expect(service.plan(url)).resolves.toMatchObject({
      systemRouteDistinct: true,
      routes: [{ route: "system" }, { route: "direct" }],
    });
    const unsupported = await service.request(url, { method: "GET" }, {
      route: "system",
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
      pinnedAddress: { hostname: "example.com", address: "93.184.216.34", family: 4 },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(unsupported).toMatchObject({ code: "ERR_PROXY_UNSUPPORTED" });
    expect(unsupported).not.toMatchObject({ code: "ERR_PROXY_REQUEST_FAILED" });
    expect(classifySafeNetworkFailure(unsupported)).toMatchObject({
      networkErrorType: "policy_denied",
      retryable: false,
    });
    expect(systemSession.fetch).not.toHaveBeenCalled();
    expect(directSession.fetch).not.toHaveBeenCalled();
    await service.dispose();
  });
});
