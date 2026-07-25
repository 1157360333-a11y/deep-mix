const { app, session } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function readSettings(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  await app.whenReady();
  const workspaceRoot = path.resolve(__dirname, "../..");
  const [userSettings, projectSettings] = await Promise.all([
    readSettings(path.join(os.homedir(), ".deep-mix", "settings.json")),
    readSettings(path.join(workspaceRoot, ".deep-mix", "settings.json")),
  ]);
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim()
    || projectSettings.webSearch?.braveApiKey?.trim()
    || userSettings.webSearch?.braveApiKey?.trim();
  if (!apiKey) throw new Error("No Brave Search key is configured for the Electron network probe.");

  const probeSession = session.fromPartition("deep-mix:web-search-live-probe", { cache: false });
  await probeSession.setProxy({ mode: "system" });
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", "Deep-Mix web search verification");
  url.searchParams.set("count", "1");
  const proxyDecision = await probeSession.resolveProxy(url.toString());
  const networkRoute = proxyDecision.split(";").some((entry) => !/^\s*DIRECT\s*$/iu.test(entry))
    ? "system"
    : "direct";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await probeSession.fetch(url.toString(), {
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
      credentials: "omit",
      signal: controller.signal,
      bypassCustomProtocolHandlers: true,
    });
    const parsed = await response.json();
    const resultCount = Array.isArray(parsed?.web?.results) ? parsed.web.results.length : 0;
    console.log(JSON.stringify({
      success: response.ok && resultCount > 0,
      httpStatus: response.status,
      provider: "brave",
      networkRoute,
      resultCount,
    }));
    if (!response.ok || resultCount === 0) process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    await probeSession.closeAllConnections();
    app.quit();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error?.name || "Error" }));
  app.quit();
  process.exitCode = 1;
});
