# Accepted dashboard design

`dashboard-concept-v1.png` is the user-selected structural source of truth from
2026-08-29. `dashboard-concept-dsp-inspired-v2.png` is the current visual source
of truth: it preserves that first concept's dense operational layout while
adding an original deep-space industrial language on 2026-08-30. The v2
telemetry row was revised after review to restore the first concept's filled
trend charts and memory histogram instead of isolated sparklines.

`dashboard-implementation-dsp-inspired-v2.png` is the matching 1536 x 1024
code-native implementation capture. It uses only fictional demonstration data.
`game-lifecycle-preflight-desktop.png` is the matching 1536 x 1024
game-management capture for the read-only lifecycle preflight. It also uses
only the deterministic demo provider.

Implementation invariants:

- preserve the deep blue-black operations-console aesthetic;
- use original orbital grids, star points, holographic borders, chamfered
  industrial panels, and restrained cyan/gold energy accents without copying
  proprietary game art or UI assets;
- preserve the dense but readable desktop layout, top instance context bar,
  left navigation, status strip, telemetry, console, deployment/version rail,
  tasks, and save/backup region;
- extend navigation without changing the design language to cover game,
  versions, mods, players, saves, server, console, configuration, client
  delivery, tasks, and audit;
- keep all text and controls code-native;
- render CPU, UPS, thread, and process trends as grid-backed filled area charts,
  and render memory as a compact vertical utilization histogram;
- do not ship production hostnames, paths, credentials, logs, saves, or player
  information in screenshots or fixtures.
