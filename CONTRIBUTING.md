# Contributing

Dyson Control welcomes focused issues and pull requests. Before changing code,
read `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and
`docs/ACCEPTANCE.md`.

## Development

Node.js 24 or newer is required. Install the root, API, and web dependencies:

```powershell
npm install
npm run install:all
```

Run the complete local gate before opening a pull request:

```powershell
npm run check
```

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
