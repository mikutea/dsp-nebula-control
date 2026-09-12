# Nebula 0.9.22 hostname-preserving WSS source patch

This directory publishes an auditable GPL-3.0-only source patch for the
official `NebulaModTeam/nebula` `v0.9.22` client. It does not contain a patched
DLL, Dyson Sphere Program files, Unity assemblies, Steam files, credentials, or
any production endpoint. It also does not make the ordinary Dyson Control
release artifact or generated client profile install this patch automatically.

The only accepted upstream identity is:

- repository: `https://github.com/NebulaModTeam/nebula.git`;
- tag: `v0.9.22`;
- commit: `3cdf95c594a2f8010b0e87a43be828e6ba2f657f`;
- license: GPL-3.0-only; and
- modified source paths: `NebulaNetwork/Client.cs` and
  `NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs` only.

The exact Git blob IDs, canonical blob SHA-256 values, patch SHA-256, patched
source SHA-256, sizes, allowed output files, and upstream license are frozen in
[`contract.json`](contract.json). The implementation also hard-codes those
trust anchors, so editing the JSON to bless different bytes fails closed.

## What the patch changes

The stock 0.9.22 join parser collapses bare input and an explicit `ws://`
prefix into the same protocol value. The parser patch records whether the
protocol was explicit and promotes only an implicit hostname route whose final
port is 443. The stock hostname constructor then resolves the hostname into
`ServerEndpoint`, then loses the hostname by constructing the WebSocket URI
from that IP endpoint. The client patch retains the original hostname
separately while still resolving `ServerEndpoint`; it does not infer transport
from a port number.

| Constructor path | Input protocol and port | Patched WebSocket authority | Remembered value |
| --- | --- | --- | --- |
| hostname string | default parser result `ws`, port `443` | promoted to `wss://<hostname>:443/socket` | `wss://<hostname>:443` |
| hostname string | explicit `wss`, any explicit port | `wss://<hostname>:<port>/socket` | `wss://<hostname>:<port>` |
| hostname string | explicit `ws`, port `443` | `ws://<hostname>:443/socket` | `ws://<hostname>:443` |
| hostname string | `ws`, non-443 port | `ws://<hostname>:<port>/socket` | `<hostname>:<port>` |
| `IPEndPoint` | any protocol and port | unchanged IP-endpoint behavior | unchanged IP-endpoint authority |

Using the hostname in the WebSocket URI lets the WebSocket/TLS stack use that
hostname for URL authority, HTTP `Host`, certificate-name validation, and TLS
SNI. The patch also fixes the authentication retry overload: a newly entered
password is passed as the password, not accidentally as the protocol, and a
hostname connection retries with the same hostname, port, and effective `wss`
protocol.

## Build a source-only candidate

Requirements are Node.js 24 or later, Git, and a complete clean checkout of the
official tag. The checkout must have the exact official `origin`, local tag,
and HEAD; sparse checkouts, modified/deleted files, untracked or ignored files,
moved tags, source-hash drift, and license drift are rejected.

```text
git clone --branch v0.9.22 --depth 1 https://github.com/NebulaModTeam/nebula.git <absolute-clean-nebula-checkout>
node scripts/nebula-hostname-wss/build-source-candidate.mjs --source-root <absolute-clean-nebula-checkout> --output-root <absolute-new-candidate-directory>
node scripts/nebula-hostname-wss/verify-source-candidate.mjs --candidate-root <absolute-new-candidate-directory>
```

The output directory must not already exist and must not overlap either
repository. Publication is temporary-directory-first and renamed only after
verification. The exact output is:

- `LICENSE` from the pinned upstream Git blob;
- patched `NebulaNetwork/Client.cs`;
- patched `NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs`;
- `nebula-v0.9.22-hostname-wss.patch`;
- `nebula-v0.9.22-hostname-wss.contract.json`; and
- deterministic `candidate-manifest.json`.

The verifier rejects missing or extra files, extra directories, symlinks,
special files, path traversal, PE (`MZ`) payloads, common proprietary game or
Unity assembly names, binaries, PDBs, native libraries, saves, and `.server`
companions. It verifies every size/hash and reverse-applies the patch to prove
that the candidate reconstructs the exact pinned upstream source.

Run the repository-only self-test directly, or use the root script that is also
part of `npm run check`:

```text
node --test scripts/nebula-hostname-wss/nebula-hostname-wss.test.mjs
npm run nebula-hostname-wss:selftest
```

## Private binary build boundary

The public source candidate is deliberately not a binary builder and is not a
complete Nebula source checkout. To build a DLL, an operator must privately use
the pinned official checkout, replace only the two verified source paths with
the candidate copies, and follow Nebula's upstream build instructions. Any
Dyson Sphere Program or Unity references must come from a locally licensed game
installation and must remain outside this repository, public artifacts, logs,
and source candidates. Do not commit or redistribute those proprietary
assemblies through this project.

A successful source build is still not a connectivity acceptance result. The
exact privately built client must complete an external Nebula join, password
authentication when enabled, lobby/application handshake, sustained
bidirectional game traffic, disconnect, and fresh reconnect against the exact
route intended for use.

## Cloudflare route contract

Nebula always requests `/socket`. A same-hostname Cloudflare Tunnel layout must
route that exact path to the plain WebSocket Nebula origin before any dashboard
or catch-all route, preserve the WebSocket upgrade, and leave the catch-all
fail closed. For example, using documentation-only values:

```yaml
ingress:
  - hostname: game.example.com
    path: ^/socket$
    service: http://192.0.2.10:8469
  - hostname: game.example.com
    service: http://192.0.2.20:8080
  - service: http_status:404
```

For this patched parser and hostname-string constructor, entering bare
`game.example.com:443` is identified as an implicit hostname route and promoted
to WSS. Explicit
`wss://game.example.com:443` remains WSS and is the least ambiguous input.
Explicit `ws://game.example.com:443` remains plaintext WebSocket because the
parser carries the explicit-protocol decision before the `Client` is created.
When `Remember Last IP` is enabled, that exact WS-on-443 route is stored with
its `ws://` scheme so menu reuse and automatic reconnect do not reinterpret it
as an implicit hostname route and promote it to WSS. Non-443 WS hostnames and
IP-literal inputs retain the stock remembered-value display format.
Stock Nebula 0.9.22 does not have this promotion and still loses the hostname;
IP-literal inputs intentionally keep stock behavior. Neither a generic `101`
response nor these fixture tests prove that a real Nebula client connected.

The source candidate includes the exact upstream GPL license. The upstream tag
has no root `NOTICE` file, and this source-only candidate does not redistribute
third-party dependency code or binaries. A later binary distribution is a
different license boundary: it must include all applicable upstream and
third-party notices plus complete corresponding source as required by GPL.
