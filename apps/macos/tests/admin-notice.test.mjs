import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sources = fileURLToPath(new URL("../Sources/Yap/", import.meta.url));

test("a notice reaches exactly the versions its pattern names; anything that is not a feed changes nothing", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "yap-admin-notice-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const feed = JSON.stringify({
    notices: [
      { versions: "([", message: "invalid pattern, skipped" },
      { versions: "^0\\.1\\.4[01]$", message: "Reinstall Yap from justyap.io." },
      { versions: "^0\\.1\\.", message: "Back up your library." },
      { versions: "^9\\.", message: "   " },
      { versions: "^3\\.", message: "x".repeat(900) },
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
        func show(_ notice: AdminNotice.Lookup) -> String {
            switch notice {
            case .unreadable: return "unreadable"
            case .none: return "-"
            case .message(let text): return text.count > 60 ? "long \\(text.count)" : text
            }
        }
        for version in ["0.1.41", "0.1.43", "2.0.0", "9.0.0", "3.0.0"] {
            print(version, show(AdminNotice.lookup(in: feed, version: version)))
        }
        for garbage in ["", "not json", "[]", #"{"notices":"nope"}"#, #"{"notice":[]}"#, #"{"notices":[{"versions":1}]}"#] {
            print("garbage", show(AdminNotice.lookup(in: Data(garbage.utf8), version: "0.1.41")))
        }
        print("oversized", show(AdminNotice.lookup(in: Data(repeating: 0x20, count: 300_000), version: "0.1.41")))
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
    "3.0.0 long 500",
    // Anything that is not a feed changes nothing: the last notice stays.
    "garbage unreadable",
    "garbage unreadable",
    "garbage unreadable",
    "garbage unreadable",
    "garbage unreadable",
    // A feed whose notices are malformed is still a feed: those notices are skipped.
    "garbage -",
    "oversized unreadable",
  ]);
});
