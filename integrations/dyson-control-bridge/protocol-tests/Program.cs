using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

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

        private const string RuntimeSessionPayload =
            "protocol=DYSON_CONTROL_RUNTIME_SESSION_V1\n" +
            "sessionId=bbbbbbbb-cccc-4ddd-8eee-ffffffffffff\n" +
            "pluginVersion=0.1.0\n" +
            "processId=4242\n" +
            "processStartedAtUnixMs=1788080000000\n" +
            "bridgeStartedAtUnixMs=1788081000000\n" +
            "issuedAtUnixMs=1788081000000\n" +
            "hmac=95fd6dfd32fca0deed984c68cdcd475d65a842004f596c5e5874a938c75e4b28\n";

        private const string LoadedSaveEvidencePayload =
            "protocol=DYSON_CONTROL_LOADED_SAVE_EVIDENCE_V1\n" +
            "sessionId=bbbbbbbb-cccc-4ddd-8eee-ffffffffffff\n" +
            "pluginVersion=0.1.0\n" +
            "processId=4242\n" +
            "processStartedAtUnixMs=1788080000000\n" +
            "bridgeStartedAtUnixMs=1788081000000\n" +
            "observationGeneration=3\n" +
            "observedAtUnixMs=1788081004000\n" +
            "writtenAtUnixMs=1788081004000\n" +
            "saveName=_lastexit_\n" +
            "dsvBytes=5242880\n" +
            "dsvWriteTimeUtcTicks=638817408010000001\n" +
            "dsvSha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" +
            "serverBytes=22016\n" +
            "serverWriteTimeUtcTicks=638817408010000777\n" +
            "serverSha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" +
            "hmac=39f7848082f8f134e09073effdffc5affafae1361764141dfe8ad9cc8fe16a72\n";

        private const string SimulationTelemetryPayload =
            "protocol=DYSON_CONTROL_SIMULATION_TELEMETRY_V1\n" +
            "sessionId=bbbbbbbb-cccc-4ddd-8eee-ffffffffffff\n" +
            "processId=4242\n" +
            "processStartedAtUnixMs=1788080000000\n" +
            "bridgeStartedAtUnixMs=1788081000000\n" +
            "sequence=7\n" +
            "sampleStartedAtUnixMs=1788081001000\n" +
            "sampleFinishedAtUnixMs=1788081003000\n" +
            "writtenAtUnixMs=1788081003000\n" +
            "windowDurationMs=2000\n" +
            "tickStarted=1000\n" +
            "tickFinished=1120\n" +
            "upsMilli=59875\n" +
            "tpsMilli=60000\n" +
            "upsSource=fpscontroller-stopwatch\n" +
            "tpsSource=gamemain-tick-wallclock\n" +
            "hmac=1142702c6adc9c87e93de149922017b4d26465e7923a5aab109035f104d75a95\n";

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

        private const string PlayerCapabilitiesJson =
            "[{\"capability\":\"observe-roster\",\"availability\":\"available\",\"mode\":\"read-only\",\"verifiedReasonCode\":\"UPSTREAM_ROSTER_API_VERIFIED\"}," +
            "{\"capability\":\"disconnect\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_CONNECTED_DISCONNECT_UNSAFE\"}," +
            "{\"capability\":\"kick\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_KICK_API_ABSENT\"}," +
            "{\"capability\":\"ban\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_BAN_API_ABSENT\"}," +
            "{\"capability\":\"whitelist\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_WHITELIST_API_ABSENT\"}," +
            "{\"capability\":\"blacklist\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_BLACKLIST_API_ABSENT\"}," +
            "{\"capability\":\"notice\",\"availability\":\"available\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED\"}," +
            "{\"capability\":\"permission\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_PERMISSION_API_ABSENT\"}]";

        private const string UnverifiedPlayerCapabilitiesJson =
            "[{\"capability\":\"observe-roster\",\"availability\":\"available\",\"mode\":\"read-only\",\"verifiedReasonCode\":\"UPSTREAM_ROSTER_API_VERIFIED\"}," +
            "{\"capability\":\"disconnect\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_CONNECTED_DISCONNECT_UNSAFE\"}," +
            "{\"capability\":\"kick\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_KICK_API_ABSENT\"}," +
            "{\"capability\":\"ban\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_BAN_API_ABSENT\"}," +
            "{\"capability\":\"whitelist\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_WHITELIST_API_ABSENT\"}," +
            "{\"capability\":\"blacklist\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_BLACKLIST_API_ABSENT\"}," +
            "{\"capability\":\"notice\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"NEBULA_NOTICE_RUNTIME_UNVERIFIED\"}," +
            "{\"capability\":\"permission\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_PERMISSION_API_ABSENT\"}]";

        // Independent unpadded Base64URL vector.
        private const string PlayerCapabilitiesJsonBase64Url =
            "W3siY2FwYWJpbGl0eSI6Im9ic2VydmUtcm9zdGVyIiwiYXZhaWxhYmlsaXR5IjoiYXZhaWxhYmxlIiwibW9kZSI6InJlYWQtb25seSIsInZlcmlmaWVkUmVhc29uQ29kZSI6IlVQU1RSRUFNX1JPU1RFUl9BUElfVkVSSUZJRUQifSx7ImNhcGFiaWxpdHkiOiJkaXNjb25uZWN0IiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9DT05ORUNURURfRElTQ09OTkVDVF9VTlNBRkUifSx7ImNhcGFiaWxpdHkiOiJraWNrIiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9LSUNLX0FQSV9BQlNFTlQifSx7ImNhcGFiaWxpdHkiOiJiYW4iLCJhdmFpbGFiaWxpdHkiOiJ1bmF2YWlsYWJsZSIsIm1vZGUiOiJtdXRhdGlvbiIsInZlcmlmaWVkUmVhc29uQ29kZSI6IlVQU1RSRUFNX0JBTl9BUElfQUJTRU5UIn0seyJjYXBhYmlsaXR5Ijoid2hpdGVsaXN0IiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9XSElURUxJU1RfQVBJX0FCU0VOVCJ9LHsiY2FwYWJpbGl0eSI6ImJsYWNrbGlzdCIsImF2YWlsYWJpbGl0eSI6InVuYXZhaWxhYmxlIiwibW9kZSI6Im11dGF0aW9uIiwidmVyaWZpZWRSZWFzb25Db2RlIjoiVVBTVFJFQU1fQkxBQ0tMSVNUX0FQSV9BQlNFTlQifSx7ImNhcGFiaWxpdHkiOiJub3RpY2UiLCJhdmFpbGFiaWxpdHkiOiJhdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9UQVJHRVRFRF9OT1RJQ0VfUFJJTUlUSVZFU19WRVJJRklFRCJ9LHsiY2FwYWJpbGl0eSI6InBlcm1pc3Npb24iLCJhdmFpbGFiaWxpdHkiOiJ1bmF2YWlsYWJsZSIsIm1vZGUiOiJtdXRhdGlvbiIsInZlcmlmaWVkUmVhc29uQ29kZSI6IlVQU1RSRUFNX1BFUk1JU1NJT05fQVBJX0FCU0VOVCJ9XQ";

        private const string PlayerCapabilitiesHmac =
            "df6871264f343d4b6ffb40c0d1a2bc3e0a7f47bac263f96a87bcd6e9d6993934";

        private const string UnverifiedPlayerCapabilitiesJsonBase64Url =
            "W3siY2FwYWJpbGl0eSI6Im9ic2VydmUtcm9zdGVyIiwiYXZhaWxhYmlsaXR5IjoiYXZhaWxhYmxlIiwibW9kZSI6InJlYWQtb25seSIsInZlcmlmaWVkUmVhc29uQ29kZSI6IlVQU1RSRUFNX1JPU1RFUl9BUElfVkVSSUZJRUQifSx7ImNhcGFiaWxpdHkiOiJkaXNjb25uZWN0IiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9DT05ORUNURURfRElTQ09OTkVDVF9VTlNBRkUifSx7ImNhcGFiaWxpdHkiOiJraWNrIiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9LSUNLX0FQSV9BQlNFTlQifSx7ImNhcGFiaWxpdHkiOiJiYW4iLCJhdmFpbGFiaWxpdHkiOiJ1bmF2YWlsYWJsZSIsIm1vZGUiOiJtdXRhdGlvbiIsInZlcmlmaWVkUmVhc29uQ29kZSI6IlVQU1RSRUFNX0JBTl9BUElfQUJTRU5UIn0seyJjYXBhYmlsaXR5Ijoid2hpdGVsaXN0IiwiYXZhaWxhYmlsaXR5IjoidW5hdmFpbGFibGUiLCJtb2RlIjoibXV0YXRpb24iLCJ2ZXJpZmllZFJlYXNvbkNvZGUiOiJVUFNUUkVBTV9XSElURUxJU1RfQVBJX0FCU0VOVCJ9LHsiY2FwYWJpbGl0eSI6ImJsYWNrbGlzdCIsImF2YWlsYWJpbGl0eSI6InVuYXZhaWxhYmxlIiwibW9kZSI6Im11dGF0aW9uIiwidmVyaWZpZWRSZWFzb25Db2RlIjoiVVBTVFJFQU1fQkxBQ0tMSVNUX0FQSV9BQlNFTlQifSx7ImNhcGFiaWxpdHkiOiJub3RpY2UiLCJhdmFpbGFiaWxpdHkiOiJ1bmF2YWlsYWJsZSIsIm1vZGUiOiJtdXRhdGlvbiIsInZlcmlmaWVkUmVhc29uQ29kZSI6Ik5FQlVMQV9OT1RJQ0VfUlVOVElNRV9VTlZFUklGSUVEIn0seyJjYXBhYmlsaXR5IjoicGVybWlzc2lvbiIsImF2YWlsYWJpbGl0eSI6InVuYXZhaWxhYmxlIiwibW9kZSI6Im11dGF0aW9uIiwidmVyaWZpZWRSZWFzb25Db2RlIjoiVVBTVFJFQU1fUEVSTUlTU0lPTl9BUElfQUJTRU5UIn1d";

        private const string UnverifiedPlayerCapabilitiesHmac =
            "49ad9008327dccd6aac3ed7233aa5b3955f910a9db61a6e7903ad9a499b90c5b";

        private const string PlayerCapabilitiesPayload =
            "protocol=DYSON_CONTROL_PLAYER_CAPABILITIES_V1\n" +
            "verifiedUpstreamRepository=NebulaModTeam/nebula\n" +
            "verifiedUpstreamTag=v0.9.22\n" +
            "verifiedRuntimeFileVersion=0.9.22.2\n" +
            "verifiedUpstreamCommit=3cdf95c594a2f8010b0e87a43be828e6ba2f657f\n" +
            "verificationScope=runtime-assembly-identity-verified\n" +
            "sessionId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n" +
            "writtenAtUnixMs=1788081004000\n" +
            "actionsEnabled=true\n" +
            "capabilitiesJsonB64=" + PlayerCapabilitiesJsonBase64Url + "\n" +
            "hmac=" + PlayerCapabilitiesHmac + "\n";

        private const string UnverifiedPlayerCapabilitiesPayload =
            "protocol=DYSON_CONTROL_PLAYER_CAPABILITIES_V1\n" +
            "verifiedUpstreamRepository=NebulaModTeam/nebula\n" +
            "verifiedUpstreamTag=v0.9.22\n" +
            "verifiedRuntimeFileVersion=0.9.22.2\n" +
            "verifiedUpstreamCommit=3cdf95c594a2f8010b0e87a43be828e6ba2f657f\n" +
            "verificationScope=source-contract-only-runtime-unverified\n" +
            "sessionId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n" +
            "writtenAtUnixMs=1788081004000\n" +
            "actionsEnabled=false\n" +
            "capabilitiesJsonB64=" + UnverifiedPlayerCapabilitiesJsonBase64Url + "\n" +
            "hmac=" + UnverifiedPlayerCapabilitiesHmac + "\n";

        private const string PlayerNoticeRequestPayload =
            "protocol=DYSON_CONTROL_PLAYER_NOTICE_REQUEST_V1\n" +
            "requestId=44444444-5555-4666-8777-888888888888\n" +
            "createdAtUnixMs=1788081000000\n" +
            "expiresAtUnixMs=1788081015000\n" +
            "action=player.notice\n" +
            "rosterSessionId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n" +
            "rosterSequence=7\n" +
            "sessionPlayerId=player-000002\n" +
            "targetJoinedAtUnixMs=1788081002000\n" +
            "templateId=maintenance-5m\n" +
            "nonce=ABCDEFGHIJKLMNOPQRSTUV\n" +
            "hmac=43c455ccb78a933e52013cc2bb0d370e4dc9f8488d8c61bfbf63c1ec4fa7035e\n";

        private const string PlayerNoticeDispatchedReceiptPayload =
            "protocol=DYSON_CONTROL_PLAYER_NOTICE_RECEIPT_V1\n" +
            "requestId=44444444-5555-4666-8777-888888888888\n" +
            "action=player.notice\n" +
            "state=transport-dispatched\n" +
            "startedAtUnixMs=1788081001000\n" +
            "finishedAtUnixMs=1788081001001\n" +
            "rosterSessionId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\n" +
            "rosterSequence=7\n" +
            "sessionPlayerId=player-000002\n" +
            "targetJoinedAtUnixMs=1788081002000\n" +
            "templateId=maintenance-5m\n" +
            "mutationMayHaveOccurred=true\n" +
            "recoveryRequired=false\n" +
            "rollback=not-possible\n" +
            "errorCode=NONE\n" +
            "hmac=f97c72fb9e97f50b5bff43a81722ec864f4d5edbc8722b1a456015915cfb2efb\n";

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
            TestLoadedSaveEvidenceProtocol();
            TestLoadedSaveEvidencePublisherAndFaults();
            TestSimulationTelemetryProtocol();
            TestSimulationTelemetrySampler();

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
            TestPlayerSnapshotBackslashEscaping();

            var playerCapabilities = BridgeProtocol.SerializePlayerCapabilities(new BridgePlayerCapabilitySnapshot
            {
                SessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                WrittenAtUnixMs = 1788081004000,
                NoticeRuntimeState = NebulaNoticeRuntimeState.Verified
            }, Secret);
            Assert(playerCapabilities == PlayerCapabilitiesPayload, "player capability serialization");
            Assert(playerCapabilities.Contains("actionsEnabled=true\n") &&
                   playerCapabilities.Contains("\"capability\":\"notice\"") == false,
                "signed capability payload enables only the encoded fixed notice action");
            TestPlayerCapabilitiesFixedVector(playerCapabilities);
            var unverifiedPlayerCapabilities = BridgeProtocol.SerializePlayerCapabilities(
                new BridgePlayerCapabilitySnapshot
                {
                    SessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                    WrittenAtUnixMs = 1788081004000,
                    NoticeRuntimeState = NebulaNoticeRuntimeState.Unverified
                },
                Secret);
            Assert(unverifiedPlayerCapabilities == UnverifiedPlayerCapabilitiesPayload,
                "unverified player capability serialization");
            TestUnverifiedPlayerCapabilitiesFixedVector(unverifiedPlayerCapabilities);
            TestPlayerCapabilityStateCoherence();
            TestAtomicPlayerFiles(players, unverifiedPlayerCapabilities);

            var tampered = RequestPayload.Replace("hmac=b", "hmac=0");
            Assert(!BridgeProtocol.TryParseRequest(tampered, Secret, out _, out var tamperError) &&
                   tamperError == "INVALID_SIGNATURE", "tamper rejection");
            Assert(!BridgeProtocol.TryParseRequest(RequestPayload + "extra=value\n", Secret, out _, out _),
                "extra-field rejection");
            TestStrictWireGrammar();
            TestBridgeFileStoreStrictUtf8();
            TestPlayerNoticeProtocol();

            Console.WriteLine("Dyson Control Bridge request V1 / receipt V2 / loaded-save V1 / telemetry V1 / players V1 / player-capabilities V1 self-test passed.");
            return 0;
        }

        private static void TestPlayerCapabilitiesFixedVector(string payload)
        {
            Assert(PlayerCapabilitiesJsonBase64Url.Length == 1358 &&
                   PlayerCapabilitiesJsonBase64Url.IndexOf('=') < 0 &&
                   PlayerCapabilitiesJsonBase64Url.IndexOfAny(new[] { ' ', '\t', '\r', '\n' }) < 0,
                "player capability Base64URL vector is unpadded and whitespace-free");

            var paddedBase64 = PlayerCapabilitiesJsonBase64Url
                .Replace('-', '+')
                .Replace('_', '/');
            paddedBase64 += new string('=', (4 - paddedBase64.Length % 4) % 4);
            var decodedJson = Encoding.UTF8.GetString(Convert.FromBase64String(paddedBase64));
            Assert(decodedJson == PlayerCapabilitiesJson && Encoding.UTF8.GetByteCount(decodedJson) == 1018,
                "player capability Base64URL vector decodes to the canonical eight-entry JSON");
            Assert(CountOccurrences(decodedJson, "\"capability\":") == 8 &&
                   CountOccurrences(decodedJson, "\"availability\":\"unavailable\"") == 6 &&
                   decodedJson.IndexOf("\"capability\":\"blacklist\"", StringComparison.Ordinal) <
                   decodedJson.IndexOf("\"capability\":\"notice\"", StringComparison.Ordinal) &&
                   decodedJson.IndexOf("\"capability\":\"notice\"", StringComparison.Ordinal) <
                   decodedJson.IndexOf("\"capability\":\"permission\"", StringComparison.Ordinal),
                "player capability JSON keeps exact order with only notice enabled");

            var hmacInput = string.Join("\n", new[]
            {
                "DYSON_CONTROL_PLAYER_CAPABILITIES_V1",
                "NebulaModTeam/nebula",
                "v0.9.22",
                "0.9.22.2",
                "3cdf95c594a2f8010b0e87a43be828e6ba2f657f",
                "runtime-assembly-identity-verified",
                "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                "1788081004000",
                "true",
                PlayerCapabilitiesJsonBase64Url
            });
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(Secret)))
            {
                var actualHmac = Convert.ToHexString(
                    hmac.ComputeHash(Encoding.UTF8.GetBytes(hmacInput))).ToLowerInvariant();
                Assert(actualHmac == PlayerCapabilitiesHmac,
                    "player capability independent HMAC vector");
            }
            Assert(payload.Contains("capabilitiesJsonB64=" + PlayerCapabilitiesJsonBase64Url + "\n") &&
                   payload.Contains("hmac=" + PlayerCapabilitiesHmac + "\n"),
                "player capability payload embeds the independently verified vectors");
        }

        private static void TestUnverifiedPlayerCapabilitiesFixedVector(string payload)
        {
            var paddedBase64 = UnverifiedPlayerCapabilitiesJsonBase64Url
                .Replace('-', '+')
                .Replace('_', '/');
            paddedBase64 += new string('=', (4 - paddedBase64.Length % 4) % 4);
            var decodedJson = Encoding.UTF8.GetString(Convert.FromBase64String(paddedBase64));
            Assert(decodedJson == UnverifiedPlayerCapabilitiesJson &&
                   Encoding.UTF8.GetByteCount(decodedJson) == 1008,
                "unverified capability fixed vector decodes exactly");
            Assert(decodedJson.Contains(
                       "\"capability\":\"notice\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"NEBULA_NOTICE_RUNTIME_UNVERIFIED\"",
                       StringComparison.Ordinal) &&
                   payload.Contains("verificationScope=source-contract-only-runtime-unverified\n", StringComparison.Ordinal) &&
                   payload.Contains("actionsEnabled=false\n", StringComparison.Ordinal),
                "unverified runtime gate is internally coherent");

            var hmacInput = string.Join("\n", new[]
            {
                "DYSON_CONTROL_PLAYER_CAPABILITIES_V1",
                "NebulaModTeam/nebula",
                "v0.9.22",
                "0.9.22.2",
                "3cdf95c594a2f8010b0e87a43be828e6ba2f657f",
                "source-contract-only-runtime-unverified",
                "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                "1788081004000",
                "false",
                UnverifiedPlayerCapabilitiesJsonBase64Url
            });
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(Secret)))
            {
                var actualHmac = Convert.ToHexString(
                    hmac.ComputeHash(Encoding.UTF8.GetBytes(hmacInput))).ToLowerInvariant();
                Assert(actualHmac == UnverifiedPlayerCapabilitiesHmac,
                    "unverified player capability independent HMAC vector");
            }
        }

        private static void TestPlayerCapabilityStateCoherence()
        {
            Assert(NebulaNoticeRuntimeCompatibility.VerifyLoadedRuntime() ==
                       NebulaNoticeRuntimeState.Unverified,
                "missing runtime assemblies fail closed without enabling a mutation");
            Assert(NebulaNoticeRuntimeCompatibility.VerificationScope(NebulaNoticeRuntimeState.Unverified) ==
                       "source-contract-only-runtime-unverified" &&
                   !NebulaNoticeRuntimeCompatibility.ActionsEnabled(NebulaNoticeRuntimeState.Unverified) &&
                   NebulaNoticeRuntimeCompatibility.NoticeAvailability(NebulaNoticeRuntimeState.Unverified) ==
                       "unavailable" &&
                   NebulaNoticeRuntimeCompatibility.NoticeReasonCode(NebulaNoticeRuntimeState.Unverified) ==
                       "NEBULA_NOTICE_RUNTIME_UNVERIFIED",
                "unverified state tuple cannot expose notice mutation");
            Assert(NebulaNoticeRuntimeCompatibility.VerificationScope(NebulaNoticeRuntimeState.Verified) ==
                       "runtime-assembly-identity-verified" &&
                   NebulaNoticeRuntimeCompatibility.ActionsEnabled(NebulaNoticeRuntimeState.Verified) &&
                   NebulaNoticeRuntimeCompatibility.NoticeAvailability(NebulaNoticeRuntimeState.Verified) ==
                       "available" &&
                   NebulaNoticeRuntimeCompatibility.NoticeReasonCode(NebulaNoticeRuntimeState.Verified) ==
                       "UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED",
                "verified state tuple enables exactly the targeted notice mutation");
            AssertThrows(
                () => BridgeProtocol.SerializePlayerCapabilities(
                    new BridgePlayerCapabilitySnapshot
                    {
                        SessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                        WrittenAtUnixMs = 1788081004000,
                        NoticeRuntimeState = (NebulaNoticeRuntimeState)99
                    },
                    Secret),
                "unknown runtime state cannot serialize a mixed capability tuple");
        }

        private static void TestPlayerSnapshotBackslashEscaping()
        {
            var backslash = (char)0x5c;
            var payload = BridgeProtocol.SerializePlayerSnapshot(new BridgePlayerSnapshot
            {
                SessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                WrittenAtUnixMs = 1788081004000,
                Sequence = 8,
                State = "active",
                Truncated = false,
                Players = new[]
                {
                    new BridgePlayerEntry
                    {
                        SessionPlayerId = "player-000003",
                        DisplayName = "Nova" + backslash + "Pilot",
                        Online = true,
                        JoinedAtUnixMs = 1788081003000,
                        Location = "planet:101"
                    }
                }
            }, Secret);
            const string prefix = "playersJsonB64=";
            var valueStart = payload.IndexOf(prefix, StringComparison.Ordinal) + prefix.Length;
            var valueEnd = payload.IndexOf('\n', valueStart);
            Assert(valueStart >= prefix.Length && valueEnd > valueStart,
                "player snapshot contains the encoded JSON field");
            var paddedBase64 = payload.Substring(valueStart, valueEnd - valueStart)
                .Replace('-', '+')
                .Replace('_', '/');
            paddedBase64 += new string('=', (4 - paddedBase64.Length % 4) % 4);
            var json = Encoding.UTF8.GetString(Convert.FromBase64String(paddedBase64));
            var escapedBackslash = new string(backslash, 2);
            Assert(json.Contains("\"displayName\":\"Nova" + escapedBackslash + "Pilot\"", StringComparison.Ordinal),
                "player snapshot escapes a backslash as an exact JSON pair");
        }

        private static int CountOccurrences(string value, string fragment)
        {
            var count = 0;
            var offset = 0;
            while ((offset = value.IndexOf(fragment, offset, StringComparison.Ordinal)) >= 0)
            {
                count++;
                offset += fragment.Length;
            }
            return count;
        }

        private static void TestPlayerNoticeProtocol()
        {
            Assert(PlayerNoticeProtocol.TryParseRequest(
                    PlayerNoticeRequestPayload, Secret, out var request, out var errorCode) && errorCode == "NONE",
                "player notice signed request accepted");
            Assert(request.RosterSessionId == "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" &&
                   request.RosterSequence == 7 && request.SessionPlayerId == "player-000002" &&
                   request.TargetJoinedAtUnixMs == 1788081002000 && request.TemplateId == "maintenance-5m",
                "player notice request binds roster and player connection generation");
            Assert(!PlayerNoticeProtocol.TryParseRequest(
                    PlayerNoticeRequestPayload.Replace("maintenance-5m", "maintenance-now"),
                    Secret, out _, out var signatureError) && signatureError == "INVALID_SIGNATURE",
                "player notice template tamper rejected");
            Assert(!PlayerNoticeProtocol.TryParseRequest(
                    PlayerNoticeRequestPayload.Replace("templateId=maintenance-5m", "templateId=free-text"),
                    Secret, out _, out _),
                "player notice accepts no caller-supplied text");

            var receipt = new PlayerNoticeReceipt
            {
                RequestId = request.RequestId,
                State = "transport-dispatched",
                StartedAtUnixMs = 1788081001000,
                FinishedAtUnixMs = 1788081001001,
                RosterSessionId = request.RosterSessionId,
                RosterSequence = request.RosterSequence,
                SessionPlayerId = request.SessionPlayerId,
                TargetJoinedAtUnixMs = request.TargetJoinedAtUnixMs,
                TemplateId = request.TemplateId,
                MutationMayHaveOccurred = true,
                RecoveryRequired = false,
                ErrorCode = "NONE"
            };
            Assert(PlayerNoticeProtocol.SerializeReceipt(receipt, Secret) == PlayerNoticeDispatchedReceiptPayload,
                "player notice dispatched receipt cross-runtime vector");
            receipt.State = "uncertain";
            receipt.RecoveryRequired = true;
            receipt.ErrorCode = "INTERRUPTED_UNCERTAIN";
            var uncertainPayload = PlayerNoticeProtocol.SerializeReceipt(receipt, Secret);
            Assert(uncertainPayload.Contains("state=uncertain\n") &&
                   uncertainPayload.Contains("mutationMayHaveOccurred=true\nrecoveryRequired=true\n"),
                "player notice crash ambiguity is explicit and non-retriable");
            receipt.State = "failed";
            AssertThrows(() => PlayerNoticeProtocol.SerializeReceipt(receipt, Secret),
                "failed player notice cannot claim a possible mutation");

            var fixtureRoot = Path.Combine(Path.GetTempPath(), "dyson-player-notice-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(fixtureRoot);
                var secretPath = Path.Combine(fixtureRoot, "secret.txt");
                File.WriteAllText(secretPath, Secret, new UTF8Encoding(false, true));
                var controlRoot = Path.Combine(fixtureRoot, "control");
                var store = new BridgeFileStore(controlRoot, secretPath);
                File.WriteAllText(
                    Path.Combine(controlRoot, "player-notice-requests", request.RequestId + ".request"),
                    PlayerNoticeRequestPayload,
                    new UTF8Encoding(false, true));
                var claim = store.TryClaimNextPlayerNotice();
                Assert(claim != null && !claim.Recovered &&
                       store.TryReadPlayerNoticeRequest(claim, out var stored, out var storedError) &&
                       storedError == "NONE" && stored.RequestId == request.RequestId,
                    "player notice has a separate strict request channel");
            }
            finally
            {
                if (Directory.Exists(fixtureRoot)) Directory.Delete(fixtureRoot, true);
            }
        }

        private static void TestLoadedSaveEvidenceProtocol()
        {
            var evidence = CreateLoadedSaveEvidence();
            var payload = BridgeProtocol.SerializeLoadedSaveEvidence(evidence, Secret);
            Assert(payload == LoadedSaveEvidencePayload, "loaded-save evidence cross-runtime vector");
            Assert(BridgeProtocol.TryParseLoadedSaveEvidence(
                       payload, Secret, out var parsed, out var parseError) &&
                   parseError == "NONE" && parsed.SessionId == evidence.SessionId &&
                   parsed.SaveName == BridgeProtocol.LastExitSaveName &&
                   parsed.ObservationGeneration == 3 && parsed.DsvSha256 == new string('a', 64) &&
                   parsed.ServerSha256 == new string('b', 64),
                "loaded-save evidence strict parse");

            var tampered = payload.Replace(
                "dsvSha256=" + new string('a', 64),
                "dsvSha256=" + new string('c', 64));
            Assert(!BridgeProtocol.TryParseLoadedSaveEvidence(
                       tampered, Secret, out _, out var tamperError) &&
                   tamperError == "INVALID_SIGNATURE",
                "loaded-save content identity tamper rejection");
            Assert(!BridgeProtocol.TryParseLoadedSaveEvidence(
                    payload + "extra=value\n", Secret, out _, out _),
                "loaded-save extra field rejection");
            Assert(!BridgeProtocol.TryParseLoadedSaveEvidence(
                    payload.Replace("serverSha256=" + new string('b', 64) + "\n", string.Empty),
                    Secret, out _, out _),
                "incomplete loaded-save evidence fails closed");

            evidence.SaveName = "manual-save";
            AssertThrows(() => BridgeProtocol.SerializeLoadedSaveEvidence(evidence, Secret),
                "non-last-exit runtime name rejected by lifecycle evidence contract");
            evidence.SaveName = BridgeProtocol.LastExitSaveName;
            evidence.DsvSha256 = new string('A', 64);
            AssertThrows(() => BridgeProtocol.SerializeLoadedSaveEvidence(evidence, Secret),
                "loaded-save digest requires canonical lowercase hex");

            var fixtureRoot = Path.Combine(Path.GetTempPath(), "dyson-loaded-save-wire-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(fixtureRoot);
                var secretPath = Path.Combine(fixtureRoot, "secret.txt");
                File.WriteAllText(secretPath, Secret, new UTF8Encoding(false, true));
                var controlRoot = Path.Combine(fixtureRoot, "control");
                var store = new BridgeFileStore(controlRoot, secretPath);
                store.WriteLoadedSaveEvidence(CreateLoadedSaveEvidence());
                Assert(File.ReadAllText(Path.Combine(controlRoot, "loaded-save-evidence")) ==
                       LoadedSaveEvidencePayload, "atomic loaded-save evidence file");
                Assert(Directory.GetFiles(controlRoot, ".partial-loaded-save-evidence-*").Length == 0,
                    "atomic loaded-save evidence cleanup");
                store.RemoveLoadedSaveEvidence();
                Assert(!File.Exists(Path.Combine(controlRoot, "loaded-save-evidence")),
                    "loaded-save evidence can be revoked on unknown state");
            }
            finally
            {
                if (Directory.Exists(fixtureRoot))
                {
                    Directory.Delete(fixtureRoot, true);
                }
            }
        }

        private static void TestLoadedSaveEvidencePublisherAndFaults()
        {
            var fixtureRoot = Path.Combine(Path.GetTempPath(), "dyson-loaded-save-publisher-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(fixtureRoot);
                var dsvPath = Path.Combine(fixtureRoot, BridgeProtocol.LastExitSaveName + ".dsv");
                var serverPath = Path.Combine(fixtureRoot, BridgeProtocol.LastExitSaveName + ".server");
                File.WriteAllText(dsvPath, "fictional-dsv-generation-one", new UTF8Encoding(false, true));
                File.WriteAllText(serverPath, "fictional-server-generation-one", new UTF8Encoding(false, true));
                var current = ObserveLoadedPair(dsvPath, serverPath, BridgeProtocol.LastExitSaveName);
                TryObserveLoadedSave observe = delegate(out LoadedSaveObservation observation)
                {
                    observation = current?.Copy();
                    return observation != null;
                };
                BridgeLoadedSaveEvidence written = null;
                var writeCount = 0;
                var removeCount = 0;
                Func<Func<LoadedSaveHashResult>, Task<LoadedSaveHashResult>> immediate = work =>
                {
                    try
                    {
                        return Task.FromResult(work());
                    }
                    catch (Exception exception)
                    {
                        return Task.FromException<LoadedSaveHashResult>(exception);
                    }
                };
                using (var publisher = new LoadedSaveEvidencePublisher(
                           observe,
                           value => { written = value; writeCount++; },
                           () => removeCount++,
                           "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
                           "0.1.0",
                           4242,
                           1788080000000,
                           1788081000000,
                           startHash: immediate))
                {
                    Assert(!publisher.Tick(1788081001000) && publisher.Tick(1788081001001) &&
                           writeCount == 1 && written.ObservationGeneration == 1 &&
                           written.SaveName == BridgeProtocol.LastExitSaveName &&
                           written.DsvBytes == current.DsvBytes && written.ServerBytes == current.ServerBytes,
                        "publisher hashes and publishes the authoritative paired generation");

                    current = current.Copy();
                    current.SaveName = "manual-save";
                    Assert(!publisher.Tick(1788081002000) && removeCount == 2 && writeCount == 1,
                        "non-last-exit authoritative runtime name revokes evidence");

                    File.WriteAllText(dsvPath, "fictional-dsv-generation-two", new UTF8Encoding(false, true));
                    File.WriteAllText(serverPath, "fictional-server-generation-two", new UTF8Encoding(false, true));
                    File.SetLastWriteTimeUtc(dsvPath, DateTime.UtcNow.AddSeconds(2));
                    File.SetLastWriteTimeUtc(serverPath, DateTime.UtcNow.AddSeconds(2));
                    current = ObserveLoadedPair(dsvPath, serverPath, BridgeProtocol.LastExitSaveName);
                    Assert(!publisher.Tick(1788081003000) && publisher.Tick(1788081003001) &&
                           writeCount == 2 && written.ObservationGeneration == 2,
                        "pair change produces a new observation generation only after rehash");

                    current = null;
                    Assert(!publisher.Tick(1788081004000) && removeCount == 3,
                        "unknown loaded save revokes the current fixed evidence file");
                }

                current = ObserveLoadedPair(dsvPath, serverPath, BridgeProtocol.LastExitSaveName);
                var lifecycleRemoveCount = 0;
                var lifecycleWriteCount = 0;
                var normalShutdown = new LoadedSaveEvidencePublisher(
                    observe,
                    _ => lifecycleWriteCount++,
                    () => lifecycleRemoveCount++,
                    "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
                    "0.1.0",
                    4242,
                    1788080000000,
                    1788081000000,
                    startHash: immediate);
                Assert(!normalShutdown.Tick(1788081004100) && normalShutdown.Tick(1788081004101) &&
                       lifecycleWriteCount == 1 && lifecycleRemoveCount == 1,
                    "new bridge generation removes the old evidence before publishing");
                normalShutdown.Dispose();
                Assert(lifecycleRemoveCount == 1,
                    "normal shutdown preserves the last complete signed evidence");
                using (var nextGeneration = new LoadedSaveEvidencePublisher(
                           observe,
                           _ => { },
                           () => lifecycleRemoveCount++,
                           "cccccccc-dddd-4eee-8fff-111111111111",
                           "0.1.0",
                           4343,
                           1788082000000,
                           1788082000000,
                           startHash: immediate))
                {
                    Assert(lifecycleRemoveCount == 2,
                        "next bridge Awake removes the stopped generation evidence");
                }

                var faultRemoveCount = 0;
                var faultedPublisher = new LoadedSaveEvidencePublisher(
                    observe,
                    _ => throw new InvalidOperationException("fictional evidence write fault"),
                    () => faultRemoveCount++,
                    "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
                    "0.1.0",
                    4242,
                    1788080000000,
                    1788081000000,
                    startHash: immediate);
                Assert(!faultedPublisher.Tick(1788081004200),
                    "fault fixture completes hashing before atomic publication");
                AssertThrows(() => faultedPublisher.Tick(1788081004201),
                    "atomic publication fault surfaces to plugin fail-closed handling");
                faultedPublisher.FailClosed();
                Assert(faultRemoveCount == 2,
                    "runtime publisher fault explicitly revokes any evidence");

                var stable = ObserveLoadedPair(dsvPath, serverPath, BridgeProtocol.LastExitSaveName);
                var original = stable.Copy();
                var completion = new TaskCompletionSource<LoadedSaveHashResult>();
                var staleWriteCount = 0;
                TryObserveLoadedSave driftingObserve = delegate(out LoadedSaveObservation observation)
                {
                    observation = stable?.Copy();
                    return observation != null;
                };
                using (var publisher = new LoadedSaveEvidencePublisher(
                           driftingObserve,
                           _ => staleWriteCount++,
                           () => { },
                           "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
                           "0.1.0",
                           4242,
                           1788080000000,
                           1788081000000,
                           startHash: _ => completion.Task))
                {
                    Assert(!publisher.Tick(1788081005000), "drift fixture starts one background hash");
                    stable = stable.Copy();
                    stable.ServerWriteTimeUtcTicks++;
                    Assert(!publisher.Tick(1788081005001), "metadata drift invalidates the in-flight hash");
                    completion.SetResult(LoadedSavePairHasher.Capture(original));
                    Assert(!publisher.Tick(1788081005002) && staleWriteCount == 0,
                        "completed stale hash cannot publish after observation drift");
                }

                var missingPair = ObserveLoadedPair(dsvPath, serverPath, BridgeProtocol.LastExitSaveName);
                File.Delete(serverPath);
                AssertThrows(() => LoadedSavePairHasher.Capture(missingPair),
                    "missing sidecar fails content hashing closed");
            }
            finally
            {
                if (Directory.Exists(fixtureRoot))
                {
                    Directory.Delete(fixtureRoot, true);
                }
            }
        }

        private static BridgeLoadedSaveEvidence CreateLoadedSaveEvidence()
        {
            return new BridgeLoadedSaveEvidence
            {
                SessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
                PluginVersion = "0.1.0",
                ProcessId = 4242,
                ProcessStartedAtUnixMs = 1788080000000,
                BridgeStartedAtUnixMs = 1788081000000,
                ObservationGeneration = 3,
                ObservedAtUnixMs = 1788081004000,
                WrittenAtUnixMs = 1788081004000,
                SaveName = BridgeProtocol.LastExitSaveName,
                DsvBytes = 5242880,
                DsvWriteTimeUtcTicks = 638817408010000001,
                DsvSha256 = new string('a', 64),
                ServerBytes = 22016,
                ServerWriteTimeUtcTicks = 638817408010000777,
                ServerSha256 = new string('b', 64)
            };
        }

        private static LoadedSaveObservation ObserveLoadedPair(string dsvPath, string serverPath, string saveName)
        {
            var dsv = new FileInfo(dsvPath);
            var server = new FileInfo(serverPath);
            dsv.Refresh();
            server.Refresh();
            return new LoadedSaveObservation
            {
                SaveName = saveName,
                DsvPath = dsv.FullName,
                DsvBytes = dsv.Length,
                DsvWriteTimeUtcTicks = dsv.LastWriteTimeUtc.Ticks,
                DsvCreationTimeUtcTicks = dsv.CreationTimeUtc.Ticks,
                ServerPath = server.FullName,
                ServerBytes = server.Length,
                ServerWriteTimeUtcTicks = server.LastWriteTimeUtc.Ticks,
                ServerCreationTimeUtcTicks = server.CreationTimeUtc.Ticks
            };
        }

        private static void TestSimulationTelemetryProtocol()
        {
            var runtimeSession = new BridgeRuntimeSession
            {
                SessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
                PluginVersion = "0.1.0",
                ProcessId = 4242,
                ProcessStartedAtUnixMs = 1788080000000,
                BridgeStartedAtUnixMs = 1788081000000,
                IssuedAtUnixMs = 1788081000000
            };
            var sessionPayload = BridgeProtocol.SerializeRuntimeSession(runtimeSession, Secret);
            Assert(sessionPayload == RuntimeSessionPayload, "runtime session cross-runtime vector");
            Assert(BridgeProtocol.TryParseRuntimeSession(
                       sessionPayload, Secret, out var parsedSession, out var sessionError) &&
                   sessionError == "NONE" && parsedSession.ProcessId == 4242 &&
                   parsedSession.SessionId == runtimeSession.SessionId,
                "runtime session strict parse");
            var tamperedSession = sessionPayload.Replace("processId=4242", "processId=4243");
            Assert(!BridgeProtocol.TryParseRuntimeSession(
                       tamperedSession, Secret, out _, out var tamperedSessionError) &&
                   tamperedSessionError == "INVALID_SIGNATURE",
                "runtime session tamper rejection");

            var telemetry = new BridgeSimulationTelemetry
            {
                SessionId = runtimeSession.SessionId,
                ProcessId = 4242,
                ProcessStartedAtUnixMs = 1788080000000,
                BridgeStartedAtUnixMs = 1788081000000,
                Sequence = 7,
                SampleStartedAtUnixMs = 1788081001000,
                SampleFinishedAtUnixMs = 1788081003000,
                WrittenAtUnixMs = 1788081003000,
                WindowDurationMs = 2000,
                TickStarted = 1000,
                TickFinished = 1120,
                UpsMilli = 59875,
                TpsMilli = 60000
            };
            var telemetryPayload = BridgeProtocol.SerializeSimulationTelemetry(telemetry, Secret);
            Assert(telemetryPayload == SimulationTelemetryPayload, "simulation telemetry cross-runtime vector");
            Assert(BridgeProtocol.TryParseSimulationTelemetry(
                       telemetryPayload, Secret, out var parsedTelemetry, out var telemetryError) &&
                   telemetryError == "NONE" && parsedTelemetry.Sequence == 7 &&
                   parsedTelemetry.UpsMilli == 59875 && parsedTelemetry.TpsMilli == 60000,
                "simulation telemetry strict parse");
            var tamperedTelemetry = telemetryPayload.Replace("upsMilli=59875", "upsMilli=59876");
            Assert(!BridgeProtocol.TryParseSimulationTelemetry(
                       tamperedTelemetry, Secret, out _, out var tamperError) &&
                   tamperError == "INVALID_SIGNATURE",
                "simulation telemetry tamper rejection");
            telemetry.TpsMilli = 59990;
            AssertThrows(() => BridgeProtocol.SerializeSimulationTelemetry(telemetry, Secret),
                "simulation telemetry tick/wall consistency rejection");
        }

        private static void TestSimulationTelemetrySampler()
        {
            var sampler = new SimulationTelemetrySampler(
                "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
                4242,
                1788080000000,
                1788081000000,
                1000,
                1500,
                10000);
            Assert(sampler.Observe(true, 1000, 60, 1788081001000, 1000) == null,
                "telemetry sampler establishes a real baseline");
            Assert(sampler.Observe(true, 1060, 59, 1788081002000, 2000) == null,
                "telemetry sampler enforces its minimum wall window");
            var first = sampler.Observe(true, 1120, 58.5, 1788081003000, 3000);
            Assert(first != null && first.Sequence == 1 && first.TickStarted == 1000 &&
                   first.TickFinished == 1120 && first.WindowDurationMs == 2000 &&
                   first.UpsMilli == 58500 && first.TpsMilli == 60000,
                "telemetry sampler uses engine UPS and gameTick/wall TPS");
            var second = sampler.Observe(true, 1220, 51.25, 1788081005000, 5000);
            Assert(second != null && second.Sequence == 2 && second.TpsMilli == 50000,
                "telemetry sampler sequence and next independent window");
            Assert(sampler.Observe(true, 1219, 51, 1788081006000, 6000) == null,
                "telemetry sampler rejects a game tick regression");
            Assert(sampler.Observe(false, 1300, 60, 1788081007000, 7000) == null,
                "telemetry sampler resets while simulation is unavailable");
            Assert(sampler.Observe(true, 1300, 60, 1788081008000, 8000) == null,
                "telemetry sampler requires a fresh post-unavailable baseline");
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
                store.WriteRuntimeSession(new BridgeRuntimeSession
                {
                    SessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
                    PluginVersion = "0.1.0",
                    ProcessId = 4242,
                    ProcessStartedAtUnixMs = 1788080000000,
                    BridgeStartedAtUnixMs = 1788081000000,
                    IssuedAtUnixMs = 1788081000000
                });
                Assert(File.ReadAllText(Path.Combine(controlRoot, "runtime-session")) == RuntimeSessionPayload,
                    "atomic runtime session file");
                store.WriteSimulationTelemetry(new BridgeSimulationTelemetry
                {
                    SessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
                    ProcessId = 4242,
                    ProcessStartedAtUnixMs = 1788080000000,
                    BridgeStartedAtUnixMs = 1788081000000,
                    Sequence = 7,
                    SampleStartedAtUnixMs = 1788081001000,
                    SampleFinishedAtUnixMs = 1788081003000,
                    WrittenAtUnixMs = 1788081003000,
                    WindowDurationMs = 2000,
                    TickStarted = 1000,
                    TickFinished = 1120,
                    UpsMilli = 59875,
                    TpsMilli = 60000
                });
                Assert(File.ReadAllText(Path.Combine(controlRoot, "simulation-telemetry")) ==
                       SimulationTelemetryPayload, "atomic simulation telemetry file");
                Assert(Directory.GetFiles(controlRoot, ".partial-runtime-session-*").Length == 0 &&
                       Directory.GetFiles(controlRoot, ".partial-simulation-telemetry-*").Length == 0,
                    "atomic simulation telemetry cleanup");
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
                    WrittenAtUnixMs = 1788081004000,
                    NoticeRuntimeState = NebulaNoticeRuntimeState.Unverified
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
