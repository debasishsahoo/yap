# 02 Operations (done, uncommitted)

**Contract.** `cli.status`, `cli.install`, `cli.uninstall` are public, synchronous,
take `{}`, and are answered by the app on its own socket (`run/app.sock`); the
service refuses them with a pointer to the app.

**Seams.** `packages/protocol/src/operations.ts`, `apps/service/src/project-service.ts`.
CLI help and MCP tools derive from `operationNames`.

**Tests.** protocol (46), `apps/service/src/project-service.test.ts` (38), `apps/cli/src/main.test.ts` (26).
