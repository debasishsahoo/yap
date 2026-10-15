import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createCli } from "./yap-cli.mjs";

export const failure = (code, message) => Object.assign(new Error(message), { code });
export function budget(value, fallback, min, max, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw failure("INVALID_REQUEST", `${name} is outside its supported range`);
  return result;
}
/**
 * Yap's issue bound, for helpers that can't import it: the first 1000 issues, then one
 * `issues-truncated` counting every issue left out, including any an earlier bound folded into a
 * marker. packages/protocol/src/skill-issues.test.ts pins the output.
 */
export function boundedIssues(issues) {
  let omitted = 0;
  const kept = [];
  for (const issue of issues) {
    if (issue.code === "issues-truncated") omitted += issue.evidence.omitted;
    else if (kept.length < 1000) kept.push(issue);
    else omitted++;
  }
  if (!omitted) return kept;
  const message =
    omitted === 1 ? "1 more issue was omitted" : `${omitted} more issues were omitted`;
  return [...kept, { code: "issues-truncated", message, evidence: { omitted } }];
}
/** Read an explicitly selected regular task file; never discover cache receipt paths. */
export async function readTaskFile(path, maxBytes) {
  if (typeof path !== "string") throw failure("INVALID_RESPONSE", "Supply a task file path");
  // A FIFO must reach the regular-file check without waiting for a producer.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw failure(
        "OUTPUT_BUDGET_EXCEEDED",
        "Task file must be regular and within its byte budget",
      );
    const result = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < result.length) {
      const { bytesRead } = await file.read(result, offset, result.length - offset, offset);
      if (!bytesRead) throw failure("ARTIFACT_CHANGED", "Task file ended before its declared size");
      offset += bytesRead;
    }
    return result;
  } finally {
    await file.close();
  }
}
/**
 * Whether this process was launched as the named helper file. A program that bundles a helper
 * shares its module URL with the bundle, so the launched file must also carry the helper's own
 * name; otherwise the helper would read the bundling program's stdin as its request.
 */
export function launchedAs(moduleUrl, name) {
  if (!process.argv[1]) return false;
  try {
    const launched = realpathSync(process.argv[1]);
    return basename(launched) === name && launched === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
export async function runJsonHelper(helper) {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw failure("INVALID_REQUEST", "Request exceeds 1 MiB");
      chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    console.log(JSON.stringify(await helper(request, createCli(request.cli))));
  } catch (error) {
    console.error(
      JSON.stringify({ error: { code: error.code ?? "INVALID_REQUEST", message: error.message } }),
    );
    process.exitCode = 1;
  }
}
