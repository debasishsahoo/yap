import { closeSync, constants, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalTransportError } from "@yap/client";
import { O_SHLOCK } from "@yap/core/open-flags";

export type SessionExclusion = {
  /** Takes the installation lock for one call; the returned function gives it back. */
  hold(): () => void;
  /** Whether the installed app is now a different version from this session. */
  replaced(): boolean;
};

/**
 * The launcher holds a shared lock on the installation for a command's whole life, so an update
 * never replaces the app under a running command. A `yap mcp` session lives as long as its agent,
 * so holding that lock would stop every update; a session holds it only while a call runs.
 */
export function sessionExclusion(env: NodeJS.ProcessEnv, ownVersion: string): SessionExclusion {
  const path = env.YAP_LAUNCH_LOCK;
  const inherited = Number(env.YAP_LAUNCH_LOCK_FD);
  // Started outside the launcher, as from a checkout: there is no installation to protect.
  if (!path || !Number.isSafeInteger(inherited) || inherited < 3)
    return { hold: () => () => {}, replaced: () => false };
  closeSync(inherited);
  return {
    hold() {
      let descriptor: number;
      try {
        descriptor = openSync(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_SHLOCK,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EAGAIN" || code === "EWOULDBLOCK")
          throw new LocalTransportError(
            "UPDATING",
            "Installation is being replaced; retry after the update",
          );
        throw error;
      }
      return () => closeSync(descriptor);
    },
    replaced() {
      try {
        const runtime = join(env.YAP_APP ?? "", "Contents/Resources/service/runtime.json");
        return JSON.parse(readFileSync(runtime, "utf8")).version !== ownVersion;
      } catch {
        return false;
      }
    },
  };
}
