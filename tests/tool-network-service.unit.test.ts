import { describe, expect, it } from "vitest";

import {
  createNodeSystemToolNetworkService,
  matchesNoProxy,
  parseMacosSystemProxyOutput,
  parseWindowsRegistryQueryOutput,
  parseWindowsProxyServer,
  resolveWindowsProxyValues,
} from "../packages/tool-runtime/src/network/node-system.js";

describe("tool network system proxy discovery", () => {
  it("parses Windows static, protocol-specific, PAC, and WPAD settings", () => {
    expect(parseWindowsProxyServer("127.0.0.1:10808")).toBe("http://127.0.0.1:10808");
    expect(parseWindowsProxyServer("http=127.0.0.1:7890;socks=127.0.0.1:7891"))
      .toBe("http://127.0.0.1:7890");
    expect(resolveWindowsProxyValues([
      { name: "ProxyEnable", data: 1 },
      { name: "ProxyServer", data: "127.0.0.1:10808" },
      { name: "ProxyOverride", data: "<local>;*.internal.example" },
    ])).toEqual({
      proxyUrl: "http://127.0.0.1:10808",
      noProxy: ["<local>", "*.internal.example"],
      source: "windows_system",
    });
    expect(resolveWindowsProxyValues([
      { name: "AutoConfigURL", data: "http://127.0.0.1/proxy.pac" },
      { name: "ProxyEnable", data: 1 },
      { name: "ProxyServer", data: "ignored:8080" },
    ])?.proxyUrl).toBe("pac+http://127.0.0.1/proxy.pac");
    expect(resolveWindowsProxyValues([{ name: "AutoDetect", data: 1 }])?.proxyUrl)
      .toBe("pac+http://wpad/wpad.dat");
    expect(parseWindowsRegistryQueryOutput(`
      HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
          ProxyEnable    REG_DWORD    0x1
          ProxyServer    REG_SZ       127.0.0.1:10808
    `)).toEqual([
      { name: "ProxyEnable", data: 1 },
      { name: "ProxyServer", data: "127.0.0.1:10808" },
    ]);
  });

  it("parses macOS PAC, WPAD, static HTTPS, and exclusion settings", () => {
    const pac = parseMacosSystemProxyOutput(`
      <dictionary> {
        ExceptionsList : <array> {
          0 : localhost
          1 : *.internal.example
        }
        ProxyAutoConfigEnable : 1
        ProxyAutoConfigURLString : http://proxy.example/proxy.pac
      }
    `);
    expect(pac).toEqual({
      proxyUrl: "pac+http://proxy.example/proxy.pac",
      noProxy: ["localhost", "*.internal.example"],
      source: "macos_system",
    });
    expect(parseMacosSystemProxyOutput(`
      <dictionary> {
        HTTPSEnable : 1
        HTTPSProxy : 127.0.0.1
        HTTPSPort : 7890
      }
    `)?.proxyUrl).toBe("http://127.0.0.1:7890");
    expect(parseMacosSystemProxyOutput("ProxyAutoDiscoveryEnable : 1")?.proxyUrl)
      .toBe("pac+http://wpad/wpad.dat");
  });

  it("honors common NO_PROXY forms", () => {
    expect(matchesNoProxy(new URL("https://api.internal.example/path"), ["*.internal.example"])).toBe(true);
    expect(matchesNoProxy(new URL("https://localhost/path"), ["<local>"])).toBe(true);
    expect(matchesNoProxy(new URL("https://example.com:8443/path"), ["example.com:8443"])).toBe(true);
    expect(matchesNoProxy(new URL("https://example.com/path"), ["example.com:8443"])).toBe(false);
  });

  it("re-reads environment proxy settings on every plan and never exposes credentials", async () => {
    const environment: NodeJS.ProcessEnv = {
      HTTPS_PROXY: "http://user:secret@127.0.0.1:10808",
    };
    const service = createNodeSystemToolNetworkService(environment);
    const proxied = await service.plan(new URL("https://api.search.brave.com/search"));
    expect(proxied).toMatchObject({
      systemRouteDistinct: true,
      routes: [
        { route: "system", source: "environment" },
        { route: "direct", source: "direct" },
      ],
    });
    expect(JSON.stringify(proxied)).not.toContain("secret");
    environment.NO_PROXY = "api.search.brave.com";
    const bypassed = await service.plan(new URL("https://api.search.brave.com/search"));
    expect(bypassed).toMatchObject({
      systemRouteDistinct: false,
      routes: [{ route: "direct", source: "direct" }],
    });
    await service.dispose();
  });
});
