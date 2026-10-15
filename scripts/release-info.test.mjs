import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureReleasePlist } from "./release-info.mjs";

test("a released app checks for updates every hour, so a failed install is retried within one", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "yap-release-plist-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const plist = join(scratch, "Info.plist");
  writeFileSync(plist, JSON.stringify({ CFBundleIdentifier: "com.example.check" }));
  execFileSync("/usr/bin/plutil", ["-convert", "xml1", plist]);
  configureReleasePlist(plist, { version: "9.9.9", catalogFormat: 29 }, "key");
  execFileSync("/usr/bin/plutil", ["-convert", "json", plist]);
  const configured = JSON.parse(readFileSync(plist, "utf8"));
  assert.equal(configured.SUEnableAutomaticChecks, true);
  // Sparkle's shortest supported schedule; its default is a day.
  assert.equal(configured.SUScheduledCheckInterval, 3600);
});
