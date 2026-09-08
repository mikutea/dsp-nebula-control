# Contributor instructions

- Treat save files, Steam state, credentials, tunnels, player data, logs, and production endpoints as secrets. Never commit them.
- Keep all process execution behind an explicit allowlist. Do not add an arbitrary shell or command endpoint.
- Any mutating game operation must support a dry-run, emit an audit record, and define its rollback behavior before it can be enabled in the UI.
- Treat `.dsv` and `.server` as one atomic Nebula save unit.
- Production defaults must fail closed: loopback binding, authenticated access, and lifecycle operations disabled until explicitly configured.
- Examples must use `example.com`, RFC 5737 addresses, and fictional paths.
- Before committing, reuse the verified baseline and run the affected checks described in `docs/incremental-validation.md`. Do not automatically repeat `npm run check`, including for a final release. Unmapped changes require an updated impact/test plan; missing real-host acceptance evidence must still be obtained.
