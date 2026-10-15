import assert from "node:assert/strict";
import { test } from "node:test";
import { extractReleaseNotes } from "./release-notes.mjs";

const notes = `Yap intro.\n\n## 0.1.40\n\nCurrent change.\n\n## 0.1.39\n\nOlder change.\n`;

test("release notes extract the shared intro and one version section", () => {
  assert.equal(
    extractReleaseNotes(notes, "v0.1.40"),
    "Yap intro.\n\n## 0.1.40\n\nCurrent change.\n",
  );
  assert.equal(extractReleaseNotes(notes, "0.1.39"), "Yap intro.\n\n## 0.1.39\n\nOlder change.\n");
});

test("release notes refuse a version without a section", () => {
  assert.throws(() => extractReleaseNotes(notes, "v0.1.38"), /No release notes section/);
});
