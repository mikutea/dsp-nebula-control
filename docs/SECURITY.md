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
- Configuration routes accept only catalog setting IDs and values. The
  filesystem root is server-side, secrets are write-only, and transaction
  responses contain no file contents, paths, or snapshot hashes.
- Console routes can read only the fixed BepInEx log beneath the trusted server
  root. Redaction happens before filtering, browser display, or download;
  cursors are signed and contain no usable host path.
- Player routes accept only a fresh HMAC-authenticated local bridge snapshot and
  expose opaque session IDs plus coarse location summaries. Unavailable source
  state stays unknown instead of becoming a false empty roster.
- Update discovery is bounded to explicit HTTPS providers, while artifact
  staging reads only a server-selected opaque ID from a fixed offline inbox.
  Component activation accepts opaque IDs, digests, versions and compatibility
  evidence only; its independent runtime adapter remains fail-closed until a
  deployment explicitly configures it.
- Steam credentials are outside Dyson Control. The product must never ask for,
  persist, or echo a Steam password or guard code.

## Authentication

- Passwords use `scrypt` with a random salt.
- Sessions use random opaque tokens; only SHA-256 token digests are stored.
- Cookies are HttpOnly, SameSite=Strict, and Secure in production.
- State-changing requests must have the configured same-origin `Origin`.
- Production refuses to start without an administrator password hash and a
  session secret of at least 32 characters.

Three exact roles are implemented and returned with their effective permission
list by the authenticated session endpoint:

| Role | Intended boundary |
| --- | --- |
| Viewer | Read status, jobs, telemetry, player presence, redacted console, saves, configuration, update and mod inventory. |
| Operator | Viewer access plus refresh, durable-alert acknowledgement, log export, fixed lifecycle/console commands, backup, configuration preview, offline staging and client-profile generation. |
| Administrator | All declared permissions, including restore, configuration apply, component activation, mod mutation and any future verified player mutation. |

An omitted optional Viewer or Operator password hash disables that login role.
Authentication never upgrades a role, and every route names one permission in
its pre-handler. Role permission is only the first gate: feature-specific
default-off mutation gates, confirmations, stopped-state proof, revision checks,
locks and rollback requirements remain independently enforced.

## Deliberate exclusions

The project does not expose:

- arbitrary shell or PowerShell execution;
- raw filesystem paths through the public API;
- raw game, mod, player, or scheduled-task log content;
- a generic file writer;
- Steam login automation;
- unverified mod downloads;
- save restore or in-place update without backup and rollback;
- arbitrary console text, command-line arguments, paths, URLs or executables.

The presence of a route does not imply that its mutation is enabled. Save,
configuration, mod and component-update routes each retain independent safety
gates. Console execution is limited to four typed lifecycle commands. Player
moderation is not synthesized: the published capability proof currently marks
unsupported Nebula actions unavailable, and no corresponding mutation route is
created. See [CONFIGURATION.md](CONFIGURATION.md),
[CONSOLE-PLAYERS.md](CONSOLE-PLAYERS.md), and
[UPDATES-CLIENTS.md](UPDATES-CLIENTS.md).

The dry-run lifecycle preview is not a mutation capability. Its successful job
state means evidence collection completed; it does not mean the requested save,
stop, or restart is safe or enabled. See [LIFECYCLE.md](LIFECYCLE.md).

## Reporting

Do not open a public issue containing credentials, production endpoints, player
information, saves, logs, or configuration exports. Use a private security
advisory once the GitHub repository enables it.
