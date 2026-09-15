# Stopped save proof contract

Implementation design for update audit U08; finalization wiring and acceptance
remain pending. `DysonStoppedSaveCapture.ps1` implements the read-only fixed-pair
primitive: simultaneous read handles, handle-resolved path checks, single-link
file identities, hashing and post-read identity checks. A native Windows fixture
verified normal hashes and hard-link rejection. This primitive alone neither
proves stopped state nor grants update authority.

Development wiring now captures the pair after validating the completed stop
intent and embeds optional `finalSaveProof` in the runtime receipt. Its intent
digest, capture time and pair hashes participate in the public receipt digest.
The bootstrap state lock is retained through receipt publication. Evidence
capture failure leaves an auditable legacy-shaped receipt rather than causing
an intentional stop to restart. The API reader passes 23 receipt tests; a native
synthetic writer fixture passed on the VM. Real finalization, API writer/reader
roundtrip, packaging/bootstrap file-copy allowlists and update-baseline
consumption still require verification before deployment. Baseline consumption
now requires the final pair proof, rejects legacy receipts for authorization,
and compares the final hashes to the independently inspected stopped pair. The
real post-start loaded proof remains unchanged. Thirty reader/provider tests
pass locally and on the target VM. Installation and package required-file lists
now include the capture helper; installer acceptance remains pending.

The complete bootstrap self-test passed on the target VM after adding the helper
to its copied bootstrap fixture and asserting both final file hashes in a clean
stop receipt. This includes real child-process stop/start, interrupted expected-
exit recovery, serialized concurrent start/stop and preservation of unrelated
processes. It uses a fictional game executable and does not touch the production
scheduler; an actual DSP save/stop roundtrip is still a separate acceptance gate.

## Authorities

The bootstrap start supervisor currently waits for the release process to exit,
validates a matching completed expected-exit intent, finalizes the binding, and
writes a clean runtime receipt. A clean process exit alone is insufficient:
the completed intent and matching binding are required by the existing path.

Extend this controlled finalization boundary to capture the fixed paired save.
Do not create an API endpoint that signs arbitrary paths or caller-supplied
hashes. Do not manufacture a proof from an old clean-exit receipt after the fact.
The existing Bridge loaded-origin proof retains its meaning: bytes actually
loaded in a particular generation, not bytes saved later in that generation.

## Required record bindings

The final-save record must bind a versioned protocol, runtime attempt and binding
UUIDs, project/data identities, completed stop intent identity, runtime generation,
fixed save slot, both file sizes and SHA-256 values, and capture/completion times.
Its exact durable identity must be linked from the corresponding clean-exit
receipt, rather than selected by directory ordering alone. Store it through the
same protected/canonical authority boundary as runtime finalization receipts.
No raw file path, game password, player data or secret belongs in the public
projection. A digest is not a signature; do not describe ACL-protected records
as cryptographically signed unless an actual signing protocol is implemented.

## Finalization ordering

1. Validate the current completed stop intent and runtime binding under the
   bootstrap state lock. Independently establish process exit and closed port.
2. Read the fixed pair through normal-file checks, reject redirects/hard links
   according to the existing save authority contract, and hash both files.
   Recheck size, timestamps and file identity after hashing; reject change.
3. Atomically publish the final-save evidence and then its linked clean-exit
   receipt. Maintain the binding/lock ordering needed to prevent a new start
   from overlapping capture. Never expose a linked receipt before its proof.
4. Missing files, concurrent mutation, incomplete intent or publication failure
   leave update qualification unavailable. An intentional stopped game must not
   be restarted merely because evidence publication failed.
5. Preserve partial/failure evidence for recovery. An interrupted publication
   must be classified and verified, never repaired by inventing hashes.

## Update consumption

Baseline capture obtains a fresh stopped proof, loads the newest applicable
runtime receipt and its exact final-save record, validates all binding/timing
fields, and independently hashes the current pair. All identities must agree.
Bracket the read with another fresh stopped observation and active lease checks.
The backup created for the transaction must reproduce the same pair identity.

Keep old runtime receipts readable for audit. They cannot authorize this new
baseline path when the final-save record is absent. Do not silently substitute
the old Bridge loaded identity or a fresh directory scan for missing authority.

After candidate or rollback startup, require the existing signed Bridge session,
heartbeat and actual loaded-origin record to prove that the exact protected pair
was loaded in the current generation. That comparison is between the final-save
baseline and a new actual-load proof, not between two claims about the old load.

## Tests before batch deployment

- Save changes the pair, completed stop binds it, backup matches, and subsequent
  startup proves that exact pair using a new loaded generation.
- Old loaded bytes, wrong slot, mismatched stop intent, newer failed runtime
  attempt, stale generation, future times and replaced files are rejected.
- Exit between each publication boundary is recoverable or explicitly blocked;
  no partial proof becomes a success and no unintended restart occurs.
- Legacy receipts remain auditable but cannot unlock update execution.
- The real VM finalization writer and API reader agree on bytes and digest;
  fixture-only tests are not native acceptance.
