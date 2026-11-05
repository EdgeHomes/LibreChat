# Private Craft MCP file workspaces

WordCraft, GridCraft, DeckCraft and PdfCraft need a private filesystem root and a separate
stdio process for each authenticated user. A shared `--root` plus `fileInputDir` lets every
user's MCP tools read files in that shared directory; deleting outputs later does not isolate it.

This LibreChat fork supports the opt-in `fileWorkspace` field on operator-managed YAML
stdio servers. It derives a directory from a SHA-256 hash of `[tenantId, userId]` supplied by
LibreChat authentication, supplies that directory as `--root`, `cwd` and the upload staging
root, and bypasses app-shared connections. Connection reuse checks the workspace identity,
including tenant changes and concurrent initialization. Neither prompts nor custom user
variables select the identity or root. Workspace servers are inspected on authenticated use.

## Configure all four servers

Install tested, pinned releases of the npm launchers and their platform packages in the
LibreChat runtime first. The launchers below must be on the backend's `PATH`; they insert
`mcp` when starting the native binary. Locally staged npm tarballs also work. If running native
binaries directly, use e.g. `command: /opt/craft/wordcraft-cli` and `args: [mcp, --compact]`.
Do not add `mcp` to the npm launcher's arguments.

Create these four base directories as the LibreChat backend's OS user, on persistent local
storage accessible to that backend. Keep them outside every publicly served directory:

```sh
mkdir -p /app/mcp-workspaces/wordcraft /app/mcp-workspaces/gridcraft \
  /app/mcp-workspaces/deckcraft /app/mcp-workspaces/pdfcraft
chmod 700 /app/mcp-workspaces /app/mcp-workspaces/*
```

Merge the following entries into the existing `mcpServers` map in `librechat.yaml`. This is
an example, not an automatic deployment change:

```yaml
secureImageLinks: true
mcpServers:
  wordcraft:
    type: stdio
    command: wordcraft-edge-mcp
    args: [--compact]
    fileWorkspace:
      root: /app/mcp-workspaces/wordcraft
      cleanupAfterDelivery: true
      retentionHours: 24
      maxFileBytes: 33554432
      sweepMaxEntries: 10000
  gridcraft:
    type: stdio
    command: gridcraft-edge-mcp
    args: [--compact]
    fileWorkspace:
      root: /app/mcp-workspaces/gridcraft
  deckcraft:
    type: stdio
    command: deckcraft-edge-mcp
    args: [--compact]
    fileWorkspace:
      root: /app/mcp-workspaces/deckcraft
  pdfcraft:
    type: stdio
    command: pdfcraft-edge-mcp
    args: [--compact]
    fileWorkspace:
      root: /app/mcp-workspaces/pdfcraft
```

The omitted settings use the defaults shown for WordCraft. `root` must be an absolute,
operator-controlled directory that already exists. User and input directories are provisioned
with mode 0700. Symlinked user/input directories are refused. Existing `--root` arguments
are replaced; separate automation read/write roots and an argument terminator are rejected.
Remove the old manually shared `cwd`, `fileInputDir` and root arguments when migrating.
This setting is unavailable to user-created or database-managed MCP servers and remote transports.
Unconfigured servers retain their existing behavior.

## Uploads, downloads and deletion

Chat uploads are copied only after their stored owner and tenant match the authenticated user.
A bounded stream writes a private partial file, then publishes it atomically without replacing
an existing input. The model receives the resulting path inside its own server's root.
Images continue through LibreChat's existing image handling. Keep `secureImageLinks: true`
(as in the example) to require the existing image owner/tenant authorization for inline previews.
If using cloud storage, keep the underlying bucket/container private as required by that storage
backend; a public storage object bypasses application authorization.

When `file_attach` returns a downloadable resource, LibreChat saves its bytes and owner/tenant
metadata through the normal attachment pipeline. Local downloads go into private upload
storage and use the existing authenticated file download/preview routes. Ordinary explicit
sharing and file ACLs still apply; workspace isolation does not disable intentional sharing.

With `cleanupAfterDelivery: true`, LibreChat then deletes the matching temporary output.
"Delivery" means storage and the file database record succeeded, before the attachment event
is sent; it does not depend on the browser opening or downloading it. Deletion verifies the
current authenticated root, exact file contents and identity. Inputs, foreign paths, symlinks
and changed files are retained. A persistence failure retains the original. A cleanup failure
logs a warning and preserves the saved download. Downloads continue working after temporary
deletion. To edit a delivered file later, attach its saved download again, or set
`cleanupAfterDelivery: false` to retain workspace outputs until expiry.

Abandoned outputs, partial copies and staged inputs expire by modification time after
`retentionHours` (default 24, allowed 1–8760). The existing file-retention sweep runs at startup
and hourly by default. `FILE_RETENTION_SWEEP_INTERVAL_MS=0` disables this fallback too.
The sweep is bounded by `sweepMaxEntries` per server/pass (default 10000, max 1000000) and
32 directory levels. It is best effort rather than an exact deletion deadline: very large
fresh directory prefixes can delay deeper entries, so size the limit for the workspace or
use an operator-managed filesystem lifecycle policy for strict retention. It never follows
symlinks or traverses legacy shared-root files. One broken server root does not stop the others.

`maxFileBytes` bounds staged uploads and content verification for immediate cleanup (default
32 MiB, max 512 MiB). The MCP resource parser and each Craft server retain their own attachment
limits; increasing this setting does not raise those limits.

## Rollout

Build/deploy this LibreChat backend before enabling `fileWorkspace`; older versions do not
provide this isolation. Restart backend replicas during the planned rollout to discard old
shared processes. Move or delete legacy shared temporary files separately after reviewing them;
this change does not infer their owners or migrate them into a user's workspace. Earlier local
MCP attachments saved under `/images` also need an operator-reviewed migration/removal; this
change routes new attachments into `/uploads` and does not rewrite existing file records.
No live configuration is changed by adding this example.

Each trusted Craft executable must enforce `--root` (tested with all four). This is an
application boundary for these servers, not an OS sandbox for arbitrary untrusted executables.
Keep the bases private to the backend OS account and avoid other tools or mounts granting
users access to their parent directories. On multiple replicas, provision a base on each runtime;
files and open document state are local to that process unless the deployment supplies suitable
shared storage/session routing. Durable attachments use LibreChat's configured storage backend.

## Local verification

Unit/regression coverage exercises identity, shared/cached/pending connections, upload ownership,
size limits, symlinks, persistence failures, content matching and bounded expiry. To run the real
stdio integration suite, set `CRAFT_MCP_BINARIES` to a JSON map of the four absolute CLI paths:

```sh
CRAFT_MCP_BINARIES='{"wordcraft":"/opt/craft/wordcraft-cli","gridcraft":"/opt/craft/gridcraft-cli","deckcraft":"/opt/craft/deckcraft-cli","pdfcraft":"/opt/craft/pdfcraft-cli"}' \
  npm exec --workspace=@librechat/api -- jest --runInBand --coverage=false src/mcp/workspace.integration.spec.ts
```

The suite starts eight real processes across its cases, tests known foreign absolute paths,
traversal and `tool_call` indirection, then verifies saved bytes survive source deletion.

### Verification on 2026-11-05

- API regression suites: 525 passing tests, including the four real Darwin ARM64 Craft CLI cases
  and existing image authorization coverage. The native suite uses synthetic CSV files and a real
  stdio transport; its durable storage callback writes to disk. The Express suites separately cover
  the real persistence adapter and database-backed download authorization.
- Backend Express/storage/ACL suites: 175 passing tests. MCP schema suite: 80 passing tests.
- `tsc --noEmit` passed for `packages/api` and `packages/data-provider`; the API production build,
  targeted ESLint, import order, Prettier and `git diff --check` passed.
- Five temporary negative controls removed identity separation, user-scoped checkout, upload
  ownership, content verification and private durable storage, respectively. Each triggered its
  expected behavioral regression failure; source was restored and the final suites passed.
- The required `npm run lighthouse` passed with Node 24 and Chrome. A final `lighthouse:run`
  against the finalized backend also passed: median LCP 3582 ms (4500 ms limit), CLS 0.0174
  (0.1 limit), TBT 20.1 ms (500 ms limit), with 250 ms injected per database query.
- No live backend, deployment configuration or service was changed. This is a local implementation;
  deployment and enabling the YAML policy are separate rollout steps.
