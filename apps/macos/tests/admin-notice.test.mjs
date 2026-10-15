import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sources = fileURLToPath(new URL("../Sources/Yap/", import.meta.url));

test("a notice reaches exactly the versions its pattern names, and anything malformed is ignored", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "yap-admin-notice-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const feed = JSON.stringify({
    notices: [
      { versions: "([", message: "invalid pattern, skipped" },
      { versions: "^0\\.1\\.4[01]$", message: "Reinstall Yap from justyap.io." },
      { versions: "^0\\.1\\.", message: "Back up your library." },
      { versions: "^9\\.", message: "" },
    ],
  });
  writeFileSync(join(scratch, "feed.json"), feed);
  const main = join(scratch, "Main.swift");
  writeFileSync(
    main,
    `
import Foundation
@main struct Check {
    static func main() {
        let feed = FileManager.default.contents(atPath: CommandLine.arguments[1])!
        for version in ["0.1.41", "0.1.43", "2.0.0", "9.0.0"] {
            print(version, AdminNotice.message(from: feed, version: version) ?? "-")
        }
        for garbage in ["", "not json", "[]", #"{"notices":"nope"}"#, #"{"notices":[{"versions":1}]}"#] {
            print("garbage", AdminNotice.message(from: Data(garbage.utf8), version: "0.1.41") ?? "-")
        }
    }
}
`,
  );
  const executable = join(scratch, "check");
  const compile = spawnSync(
    "swiftc",
    [
      "-swift-version",
      "6",
      "-parse-as-library",
      join(sources, "AdminNotice.swift"),
      main,
      "-o",
      executable,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(compile.status, 0, compile.stderr);
  const run = spawnSync(executable, [join(scratch, "feed.json")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split("\n"), [
    "0.1.41 Reinstall Yap from justyap.io.",
    "0.1.43 Back up your library.",
    "2.0.0 -",
    "9.0.0 -",
    "garbage -",
    "garbage -",
    "garbage -",
    "garbage -",
    "garbage -",
  ]);
});
