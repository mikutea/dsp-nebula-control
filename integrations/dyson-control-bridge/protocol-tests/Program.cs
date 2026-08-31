using System;
using System.IO;
using System.Text;

namespace DysonControl.Bridge
{
    internal static class Program
    {
        private const string Secret = "fictional-cross-runtime-secret-0123456789";
        private const string RequestPayload =
            "protocol=DYSON_CONTROL_REQUEST_V1\n" +
            "requestId=11111111-2222-4333-8444-555555555555\n" +
            "createdAtUnixMs=1788081000000\n" +
            "expiresAtUnixMs=1788081015000\n" +
            "action=save\n" +
            "nonce=ABCDEFGHIJKLMNOPQRSTUV\n" +
            "hmac=b1259d0dfd035395c0e797d91d1e76fda3531c264c391d4bdc0fb3aa3d43d54a\n";

        private const string ReceiptPayload =
            "protocol=DYSON_CONTROL_RECEIPT_V2\n" +
            "requestId=11111111-2222-4333-8444-555555555555\n" +
            "action=save\n" +
            "state=succeeded\n" +
            "startedAtUnixMs=1788081001000\n" +
            "finishedAtUnixMs=1788081003500\n" +
            "saveName=_lastexit_\n" +
            "saveTimeBefore=1788080000\n" +
            "saveTimeAfter=1788081003\n" +
            "dsvBytes=5242880\n" +
            "dsvWriteTimeUtcTicks=638817408010000001\n" +
            "serverBytes=22016\n" +
            "serverWriteTimeUtcTicks=638817408010000777\n" +
            "dsvChanged=true\n" +
            "serverChanged=true\n" +
            "errorCode=NONE\n" +
            "hmac=614136ceb2a204b2b9e25b969b33bf931e89f7d792e06f15bbcf9208f6be8da4\n";

        private const string GenerationId =
            "generation-v1:25776f27535c4eb66e45c074cfaa700ed15bce62281f65220483a5659f8d5e8d";

        private const string OneFileMissingReceiptPayload =
            "protocol=DYSON_CONTROL_RECEIPT_V2\n" +
            "requestId=22222222-3333-4444-8555-666666666666\n" +
            "action=save\n" +
            "state=failed\n" +
            "startedAtUnixMs=1788081004000\n" +
            "finishedAtUnixMs=1788081005000\n" +
            "saveName=_lastexit_\n" +
            "saveTimeBefore=1788081003\n" +
            "saveTimeAfter=1788081004\n" +
            "dsvBytes=-1\n" +
            "dsvWriteTimeUtcTicks=-1\n" +
            "serverBytes=22032\n" +
            "serverWriteTimeUtcTicks=638817408020000777\n" +
            "dsvChanged=true\n" +
            "serverChanged=true\n" +
            "errorCode=SAVE_PAIR_MISSING\n" +
            "hmac=3eeda6e09a8b4fa36e480ce4b246bf8f17875e979934acb3ce205ecee4daa5ac\n";

        private const string BothFilesMissingReceiptPayload =
            "protocol=DYSON_CONTROL_RECEIPT_V2\n" +
            "requestId=33333333-4444-4555-8666-777777777777\n" +
            "action=save\n" +
            "state=failed\n" +
            "startedAtUnixMs=1788081006000\n" +
            "finishedAtUnixMs=1788081007000\n" +
            "saveName=_lastexit_\n" +
            "saveTimeBefore=1788081003\n" +
            "saveTimeAfter=1788081004\n" +
            "dsvBytes=-1\n" +
            "dsvWriteTimeUtcTicks=-1\n" +
            "serverBytes=-1\n" +
            "serverWriteTimeUtcTicks=-1\n" +
            "dsvChanged=true\n" +
            "serverChanged=true\n" +
            "errorCode=SAVE_PAIR_MISSING\n" +
            "hmac=64413d6d559dc5b987d775ca988802eff61c8526443f4842cd62c8f8720464cb\n";

        private const string HeartbeatPayload =
            "protocol=DYSON_CONTROL_HEARTBEAT_V1\n" +
            "pluginVersion=0.1.0\n" +
            "processId=4242\n" +
            "startedAtUnixMs=1788080000000\n" +
            "writtenAtUnixMs=1788081004000\n" +
            "state=ready\n" +
            "hmac=272dea72a7446db521b006f22718777f0cb4443a05022a76d4fffe2c1a06f6f2\n";

        private const string PlayersPayload =
            "protocol=DYSON_CONTROL_PLAYERS_V1\n" +
            "sessionId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n" +
            "writtenAtUnixMs=1788081004000\n" +
            "sequence=7\n" +
            "state=active\n" +
            "truncated=false\n" +
            "playerCount=2\n" +
            "playersJsonB64=W3sic2Vzc2lvblBsYXllcklkIjoicGxheWVyLTAwMDAwMSIsImRpc3BsYXlOYW1lIjoiTm92YSIsIm9ubGluZSI6dHJ1ZSwiam9pbmVkQXRVbml4TXMiOjE3ODgwODEwMDEwMDAsImxvY2F0aW9uIjoicGxhbmV0OjEwMSJ9LHsic2Vzc2lvblBsYXllcklkIjoicGxheWVyLTAwMDAwMiIsImRpc3BsYXlOYW1lIjoi5pif5rW3Iiwib25saW5lIjp0cnVlLCJqb2luZWRBdFVuaXhNcyI6MTc4ODA4MTAwMjAwMCwibG9jYXRpb24iOiJzdGFyOjIifV0\n" +
            "hmac=bce756c9eb27bfd2784ae2277881872ef1ad5a711d5e9bf5972c559eeb3cd92e\n";

        private const string PlayerCapabilitiesPayload =
            "protocol=DYSON_CONTROL_PLAYER_CAPABILITIES_V1\n" +
            "verifiedUpstreamRepository=NebulaModTeam/nebula\n" +
            "verifiedUpstreamTag=v0.9.22\n" +
            "verifiedRuntimeFileVersion=0.9.22.2\n" +
            "verifiedUpstreamCommit=3cdf95c594a2f8010b0e87a43be828e6ba2f657f\n" +
            "verificationScope=source-contract-only-runtime-unverified\n" +
            "sessionId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n" +
            "writtenAtUnixMs=1788081004000\n" +
            "actionsEnabled=false\n" +
            "capabilitiesJsonB64=W3siY2FwYWJpbGl0eSI6Im9ic2VydmUtcm9zdGVyIiwiYXZhaWxhYmlsaXR5IjoiYXZhaWxhYmxlIiwibW9kZSI6InJlYWQtb25seSIsInZlcmlmaWVkUmVhc29uQ29kZSI6IlVQU1RSRUFNX1JPU1RFUl9BUElfVkVSSUZJRUQifSx7ImNhcGFiaWxpdHkiOiJkaXNjb25uZWN0IiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9DT05ORUNURURfRElTQ09OTkVDVF9VTlNBRkUifSx7ImNhcGFiaWxpdHkiOiJraWNrIiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9LSUNLX0FQSV9BQlNFTlQifSx7ImNhcGFiaWxpdHkiOiJiYW4iLCJhdmFpbGFiaWxpdHkiOiJ1bmF2YWlsYWJsZSIsIm1vZGUiOiJtdXRhdGlvbiIsInZlcmlmaWVkUmVhc29uQ29kZSI6IlVQU1RSRUFNX0JBTl9BUElfQUJTRU5UIn0seyJjYXBhYmlsaXR5Ijoid2hpdGVsaXN0IiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9XSElURUxJU1RfQVBJX0FCU0VOVCJ9LHsiY2FwYWJpbGl0eSI6InBlcm1pc3Npb24iLCJhdmFpbGFiaWxpdHkiOiJ1bmF2YWlsYWJsZSIsIm1vZGUiOiJtdXRhdGlvbiIsInZlcmlmaWVkUmVhc29uQ29kZSI6IlVQU1RSRUFNX1BFUk1JU1NJT05fQVBJX0FCU0VOVCJ9XQ\n" +
            "hmac=82d46a96e4402498c183a9dd7ccd281f4e4e1ae20999f33c44d243e846ea5cd0\n";

        private static int Main()
        {
            Assert(BridgeProtocol.TryValidateSecret(Secret, out var normalized) && normalized == Secret,
                "secret validation");
            Assert(BridgeProtocol.TryParseRequest(RequestPayload, Secret, out var request, out var requestError),
                "request parse: " + requestError);
            Assert(request.RequestId == "11111111-2222-4333-8444-555555555555", "request ID");
            Assert(request.CreatedAtUnixMs == 1788081000000, "request created time");
            Assert(request.ExpiresAtUnixMs == 1788081015000, "request expiry");

            var receiptEvidence = new BridgeReceipt
            {
                RequestId = request.RequestId,
                State = "succeeded",
                StartedAtUnixMs = 1788081001000,
                FinishedAtUnixMs = 1788081003500,
                SaveName = BridgeProtocol.LastExitSaveName,
                SaveTimeBefore = 1788080000,
                SaveTimeAfter = 1788081003,
                DsvBytes = 5242880,
                DsvWriteTimeUtcTicks = 638817408010000001,
                ServerBytes = 22016,
                ServerWriteTimeUtcTicks = 638817408010000777,
                DsvChanged = true,
                ServerChanged = true,
                ErrorCode = "NONE"
            };
            var receipt = BridgeProtocol.SerializeReceipt(receiptEvidence, Secret);
            Assert(receipt == ReceiptPayload, "receipt serialization");
            Assert(BridgeProtocol.ComputeSaveGenerationId(receiptEvidence) == GenerationId,
                "generation-v1 canonical identity");
            receiptEvidence.RequestId = "99999999-8888-4777-8666-555555555555";
            Assert(BridgeProtocol.ComputeSaveGenerationId(receiptEvidence) == GenerationId,
                "generation identity excludes request ID");
            receiptEvidence.RequestId = request.RequestId;
            receiptEvidence.ServerChanged = false;
            AssertThrows(() => BridgeProtocol.SerializeReceipt(receiptEvidence, Secret),
                "one-sided save generation rejection");
            receiptEvidence.ServerChanged = true;
            TestImmediateTupleStability();
            TestMonotonicElapsedWindows();
            TestReceiptSaveSlotSemantics(receiptEvidence);
            TestFailedMissingPairVectors();

            var heartbeat = BridgeProtocol.SerializeHeartbeat(new BridgeHeartbeat
            {
                PluginVersion = "0.1.0",
                ProcessId = 4242,
                StartedAtUnixMs = 1788080000000,
                WrittenAtUnixMs = 1788081004000
            }, Secret);
            Assert(heartbeat == HeartbeatPayload, "heartbeat serialization");

            var players = BridgeProtocol.SerializePlayerSnapshot(new BridgePlayerSnapshot
            {
                SessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                WrittenAtUnixMs = 1788081004000,
                Sequence = 7,
                State = "active",
                Truncated = false,
                Players = new[]
                {
                    new BridgePlayerEntry
                    {
                        SessionPlayerId = "player-000002",
                        DisplayName = "星海",
                        Online = true,
                        JoinedAtUnixMs = 1788081002000,
                        Location = "star:2"
                    },
                    new BridgePlayerEntry
                    {
                        SessionPlayerId = "player-000001",
                        DisplayName = "Nova",
                        Online = true,
                        JoinedAtUnixMs = 1788081001000,
                        Location = "planet:101"
                    }
                }
            }, Secret);
            Assert(players == PlayersPayload, "player snapshot serialization");

            var playerCapabilities = BridgeProtocol.SerializePlayerCapabilities(new BridgePlayerCapabilitySnapshot
            {
                SessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                WrittenAtUnixMs = 1788081004000
            }, Secret);
            Assert(playerCapabilities == PlayerCapabilitiesPayload, "player capability serialization");
            Assert(playerCapabilities.Contains("actionsEnabled=false\n"),
                "player mutations remain disabled");
            TestAtomicPlayerFiles(players, playerCapabilities);

            var tampered = RequestPayload.Replace("hmac=b", "hmac=0");
            Assert(!BridgeProtocol.TryParseRequest(tampered, Secret, out _, out var tamperError) &&
                   tamperError == "INVALID_SIGNATURE", "tamper rejection");
            Assert(!BridgeProtocol.TryParseRequest(RequestPayload + "extra=value\n", Secret, out _, out _),
                "extra-field rejection");
            TestStrictWireGrammar();
            TestBridgeFileStoreStrictUtf8();

            Console.WriteLine("Dyson Control Bridge request V1 / receipt V2 self-test passed.");
            return 0;
        }

        private static void TestImmediateTupleStability()
        {
            var before = new SaveObservation
            {
                PairPresent = true,
                SaveTime = 1000,
                DsvBytes = 100,
                DsvWriteTimeUtcTicks = 638817408000000001,
                ServerBytes = 50,
                ServerWriteTimeUtcTicks = 638817408000000002
            };
            var oneSided = new SaveObservation
            {
                PairPresent = true,
                SaveTime = 1001,
                DsvBytes = 101,
                DsvWriteTimeUtcTicks = 638817408010000001,
                ServerBytes = 50,
                ServerWriteTimeUtcTicks = 638817408000000002
            };
            AssertArgumentThrows(() => new SaveObservationStabilityTracker(before, oneSided, 10000),
                "immediate one-sided generation rejected");

            var targetA = new SaveObservation
            {
                PairPresent = true,
                SaveTime = 1001,
                DsvBytes = 101,
                DsvWriteTimeUtcTicks = 638817408010000001,
                ServerBytes = 51,
                ServerWriteTimeUtcTicks = 638817408010000002
            };
            var capturedAt = BridgeMonotonicTime.DurationTicks(1000);
            var stabilityTicks = BridgeMonotonicTime.DurationTicks(500);
            var tracker = new SaveObservationStabilityTracker(before, targetA, capturedAt);
            Assert(!tracker.Observe(targetA, capturedAt + stabilityTicks - 1, stabilityTicks),
                "immutable target stability window not elapsed");
            Assert(tracker.Observe(targetA, capturedAt + stabilityTicks, stabilityTicks) &&
                   tracker.DsvChanged && tracker.ServerChanged && !tracker.IsUnstable,
                "immutable target accepted after monotonic stability window");

            var targetB = new SaveObservation
            {
                PairPresent = true,
                SaveTime = 1001,
                DsvBytes = 101,
                DsvWriteTimeUtcTicks = 638817408010000003,
                ServerBytes = 51,
                ServerWriteTimeUtcTicks = 638817408010000002
            };
            var driftToB = new SaveObservationStabilityTracker(before, targetA, capturedAt);
            Assert(!driftToB.Observe(targetB, capturedAt + 1, stabilityTicks) && driftToB.IsUnstable,
                "A-to-B drift permanently latches unstable");
            Assert(!driftToB.Observe(targetB, capturedAt + stabilityTicks * 3, stabilityTicks),
                "A-to-B stable candidate cannot replace immediate target");

            var driftBackToA = new SaveObservationStabilityTracker(before, targetA, capturedAt);
            Assert(!driftBackToA.Observe(targetB, capturedAt + 1, stabilityTicks) &&
                   !driftBackToA.Observe(targetA, capturedAt + stabilityTicks * 3, stabilityTicks) &&
                   driftBackToA.IsUnstable,
                "A-to-B-to-A cannot recover after target drift");

            var clockRegression = new SaveObservationStabilityTracker(before, targetA, capturedAt);
            Assert(!clockRegression.Observe(targetA, capturedAt - 1, stabilityTicks) &&
                   clockRegression.IsUnstable,
                "monotonic clock regression fails closed");

            var frozenSource = new SaveObservation
            {
                PairPresent = targetA.PairPresent,
                SaveTime = targetA.SaveTime,
                DsvBytes = targetA.DsvBytes,
                DsvWriteTimeUtcTicks = targetA.DsvWriteTimeUtcTicks,
                ServerBytes = targetA.ServerBytes,
                ServerWriteTimeUtcTicks = targetA.ServerWriteTimeUtcTicks
            };
            var frozenTracker = new SaveObservationStabilityTracker(before, frozenSource, capturedAt);
            frozenSource.DsvBytes++;
            Assert(frozenTracker.Observe(targetA, capturedAt + stabilityTicks, stabilityTicks),
                "tracker copies the immediate tuple instead of retaining mutable input");

            var saveTimeDidNotAdvance = new SaveObservation
            {
                PairPresent = true,
                SaveTime = 1000,
                DsvBytes = 102,
                DsvWriteTimeUtcTicks = 638817408020000001,
                ServerBytes = 52,
                ServerWriteTimeUtcTicks = 638817408020000002
            };
            AssertArgumentThrows(() => new SaveObservationStabilityTracker(before, saveTimeDidNotAdvance, capturedAt),
                "non-advancing LastSaveTime rejected immediately");

            var missingBefore = new SaveObservation { PairPresent = false, SaveTime = 0 };
            var createdPair = new SaveObservation
            {
                PairPresent = true,
                SaveTime = 1,
                DsvBytes = 100,
                DsvWriteTimeUtcTicks = 638817408030000001,
                ServerBytes = 50,
                ServerWriteTimeUtcTicks = 638817408030000002
            };
            var firstGenerationTracker = new SaveObservationStabilityTracker(
                missingBefore,
                createdPair,
                capturedAt);
            Assert(firstGenerationTracker.Observe(createdPair, capturedAt + stabilityTicks, stabilityTicks),
                "first complete paired generation from an exact absent baseline");
        }

        private static void TestReceiptSaveSlotSemantics(BridgeReceipt receiptEvidence)
        {
            receiptEvidence.SaveName = "_autosave_";
            AssertThrows(() => BridgeProtocol.SerializeReceipt(receiptEvidence, Secret),
                "successful receipt requires exact last-exit slot");
            receiptEvidence.SaveName = BridgeProtocol.UnavailableSaveName;
            AssertThrows(() => BridgeProtocol.SerializeReceipt(receiptEvidence, Secret),
                "unavailable slot cannot report success");
            receiptEvidence.SaveName = BridgeProtocol.LastExitSaveName;

            var unavailableFailure = new BridgeReceipt
            {
                RequestId = "44444444-5555-4666-8777-888888888888",
                State = "failed",
                StartedAtUnixMs = 1788081008000,
                FinishedAtUnixMs = 1788081008001,
                SaveName = BridgeProtocol.UnavailableSaveName,
                SaveTimeBefore = -1,
                SaveTimeAfter = -1,
                DsvBytes = -1,
                DsvWriteTimeUtcTicks = -1,
                ServerBytes = -1,
                ServerWriteTimeUtcTicks = -1,
                DsvChanged = false,
                ServerChanged = false,
                ErrorCode = "GAME_NOT_READY"
            };
            Assert(BridgeProtocol.SerializeReceipt(unavailableFailure, Secret)
                    .Contains("saveName=_unavailable_\n"),
                "failed unavailable receipt remains signable");
            unavailableFailure.SaveName = "_autosave_";
            AssertThrows(() => BridgeProtocol.SerializeReceipt(unavailableFailure, Secret),
                "failed receipt rejects an arbitrary save slot");
        }

        private static void TestMonotonicElapsedWindows()
        {
            var startedAtMonotonicTicks = BridgeMonotonicTime.DurationTicks(1000);
            var durationTicks = BridgeMonotonicTime.DurationTicks(500);
            var startedAtUnixMs = 1788081000000L;
            var wallClockJumpedForward = startedAtUnixMs + 86400000L;
            Assert(wallClockJumpedForward - startedAtUnixMs > 500 &&
                   !BridgeMonotonicTime.HasElapsed(
                       startedAtMonotonicTicks,
                       startedAtMonotonicTicks + durationTicks - 1,
                       durationTicks),
                "forward UTC correction cannot expire a monotonic window");

            var wallClockJumpedBackward = startedAtUnixMs - 86400000L;
            Assert(wallClockJumpedBackward - startedAtUnixMs < 0 &&
                   BridgeMonotonicTime.HasElapsed(
                       startedAtMonotonicTicks,
                       startedAtMonotonicTicks + durationTicks,
                       durationTicks),
                "backward UTC correction cannot extend a monotonic window");
        }

        private static void TestFailedMissingPairVectors()
        {
            var oneMissing = BridgeProtocol.SerializeReceipt(new BridgeReceipt
            {
                RequestId = "22222222-3333-4444-8555-666666666666",
                State = "failed",
                StartedAtUnixMs = 1788081004000,
                FinishedAtUnixMs = 1788081005000,
                SaveName = BridgeProtocol.LastExitSaveName,
                SaveTimeBefore = 1788081003,
                SaveTimeAfter = 1788081004,
                DsvBytes = -1,
                DsvWriteTimeUtcTicks = -1,
                ServerBytes = 22032,
                ServerWriteTimeUtcTicks = 638817408020000777,
                DsvChanged = true,
                ServerChanged = true,
                ErrorCode = "SAVE_PAIR_MISSING"
            }, Secret);
            Assert(oneMissing == OneFileMissingReceiptPayload,
                "failed receipt with one missing post-save file");

            var bothMissing = BridgeProtocol.SerializeReceipt(new BridgeReceipt
            {
                RequestId = "33333333-4444-4555-8666-777777777777",
                State = "failed",
                StartedAtUnixMs = 1788081006000,
                FinishedAtUnixMs = 1788081007000,
                SaveName = BridgeProtocol.LastExitSaveName,
                SaveTimeBefore = 1788081003,
                SaveTimeAfter = 1788081004,
                DsvBytes = -1,
                DsvWriteTimeUtcTicks = -1,
                ServerBytes = -1,
                ServerWriteTimeUtcTicks = -1,
                DsvChanged = true,
                ServerChanged = true,
                ErrorCode = "SAVE_PAIR_MISSING"
            }, Secret);
            Assert(bothMissing == BothFilesMissingReceiptPayload,
                "failed receipt with both post-save files missing");
        }

        private static void TestStrictWireGrammar()
        {
            var versionEightRequest = RequestPayload
                .Replace("11111111-2222-4333-8444-555555555555",
                    "11111111-2222-8333-8444-555555555555")
                .Replace("b1259d0dfd035395c0e797d91d1e76fda3531c264c391d4bdc0fb3aa3d43d54a",
                    "46e9b2e9d3ee93db8070ce1a055442aec7fc81123e2d0063049c6cd5470527e2");
            Assert(BridgeProtocol.TryParseRequest(versionEightRequest, Secret, out _, out _),
                "RFC GUID version 8 accepted");
            Assert(!BridgeProtocol.TryParseRequest(
                    RequestPayload.Replace("2222-4333", "2222-0333"), Secret, out _, out _),
                "non-RFC GUID version rejected");
            Assert(!BridgeProtocol.TryParseRequest(
                    RequestPayload.Replace("4333-8444", "4333-7444"), Secret, out _, out _),
                "non-RFC GUID variant rejected");
            Assert(!BridgeProtocol.TryParseRequest(
                    RequestPayload.Replace("createdAtUnixMs=1788081000000",
                        "createdAtUnixMs=01788081000000"), Secret, out _, out _),
                "leading-zero request time rejected");
            Assert(!BridgeProtocol.TryParseRequest("\uFEFF" + RequestPayload, Secret, out _, out _),
                "leading BOM rejected");
            Assert(!BridgeProtocol.TryParseRequest(
                    RequestPayload.Replace("action=save", "action=sa\uFEFFve"), Secret, out _, out _),
                "embedded BOM rejected");
            AssertThrows(() => BridgeProtocol.SerializeHeartbeat(new BridgeHeartbeat
                {
                    PluginVersion = "0.1.0\n",
                    ProcessId = 4242,
                    StartedAtUnixMs = 1788080000000,
                    WrittenAtUnixMs = 1788081004000
                }, Secret),
                "C# plugin-version regex is fully anchored");
        }

        private static void TestBridgeFileStoreStrictUtf8()
        {
            var payloadBytes = Encoding.UTF8.GetBytes(RequestPayload);
            AssertBridgeFileStoreRequest(payloadBytes, true, "UTF-8 request without BOM");

            var bomPayload = new byte[payloadBytes.Length + 3];
            bomPayload[0] = 0xEF;
            bomPayload[1] = 0xBB;
            bomPayload[2] = 0xBF;
            Buffer.BlockCopy(payloadBytes, 0, bomPayload, 3, payloadBytes.Length);
            AssertBridgeFileStoreRequest(bomPayload, false, "UTF-8 request with BOM");

            var invalidUtf8Payload = new byte[payloadBytes.Length + 1];
            Buffer.BlockCopy(payloadBytes, 0, invalidUtf8Payload, 0, payloadBytes.Length);
            invalidUtf8Payload[invalidUtf8Payload.Length - 1] = 0xFF;
            AssertBridgeFileStoreRequest(invalidUtf8Payload, false, "request with invalid UTF-8");
        }

        private static void AssertBridgeFileStoreRequest(byte[] payload, bool expectedSuccess, string name)
        {
            var fixtureRoot = Path.Combine(Path.GetTempPath(), "dyson-request-protocol-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(fixtureRoot);
                var secretPath = Path.Combine(fixtureRoot, "secret.txt");
                File.WriteAllText(secretPath, Secret, new UTF8Encoding(false, true));
                var controlRoot = Path.Combine(fixtureRoot, "control");
                var store = new BridgeFileStore(controlRoot, secretPath);
                var requestPath = Path.Combine(
                    controlRoot,
                    "requests",
                    "11111111-2222-4333-8444-555555555555.request");
                File.WriteAllBytes(requestPath, payload);
                var claim = store.TryClaimNext();
                Assert(claim != null, name + " was claimed");
                var succeeded = store.TryReadRequest(claim, out var request, out var errorCode);
                if (expectedSuccess)
                {
                    Assert(succeeded && request != null && errorCode == "NONE", name + " was accepted");
                }
                else
                {
                    Assert(!succeeded && request == null && errorCode == "INVALID_REQUEST",
                        name + " was rejected without decoder detail leakage");
                }
            }
            finally
            {
                if (Directory.Exists(fixtureRoot))
                {
                    Directory.Delete(fixtureRoot, true);
                }
            }
        }

        private static void TestAtomicPlayerFiles(string expectedPlayersPayload, string expectedCapabilitiesPayload)
        {
            var fixtureRoot = Path.Combine(Path.GetTempPath(), "dyson-player-protocol-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(fixtureRoot);
                var secretPath = Path.Combine(fixtureRoot, "secret.txt");
                File.WriteAllText(secretPath, Secret);
                var controlRoot = Path.Combine(fixtureRoot, "control");
                var store = new BridgeFileStore(controlRoot, secretPath);
                store.WriteHeartbeat("0.1.0", 4242, 1788080000000, 1788081004000);
                Assert(File.ReadAllText(Path.Combine(controlRoot, "heartbeat")) == HeartbeatPayload,
                    "atomic heartbeat remains compatible");
                store.WritePlayerSnapshot(new BridgePlayerSnapshot
                {
                    SessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                    WrittenAtUnixMs = 1788081004000,
                    Sequence = 7,
                    State = "active",
                    Truncated = false,
                    Players = new[]
                    {
                        new BridgePlayerEntry
                        {
                            SessionPlayerId = "player-000001",
                            DisplayName = "Nova",
                            Online = true,
                            JoinedAtUnixMs = 1788081001000,
                            Location = "planet:101"
                        },
                        new BridgePlayerEntry
                        {
                            SessionPlayerId = "player-000002",
                            DisplayName = "星海",
                            Online = true,
                            JoinedAtUnixMs = 1788081002000,
                            Location = "star:2"
                        }
                    }
                });
                Assert(File.ReadAllText(Path.Combine(controlRoot, "players")) == expectedPlayersPayload,
                    "atomic player snapshot file");
                Assert(Directory.GetFiles(controlRoot, ".partial-players-*").Length == 0,
                    "atomic player snapshot cleanup");
                store.WritePlayerCapabilities(new BridgePlayerCapabilitySnapshot
                {
                    SessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                    WrittenAtUnixMs = 1788081004000
                });
                Assert(File.ReadAllText(Path.Combine(controlRoot, "player-capabilities")) ==
                       expectedCapabilitiesPayload, "atomic player capability file");
                Assert(Directory.GetFiles(controlRoot, ".partial-player-capabilities-*").Length == 0,
                    "atomic player capability cleanup");
            }
            finally
            {
                if (Directory.Exists(fixtureRoot))
                {
                    Directory.Delete(fixtureRoot, true);
                }
            }
        }

        private static void Assert(bool condition, string name)
        {
            if (!condition)
            {
                throw new InvalidOperationException("Protocol self-test failed: " + name);
            }
        }

        private static void AssertThrows(Action action, string name)
        {
            try
            {
                action();
            }
            catch (InvalidOperationException)
            {
                return;
            }
            throw new InvalidOperationException("Protocol self-test failed: " + name);
        }

        private static void AssertArgumentThrows(Action action, string name)
        {
            try
            {
                action();
            }
            catch (ArgumentException)
            {
                return;
            }
            throw new InvalidOperationException("Protocol self-test failed: " + name);
        }
    }
}
