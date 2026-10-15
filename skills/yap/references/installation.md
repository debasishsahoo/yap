# Install the released app

Use this procedure when `yap` or its selected app is missing. First check
`uname -m` and `sw_vers -productVersion`: the app requires Apple Silicon (`arm64`)
and macOS 26 or newer. On Linux, including Docker, report that native installation
is unsupported; do not install a macOS bundle there. Linux can independently run
the portable JavaScript CLI bundle with Node for schema/transport tests; that
does not install the macOS launcher or verify native service/capture readiness.
A consumer install needs no
source checkout, Bun, separate Node, Swift or MCP configuration.

## Download and verify

Resolve the latest stable release once, then download all assets from that tag.
The GitHub API and release downloads below need network access; an authentication,
rate-limit or download failure is a blocker, not evidence of installation.

```sh
(
  set -eu
  yap_download=$(mktemp -d)
  cd "$yap_download"
  curl -fL https://api.github.com/repos/dzhng/yap/releases/latest -o latest.json
  yap_tag=$(/usr/bin/plutil -extract tag_name raw -o - latest.json)
  yap_release="https://github.com/dzhng/yap/releases/download/$yap_tag"
  curl -fL "$yap_release/SHA256SUMS" -o SHA256SUMS
  curl -fL "$yap_release/release.json" -o release.json
  yap_zip=$(awk '/\.zip$/ { print $2 }' SHA256SUMS)
  test -n "$yap_zip"
  curl -fL "$yap_release/$yap_zip" -o "$yap_zip"
  shasum -a 256 -c SHA256SUMS
  cat release.json
  ditto -x -k "$yap_zip" unpacked
  printf 'Verified release extracted at: %s\n' "$yap_download/unpacked"
)
```

Check that `release.json` names the selected tag, `arm64` and a compatible minimum
macOS version. It also reports signing and notarization. Keep the ZIP and receipt
until installation has been verified. Stop on checksum failure.

## Install the app

Use the verified extraction path printed above for `yap_unpacked`. The app runs
only from `/Applications` or `~/Applications`. Update an existing copy in place;
otherwise install to `~/Applications`. For an update, quit the running app first and
keep the old bundle as a backup; never replace a live app or discard its library.

```sh
(
  set -eu
  yap_unpacked="/absolute/path/printed/above/unpacked"
  # Match the launcher: ~/Applications first, else an existing /Applications copy.
  yap_app="$HOME/Applications/Yap.app"
  if [ ! -e "$yap_app" ] && [ -d /Applications/Yap.app ]; then yap_app=/Applications/Yap.app; fi
  if [ -e "$yap_app" ] || [ -L "$yap_app" ]; then
    yap_backup=$(mktemp -d)
    mv "$yap_app" "$yap_backup/"
    printf 'Previous app retained at: %s\n' "$yap_backup/Yap.app"
  fi
  mkdir -p "$(dirname "$yap_app")"
  ditto "$yap_unpacked/Yap.app" "$yap_app"
  open "$yap_app"
  printf 'Opened: %s\n' "$yap_app"
)
```

On launch, with **Settings → Set up my agents** on (the default), the app installs
`~/.local/bin/yap`, the yap skill for every agent harness it finds, and a marked
PATH line in the login shell profile when no startup file already puts
`~/.local/bin` on PATH. It repeats this at every launch, including the relaunch
after an update, so the command and skill always match the app. Do not copy a
launcher or run `npx skills add` yourself.

A new PATH line reaches only new login shells. In the current session, and for
agents launched from the Dock, call the command by its full path,
`~/.local/bin/yap`.

Opening at login is a separate, opt-in choice. Ask the user whether Yap should
open automatically when they sign in. Only after an explicit yes, call
`~/.local/bin/yap login.setEnabled --params '{"enabled":true}'`; for no, leave it
unregistered (or explicitly call the same operation with `false`). Verify the
result with `~/.local/bin/yap login.status`. Do not infer consent from installing
the app or the CLI.

## Verify installation separately from permissions

1. Run `~/.local/bin/yap cli.status` and `~/.local/bin/yap skill.status`. Expect
   `installed` for both. These may launch the installed app's service; the first
   launch can take a few seconds while the app sets up.
2. Run `~/.local/bin/yap capture.status --help` (schema only, no app launch) and
   `~/.local/bin/yap service.health`. Inspect `ok` and the returned service status.
3. If macOS blocks launch, have the user try opening the installed app, then approve
   System Settings → Privacy & Security → **Open Anyway**. Releases are not
   notarized; a `curl` download is never blocked, a browser download is. Managed
   Macs may prohibit that override. Do not remove quarantine attributes or disable
   Gatekeeper to bypass it.
4. Discover `capture.sources` and `capture.status` before an actual recording
   request. Screen, microphone and camera permissions are separate user actions.
   The default transcript model is prepared automatically. Optional alignment,
   speaker and voice models are downloaded only after a capability reports
   `MODEL_NOT_PREPARED` and the user approves `model.prepare`; status and help
   reads never download models.

Report a short checklist: release tag, app path, command (`cli.status` and whether
it is on PATH), skill (`skill.status`), service health, and that permissions are
granted at first recording. If only help passed, say so.
Use the installed CLI's schemas even when this skill is newer than that release.

## When the app reports a problem

What each state means:

- **`missing`** (command or skill): Settings → **Set up my agents** is probably off.
  Ask the user before turning it back on, or run `cli.install` / `skill.install`.
- **`needs_attention`**: a write failed and the reply carries an `error` (for example
  an unwritable `~/.local/bin` or a profile file that isn't UTF-8 text). Report it;
  do not change ownership or permissions without the user.
- **`different`**: `~/.local/bin/yap` is some other file; `cli.install` replaces it.
- **`unavailable`**: this build carries no launcher (a source build).
- **No answer at all** with the app outside an Applications folder: it showed a
  "Move it home" prompt and quit. Reinstall with the steps above.

Install by hand only when those don't resolve it. The command must be written as
fresh bytes, not copied (a copy keeps a quarantine flag and stays blocked):

```sh
(
  set -eu
  yap_app="$HOME/Applications/Yap.app"   # or /Applications/Yap.app
  mkdir -p "$HOME/.local/bin"
  yap_staged=$(mktemp "$HOME/.local/bin/yap.installing.XXXXXX")
  cat "$yap_app/Contents/Resources/bin/yap" > "$yap_staged"
  chmod 755 "$yap_staged"
  mv "$yap_staged" "$HOME/.local/bin/yap"
)
```

The skill: follow [skill lifecycle](skill-lifecycle.md).

## App updates and recovery

An older installation without the updater needs one manual bootstrap using the
install steps above. Wait for accepted
work and old client processes to finish before replacing it; never kill clients,
cancel jobs or stop a recording merely to install an update. Retain the old bundle
and launcher and leave the library intact.

Updater-bearing releases download candidates automatically and install when the
app, service and existing CLI clients permit it. The app bundle contains the actual
CLI, Node, service and workers, so they update together; the relaunched app
then refreshes `~/.local/bin/yap` from its bundled launcher. An already-running CLI remains its old generation until it exits. The
app's automatic-update preference persists; turning it off cancels download or
staged installation until replacement has been finally authorized. After that
point it applies to the successor. The update does not edit skill files itself;
with skill maintenance on, the relaunched app refreshes the global skill through
the skill lifecycle.

Read advertised update state and errors literally. `update.*`, `skill.*`, `cli.*`
and `login.*` are answered by the app itself, so they work while `service.health`
fails. `UPDATING` is a retryable installation fence; retry after relaunch,
following the operation's write-identity contract. `UPDATE_FAILED` or
`UPDATE_SHUTDOWN_FAILED` reports a cycle that stopped: the app restarts its
service if it had closed it, and retries the update within the hour. Do not
force-kill a closing child, launch a competing service or replay an uncertain
mutation.

If an installed update cannot start, retain the reported failure and use the same
verified download/install procedure for a specifically chosen previous release
with the same catalog format. Back up the app, preserve the library, and
verify health after reinstalling. Do not promise arbitrary downgrades, automatic
post-launch rollback or restoration of capture permissions from a checksum alone.
