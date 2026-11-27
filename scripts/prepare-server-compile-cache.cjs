/* oxlint-disable t3code/no-global-process-runtime -- Packaging must compare the build host with the executable target. */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// afterPack runs before signing and installer creation, against the final ASAR layout.
module.exports = async ({ appOutDir, electronPlatformName, arch, packager }) => {
  if (!["darwin", "win32", "linux"].includes(electronPlatformName)) {
    console.log(`[server-compile-cache] Skipping unsupported target ${electronPlatformName}`);
    return;
  }
  // Generating the cache runs the bundle, and a PR preview's bundle must never run next to signing secrets.
  if (process.env.T3CODE_DESKTOP_UNTRUSTED_BUNDLE === "true") {
    console.log("[server-compile-cache] Skipping untrusted bundle");
    return;
  }
  const targetArch = ["ia32", "x64", "armv7l", "arm64", "universal"][arch];
  const runsWithRosetta =
    electronPlatformName === "darwin" &&
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    targetArch === "x64";
  if (
    electronPlatformName !== process.platform ||
    (targetArch !== process.arch && !runsWithRosetta)
  ) {
    console.log(
      `[server-compile-cache] Skipping unexecutable target ${electronPlatformName}/${targetArch}`,
    );
    return;
  }
  const product = packager.appInfo.productFilename;
  const resources =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${product}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  const executable =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${product}.app`, "Contents", "MacOS", product)
      : path.join(
          appOutDir,
          electronPlatformName === "win32" ? `${product}.exe` : packager.executableName,
        );
  const helper = path.join(
    resources,
    "app.asar",
    "apps/desktop/dist-electron/serverCompileCache.cjs",
  );
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const name of Object.keys(env)) {
    if (name.startsWith("NODE_") || name.startsWith("T3CODE_")) delete env[name];
  }
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "t3-release-cache-"));
  env.T3CODE_HOME = state;
  const timeout = runsWithRosetta ? 180_000 : 120_000;
  const timingPrefix = "[server-compile-cache] +";
  let result;
  try {
    // Run a script file, not -e: -e defines a global __filename of "[eval]", which
    // @effect/platform-node passes to createRequire and fails on.
    const runner = path.join(state, "prepare-server-compile-cache-runner.cjs");
    fs.writeFileSync(
      runner,
      `
const { writeSync } = require("node:fs");
const reportProgress = (stage) => {
  writeSync(1, ${JSON.stringify(timingPrefix)} + (Date.now() - ${Date.now()}) + "ms " + stage + "\\n");
};
reportProgress("Electron started");
require(${JSON.stringify(helper)})
  .generatePreparedServerCache(${JSON.stringify(resources)}, reportProgress)
  .then(() => process.exit(0), error => { console.error(error); process.exit(1); });
`,
    );
    console.log(
      `[server-compile-cache] Launching packaged Electron with a ${timeout / 1000}s timeout`,
    );
    result = spawnSync(executable, [runner], { env, encoding: "utf8", timeout });
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
  for (const line of result.stdout?.split(/\r?\n/) ?? []) {
    if (line.startsWith(timingPrefix)) console.log(line);
  }
  if (runsWithRosetta && result.error?.code === "ETIMEDOUT") {
    fs.rmSync(path.join(resources, "server-compile-cache"), { recursive: true, force: true });
    console.warn(
      "[server-compile-cache] Generation timed out under Rosetta. The app will compile on startup.",
    );
    return;
  }
  if (result.status !== 0)
    throw new Error(`Server compile cache generation failed: ${result.error || result.stderr}`);
  console.log("[server-compile-cache] Prepared server bytecode with packaged Electron");
};
