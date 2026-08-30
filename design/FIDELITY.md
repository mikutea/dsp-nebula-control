# Visual fidelity ledger

The current implementation is checked against
`dashboard-concept-dsp-inspired-v2.png`. That concept is a visual evolution of
the user-selected `dashboard-concept-v1.png`; it does not replace the first
concept's information architecture or density.

Both the accepted concept and the checked-in implementation capture use the
native 1536 x 1024 review canvas.

## Preserved design relationships

1. The fixed top bar keeps instance, environment, connection, and operator
   context in one continuous operational strip.
2. The expanded left rail preserves the first concept's dense icon-and-label
   rhythm while exposing all 11 requested management workspaces.
3. The seven-item state strip remains the first high-density data surface below
   the heading and keeps health, versions, players, uptime, connectivity, and
   save integrity visible together.
4. The telemetry row uses five equal-width panels. CPU, UPS, thread, and process
   data use grid-backed filled area traces with luminous current-value nodes;
   memory uses 10 compact vertical utilization bars. This is the reviewed
   replacement for the rejected isolated-sparkline treatment.
5. The main workspace preserves the large realtime-console region and narrow
   deployment/version rail, including the original strong 3.3:0.95 width
   relationship.
6. Recent tasks and paired-save integrity remain visible together along the
   bottom, so operational history and recoverability are not hidden on separate
   pages.
7. The v2 visual layer is code-native CSS/SVG: deep navy space, subtle star
   points, 64 px holographic grid, orbital arcs, thin cyan rails, chamfered panel
   corners, and restrained green/amber status glow.
8. The original layout remains usable rather than decorative: headings, values,
   console text, warning states, and disabled lifecycle controls retain strong
   contrast over every background effect.

## Above-the-fold copy comparison

- Both concept and implementation use `服务器总览` and retain the four
  lifecycle/refresh actions.
- The checked-in implementation explicitly says `演示数据 · 不会操作真实服务器`.
  The concept uses equivalent demonstration wording.
- The implementation uses the reserved example endpoint
  `dsp.example.com:8469`; no production hostname appears in either public
  screenshot.
- Version numbers, player counts, PIDs, log entries, task times, and save values
  are fictional fixtures. They intentionally differ from the visual concept and
  are not claims about a live server.

## Intentional deviations

- The orbit emblem, background star field, chart geometry, and all UI icons are
  original SVG/CSS or Lucide components. No Dyson Sphere Program screenshot,
  logo, texture, or proprietary interface asset is shipped.
- Lifecycle, command, backup, update-activation, kick/ban, restore, and host
  controls stay disabled until their allowlisted adapters, role checks, audit
  records, and rollback behavior are verified.
- The production collector never feeds the checked-in screenshot. Public visual
  assets are generated only from the demo provider.
- At 620 px and below, the left rail becomes an accessible drawer and the four
  lifecycle actions become a legible 2 x 2 grid instead of shrinking the desktop
  arrangement.

## Verified interaction path

1. Open the local demo origin and authenticate with a development-only password.
2. Land on `服务器总览`; confirm all five telemetry panels, the console,
   deployment rail, task history, and paired-save panel render.
3. At 390 x 844, open the navigation drawer and select `服务器管理`; the drawer
   closes automatically and the selected workspace becomes active.
4. At 1536 x 1024, `服务器管理` displays 10 structured rows, including an amber
   warning for the deliberately locked stop workflow.
5. Refresh remains functional; all mutation controls remain visibly locked.

## Browser QA baseline

- Desktop: 1536 x 1024, exact client/scroll width 1536, no page overflow.
- Mobile: 390 x 844 viewport, exact client/scroll width 375 after browser
  scrollbar allocation, no horizontal overflow, 2 x 2 action grid, and all 11
  navigation items reachable through the drawer.
- Demo overview: five telemetry panels, four filled area charts, 10 memory bars,
  four endpoint nodes, seven fictional console entries, and 11 navigation
  destinations.
