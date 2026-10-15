import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_CALL_TIMEOUT_MS,
  appOperations,
  appSocketPath,
  personalHome,
  serviceRuntimeDirectory,
  serviceSocketPath,
} from "@yap/protocol";
import { callLocal, LocalTransportError } from "./transport.js";

/** Finding a service that is already running: a health answer takes milliseconds. */
export const DISCOVERY_BUDGET_MS = DEFAULT_CALL_TIMEOUT_MS;
/**
 * Waiting for a service whose app discovery launched itself. A cold first launch spends its time
 * before the service can answer: macOS assesses a freshly installed bundle (tens of seconds for
 * an app carrying its own runtime), then the app, Node and the service start, on a Mac that may
 * be busy. A minute covers that with room while still ending a launch that will never serve.
 */
export const LAUNCH_BUDGET_MS = 60_000;
const LAUNCHER = "/usr/bin/open";

export type ServiceSelection = {
  /** Explicit sockets bypass discovery and never launch the app. */
  socketPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
  /**
   * One deadline for the whole discovery, including any launch. Without it, finding a running
   * service has DISCOVERY_BUDGET_MS, and a launch that found nothing listening restarts the
   * deadline at LAUNCH_BUDGET_MS.
   */
  budgetMs?: number | undefined;
};

/** Where an endpoint listens, how to ask whether it answers, and what to call it in errors. */
type Endpoint = { socketPath: (runtimeDirectory: string) => string; probe: string; name: string };
const service: Endpoint = {
  socketPath: serviceSocketPath,
  probe: "service.health",
  name: "Service",
};
// Any answer proves the app is listening, including a build that installs updates manually.
const app: Endpoint = { socketPath: appSocketPath, probe: "update.status", name: "App" };

/** Discovery sends only health probes. The caller sends its operation once after this returns. */
export function resolveServiceSocket(options: ServiceSelection = {}): Promise<string> {
  return resolveEndpoint(service, options);
}

/** The socket that answers `operation`: the app's for the operations it owns, else the service's. */
export function resolveOperationSocket(
  operation: string,
  options: ServiceSelection = {},
): Promise<string> {
  return resolveEndpoint(appOperations.has(operation) ? app : service, options);
}

async function resolveEndpoint(endpoint: Endpoint, options: ServiceSelection): Promise<string> {
  if (options.socketPath !== undefined) return options.socketPath;
  const env = options.env ?? process.env;
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      new LocalTransportError("ABORTED", "Service discovery canceled; no request was sent"),
    );
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const socketPath = endpoint.socketPath(serviceRuntimeDirectory(personalHome(env)));
  let timer: NodeJS.Timeout | undefined;
  const expireAfter = (budgetMs: number, budget: string) => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(
          new LocalTransportError(
            "TIMEOUT",
            `${endpoint.name} at ${socketPath} did not become ready within the ${budgetMs} ms ${budget}. ` +
              "No request was sent. Check the app's service status, or pass an explicit socket.",
          ),
        ),
      budgetMs,
    );
  };
  if (options.budgetMs === undefined)
    expireAfter(DISCOVERY_BUDGET_MS, "budget for a running service");
  else expireAfter(options.budgetMs, "discovery budget");
  const coldLaunch =
    options.budgetMs === undefined
      ? () => expireAfter(LAUNCH_BUDGET_MS, "launch budget")
      : () => {};
  const signal = controller.signal;
  try {
    signal.throwIfAborted();
    // The race also bounds filesystem inspection, which has no AbortSignal API. The
    // discovery branch checks cancellation again before it can launch anything late.
    return await Promise.race([
      discover(endpoint, socketPath, env, signal, coldLaunch),
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function discover(
  endpoint: Endpoint,
  socketPath: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  coldLaunch: () => void,
): Promise<string> {
  const found = await probe(endpoint, socketPath, signal);
  if (found === "answering") return socketPath;
  signal.throwIfAborted();
  const bundle = env.YAP_APP ?? join(homedir(), "Applications", "Yap.app");
  if (!isAbsolute(bundle))
    throw new LocalTransportError(
      "APP_NOT_FOUND",
      `YAP_APP must be an absolute path to a .app bundle; received ${JSON.stringify(bundle)}`,
    );
  const executables = await stat(join(bundle, "Contents", "MacOS")).catch(() => undefined);
  signal.throwIfAborted();
  if (!executables?.isDirectory())
    throw new LocalTransportError(
      "APP_NOT_FOUND",
      `No recorder app bundle at ${JSON.stringify(bundle)}. ` +
        "Install the personal app there, set YAP_APP to its absolute path, or pass --socket PATH.",
    );
  // Always carry the resolved home, including the default/empty-env case. LaunchServices
  // may inherit a different environment; an already-running app retains its original home.
  // Only a launch that found nothing listening starts the app; one that found a silent listener
  // coalesces with the running instance, so it keeps the running budget.
  if (found === "absent") coldLaunch();
  await launch(bundle, personalHome(env), env.YAP_DEFAULTS, signal);
  while (true) {
    await delay(100, undefined, { signal });
    if ((await probe(endpoint, socketPath, signal)) === "answering") return socketPath;
  }
}

/** "absent": nothing accepted the connection. "silent": something did, but gave no health answer. */
async function probe(
  endpoint: Endpoint,
  socketPath: string,
  signal: AbortSignal,
): Promise<"answering" | "absent" | "silent"> {
  try {
    await callLocal(
      socketPath,
      { id: randomUUID(), operation: endpoint.probe, params: {} },
      { timeoutMs: 1_000, signal },
    );
    return "answering";
  } catch (error) {
    signal.throwIfAborted();
    return error instanceof LocalTransportError && error.code === "CONNECTION_ERROR"
      ? "absent"
      : "silent";
  }
}

function launch(
  bundle: string,
  home: string,
  preferences: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolveLaunch, reject) => {
    // No --args: ordinary launch starts the menu-bar service, never a capture probe. This launch
    // serves a request rather than a person opening the app, so it says so: the app then starts
    // its service without putting its own window in front of whatever someone is doing.
    const child = spawn(
      LAUNCHER,
      [
        "-g",
        "-a",
        bundle,
        "--env",
        `YAP_HOME=${home}`,
        "--env",
        "YAP_SERVICE_LAUNCH=1",
        ...(preferences === undefined ? [] : ["--env", `YAP_DEFAULTS=${preferences}`]),
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let diagnostic = "";
    const abort = () => {
      child.kill("SIGKILL");
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (bytes: Buffer) => {
      diagnostic = (diagnostic + bytes.toString("utf8")).slice(0, 2_000);
    });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(
        new LocalTransportError("LAUNCH_FAILED", `Could not run ${LAUNCHER}: ${error.message}`),
      );
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (code === 0) resolveLaunch();
      else
        reject(
          new LocalTransportError(
            "LAUNCH_FAILED",
            `Could not launch ${JSON.stringify(bundle)}: ${diagnostic.trim() || `exit code ${code}`}`,
          ),
        );
    });
  });
}
