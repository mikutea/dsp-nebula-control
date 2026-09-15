# Public release hygiene gate

`check.mjs` produces deterministic JSON evidence for a public repository or
release candidate. It never prints matched content or the host filesystem root.
Findings contain only a rule ID and, when available, a repository/artifact
relative path or Git blob ID.

The default scan covers every tracked file plus every untracked, nonignored
file in the current worktree. The repository command also enables the optional
reachable-history scan:

```text
npm run public-release:check
```

A dirty worktree is scanned for useful findings but cannot pass release
provenance: the evidence includes `REPOSITORY_DIRTY` until tracked and
nonignored candidates correspond to a clean commit/tree.

To verify an already generated directory-form control-plane artifact against
its `artifact-manifest.json` and scan its paths, contents, image metadata, and
binary strings:

```text
node scripts/public-release/check.mjs --history --artifact <artifact-directory>
```

`--evidence <new-file>` writes the same JSON emitted on stdout using exclusive
creation. The evidence contains the current commit and tree IDs, dirty state,
requested/completed scopes, bounded counts, policy identity/hash, and findings.

The scanner permits `example.com`, RFC 5737 TEST-NET addresses, loopback, and
explicitly fictional/test placeholders. Rule suppressions live in
`policy.mjs`; each one is an exact `scope + ruleId + path` tuple. A reviewed
historical exception may additionally require one exact Git blob ID, so a
future blob at the same path is scanned again. Globs and prefix suppressions
are intentionally unsupported.

Blob-scoped metadata exceptions cover previously published OpenAI/Trufo C2PA
provenance for the accepted concept images. Additional blob-scoped exceptions
cover only the exact reviewed source/test blobs that implement or exercise the
scanner's own credential, Steam-ID, and UNC-path detectors. Their contents were
reviewed as fictional fixtures or detector expressions before the exceptions
were added. The exceptions do not apply to any future blob at the same path.
Current worktree images remain metadata-free.

The automated image check validates common containers and rejects embedded
PNG/JPEG/WebP/SVG metadata. It cannot determine whether compressed pixels show
a real person, QR code, player name, or endpoint, so exact image review remains
a separate release requirement. Reachable refs outside the local clone, forks,
hosting-provider caches, and previously published release assets are likewise
outside this local gate and require independent platform-side verification.
