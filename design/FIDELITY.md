# Visual fidelity ledger

The implementation is checked against `dashboard-concept-v1.png`, the
user-selected first concept from 2026-08-29.

## Preserved design relationships

1. The fixed top bar keeps instance, environment, connection, and operator
   context in one horizontal operational strip.
2. The grouped left navigation keeps the same dense icon-and-label rhythm and
   blue active-state treatment. It is expanded to cover every requested
   management domain.
3. The server state strip preserves the seven high-priority facts visible
   before any detailed telemetry.
4. The telemetry row keeps compact inline traces, numeric summaries, and the
   cyan/green/amber status palette.
5. The main workspace preserves the large live-console region and the narrow
   deployment/version rail.
6. Recent tasks and paired-save integrity remain visible together at the bottom
   of the overview.
7. Typography, square borders, restrained shadows, dark surfaces, and cyan
   accents stay within the original operations-console visual language.

## Intentional deviations

- The checked-in screenshot says `演示环境` and uses `example.com` so it cannot
  be mistaken for production or leak a real endpoint.
- Navigation is expanded to include game, player, version, mod, save, client,
  server, configuration, and audit workspaces.
- Lifecycle and command controls are disabled until their allowlisted adapters,
  role checks, audit records, and rollback behavior are verified.
- Version values are fictional demonstration fixtures; update availability is
  never fabricated.
- At 620 px and below, the left rail becomes an accessible navigation drawer.

## Browser QA baseline

- Desktop capture: 1536 x 1024, no horizontal or vertical page overflow.
- Tablet check: 900 x 900, no horizontal overflow; content stacks vertically.
- Mobile check: 620 x 900, no horizontal overflow; all modules remain reachable
  through the navigation drawer.
