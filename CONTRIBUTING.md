# Contributing

Dyson Control welcomes focused issues and pull requests. Before changing code,
read `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and
`docs/ACCEPTANCE.md`.

## Development

The complete gate requires Windows, Windows PowerShell 5.1, Node.js 24 or
newer, npm, and the .NET 8 SDK. Install the three locked dependency trees
without rewriting their lockfiles:

GitHub CI installs and verifies the exact certified test toolchain: Node.js
24.20.0 and .NET SDK 8.0.424. These are reproducibility pins for the canonical
CI result, not a narrower deployment contract; the public Node engine range
remains `>=24.0.0`, and contributors may use another compatible .NET 8 SDK for
local iteration before reproducing failures on the certified versions.

```powershell
npm ci
npm ci --prefix apps/api
npm ci --prefix apps/web
```

Run the complete local gate before opening a pull request:

```powershell
npm run check
```

Node-only checks can be useful on another operating system, but they do not
replace the Windows PowerShell 5.1 or cross-runtime Bridge gates required by
CI and release automation.

Before a public tag or release, also run the real repository/history scan and
verify the generated artifact directory. Unlike its self-test, this gate is
expected to fail on a dirty development tree:

```powershell
npm run public-release:check
node scripts/public-release/check.mjs --history --artifact <artifact-directory>
```

## Safety requirements

- Never commit game binaries, Steam credentials/state, real saves, player
  information, production endpoints, logs, or configuration exports.
- Do not add an arbitrary command, shell, filesystem-write, or package-download
  endpoint.
- Every mutation needs a dry run, durable audit record, explicit capability,
  integration test, and documented rollback behavior.
- Treat matching `.dsv` and `.server` files as one atomic save unit.
- Examples and screenshots must use fictional data and `example.com`.
- Do not mark an acceptance requirement `verified` unless its evidence directly
  proves the complete criterion at the required unit, integration, installation,
  or production scope. Production evidence remains outside the public repository.
