import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Bundles one Node entry into a single file with Node builtins left external, the form the app
 * ships its service and CLI in: they run outside the checkout with no node_modules in reach.
 */
export function bundleNodeEntry(entry, outfile, options = {}) {
  mkdirSync(dirname(outfile), { recursive: true });
  execFileSync("bun", ["build", entry, "--target=node", "--outfile", outfile], {
    stdio: options.stdio ?? "inherit",
  });
}
