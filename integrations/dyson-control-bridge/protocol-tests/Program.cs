using System;
using System.IO;

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
            "protocol=DYSON_CONTROL_RECEIPT_V1\n" +
            "requestId=11111111-2222-4333-8444-555555555555\n" +
            "action=save\n" +
            "state=succeeded\n" +
            "startedAtUnixMs=1788081001000\n" +
            "finishedAtUnixMs=1788081003500\n" +
            "saveTimeBefore=1788080000\n" +
            "saveTimeAfter=1788081003\n" +
            "dsvBytes=5242880\n" +
            "serverBytes=22016\n" +
            "errorCode=NONE\n" +
            "hmac=ae20a2ab9be050ab4ebabf48dae7aaeee85d4ff6baf41c219e95d384a61bd0d3\n";

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

            var receipt = BridgeProtocol.SerializeReceipt(new BridgeReceipt
            {
                RequestId = request.RequestId,
                State = "succeeded",
                StartedAtUnixMs = 1788081001000,
                FinishedAtUnixMs = 1788081003500,
                SaveTimeBefore = 1788080000,
                SaveTimeAfter = 1788081003,
                DsvBytes = 5242880,
                ServerBytes = 22016,
                ErrorCode = "NONE"
            }, Secret);
            Assert(receipt == ReceiptPayload, "receipt serialization");

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

            Console.WriteLine("Dyson Control Bridge protocol V1 self-test passed.");
            return 0;
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
    }
}
