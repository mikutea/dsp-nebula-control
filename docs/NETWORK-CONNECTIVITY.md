# Nebula network connectivity and production qualification

This guide describes reusable connectivity patterns for a Nebula listen server.
It contains no production endpoint, address, credential, player data, tunnel
identifier, or router configuration. The examples use only `example.com` and
the IPv4 documentation ranges reserved by RFC 5737.

Repository tests and network preflights can establish evidence, but they do not
authorize or perform DNS, router, firewall, Cloudflare, PassWall, process, or
service changes. None of the patterns in this document is production-qualified
until an external client completes the end-to-end checklist below.

## Verified protocol facts

This section is based on the NebulaModTeam repositories and Cloudflare
documentation current on 2026-09-01. The Nebula source observations are pinned
to commit `3cdf95c594a2f8010b0e87a43be828e6ba2f657f`; the official wiki observation
is pinned to wiki commit `fb6bbaf77ae112b1b82eb03562043e96ab774dcc`, and
the Cloudflare documentation source is pinned to commit
`fe4f2c8bd23c2d0f174505d7f2a1c21569331ad2`.

- Nebula uses a listen-server architecture and WebSocket over TCP. Its default
  port is `8469`, and the port is configurable. The official hosting guide says
  WAN clients need port forwarding when direct inbound reachability is not
  already available, and conventional forwarding does not solve CGNAT.
- The stock 0.9.22 join parser defaults to `ws`. It recognizes only explicit `ws://`
  and `wss://` prefixes, parses an explicit port when present, and otherwise
  falls back to the configured host port.
- The client always appends `/socket` when it creates the WebSocket connection.
- For a hostname, the stock 0.9.22 client resolves the name first, selects the first
  returned address, converts it to an IP endpoint, and then constructs the final
  WebSocket URI from that IP endpoint. The original hostname is therefore not
  retained in the final URI.
- The current host starts a WebSocket server on the configured TCP port and
  permits forwarded requests for tunneling compatibility. This source alone
  does not configure a public TLS certificate or qualify any particular
  reverse proxy.
- Cloudflare supports WebSocket connections for proxied HTTP applications, and
  Cloudflare Tunnel supports WebSockets. A Tunnel can route a public HTTP
  hostname and path to an HTTP origin.
- A Cloudflare Tunnel published as arbitrary TCP is a different access model:
  Cloudflare documents that TCP is streamed over WebSocket and that the end
  user runs client-side `cloudflared`. Stock Nebula does not itself replace
  that helper.
- A DNS-only record returns the configured origin address and does not route
  application traffic through Cloudflare. It exposes the origin address and
  does not gain Cloudflare HTTP proxy protection.

The important consequence is that two separately true statements do not prove
the combined deployment:

1. Nebula recognizes a `wss://` input prefix.
2. Cloudflare Tunnel supports WebSockets.

The stock Nebula hostname-to-IP conversion is an independent compatibility gate
for hostname-based TLS, certificate validation, SNI, and Cloudflare hostname
routing. This repository now contains a GPL source-only, commit/hash-bound
candidate patch that preserves the hostname, but its fixture and source-build
checks are not network evidence. Only a join by the exact privately built client
intended for production can close that gate. See
[`integrations/nebula-hostname-wss/README.md`](../integrations/nebula-hostname-wss/README.md).

## Connectivity choices

| Pattern | Client input example | Public data path | Current qualification |
| --- | --- | --- | --- |
| DNS-only DDNS plus TCP port mapping | `game.example.com:8469` or `ws://game.example.com:8469` | Client connects directly to the current origin address; router maps the TCP port to Nebula | Feasible when the origin is publicly reachable and not blocked by CGNAT, but still requires external E2E |
| HTTP/WebSocket reverse proxy or Cloudflare Tunnel | `wss://game.example.com:443` | TLS/WSS at the public hostname; HTTP WebSocket forwarding to Nebula `/socket` | Candidate only: stock 0.9.22 loses the hostname; the repository patch preserves it, but the exact built client still requires external Nebula E2E |
| Cloudflare Tunnel arbitrary TCP published application | Nebula connects to a client-local helper endpoint | Client-side `cloudflared` carries TCP to the published hostname | Requires an additional managed client component; it is not native hostname-to-Nebula connectivity |
| Cloudflare One private routing | Nebula connects through an enrolled client network | Cloudflare One Client routes the private hostname or address through Tunnel | Viable only for a managed client population; not a public, clientless join method |
| Cloudflare Spectrum for raw TCP | Product-specific hostname and port | Cloudflare Spectrum proxies Layer 4 traffic | Separate product and design; not implied by a normal Tunnel or proxied DNS record |

Do not mix evidence between rows. For example, a successful HTTPS dashboard
request does not prove the game WebSocket path, and an open TCP port does not
prove that Nebula owns the listener or that its application handshake succeeds.

## Candidate A: DNS-only DDNS and NAT port mapping

Use this pattern when the host has a publicly routable address that may change,
the operator controls the edge NAT device, and direct exposure is an accepted
risk.

The reusable flow is:

1. Run Nebula on a fixed internal host and fixed TCP port. In documentation, the
   host can be represented as `192.0.2.10:8469`; that address is not deployable.
2. Maintain an `A` or `AAAA` record such as `game.example.com` with a narrowly
   scoped DDNS updater. Keep the record DNS-only so it resolves to the origin
   rather than to a Cloudflare proxy address.
3. Configure one explicit TCP mapping from the chosen public port to the Nebula
   listener. Do not forward UDP merely because some games use it; Nebula's
   documented transport is TCP.
4. From a genuinely external network, verify DNS freshness, TCP reachability,
   listener ownership, WebSocket upgrade on `/socket`, and a full Nebula join.
5. Repeat the external check after a controlled DDNS address change or renewal
   event before relying on the update mechanism.

This pattern does not create a public address. If the WAN address is CGNAT or
otherwise not inbound-routable, DDNS merely publishes an unusable destination
and conventional port mapping cannot repair it. Obtain an inbound-routable
service from the ISP or choose a tunnel/overlay design.

DNS-only also exposes the origin address. Apply host and edge firewall policy,
rate limits where available, least-privilege DDNS credentials, monitoring, and
a rollback plan independently. Do not publish the updater token, router export,
WAN address, or scan output.

### Input syntax matters

For the stock 0.9.22 join parser, these are not equivalent:

- `game.example.com:443` defaults to plaintext `ws` on TCP 443.
- `ws://game.example.com:443` explicitly selects plaintext WebSocket.
- `wss://game.example.com:443` explicitly selects WebSocket over TLS.

Therefore, stock `game.example.com:443` must never be described as a verified
WSS endpoint merely because 443 is commonly used for HTTPS. Port number does
not change the stock parser's default protocol.

The repository's pinned two-file hostname-preserving source patch records in
the join parser whether `ws` or `wss` was explicitly supplied. It promotes only
a hostname route whose protocol was implicit `ws` and whose final port is 443.
The `Client` constructor receives that resolved protocol decision and preserves
the hostname authority; it does not infer TLS from the port itself. Thus bare
`game.example.com:443` becomes WSS, explicit `ws://game.example.com:443`
remains plaintext WS, explicit `wss://game.example.com:443` remains WSS, and
IP-literal/IPv6 endpoint construction keeps stock behavior. `RememberLastIP`
retains the hostname and effective protocol. Prefer the explicit WSS form in
operator instructions because it remains unambiguous across patched and stock
clients. This is a source contract, not evidence that any binary was built,
distributed, or connected.

## Candidate B: WSS through a Cloudflare HTTP published application

This is the no-public-inbound-port candidate. `cloudflared` makes outbound
connections to Cloudflare, while the public HTTP application accepts a
WebSocket upgrade.

A reusable intended route is:

```yaml
ingress:
  - hostname: game.example.com
    path: ^/socket$
    service: http://192.0.2.10:8469
  - service: http_status:404
```

The example address is reserved for documentation and must be replaced only in
private deployment configuration. The intended public client input is
`wss://game.example.com:443`; Nebula then requests `/socket`. TLS terminates at
the public HTTP edge while `cloudflared` forwards the HTTP WebSocket connection
to the plain WebSocket origin.

Cloudflare's documented WebSocket and path-routing support proves that this
architecture is representable. It does **not** qualify the current Nebula
client. In the pinned source, a hostname input is resolved to the first IP
address and the final socket URI is built as
`wss://192.0.2.10:443/socket` (using an RFC 5737 address here only to illustrate
the IP-literal shape). That can remove the hostname required for certificate
matching, SNI, and public-hostname routing.

Treat the WSS route as blocked for production until one of these outcomes is
independently demonstrated:

- the exact distributed Nebula client preserves the original hostname through
  TLS and the WebSocket `Host` header, contrary to or later than the pinned
  source behavior;
- the repository's exact commit/hash-bound GPL patch is privately built from the
  pinned source, its source-only candidate verifies, and that exact binary passes
  external E2E; or
- a separately managed local connector provides a qualified endpoint to the
  client without weakening TLS verification.

A WebSocket tool that receives `101 Switching Protocols` using the correct
hostname is useful edge-to-origin evidence, but it does not exercise Nebula's
hostname parsing or its binary application handshake. It cannot close the
client compatibility gate by itself.

## Why Tunnel TCP is not a drop-in substitute

Cloudflare's arbitrary-TCP published-application mode is not a transparent raw
TCP listener for an unmodified public client. Official documentation requires
the end user to run `cloudflared access tcp`; that helper opens a local endpoint
to which the actual application connects. Long-lived connections have
additional product guidance and should be evaluated for the intended session
duration.

This can be a candidate for a managed group where every player receives a
pinned helper, authentication procedure, update policy, health check, and
support plan. It is not a reusable public join address for stock Nebula and must
not be documented as one. Likewise, a normal proxied DNS record is an HTTP proxy
feature, not proof of arbitrary raw TCP support; Cloudflare Spectrum is a
separate Layer 4 option.

## Keep management and game data planes separate

The management plane and game data plane have different protocols, clients,
authentication, exposure, and failure modes:

| Plane | Typical route | Required evidence |
| --- | --- | --- |
| Management | `https://control.example.com/` | Browser/API authentication, authorization, loopback or private origin binding, CSRF/session policy, and independent readiness |
| Game data | `wss://game.example.com:443/socket` or direct `ws` on an explicit port | TCP listener identity, WebSocket upgrade, Nebula authentication/handshake, sustained bidirectional game traffic, and reconnect behavior |

Separate hostnames and origins are preferred. They make access policy, logs,
rate limits, health checks, rollback, and incident isolation explicit. Do not
expose a control API merely because a game socket must be reachable, and do not
use a successful dashboard response as game readiness.

Cloudflare Tunnel can match both hostname and path, so a same-hostname layout is
technically representable: route the exact `/socket` path to Nebula, route the
management paths to a different origin, and finish with a fail-closed catch-all.
That layout remains higher risk and requires all of the following:

- exact, non-overlapping path rules with WebSocket upgrade headers preserved;
- independent authentication and authorization for management routes;
- no interactive Cloudflare Access challenge on the game path unless the exact
  Nebula client is proven able to satisfy it;
- separate readiness and rollback checks for both origins;
- log redaction so credentials, player identifiers, addresses, and tokens are
  not copied into release evidence; and
- external tests showing that management routing cannot capture `/socket` and
  the game route cannot reach management actions.

Even when the same hostname is used, it is still two security planes. The
source patch addresses the stock client's hostname loss and the narrow implicit
hostname-on-443 protocol decision only; it does not prove
the route order, certificate, origin, authentication, Nebula handshake, or
management/game separation.

## PassWall or policy-routing evidence

Do not add a bypass rule merely because a connection failed. First establish
whether DNS, TCP, TLS, HTTP routing, WebSocket upgrade, or the Nebula handshake
is the failing layer. A domain rule cannot repair a stale or incorrect DNS
answer, and a TCP connection only proves transport reachability.

Before and after any separately authorized route change, retain a redacted
evidence record with these fields:

- test timestamp, client network class, exact client and Nebula versions;
- intended topology (`dns_only_direct`, `http_websocket_tunnel`,
  `client_side_tcp_helper`, or `private_overlay`);
- opaque hostname inventory ID (never the queried hostname value), record types,
  resolver identity class, TTL, answer count, and answer classification
  (`origin`, `cloud_edge`, `private`, `documentation`, `unexpected`, or `none`),
  with production addresses redacted;
- requested protocol, opaque hostname inventory ID, port, and path class;
- active policy rule identifier, rule order, matched domain set, outbound
  identity, and rendered-config hash;
- actual matched transport (`tcp`) and the redacted destination tuple after
  resolution;
- rule counter or log delta tied to the test interval;
- client process identity and, on the host, listener PID plus executable
  identity;
- TCP outcome (`connected`, `refused`, `timeout`, or `unreachable`);
- TLS outcome (`not_applicable`, `trusted_hostname`, `name_mismatch`,
  `untrusted_chain`, or `handshake_failed`);
- HTTP/WebSocket outcome (`101`, `authentication_required`, `wrong_route`,
  `redirected`, `non_upgrade_response`, or `not_reached`); and
- Nebula outcome (`lobby_joined`, `application_handshake_failed`,
  `disconnected_after_join`, or `not_reached`).

For a DNS-only direct endpoint, the expected answer class is `origin`. For a
Cloudflare HTTP published application, it is `cloud_edge`. Do not pin a bypass
to a transient edge IP list when the policy engine can match the intended
hostname safely. Validate the active rendered policy and a real counter/log hit;
the presence of an editable rule alone is not evidence that the client used it.

## Qualification protocol handoff

The repository-only [production qualification runbook](PRODUCTION-QUALIFICATION.md)
maps this guide to the fixed `game-protocol-path` and `external-client-e2e`
steps. A redacted `DYSON_NEBULA_NETWORK_ASSESSMENT_V1` result may support the
first step only when its private source evidence is independently verified and
digest-bound to the exact qualification run. DNS resolution, TCP reachability,
or a WebSocket `101` never substitutes for the second step's two-party challenge,
server-authoritative join/interaction/save/disconnect observations, and fresh
reconnect challenge.

`npm run qualification:selftest` validates those receipt order, challenge,
timing, privacy, pause/resume, and tamper rules using a marked temporary Shadow
fixture. It makes zero real network calls and leaves `PRD-003` and `PRD-004`
`not-started`. Protocol v1 has no production adapter, does not authorize a DNS,
router, firewall, PassWall, tunnel, or process change, and never stores target
values or network addresses in its public projection.

`DYSON_NEBULA_NETWORK_ASSESSMENT_V2` adds a separate, fail-closed handoff for
the hostname-preserving WSS candidate. It never accepts a caller assertion that
the route is verified. Instead, its fixed same-tree verifier revalidates the
protected qualification material, the two independently harvested builds, the
four distinct collector signatures, the external-client transcript, and the
replay ledger. The only data crossing back into the network assessment is this
exact six-field redacted projection:

```text
qualificationId
runId
bindingSha256
expiresAtUtc
decision
blockerCodes
```

Here `bindingSha256` is exactly the verified qualification document's
`documentSha256`. Preview returns `preview-valid` plus
`DYSON_HOSTNAME_WSS_QUALIFICATION_NOT_CONSUMED`; it cannot establish a usable
client contract. Only an explicit consume operation whose verifier exits
successfully with `decision=qualified`, an empty blocker list, and matching
qualification ID, hostname authority, port `443`, run ID, binding digest, and
expiry can derive `hostname-preserved`, `wss`, `/socket`, and
`http-websocket-tunnel` semantics. The assessment then independently requires a
single `DSPGAME` listener owner, a public first DNS answer, TCP reachability, a
trusted hostname certificate, and a valid WebSocket upgrade. PassWall bypass is
derived from the protected receipt chain; raw caller-supplied route labels are
not accepted.

`npm run network:v2-selftest` exercises qualified, preview, stock, tamper,
expiry, wrong-ID, replay-conflict, non-public DNS, missing-listener, privacy,
and fixed-verifier boundary cases with local fixtures. The implementation has
no network-mutation path. A passing self-test still leaves `PRD-003` and
`PRD-004` `not-started` until the protected production qualification and real
external join have been completed and independently accepted.

## External-client E2E acceptance checklist

Run this checklist from a network that does not share the host's LAN, NAT, DNS
cache, or policy router. Record only redacted, schema-bounded evidence.

### 1. Freeze the candidate

- Record the exact host and client Nebula versions and the source/release
  correspondence used to justify their address semantics.
- Choose exactly one topology from the connectivity table. Record whether an
  additional client helper is part of that topology.
- Record the intended public protocol, hostname class, port, and `/socket` path.
- Confirm that management and game routes, origins, and authentication policies
  are separately defined.

### 2. Prove host ownership

- Confirm that the intended TCP port is listening on the intended interface.
- Map the listener to one PID and executable identity. A port-open result without
  process identity fails this step.
- Confirm that an unrelated dashboard, reverse proxy, stale server, or test
  process does not own the port.
- Confirm that lifecycle actions remain disabled unless a separate, exact
  authorization is supplied; connectivity acceptance is read-only.

### 3. Prove DNS classification

- Query through the client's normal resolver and an independent public resolver.
- Record answer type, count, TTL, and classification without publishing the
  addresses.
- For DNS-only DDNS, verify that the result tracks the current inbound-routable
  WAN address and that the ISP is not imposing CGNAT.
- For a Cloudflare HTTP route, verify that the result is a Cloudflare edge
  classification rather than the origin.
- Wait out documented caches or TTLs after a planned record update; do not treat
  one resolver's old answer as current state.

### 4. Prove each protocol layer

- From the external client, classify TCP as connected, refused, timed out, or
  unreachable.
- For WSS, require a trusted certificate for the requested hostname and retain
  evidence that SNI and the HTTP `Host` value are the hostname, not a resolved IP
  literal.
- Send a WebSocket upgrade to `/socket` and classify the response. Redirects,
  dashboard HTML, access-login HTML, generic `200`, `404`, `502`, or `525` are
  not successful upgrades.
- Treat `101 Switching Protocols` as WebSocket evidence only. Continue to the
  Nebula application check.

### 5. Prove Nebula end to end

- Join with the exact production-candidate Nebula client input, not only a
  generic WebSocket tool.
- Require the lobby to load and the server to record the expected authenticated
  session without logging credentials or player data.
- Exercise bidirectional game traffic appropriate to a disposable acceptance
  world and observe it from both host and client.
- Keep the session active for an operator-defined acceptance interval that
  covers expected idle and active periods.
- Disconnect and reconnect once. Confirm that no stale session, wrong origin, or
  alternate listener accepted the second connection.
- Test from a second external network path if the endpoint will serve diverse
  client networks.

### 6. Prove separation and rollback

- Verify the management route independently with authorized and unauthorized
  requests. Do not place credentials in captured output.
- Verify that `/socket` cannot reach management actions and management path
  routing cannot consume the game upgrade.
- Verify that disabling the candidate route restores the documented prior
  state without stopping unrelated services. This is a planned rollback test,
  not authorization to perform it in production.
- Archive only the redacted decision record, test classifications, exact
  versions, and hashes. Keep raw logs, addresses, tunnel exports, credentials,
  and player data outside public artifacts.

## Failure classification

Use the earliest failed layer as the primary diagnosis:

| Earliest failed layer | Examples | Do not conclude |
| --- | --- | --- |
| DNS | no answer, stale DDNS answer, unexpected answer class | that a port or Nebula process is broken |
| TCP | refused, timeout, unreachable | that TLS, WebSocket, or Nebula authentication was attempted |
| TLS | certificate name mismatch, missing SNI, untrusted chain | that Cloudflare lacks WebSocket support |
| HTTP routing | dashboard HTML, redirect, access challenge, wrong status | that `/socket` reached Nebula |
| WebSocket | no valid `101` upgrade | that the binary application protocol was exchanged |
| Nebula | lobby/authentication/packet handshake failure after upgrade | that TCP or the proxy is generally unavailable |
| Persistence | initial join works but idle, active, or reconnect test fails | that the route is production-ready |

## Outstanding production decisions

The following choices require current, environment-specific evidence and are
deliberately unresolved here:

- whether the WAN is inbound-routable or behind CGNAT;
- whether direct origin exposure from DNS-only DDNS is acceptable;
- the exact public TCP port and independently authorized NAT/firewall policy;
- whether the distributed Nebula client still exhibits the pinned
  hostname-to-IP behavior;
- whether Nebula will be changed to retain the hostname for WSS/SNI, or whether
  a managed local connector will be required;
- whether the game and management planes use separate hostnames or reviewed
  same-hostname path routing;
- whether Cloudflare Access, WAF, proxy timeouts, and reconnect behavior are
  compatible with the exact game client and expected session duration; and
- whether PassWall needs a direct rule at all, and, if so, which rendered rule
  and observed client path prove it.

Until these decisions and the external E2E checklist are closed, describe the
network as a candidate design, not as a reachable or production-ready service.

## Official references

- [Nebula README: direct connections use TCP and default port 8469](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/README.md#L24-L28)
- [Nebula hosting and joining guide at the reviewed wiki commit](https://github.com/NebulaModTeam/nebula/wiki/Hosting-and-Joining/fb6bbaf77ae112b1b82eb03562043e96ab774dcc#network-connectivity-solutions)
- [Nebula join parser: default `ws`, explicit `ws`/`wss`, and port parsing](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaPatcher/Patches/Dynamic/UIMainMenu_Patch.cs#L312-L390)
- [Nebula client: hostname resolution and final `/socket` URI](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaNetwork/Client.cs#L53-L88)
- [Nebula host WebSocket listener, `/socket`, and forwarded-request behavior](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/NebulaNetwork/Server.cs#L217-L240)
- [Nebula changelog: explicit WSS input support](https://github.com/NebulaModTeam/nebula/blob/3cdf95c594a2f8010b0e87a43be828e6ba2f657f/CHANGELOG.md#L59-L67)
- [Cloudflare WebSocket support, official docs source](https://github.com/cloudflare/cloudflare-docs/blob/fe4f2c8bd23c2d0f174505d7f2a1c21569331ad2/src/content/docs/network/websockets.mdx)
- [Cloudflare Tunnel WebSocket support, official FAQ source](https://github.com/cloudflare/cloudflare-docs/blob/fe4f2c8bd23c2d0f174505d7f2a1c21569331ad2/src/content/docs/cloudflare-one/faq/cloudflare-tunnels-faq.mdx)
- [Cloudflare Tunnel published applications, official docs source](https://github.com/cloudflare/cloudflare-docs/blob/fe4f2c8bd23c2d0f174505d7f2a1c21569331ad2/src/content/docs/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/index.mdx)
- [Cloudflare Tunnel ingress hostname/path matching, official docs source](https://github.com/cloudflare/cloudflare-docs/blob/fe4f2c8bd23c2d0f174505d7f2a1c21569331ad2/src/content/docs/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file.mdx)
- [Cloudflare protocols for published applications, official docs source](https://github.com/cloudflare/cloudflare-docs/blob/fe4f2c8bd23c2d0f174505d7f2a1c21569331ad2/src/content/docs/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols.mdx)
- [Cloudflare client-side arbitrary TCP access, official docs source](https://github.com/cloudflare/cloudflare-docs/blob/fe4f2c8bd23c2d0f174505d7f2a1c21569331ad2/src/content/docs/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/arbitrary-tcp.mdx)
- [Cloudflare DNS proxy status and DNS-only behavior, official docs source](https://github.com/cloudflare/cloudflare-docs/blob/fe4f2c8bd23c2d0f174505d7f2a1c21569331ad2/src/content/docs/dns/proxy-status/index.mdx)
- [Cloudflare guidance for dynamic DNS records, official docs source](https://github.com/cloudflare/cloudflare-docs/blob/fe4f2c8bd23c2d0f174505d7f2a1c21569331ad2/src/content/docs/dns/manage-dns-records/how-to/managing-dynamic-ip-addresses.mdx)
- [Cloudflare Spectrum overview, official docs source](https://github.com/cloudflare/cloudflare-docs/blob/fe4f2c8bd23c2d0f174505d7f2a1c21569331ad2/src/content/docs/spectrum/index.mdx)
- RFC 5737, *IPv4 Address Blocks Reserved for Documentation*.
