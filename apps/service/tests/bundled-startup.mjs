import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { callLocal } from "@yap/client";
import { bundleNodeEntry } from "../../../scripts/node-bundle.mjs";
import { nativeBinary } from "./fixtures/project-export.mjs";

// The app gives its service this long to report `started` before showing it unavailable.
const appStartupBudgetMs = 10_000;

test(
  "the shipped service bundle starts and answers while the app holds its control channel open",
  { timeout: 60_000 },
  async (t) => {
    // An installed app lives at a real path. Through a symlinked one (macOS /tmp and /var) a
    // bundled module can mistake itself for the launched script by accident, and pass here.
    // Short, too: the service socket lives under this home, within the Unix socket path limit.
    const directory = realpathSync(await mkdtemp("/tmp/yap-bundled-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bundle = join(directory, "Yap.app/Contents/Resources/service/main.mjs");
    bundleNodeEntry(resolve("apps/service/dist/main.js"), bundle, { stdio: "pipe" });
    const child = spawn(process.execPath, [bundle], {
      cwd: "/",
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        YAP_HOME: join(directory, "home"),
        YAP_NATIVE: nativeBinary,
        YAP_FFMPEG_DIRECTORY: "",
        YAP_AUTO_PREPARE_MODELS: "0",
      },
    });
    const closed = once(child, "close");
    let control = "",
      diagnostics = "";
    child.stdout.on("data", (chunk) => (control += chunk));
    child.stderr.on("data", (chunk) => (diagnostics = (diagnostics + chunk).slice(-32_000)));
    const group = (signal) => {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    };
    let answered = false;
    try {
      const deadline = Date.now() + appStartupBudgetMs;
      let started;
      while (!started) {
        const events = control
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const failed = events.find((event) => event.event === "failed");
        assert.equal(failed, undefined, JSON.stringify(failed));
        started = events.find((event) => event.event === "started");
        if (started) break;
        assert.ok(
          Date.now() < deadline,
          `Service did not start within the app's ${appStartupBudgetMs} ms budget: ${diagnostics}`,
        );
        await delay(20);
      }
      const health = await callLocal(started.socketPath, {
        id: randomUUID(),
        operation: "service.health",
        params: {},
      });
      assert.equal(health.ok, true, JSON.stringify(health));
      answered = true;
    } finally {
      // Closing the control channel is how the app stops its service.
      child.stdin.end();
      const watchdog = setTimeout(() => group("SIGKILL"), 5_000);
      const [code] = await closed;
      clearTimeout(watchdog);
      if (group(0)) group("SIGKILL");
      if (answered) assert.equal(code, 0, diagnostics);
    }
  },
);
