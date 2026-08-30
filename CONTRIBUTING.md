# Contributing

Dyson Control welcomes focused issues and pull requests. Before changing code,
read `AGENTS.md`, `docs/ARCHITECTURE.md`, and `docs/SECURITY.md`.

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

## Safety requirements

- Never commit game binaries, Steam credentials/state, real saves, player
  information, production endpoints, logs, or configuration exports.
- Do not add an arbitrary command, shell, filesystem-write, or package-download
  endpoint.
- Every mutation needs a dry run, durable audit record, explicit capability,
  integration test, and documented rollback behavior.
- Treat matching `.dsv` and `.server` files as one atomic save unit.
- Examples and screenshots must use fictional data and `example.com`.
