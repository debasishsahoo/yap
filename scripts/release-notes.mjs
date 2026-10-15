import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const versionOf = (value) => {
  const version = String(value ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`Invalid release version: ${JSON.stringify(value)}`);
  return version;
};

export function extractReleaseNotes(markdown, tagOrVersion) {
  const version = versionOf(tagOrVersion);
  const heading = `## ${version}`;
  const firstHeading = markdown.search(/^## /m);
  const intro = firstHeading < 0 ? markdown : markdown.slice(0, firstHeading);
  const start = markdown.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`No release notes section for ${version}`);
  const bodyStart = start + heading.length + 1;
  const nextHeading = markdown.slice(bodyStart).search(/^## /m);
  const section =
    nextHeading < 0 ? markdown.slice(start) : markdown.slice(start, bodyStart + nextHeading);
  return `${intro.trimEnd()}\n\n${section.trim()}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!tag || process.argv.length !== 3) throw new Error("Usage: node release-notes.mjs TAG");
  const root = dirname(fileURLToPath(import.meta.url));
  process.stdout.write(
    extractReleaseNotes(readFileSync(join(root, "release-notes.md"), "utf8"), tag),
  );
}
