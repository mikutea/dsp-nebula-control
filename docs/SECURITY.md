# Security model

## Trust boundaries

- The browser is untrusted input.
- The control-plane HTTP listener is loopback-only by default.
- A TLS reverse proxy is responsible for public transport security.
- The Windows provider may read the configured game root but cannot execute an
  arbitrary command supplied by a request.
- Collector output is constrained by a strict schema and contains summarized
  health fields only; raw paths and log lines never cross the provider boundary.
- Lifecycle preview accepts a fixed action enum, runs one fixed read-only
  collector, and exposes only bounded check messages and stable blocker codes.
  It always forces execution back to disabled at the provider boundary.
- Steam credentials are outside Dyson Control. The product must never ask for,
  persist, or echo a Steam password or guard code.

## Authentication

- Passwords use `scrypt` with a random salt.
- Sessions use random opaque tokens; only SHA-256 token digests are stored.
- Cookies are HttpOnly, SameSite=Strict, and Secure in production.
- State-changing requests must have the configured same-origin `Origin`.
- Production refuses to start without an administrator password hash and a
  session secret of at least 32 characters.

The first release has one administrator role. Viewer/operator roles will be
added before lifecycle actions are enabled.

## Deliberate exclusions

The project does not expose:

- arbitrary shell or PowerShell execution;
- raw filesystem paths through the public API;
- raw game, mod, player, or scheduled-task log content;
- a generic file writer;
- Steam login automation;
- unverified Mod downloads;
- save restore or in-place update without backup and rollback.

The dry-run lifecycle preview is not a mutation capability. Its successful job
state means evidence collection completed; it does not mean the requested save,
stop, or restart is safe or enabled. See [LIFECYCLE.md](LIFECYCLE.md).

## Reporting

Do not open a public issue containing credentials, production endpoints, player
information, saves, logs, or configuration exports. Use a private security
advisory once the GitHub repository enables it.
