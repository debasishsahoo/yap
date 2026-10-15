import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

test(
  "the preview window can be captured except during a take, and never covers the video",
  { timeout: 120_000 },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "yap-preview-window-"));
    try {
      const executable = compileControlsCheck(
        scratch,
        ["PreviewController", "PreviewWindow"],
        String.raw`
import AppKit
import AVKit
@main struct Check {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let preview = PreviewWindow()
        preview.open(title: "Fixture preview", retry: {}, closed: {})
        guard let window = NSApp.windows.first(where: { $0.title == "Fixture preview" }),
              let content = window.contentView else { preconditionFailure("The preview opens a window") }
        precondition(window.sharingType != .none, "People can screenshot and share the preview window")
        func player() -> NSView { descendants(content).first { $0 is AVPlayerView }! }
        func bars() -> [NSView] { descendants(content).filter { $0 is NSStackView && !$0.isHidden } }
        content.layoutSubtreeIfNeeded()
        precondition(bars().isEmpty, "With no revision history there is no bar")
        precondition(player().frame.height >= content.bounds.height - 1, "The video fills the window")
        let video = player().frame
        precondition(abs(video.width / video.height - 16.0 / 9.0) < 0.02, "The video area is 16:9: \(video.size)")
        // The controller offers Export before the revision history arrives.
        preview.showExport {}
        preview.showTimeline([PreviewTimelineItem(id: "r1", ordinal: 0, label: "Revision 1", operation: "edit")],
            selected: "r1", select: { _ in })
        content.layoutSubtreeIfNeeded()
        guard let bar = bars().first else { preconditionFailure("Revision history shows a bar") }
        bar.layoutSubtreeIfNeeded()
        let export = descendants(bar).first { ($0 as? NSButton)?.title == "Export" }!
        let exportFrame = export.convert(export.bounds, to: bar)
        precondition(bar.bounds.maxX - exportFrame.maxX < 30, "Export stays at the right edge: \(exportFrame) in \(bar.bounds)")
        let barFrame = bar.convert(bar.bounds, to: content), videoFrame = player().convert(player().bounds, to: content)
        precondition(!barFrame.intersects(videoFrame), "The bar sits beside the video, never over it")
        // A display take leaves out this app's windows only if one was on screen when it began.
        PreviewWindow.takeInProgress = true
        precondition(window.sharingType == .none, "While a take records, the preview stays out of it")
        PreviewWindow.takeInProgress = false
        precondition(window.sharingType != .none, "After the take, the preview can be captured again")
        print("ok")
    }
    @MainActor static func descendants(_ view: NSView) -> [NSView] { view.subviews + view.subviews.flatMap(descendants) }
}
`,
      );
      const out = execFileSync(executable, [], {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, YAP_FIXTURE_CONTROLS: "1" },
      });
      assert.equal(out.trim(), "ok");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
