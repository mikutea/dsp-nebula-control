using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace DysonControl.Bridge
{
    internal static class BridgeProtocol
    {
        internal const string RequestProtocol = "DYSON_CONTROL_REQUEST_V1";
        internal const string ReceiptProtocol = "DYSON_CONTROL_RECEIPT_V2";
        internal const string LastExitSaveName = "_lastexit_";
        internal const string UnavailableSaveName = "_unavailable_";
        internal const string HeartbeatProtocol = "DYSON_CONTROL_HEARTBEAT_V1";
        internal const string RuntimeSessionProtocol = "DYSON_CONTROL_RUNTIME_SESSION_V1";
        internal const string LoadedSaveEvidenceProtocol = "DYSON_CONTROL_LOADED_SAVE_EVIDENCE_V1";
        internal const string SimulationTelemetryProtocol = "DYSON_CONTROL_SIMULATION_TELEMETRY_V1";
        internal const string SimulationUpsSource = "fpscontroller-stopwatch";
        internal const string SimulationTpsSource = "gamemain-tick-wallclock";
        internal const string PlayersProtocol = "DYSON_CONTROL_PLAYERS_V1";
        internal const string PlayerCapabilitiesProtocol = "DYSON_CONTROL_PLAYER_CAPABILITIES_V1";
        internal const string VerifiedNebulaRepository = "NebulaModTeam/nebula";
        internal const string VerifiedNebulaTag = "v0.9.22";
        internal const string VerifiedNebulaRuntimeFileVersion =
            NebulaNoticeRuntimeCompatibility.ExpectedModelFileVersion;
        internal const string VerifiedNebulaCommit = "3cdf95c594a2f8010b0e87a43be828e6ba2f657f";
        internal const int MaximumPlayers = 64;
        internal const long MaximumSimulationMilliRate = 10000000;

        private static readonly string[] RequestKeys =
        {
            "protocol", "requestId", "createdAtUnixMs", "expiresAtUnixMs", "action", "nonce", "hmac"
        };

        private static readonly string[] ReceiptKeys =
        {
            "protocol", "requestId", "action", "state", "startedAtUnixMs", "finishedAtUnixMs",
            "saveName", "saveTimeBefore", "saveTimeAfter",
            "dsvBytes", "dsvWriteTimeUtcTicks", "serverBytes", "serverWriteTimeUtcTicks",
            "dsvChanged", "serverChanged", "errorCode", "hmac"
        };

        private static readonly string[] HeartbeatKeys =
        {
            "protocol", "pluginVersion", "processId", "startedAtUnixMs", "writtenAtUnixMs", "state", "hmac"
        };

        private static readonly string[] RuntimeSessionKeys =
        {
            "protocol", "sessionId", "pluginVersion", "processId", "processStartedAtUnixMs",
            "bridgeStartedAtUnixMs", "issuedAtUnixMs", "hmac"
        };

        private static readonly string[] LoadedSaveEvidenceKeys =
        {
            "protocol", "sessionId", "pluginVersion", "processId", "processStartedAtUnixMs",
            "bridgeStartedAtUnixMs", "observationGeneration", "observedAtUnixMs", "writtenAtUnixMs",
            "saveName", "dsvBytes", "dsvWriteTimeUtcTicks", "dsvSha256",
            "serverBytes", "serverWriteTimeUtcTicks", "serverSha256", "hmac"
        };

        private static readonly string[] SimulationTelemetryKeys =
        {
            "protocol", "sessionId", "processId", "processStartedAtUnixMs", "bridgeStartedAtUnixMs",
            "sequence", "sampleStartedAtUnixMs", "sampleFinishedAtUnixMs", "writtenAtUnixMs",
            "windowDurationMs", "tickStarted", "tickFinished", "upsMilli", "tpsMilli",
            "upsSource", "tpsSource", "hmac"
        };

        private static readonly string[] PlayersKeys =
        {
            "protocol", "sessionId", "writtenAtUnixMs", "sequence", "state", "truncated",
            "playerCount", "playersJsonB64", "hmac"
        };

        private static readonly string[] PlayerCapabilitiesKeys =
        {
            "protocol", "verifiedUpstreamRepository", "verifiedUpstreamTag", "verifiedRuntimeFileVersion",
            "verifiedUpstreamCommit", "verificationScope", "sessionId", "writtenAtUnixMs", "actionsEnabled",
            "capabilitiesJsonB64", "hmac"
        };

        private static readonly Regex NoncePattern = new Regex(
            @"\A[A-Za-z0-9_-]{22,64}\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex HmacPattern = new Regex(
            @"\A[0-9A-Fa-f]{64}\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex LowerHexSha256Pattern = new Regex(
            @"\A[0-9a-f]{64}\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex ErrorCodePattern = new Regex(
            @"\A(?:NONE|[A-Z][A-Z0-9_]{2,47})\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex SessionPlayerIdPattern = new Regex(
            @"\Aplayer-[0-9]{6,12}\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex PlayerLocationPattern = new Regex(
            @"\A(?:deep-space|planet:[1-9][0-9]{0,9}|star:[1-9][0-9]{0,9})\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex PluginVersionPattern = new Regex(
            @"\A[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]{1,32})?\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex RfcGuidPattern = new Regex(
            @"\A[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex CanonicalUnsignedDecimalPattern = new Regex(
            @"\A(?:0|[1-9][0-9]*)\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        internal static bool TryValidateSecret(string value, out string secret)
        {
            secret = (value ?? string.Empty).Trim();
            return secret.Length >= 32 && secret.Length <= 512 &&
                   secret.IndexOf('\r') < 0 && secret.IndexOf('\n') < 0 && secret.IndexOf('\0') < 0;
        }

        internal static bool IsValidSaveName(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 120 || value == "." || value == ".." ||
                Encoding.UTF8.GetByteCount(value) > 360)
            {
                return false;
            }
            foreach (var character in value)
            {
                if (character < 0x20 || character == '\\' || character == '/' || character == ':' ||
                    character == '*' || character == '?' || character == '"' || character == '<' ||
                    character == '>' || character == '|')
                {
                    return false;
                }
            }
            return true;
        }

        internal static bool TryParseRequest(
            string payload,
            string secret,
            out BridgeRequest request,
            out string errorCode)
        {
            request = null;
            errorCode = "INVALID_REQUEST";
            if (!TryParseOrdered(payload, RequestKeys, out var values))
            {
                return false;
            }

            if (values["protocol"] != RequestProtocol || values["action"] != "save" ||
                !TryParseRfcGuid(values["requestId"], out var requestId) ||
                !TryParsePositiveLong(values["createdAtUnixMs"], out var createdAtUnixMs) ||
                !TryParsePositiveLong(values["expiresAtUnixMs"], out var expiresAtUnixMs) ||
                expiresAtUnixMs <= createdAtUnixMs || expiresAtUnixMs - createdAtUnixMs > 120000 ||
                !NoncePattern.IsMatch(values["nonce"]) || !HmacPattern.IsMatch(values["hmac"]))
            {
                return false;
            }

            var normalizedId = requestId.ToString("D").ToLowerInvariant();
            var expected = ComputeHmac(secret, new[]
            {
                RequestProtocol,
                normalizedId,
                createdAtUnixMs.ToString(CultureInfo.InvariantCulture),
                expiresAtUnixMs.ToString(CultureInfo.InvariantCulture),
                "save",
                values["nonce"]
            });
            if (!FixedTimeEquals(values["hmac"], expected))
            {
                errorCode = "INVALID_SIGNATURE";
                return false;
            }

            request = new BridgeRequest
            {
                RequestId = normalizedId,
                CreatedAtUnixMs = createdAtUnixMs,
                ExpiresAtUnixMs = expiresAtUnixMs,
                Nonce = values["nonce"]
            };
            errorCode = "NONE";
            return true;
        }

        internal static string SerializeReceipt(BridgeReceipt receipt, string secret)
        {
            if (receipt == null || !TryParseRfcGuid(receipt.RequestId, out var parsedId) ||
                !TryValidateSecret(secret, out var normalizedSecret))
            {
                throw new InvalidOperationException("Receipt identity is invalid.");
            }
            var normalizedId = parsedId.ToString("D").ToLowerInvariant();
            if (receipt.State != "succeeded" && receipt.State != "failed")
            {
                throw new InvalidOperationException("Receipt state is invalid.");
            }
            if ((receipt.State == "succeeded" && receipt.SaveName != LastExitSaveName) ||
                (receipt.State == "failed" && receipt.SaveName != LastExitSaveName &&
                 receipt.SaveName != UnavailableSaveName))
            {
                throw new InvalidOperationException("Receipt save slot is invalid.");
            }
            if (receipt.FinishedAtUnixMs < receipt.StartedAtUnixMs)
            {
                throw new InvalidOperationException("Receipt timestamps are invalid.");
            }
            if (receipt.State == "succeeded" &&
                (receipt.ErrorCode != "NONE" || receipt.DsvBytes <= 0 || receipt.ServerBytes <= 0 ||
                 receipt.DsvWriteTimeUtcTicks <= 0 || receipt.ServerWriteTimeUtcTicks <= 0 ||
                 receipt.SaveTimeBefore < 0 || receipt.SaveTimeAfter <= receipt.SaveTimeBefore ||
                 !receipt.DsvChanged || !receipt.ServerChanged))
            {
                throw new InvalidOperationException("Successful receipt evidence is incomplete.");
            }
            // On failures, Changed=true with -1 post-state metadata means a
            // pre-call file identity changed by disappearing. Keep that state
            // signed rather than hiding it behind Changed=false.
            if (receipt.State == "failed" && receipt.ErrorCode == "NONE")
            {
                throw new InvalidOperationException("Failed receipt needs an error code.");
            }
            if (receipt.StartedAtUnixMs <= 0 || receipt.FinishedAtUnixMs <= 0 ||
                receipt.SaveTimeBefore < -1 || receipt.SaveTimeAfter < -1 ||
                receipt.DsvBytes < -1 || receipt.ServerBytes < -1 ||
                receipt.DsvWriteTimeUtcTicks < -1 || receipt.ServerWriteTimeUtcTicks < -1)
            {
                throw new InvalidOperationException("Receipt numeric evidence is invalid.");
            }
            if (!ErrorCodePattern.IsMatch(receipt.ErrorCode ?? string.Empty))
            {
                throw new InvalidOperationException("Receipt error code is invalid.");
            }

            var values = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["protocol"] = ReceiptProtocol,
                ["requestId"] = normalizedId,
                ["action"] = "save",
                ["state"] = receipt.State,
                ["startedAtUnixMs"] = receipt.StartedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["finishedAtUnixMs"] = receipt.FinishedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["saveName"] = receipt.SaveName,
                ["saveTimeBefore"] = receipt.SaveTimeBefore.ToString(CultureInfo.InvariantCulture),
                ["saveTimeAfter"] = receipt.SaveTimeAfter.ToString(CultureInfo.InvariantCulture),
                ["dsvBytes"] = receipt.DsvBytes.ToString(CultureInfo.InvariantCulture),
                ["dsvWriteTimeUtcTicks"] = receipt.DsvWriteTimeUtcTicks.ToString(CultureInfo.InvariantCulture),
                ["serverBytes"] = receipt.ServerBytes.ToString(CultureInfo.InvariantCulture),
                ["serverWriteTimeUtcTicks"] = receipt.ServerWriteTimeUtcTicks.ToString(CultureInfo.InvariantCulture),
                ["dsvChanged"] = receipt.DsvChanged ? "true" : "false",
                ["serverChanged"] = receipt.ServerChanged ? "true" : "false",
                ["errorCode"] = receipt.ErrorCode
            };
            values["hmac"] = ComputeHmac(normalizedSecret, new[]
            {
                ReceiptProtocol,
                normalizedId,
                "save",
                receipt.State,
                values["startedAtUnixMs"],
                values["finishedAtUnixMs"],
                values["saveName"],
                values["saveTimeBefore"],
                values["saveTimeAfter"],
                values["dsvBytes"],
                values["dsvWriteTimeUtcTicks"],
                values["serverBytes"],
                values["serverWriteTimeUtcTicks"],
                values["dsvChanged"],
                values["serverChanged"],
                receipt.ErrorCode
            });

            StringBuilder builder = new StringBuilder(512);
            foreach (var key in ReceiptKeys)
            {
                builder.Append(key).Append('=').Append(values[key]).Append('\n');
            }
            return builder.ToString();
        }

        internal static string ComputeSaveGenerationId(BridgeReceipt receipt)
        {
            if (receipt == null || receipt.State != "succeeded")
            {
                throw new InvalidOperationException("A successful V2 receipt is required for a generation identity.");
            }
            // Reuse strict receipt validation without coupling generation identity to requestId or HMAC.
            if (receipt.SaveName != LastExitSaveName || receipt.DsvBytes <= 0 || receipt.ServerBytes <= 0 ||
                receipt.DsvWriteTimeUtcTicks <= 0 || receipt.ServerWriteTimeUtcTicks <= 0 ||
                receipt.SaveTimeBefore < 0 || receipt.SaveTimeAfter <= receipt.SaveTimeBefore ||
                !receipt.DsvChanged || !receipt.ServerChanged)
            {
                throw new InvalidOperationException("Receipt generation evidence is incomplete.");
            }
            var input = string.Join("\n", new[]
            {
                "dyson-control-save-generation-v1",
                receipt.SaveName,
                receipt.SaveTimeAfter.ToString(CultureInfo.InvariantCulture),
                receipt.DsvBytes.ToString(CultureInfo.InvariantCulture),
                receipt.DsvWriteTimeUtcTicks.ToString(CultureInfo.InvariantCulture),
                receipt.ServerBytes.ToString(CultureInfo.InvariantCulture),
                receipt.ServerWriteTimeUtcTicks.ToString(CultureInfo.InvariantCulture)
            });
            using (var algorithm = SHA256.Create())
            {
                var hash = algorithm.ComputeHash(Encoding.UTF8.GetBytes(input));
                var builder = new StringBuilder("generation-v1:");
                foreach (var value in hash)
                {
                    builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                }
                return builder.ToString();
            }
        }

        internal static string SerializeHeartbeat(BridgeHeartbeat heartbeat, string secret)
        {
            if (heartbeat == null ||
                !PluginVersionPattern.IsMatch(heartbeat.PluginVersion ?? string.Empty) ||
                heartbeat.ProcessId <= 0 || heartbeat.StartedAtUnixMs <= 0 ||
                heartbeat.WrittenAtUnixMs < heartbeat.StartedAtUnixMs)
            {
                throw new InvalidOperationException("Heartbeat evidence is invalid.");
            }

            var values = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["protocol"] = HeartbeatProtocol,
                ["pluginVersion"] = heartbeat.PluginVersion,
                ["processId"] = heartbeat.ProcessId.ToString(CultureInfo.InvariantCulture),
                ["startedAtUnixMs"] = heartbeat.StartedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["writtenAtUnixMs"] = heartbeat.WrittenAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["state"] = "ready"
            };
            values["hmac"] = ComputeHmac(secret, new[]
            {
                HeartbeatProtocol,
                values["pluginVersion"],
                values["processId"],
                values["startedAtUnixMs"],
                values["writtenAtUnixMs"],
                values["state"]
            });

            var builder = new StringBuilder(384);
            foreach (var key in HeartbeatKeys)
            {
                builder.Append(key).Append('=').Append(values[key]).Append('\n');
            }
            return builder.ToString();
        }

        internal static string SerializeLoadedSaveEvidence(BridgeLoadedSaveEvidence evidence, string secret)
        {
            if (!TryValidateSecret(secret, out var normalizedSecret) ||
                !TryNormalizeLoadedSaveEvidence(evidence, out var normalizedSessionId))
            {
                throw new InvalidOperationException("Loaded-save evidence is invalid.");
            }
            var values = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["protocol"] = LoadedSaveEvidenceProtocol,
                ["sessionId"] = normalizedSessionId,
                ["pluginVersion"] = evidence.PluginVersion,
                ["processId"] = evidence.ProcessId.ToString(CultureInfo.InvariantCulture),
                ["processStartedAtUnixMs"] = evidence.ProcessStartedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["bridgeStartedAtUnixMs"] = evidence.BridgeStartedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["observationGeneration"] = evidence.ObservationGeneration.ToString(CultureInfo.InvariantCulture),
                ["observedAtUnixMs"] = evidence.ObservedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["writtenAtUnixMs"] = evidence.WrittenAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["saveName"] = evidence.SaveName,
                ["dsvBytes"] = evidence.DsvBytes.ToString(CultureInfo.InvariantCulture),
                ["dsvWriteTimeUtcTicks"] = evidence.DsvWriteTimeUtcTicks.ToString(CultureInfo.InvariantCulture),
                ["dsvSha256"] = evidence.DsvSha256,
                ["serverBytes"] = evidence.ServerBytes.ToString(CultureInfo.InvariantCulture),
                ["serverWriteTimeUtcTicks"] = evidence.ServerWriteTimeUtcTicks.ToString(CultureInfo.InvariantCulture),
                ["serverSha256"] = evidence.ServerSha256
            };
            values["hmac"] = ComputeHmac(normalizedSecret, LoadedSaveEvidenceKeys
                .Take(LoadedSaveEvidenceKeys.Length - 1)
                .Select(key => values[key]));
            return SerializeOrdered(LoadedSaveEvidenceKeys, values, 1024);
        }

        internal static bool TryParseLoadedSaveEvidence(
            string payload,
            string secret,
            out BridgeLoadedSaveEvidence evidence,
            out string errorCode)
        {
            evidence = null;
            errorCode = "INVALID_LOADED_SAVE_EVIDENCE";
            if (!TryValidateSecret(secret, out var normalizedSecret) ||
                !TryParseOrdered(payload, LoadedSaveEvidenceKeys, out var values) ||
                values["protocol"] != LoadedSaveEvidenceProtocol ||
                !TryParseRfcGuid(values["sessionId"], out var parsedSessionId) ||
                !PluginVersionPattern.IsMatch(values["pluginVersion"]) ||
                !TryParsePositiveLong(values["processId"], out var processId) || processId > int.MaxValue ||
                !TryParsePositiveLong(values["processStartedAtUnixMs"], out var processStartedAtUnixMs) ||
                !TryParsePositiveLong(values["bridgeStartedAtUnixMs"], out var bridgeStartedAtUnixMs) ||
                !TryParsePositiveLong(values["observationGeneration"], out var observationGeneration) ||
                !TryParsePositiveLong(values["observedAtUnixMs"], out var observedAtUnixMs) ||
                !TryParsePositiveLong(values["writtenAtUnixMs"], out var writtenAtUnixMs) ||
                values["saveName"] != LastExitSaveName ||
                !TryParsePositiveLong(values["dsvBytes"], out var dsvBytes) ||
                !TryParsePositiveLong(values["dsvWriteTimeUtcTicks"], out var dsvWriteTimeUtcTicks) ||
                !LowerHexSha256Pattern.IsMatch(values["dsvSha256"]) ||
                !TryParsePositiveLong(values["serverBytes"], out var serverBytes) ||
                !TryParsePositiveLong(values["serverWriteTimeUtcTicks"], out var serverWriteTimeUtcTicks) ||
                !LowerHexSha256Pattern.IsMatch(values["serverSha256"]) ||
                !HmacPattern.IsMatch(values["hmac"]))
            {
                return false;
            }
            var expected = ComputeHmac(normalizedSecret, LoadedSaveEvidenceKeys
                .Take(LoadedSaveEvidenceKeys.Length - 1)
                .Select(key => values[key]));
            if (!FixedTimeEquals(values["hmac"], expected))
            {
                errorCode = "INVALID_SIGNATURE";
                return false;
            }
            var parsed = new BridgeLoadedSaveEvidence
            {
                SessionId = parsedSessionId.ToString("D").ToLowerInvariant(),
                PluginVersion = values["pluginVersion"],
                ProcessId = (int)processId,
                ProcessStartedAtUnixMs = processStartedAtUnixMs,
                BridgeStartedAtUnixMs = bridgeStartedAtUnixMs,
                ObservationGeneration = observationGeneration,
                ObservedAtUnixMs = observedAtUnixMs,
                WrittenAtUnixMs = writtenAtUnixMs,
                SaveName = values["saveName"],
                DsvBytes = dsvBytes,
                DsvWriteTimeUtcTicks = dsvWriteTimeUtcTicks,
                DsvSha256 = values["dsvSha256"],
                ServerBytes = serverBytes,
                ServerWriteTimeUtcTicks = serverWriteTimeUtcTicks,
                ServerSha256 = values["serverSha256"]
            };
            if (!TryNormalizeLoadedSaveEvidence(parsed, out _))
            {
                return false;
            }
            evidence = parsed;
            errorCode = "NONE";
            return true;
        }

        internal static string SerializeRuntimeSession(BridgeRuntimeSession session, string secret)
        {
            if (!TryValidateSecret(secret, out var normalizedSecret) ||
                !TryNormalizeRuntimeSession(session, out var normalizedSessionId))
            {
                throw new InvalidOperationException("Runtime session evidence is invalid.");
            }

            var values = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["protocol"] = RuntimeSessionProtocol,
                ["sessionId"] = normalizedSessionId,
                ["pluginVersion"] = session.PluginVersion,
                ["processId"] = session.ProcessId.ToString(CultureInfo.InvariantCulture),
                ["processStartedAtUnixMs"] = session.ProcessStartedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["bridgeStartedAtUnixMs"] = session.BridgeStartedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["issuedAtUnixMs"] = session.IssuedAtUnixMs.ToString(CultureInfo.InvariantCulture)
            };
            values["hmac"] = ComputeHmac(normalizedSecret, new[]
            {
                RuntimeSessionProtocol,
                values["sessionId"],
                values["pluginVersion"],
                values["processId"],
                values["processStartedAtUnixMs"],
                values["bridgeStartedAtUnixMs"],
                values["issuedAtUnixMs"]
            });
            return SerializeOrdered(RuntimeSessionKeys, values, 512);
        }

        internal static bool TryParseRuntimeSession(
            string payload,
            string secret,
            out BridgeRuntimeSession session,
            out string errorCode)
        {
            session = null;
            errorCode = "INVALID_RUNTIME_SESSION";
            if (!TryValidateSecret(secret, out var normalizedSecret) ||
                !TryParseOrdered(payload, RuntimeSessionKeys, out var values) ||
                values["protocol"] != RuntimeSessionProtocol ||
                !TryParseRfcGuid(values["sessionId"], out var parsedSessionId) ||
                !PluginVersionPattern.IsMatch(values["pluginVersion"]) ||
                !TryParsePositiveLong(values["processId"], out var processId) || processId > int.MaxValue ||
                !TryParsePositiveLong(values["processStartedAtUnixMs"], out var processStartedAtUnixMs) ||
                !TryParsePositiveLong(values["bridgeStartedAtUnixMs"], out var bridgeStartedAtUnixMs) ||
                !TryParsePositiveLong(values["issuedAtUnixMs"], out var issuedAtUnixMs) ||
                !HmacPattern.IsMatch(values["hmac"]))
            {
                return false;
            }

            var normalizedSessionId = parsedSessionId.ToString("D").ToLowerInvariant();
            var expected = ComputeHmac(normalizedSecret, new[]
            {
                RuntimeSessionProtocol,
                normalizedSessionId,
                values["pluginVersion"],
                values["processId"],
                values["processStartedAtUnixMs"],
                values["bridgeStartedAtUnixMs"],
                values["issuedAtUnixMs"]
            });
            if (!FixedTimeEquals(values["hmac"], expected))
            {
                errorCode = "INVALID_SIGNATURE";
                return false;
            }

            var parsed = new BridgeRuntimeSession
            {
                SessionId = normalizedSessionId,
                PluginVersion = values["pluginVersion"],
                ProcessId = (int)processId,
                ProcessStartedAtUnixMs = processStartedAtUnixMs,
                BridgeStartedAtUnixMs = bridgeStartedAtUnixMs,
                IssuedAtUnixMs = issuedAtUnixMs
            };
            if (!TryNormalizeRuntimeSession(parsed, out _))
            {
                return false;
            }
            session = parsed;
            errorCode = "NONE";
            return true;
        }

        internal static string SerializeSimulationTelemetry(BridgeSimulationTelemetry telemetry, string secret)
        {
            if (!TryValidateSecret(secret, out var normalizedSecret) ||
                !TryNormalizeSimulationTelemetry(telemetry, out var normalizedSessionId))
            {
                throw new InvalidOperationException("Simulation telemetry evidence is invalid.");
            }

            var values = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["protocol"] = SimulationTelemetryProtocol,
                ["sessionId"] = normalizedSessionId,
                ["processId"] = telemetry.ProcessId.ToString(CultureInfo.InvariantCulture),
                ["processStartedAtUnixMs"] = telemetry.ProcessStartedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["bridgeStartedAtUnixMs"] = telemetry.BridgeStartedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["sequence"] = telemetry.Sequence.ToString(CultureInfo.InvariantCulture),
                ["sampleStartedAtUnixMs"] = telemetry.SampleStartedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["sampleFinishedAtUnixMs"] = telemetry.SampleFinishedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["writtenAtUnixMs"] = telemetry.WrittenAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["windowDurationMs"] = telemetry.WindowDurationMs.ToString(CultureInfo.InvariantCulture),
                ["tickStarted"] = telemetry.TickStarted.ToString(CultureInfo.InvariantCulture),
                ["tickFinished"] = telemetry.TickFinished.ToString(CultureInfo.InvariantCulture),
                ["upsMilli"] = telemetry.UpsMilli.ToString(CultureInfo.InvariantCulture),
                ["tpsMilli"] = telemetry.TpsMilli.ToString(CultureInfo.InvariantCulture),
                ["upsSource"] = SimulationUpsSource,
                ["tpsSource"] = SimulationTpsSource
            };
            values["hmac"] = ComputeHmac(normalizedSecret, new[]
            {
                SimulationTelemetryProtocol,
                values["sessionId"],
                values["processId"],
                values["processStartedAtUnixMs"],
                values["bridgeStartedAtUnixMs"],
                values["sequence"],
                values["sampleStartedAtUnixMs"],
                values["sampleFinishedAtUnixMs"],
                values["writtenAtUnixMs"],
                values["windowDurationMs"],
                values["tickStarted"],
                values["tickFinished"],
                values["upsMilli"],
                values["tpsMilli"],
                SimulationUpsSource,
                SimulationTpsSource
            });
            return SerializeOrdered(SimulationTelemetryKeys, values, 1024);
        }

        internal static bool TryParseSimulationTelemetry(
            string payload,
            string secret,
            out BridgeSimulationTelemetry telemetry,
            out string errorCode)
        {
            telemetry = null;
            errorCode = "INVALID_SIMULATION_TELEMETRY";
            if (!TryValidateSecret(secret, out var normalizedSecret) ||
                !TryParseOrdered(payload, SimulationTelemetryKeys, out var values) ||
                values["protocol"] != SimulationTelemetryProtocol ||
                !TryParseRfcGuid(values["sessionId"], out var parsedSessionId) ||
                !TryParsePositiveLong(values["processId"], out var processId) || processId > int.MaxValue ||
                !TryParsePositiveLong(values["processStartedAtUnixMs"], out var processStartedAtUnixMs) ||
                !TryParsePositiveLong(values["bridgeStartedAtUnixMs"], out var bridgeStartedAtUnixMs) ||
                !TryParsePositiveLong(values["sequence"], out var sequence) ||
                !TryParsePositiveLong(values["sampleStartedAtUnixMs"], out var sampleStartedAtUnixMs) ||
                !TryParsePositiveLong(values["sampleFinishedAtUnixMs"], out var sampleFinishedAtUnixMs) ||
                !TryParsePositiveLong(values["writtenAtUnixMs"], out var writtenAtUnixMs) ||
                !TryParsePositiveLong(values["windowDurationMs"], out var windowDurationMs) ||
                !TryParseNonNegativeLong(values["tickStarted"], out var tickStarted) ||
                !TryParseNonNegativeLong(values["tickFinished"], out var tickFinished) ||
                !TryParseNonNegativeLong(values["upsMilli"], out var upsMilli) ||
                !TryParseNonNegativeLong(values["tpsMilli"], out var tpsMilli) ||
                values["upsSource"] != SimulationUpsSource || values["tpsSource"] != SimulationTpsSource ||
                !HmacPattern.IsMatch(values["hmac"]))
            {
                return false;
            }

            var normalizedSessionId = parsedSessionId.ToString("D").ToLowerInvariant();
            var expected = ComputeHmac(normalizedSecret, new[]
            {
                SimulationTelemetryProtocol,
                normalizedSessionId,
                values["processId"],
                values["processStartedAtUnixMs"],
                values["bridgeStartedAtUnixMs"],
                values["sequence"],
                values["sampleStartedAtUnixMs"],
                values["sampleFinishedAtUnixMs"],
                values["writtenAtUnixMs"],
                values["windowDurationMs"],
                values["tickStarted"],
                values["tickFinished"],
                values["upsMilli"],
                values["tpsMilli"],
                SimulationUpsSource,
                SimulationTpsSource
            });
            if (!FixedTimeEquals(values["hmac"], expected))
            {
                errorCode = "INVALID_SIGNATURE";
                return false;
            }

            var parsed = new BridgeSimulationTelemetry
            {
                SessionId = normalizedSessionId,
                ProcessId = (int)processId,
                ProcessStartedAtUnixMs = processStartedAtUnixMs,
                BridgeStartedAtUnixMs = bridgeStartedAtUnixMs,
                Sequence = sequence,
                SampleStartedAtUnixMs = sampleStartedAtUnixMs,
                SampleFinishedAtUnixMs = sampleFinishedAtUnixMs,
                WrittenAtUnixMs = writtenAtUnixMs,
                WindowDurationMs = windowDurationMs,
                TickStarted = tickStarted,
                TickFinished = tickFinished,
                UpsMilli = upsMilli,
                TpsMilli = tpsMilli
            };
            if (!TryNormalizeSimulationTelemetry(parsed, out _))
            {
                return false;
            }
            telemetry = parsed;
            errorCode = "NONE";
            return true;
        }

        private static bool TryNormalizeRuntimeSession(
            BridgeRuntimeSession session,
            out string normalizedSessionId)
        {
            normalizedSessionId = null;
            if (session == null || !TryParseRfcGuid(session.SessionId, out var parsedSessionId) ||
                !PluginVersionPattern.IsMatch(session.PluginVersion ?? string.Empty) ||
                session.ProcessId <= 0 || session.ProcessStartedAtUnixMs <= 0 ||
                session.BridgeStartedAtUnixMs < session.ProcessStartedAtUnixMs ||
                session.IssuedAtUnixMs < session.BridgeStartedAtUnixMs - 5000 ||
                session.IssuedAtUnixMs > session.BridgeStartedAtUnixMs + 120000)
            {
                return false;
            }
            normalizedSessionId = parsedSessionId.ToString("D").ToLowerInvariant();
            return true;
        }

        private static bool TryNormalizeLoadedSaveEvidence(
            BridgeLoadedSaveEvidence evidence,
            out string normalizedSessionId)
        {
            normalizedSessionId = null;
            if (evidence == null || !TryParseRfcGuid(evidence.SessionId, out var parsedSessionId) ||
                !PluginVersionPattern.IsMatch(evidence.PluginVersion ?? string.Empty) ||
                evidence.ProcessId <= 0 || evidence.ProcessStartedAtUnixMs <= 0 ||
                evidence.BridgeStartedAtUnixMs < evidence.ProcessStartedAtUnixMs ||
                evidence.ObservationGeneration <= 0 ||
                evidence.ObservedAtUnixMs < evidence.BridgeStartedAtUnixMs ||
                evidence.WrittenAtUnixMs < evidence.ObservedAtUnixMs ||
                evidence.WrittenAtUnixMs - evidence.ObservedAtUnixMs > 5000 ||
                !string.Equals(evidence.SaveName, LastExitSaveName, StringComparison.Ordinal) ||
                evidence.DsvBytes <= 0 || evidence.DsvWriteTimeUtcTicks <= 0 ||
                !LowerHexSha256Pattern.IsMatch(evidence.DsvSha256 ?? string.Empty) ||
                evidence.ServerBytes <= 0 || evidence.ServerWriteTimeUtcTicks <= 0 ||
                !LowerHexSha256Pattern.IsMatch(evidence.ServerSha256 ?? string.Empty))
            {
                return false;
            }
            normalizedSessionId = parsedSessionId.ToString("D").ToLowerInvariant();
            return true;
        }

        private static bool TryNormalizeSimulationTelemetry(
            BridgeSimulationTelemetry telemetry,
            out string normalizedSessionId)
        {
            normalizedSessionId = null;
            if (telemetry == null || !TryParseRfcGuid(telemetry.SessionId, out var parsedSessionId) ||
                telemetry.ProcessId <= 0 || telemetry.ProcessStartedAtUnixMs <= 0 ||
                telemetry.BridgeStartedAtUnixMs < telemetry.ProcessStartedAtUnixMs ||
                telemetry.Sequence <= 0 || telemetry.SampleStartedAtUnixMs <= 0 ||
                telemetry.SampleFinishedAtUnixMs < telemetry.SampleStartedAtUnixMs ||
                telemetry.WrittenAtUnixMs < telemetry.SampleFinishedAtUnixMs ||
                telemetry.WrittenAtUnixMs - telemetry.SampleFinishedAtUnixMs > 5000 ||
                telemetry.SampleFinishedAtUnixMs - telemetry.SampleStartedAtUnixMs > 120000 ||
                telemetry.SampleStartedAtUnixMs < telemetry.BridgeStartedAtUnixMs - 5000 ||
                telemetry.WindowDurationMs < 1000 || telemetry.WindowDurationMs > 10000 ||
                telemetry.TickStarted < 0 || telemetry.TickFinished < telemetry.TickStarted ||
                telemetry.UpsMilli < 0 || telemetry.UpsMilli > MaximumSimulationMilliRate ||
                telemetry.TpsMilli < 0 || telemetry.TpsMilli > MaximumSimulationMilliRate ||
                !IsTelemetryTpsConsistent(telemetry))
            {
                return false;
            }
            normalizedSessionId = parsedSessionId.ToString("D").ToLowerInvariant();
            return true;
        }

        private static bool IsTelemetryTpsConsistent(BridgeSimulationTelemetry telemetry)
        {
            var tickDelta = telemetry.TickFinished - telemetry.TickStarted;
            var expectedMilli = tickDelta * 1000000.0 / telemetry.WindowDurationMs;
            return !double.IsNaN(expectedMilli) && !double.IsInfinity(expectedMilli) &&
                   Math.Abs(expectedMilli - telemetry.TpsMilli) <= 1.0;
        }

        private static string SerializeOrdered(
            IReadOnlyList<string> keys,
            IReadOnlyDictionary<string, string> values,
            int capacity)
        {
            var builder = new StringBuilder(capacity);
            foreach (var key in keys)
            {
                builder.Append(key).Append('=').Append(values[key]).Append('\n');
            }
            var payload = builder.ToString();
            if (Encoding.UTF8.GetByteCount(payload) > 4096)
            {
                throw new InvalidOperationException("Bridge protocol payload exceeds its fixed bound.");
            }
            return payload;
        }

        internal static string SerializePlayerSnapshot(BridgePlayerSnapshot snapshot, string secret)
        {
            if (snapshot == null || !TryParseRfcGuid(snapshot.SessionId, out var parsedSessionId) ||
                snapshot.WrittenAtUnixMs <= 0 || snapshot.Sequence <= 0 ||
                (snapshot.State != "active" && snapshot.State != "inactive" && snapshot.State != "unavailable") ||
                snapshot.Players == null || snapshot.Players.Count > MaximumPlayers ||
                (snapshot.State != "active" && (snapshot.Players.Count != 0 || snapshot.Truncated)))
            {
                throw new InvalidOperationException("Player snapshot evidence is invalid.");
            }

            var orderedPlayers = snapshot.Players.OrderBy(player => player.SessionPlayerId, StringComparer.Ordinal).ToList();
            var seenPlayerIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var player in orderedPlayers)
            {
                if (player == null || !SessionPlayerIdPattern.IsMatch(player.SessionPlayerId ?? string.Empty) ||
                    !seenPlayerIds.Add(player.SessionPlayerId) ||
                    string.IsNullOrWhiteSpace(player.DisplayName) ||
                    CountUnicodeScalars(player.DisplayName) > 64 ||
                    Encoding.UTF8.GetByteCount(player.DisplayName) > 128 ||
                    player.DisplayName.IndexOf('\0') >= 0 || player.DisplayName.IndexOf('\r') >= 0 ||
                    player.DisplayName.IndexOf('\n') >= 0 || !player.Online ||
                    player.JoinedAtUnixMs <= 0 || player.JoinedAtUnixMs > snapshot.WrittenAtUnixMs + 5000 ||
                    !PlayerLocationPattern.IsMatch(player.Location ?? string.Empty))
                {
                    throw new InvalidOperationException("Player snapshot row is invalid.");
                }
            }

            var normalizedSessionId = parsedSessionId.ToString("D").ToLowerInvariant();
            var playersJson = SerializePlayersJson(orderedPlayers);
            var playersJsonB64 = ToBase64Url(Encoding.UTF8.GetBytes(playersJson));
            var values = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["protocol"] = PlayersProtocol,
                ["sessionId"] = normalizedSessionId,
                ["writtenAtUnixMs"] = snapshot.WrittenAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["sequence"] = snapshot.Sequence.ToString(CultureInfo.InvariantCulture),
                ["state"] = snapshot.State,
                ["truncated"] = snapshot.Truncated ? "true" : "false",
                ["playerCount"] = orderedPlayers.Count.ToString(CultureInfo.InvariantCulture),
                ["playersJsonB64"] = playersJsonB64
            };
            values["hmac"] = ComputeHmac(secret, new[]
            {
                PlayersProtocol,
                values["sessionId"],
                values["writtenAtUnixMs"],
                values["sequence"],
                values["state"],
                values["truncated"],
                values["playerCount"],
                playersJsonB64
            });

            var builder = new StringBuilder(1024);
            foreach (var key in PlayersKeys)
            {
                builder.Append(key).Append('=').Append(values[key]).Append('\n');
            }
            return builder.ToString();
        }

        internal static string SerializePlayerCapabilities(BridgePlayerCapabilitySnapshot snapshot, string secret)
        {
            if (snapshot == null || !TryParseRfcGuid(snapshot.SessionId, out var parsedSessionId) ||
                snapshot.WrittenAtUnixMs <= 0 ||
                !NebulaNoticeRuntimeCompatibility.IsKnownState(snapshot.NoticeRuntimeState))
            {
                throw new InvalidOperationException("Player capability evidence is invalid.");
            }
            if (!TryValidateSecret(secret, out var normalizedSecret))
            {
                throw new InvalidOperationException("Bridge secret is invalid.");
            }

            var normalizedSessionId = parsedSessionId.ToString("D").ToLowerInvariant();
            var verificationScope = NebulaNoticeRuntimeCompatibility.VerificationScope(snapshot.NoticeRuntimeState);
            var actionsEnabled = NebulaNoticeRuntimeCompatibility.ActionsEnabled(snapshot.NoticeRuntimeState);
            var capabilitiesJsonB64 = ToBase64Url(Encoding.UTF8.GetBytes(
                SerializePlayerCapabilitiesJson(snapshot.NoticeRuntimeState)));
            var values = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["protocol"] = PlayerCapabilitiesProtocol,
                ["verifiedUpstreamRepository"] = VerifiedNebulaRepository,
                ["verifiedUpstreamTag"] = VerifiedNebulaTag,
                ["verifiedRuntimeFileVersion"] = VerifiedNebulaRuntimeFileVersion,
                ["verifiedUpstreamCommit"] = VerifiedNebulaCommit,
                ["verificationScope"] = verificationScope,
                ["sessionId"] = normalizedSessionId,
                ["writtenAtUnixMs"] = snapshot.WrittenAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["actionsEnabled"] = actionsEnabled ? "true" : "false",
                ["capabilitiesJsonB64"] = capabilitiesJsonB64
            };
            values["hmac"] = ComputeHmac(normalizedSecret, new[]
            {
                PlayerCapabilitiesProtocol,
                VerifiedNebulaRepository,
                VerifiedNebulaTag,
                VerifiedNebulaRuntimeFileVersion,
                VerifiedNebulaCommit,
                verificationScope,
                normalizedSessionId,
                values["writtenAtUnixMs"],
                values["actionsEnabled"],
                capabilitiesJsonB64
            });

            var builder = new StringBuilder(2048);
            foreach (var key in PlayerCapabilitiesKeys)
            {
                builder.Append(key).Append('=').Append(values[key]).Append('\n');
            }
            return builder.ToString();
        }

        private static string SerializePlayerCapabilitiesJson(NebulaNoticeRuntimeState noticeRuntimeState)
        {
            return "[" +
                   "{\"capability\":\"observe-roster\",\"availability\":\"available\",\"mode\":\"read-only\",\"verifiedReasonCode\":\"UPSTREAM_ROSTER_API_VERIFIED\"}," +
                   "{\"capability\":\"disconnect\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_CONNECTED_DISCONNECT_UNSAFE\"}," +
                   "{\"capability\":\"kick\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_KICK_API_ABSENT\"}," +
                   "{\"capability\":\"ban\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_BAN_API_ABSENT\"}," +
                   "{\"capability\":\"whitelist\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_WHITELIST_API_ABSENT\"}," +
                   "{\"capability\":\"blacklist\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_BLACKLIST_API_ABSENT\"}," +
                   "{\"capability\":\"notice\",\"availability\":\"" +
                   NebulaNoticeRuntimeCompatibility.NoticeAvailability(noticeRuntimeState) +
                   "\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"" +
                   NebulaNoticeRuntimeCompatibility.NoticeReasonCode(noticeRuntimeState) + "\"}," +
                   "{\"capability\":\"permission\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_PERMISSION_API_ABSENT\"}" +
                   "]";
        }

        private static string SerializePlayersJson(IReadOnlyList<BridgePlayerEntry> players)
        {
            var builder = new StringBuilder(512);
            builder.Append('[');
            for (var index = 0; index < players.Count; index++)
            {
                if (index > 0)
                {
                    builder.Append(',');
                }
                var player = players[index];
                builder.Append("{\"sessionPlayerId\":\"");
                AppendJsonString(builder, player.SessionPlayerId);
                builder.Append("\",\"displayName\":\"");
                AppendJsonString(builder, player.DisplayName);
                builder.Append("\",\"online\":true,\"joinedAtUnixMs\":")
                    .Append(player.JoinedAtUnixMs.ToString(CultureInfo.InvariantCulture));
                builder.Append(",\"location\":\"");
                AppendJsonString(builder, player.Location);
                builder.Append("\"}");
            }
            builder.Append(']');
            return builder.ToString();
        }

        private static void AppendJsonString(StringBuilder builder, string value)
        {
            foreach (var character in value)
            {
                switch (character)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append('\\').Append('\\'); break;
                    case '\b': builder.Append("\\b"); break;
                    case '\f': builder.Append("\\f"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (character < 0x20)
                        {
                            builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(character);
                        }
                        break;
                }
            }
        }

        private static string ToBase64Url(byte[] value)
        {
            return Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        private static int CountUnicodeScalars(string value)
        {
            var count = 0;
            for (var index = 0; index < value.Length; index++)
            {
                if (char.IsHighSurrogate(value[index]) && index + 1 < value.Length &&
                    char.IsLowSurrogate(value[index + 1]))
                {
                    index++;
                }
                count++;
            }
            return count;
        }

        private static bool TryParseOrdered(
            string payload,
            IReadOnlyList<string> keys,
            out Dictionary<string, string> values)
        {
            values = null;
            if (payload == null || Encoding.UTF8.GetByteCount(payload) > 4096 ||
                payload.IndexOf('\0') >= 0 || payload.IndexOf('\uFEFF') >= 0)
            {
                return false;
            }
            var lines = payload.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
            var lineCount = lines.Length;
            if (lineCount > 0 && lines[lineCount - 1].Length == 0)
            {
                lineCount--;
            }
            if (lineCount != keys.Count)
            {
                return false;
            }

            var parsed = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var index = 0; index < keys.Count; index++)
            {
                var prefix = keys[index] + "=";
                var line = lines[index];
                if (!line.StartsWith(prefix, StringComparison.Ordinal))
                {
                    return false;
                }
                var value = line.Substring(prefix.Length);
                if (value.Length == 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0 || value.IndexOf('\0') >= 0)
                {
                    return false;
                }
                parsed.Add(keys[index], value);
            }
            values = parsed;
            return true;
        }

        private static bool TryParsePositiveLong(string value, out long parsed)
        {
            parsed = 0;
            return CanonicalUnsignedDecimalPattern.IsMatch(value ?? string.Empty) &&
                   long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) && parsed > 0;
        }

        private static bool TryParseNonNegativeLong(string value, out long parsed)
        {
            parsed = 0;
            return CanonicalUnsignedDecimalPattern.IsMatch(value ?? string.Empty) &&
                   long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed);
        }

        private static bool TryParseRfcGuid(string value, out Guid parsed)
        {
            parsed = Guid.Empty;
            return RfcGuidPattern.IsMatch(value ?? string.Empty) &&
                   Guid.TryParseExact(value, "D", out parsed);
        }

        private static string ComputeHmac(string secret, IEnumerable<string> parts)
        {
            using (var algorithm = new HMACSHA256(Encoding.UTF8.GetBytes(secret)))
            {
                var bytes = Encoding.UTF8.GetBytes(string.Join("\n", parts));
                var hash = algorithm.ComputeHash(bytes);
                StringBuilder builder = new StringBuilder(hash.Length * 2);
                foreach (var value in hash)
                {
                    builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                }
                return builder.ToString();
            }
        }

        private static bool FixedTimeEquals(string actualHex, string expectedHex)
        {
            if (actualHex == null || expectedHex == null || actualHex.Length != expectedHex.Length)
            {
                return false;
            }
            var difference = 0;
            for (var index = 0; index < actualHex.Length; index++)
            {
                difference |= char.ToLowerInvariant(actualHex[index]) ^ char.ToLowerInvariant(expectedHex[index]);
            }
            return difference == 0;
        }
    }

    internal sealed class BridgeRequest
    {
        internal string RequestId { get; set; }
        internal long CreatedAtUnixMs { get; set; }
        internal long ExpiresAtUnixMs { get; set; }
        internal string Nonce { get; set; }
    }

    internal sealed class BridgeReceipt
    {
        internal string RequestId { get; set; }
        internal string State { get; set; }
        internal long StartedAtUnixMs { get; set; }
        internal long FinishedAtUnixMs { get; set; }
        internal string SaveName { get; set; }
        internal long SaveTimeBefore { get; set; } = -1;
        internal long SaveTimeAfter { get; set; } = -1;
        internal long DsvBytes { get; set; } = -1;
        internal long DsvWriteTimeUtcTicks { get; set; } = -1;
        internal long ServerBytes { get; set; } = -1;
        internal long ServerWriteTimeUtcTicks { get; set; } = -1;
        internal bool DsvChanged { get; set; }
        internal bool ServerChanged { get; set; }
        internal string ErrorCode { get; set; }
    }

    internal sealed class SaveObservation : IEquatable<SaveObservation>
    {
        internal bool PairPresent { get; set; }
        internal long DsvBytes { get; set; } = -1;
        internal long DsvWriteTimeUtcTicks { get; set; } = -1;
        internal long ServerBytes { get; set; } = -1;
        internal long ServerWriteTimeUtcTicks { get; set; } = -1;
        internal long SaveTime { get; set; } = -1;

        internal bool DsvChangedFrom(SaveObservation before)
        {
            if (before == null)
            {
                throw new ArgumentNullException(nameof(before));
            }
            return DsvBytes != before.DsvBytes ||
                   DsvWriteTimeUtcTicks != before.DsvWriteTimeUtcTicks;
        }

        internal bool ServerChangedFrom(SaveObservation before)
        {
            if (before == null)
            {
                throw new ArgumentNullException(nameof(before));
            }
            return ServerBytes != before.ServerBytes ||
                   ServerWriteTimeUtcTicks != before.ServerWriteTimeUtcTicks;
        }

        public bool Equals(SaveObservation other)
        {
            return other != null && PairPresent == other.PairPresent && DsvBytes == other.DsvBytes &&
                   DsvWriteTimeUtcTicks == other.DsvWriteTimeUtcTicks &&
                   ServerBytes == other.ServerBytes &&
                   ServerWriteTimeUtcTicks == other.ServerWriteTimeUtcTicks && SaveTime == other.SaveTime;
        }

        public override bool Equals(object obj)
        {
            return Equals(obj as SaveObservation);
        }

        public override int GetHashCode()
        {
            unchecked
            {
                var hash = PairPresent ? 17 : 31;
                hash = hash * 31 + DsvBytes.GetHashCode();
                hash = hash * 31 + DsvWriteTimeUtcTicks.GetHashCode();
                hash = hash * 31 + ServerBytes.GetHashCode();
                hash = hash * 31 + ServerWriteTimeUtcTicks.GetHashCode();
                hash = hash * 31 + SaveTime.GetHashCode();
                return hash;
            }
        }
    }

    internal static class BridgeMonotonicTime
    {
        internal static long NowTicks()
        {
            return Stopwatch.GetTimestamp();
        }

        internal static long DurationTicks(long milliseconds)
        {
            if (milliseconds < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(milliseconds));
            }
            checked
            {
                var wholeSeconds = milliseconds / 1000;
                var remainingMilliseconds = milliseconds % 1000;
                var wholeTicks = wholeSeconds * Stopwatch.Frequency;
                var partialTicks = (remainingMilliseconds * Stopwatch.Frequency + 999) / 1000;
                return wholeTicks + partialTicks;
            }
        }

        internal static long DeadlineAfter(long startedAtTicks, long durationTicks)
        {
            if (startedAtTicks < 0 || durationTicks < 0)
            {
                throw new ArgumentOutOfRangeException();
            }
            return startedAtTicks > long.MaxValue - durationTicks
                ? long.MaxValue
                : startedAtTicks + durationTicks;
        }

        internal static bool HasElapsed(long startedAtTicks, long nowTicks, long durationTicks)
        {
            if (startedAtTicks < 0 || nowTicks < 0 || durationTicks < 0)
            {
                throw new ArgumentOutOfRangeException();
            }
            return nowTicks >= startedAtTicks && nowTicks - startedAtTicks >= durationTicks;
        }
    }

    /// <summary>
    /// Proves exactly the immutable tuple captured immediately after
    /// GameSave.SaveCurrentGame returned. Nebula v0.9.22 writes .server before
    /// .dsv, so the immediate tuple must be complete, LastSaveTime must advance,
    /// and both file identities must differ from the pre-call tuple. The
    /// stability window may only confirm that tuple; any later mismatch is
    /// permanently unstable, even if the tuple subsequently returns.
    /// </summary>
    internal sealed class SaveObservationStabilityTracker
    {
        private readonly SaveObservation target;
        private readonly long stableSinceMonotonicTicks;
        private bool unstable;

        internal SaveObservationStabilityTracker(
            SaveObservation before,
            SaveObservation immediateTarget,
            long capturedAtMonotonicTicks)
        {
            if (before == null)
            {
                throw new ArgumentNullException(nameof(before));
            }
            if (immediateTarget == null)
            {
                throw new ArgumentNullException(nameof(immediateTarget));
            }
            if (capturedAtMonotonicTicks < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(capturedAtMonotonicTicks));
            }
            if (!immediateTarget.PairPresent || immediateTarget.DsvBytes <= 0 ||
                immediateTarget.DsvWriteTimeUtcTicks <= 0 || immediateTarget.ServerBytes <= 0 ||
                immediateTarget.ServerWriteTimeUtcTicks <= 0 ||
                immediateTarget.SaveTime <= before.SaveTime ||
                !immediateTarget.DsvChangedFrom(before) ||
                !immediateTarget.ServerChangedFrom(before))
            {
                throw new ArgumentException("The immediate post-call tuple is ineligible.", nameof(immediateTarget));
            }

            target = Copy(immediateTarget);
            stableSinceMonotonicTicks = capturedAtMonotonicTicks;
        }

        internal bool DsvChanged => true;
        internal bool ServerChanged => true;
        internal bool IsUnstable => unstable;
        internal SaveObservation Target => Copy(target);

        internal bool Observe(SaveObservation current, long nowMonotonicTicks, long stabilityTicks)
        {
            if (current == null)
            {
                throw new ArgumentNullException(nameof(current));
            }
            if (nowMonotonicTicks < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(nowMonotonicTicks));
            }
            if (stabilityTicks < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(stabilityTicks));
            }
            if (unstable)
            {
                return false;
            }
            if (nowMonotonicTicks < stableSinceMonotonicTicks || !target.Equals(current))
            {
                unstable = true;
                return false;
            }
            return BridgeMonotonicTime.HasElapsed(
                stableSinceMonotonicTicks,
                nowMonotonicTicks,
                stabilityTicks);
        }

        private static SaveObservation Copy(SaveObservation source)
        {
            return new SaveObservation
            {
                PairPresent = source.PairPresent,
                DsvBytes = source.DsvBytes,
                DsvWriteTimeUtcTicks = source.DsvWriteTimeUtcTicks,
                ServerBytes = source.ServerBytes,
                ServerWriteTimeUtcTicks = source.ServerWriteTimeUtcTicks,
                SaveTime = source.SaveTime
            };
        }
    }

    internal sealed class BridgeHeartbeat
    {
        internal string PluginVersion { get; set; }
        internal int ProcessId { get; set; }
        internal long StartedAtUnixMs { get; set; }
        internal long WrittenAtUnixMs { get; set; }
    }

    internal sealed class BridgeLoadedSaveEvidence
    {
        internal string SessionId { get; set; }
        internal string PluginVersion { get; set; }
        internal int ProcessId { get; set; }
        internal long ProcessStartedAtUnixMs { get; set; }
        internal long BridgeStartedAtUnixMs { get; set; }
        internal long ObservationGeneration { get; set; }
        internal long ObservedAtUnixMs { get; set; }
        internal long WrittenAtUnixMs { get; set; }
        internal string SaveName { get; set; }
        internal long DsvBytes { get; set; }
        internal long DsvWriteTimeUtcTicks { get; set; }
        internal string DsvSha256 { get; set; }
        internal long ServerBytes { get; set; }
        internal long ServerWriteTimeUtcTicks { get; set; }
        internal string ServerSha256 { get; set; }
    }

    internal sealed class BridgeRuntimeSession
    {
        internal string SessionId { get; set; }
        internal string PluginVersion { get; set; }
        internal int ProcessId { get; set; }
        internal long ProcessStartedAtUnixMs { get; set; }
        internal long BridgeStartedAtUnixMs { get; set; }
        internal long IssuedAtUnixMs { get; set; }
    }

    internal sealed class BridgeSimulationTelemetry
    {
        internal string SessionId { get; set; }
        internal int ProcessId { get; set; }
        internal long ProcessStartedAtUnixMs { get; set; }
        internal long BridgeStartedAtUnixMs { get; set; }
        internal long Sequence { get; set; }
        internal long SampleStartedAtUnixMs { get; set; }
        internal long SampleFinishedAtUnixMs { get; set; }
        internal long WrittenAtUnixMs { get; set; }
        internal long WindowDurationMs { get; set; }
        internal long TickStarted { get; set; }
        internal long TickFinished { get; set; }
        internal long UpsMilli { get; set; }
        internal long TpsMilli { get; set; }
    }

    internal sealed class BridgePlayerSnapshot
    {
        internal string SessionId { get; set; }
        internal long WrittenAtUnixMs { get; set; }
        internal long Sequence { get; set; }
        internal string State { get; set; }
        internal bool Truncated { get; set; }
        internal IReadOnlyList<BridgePlayerEntry> Players { get; set; }
    }

    internal sealed class BridgePlayerCapabilitySnapshot
    {
        internal string SessionId { get; set; }
        internal long WrittenAtUnixMs { get; set; }
        internal NebulaNoticeRuntimeState NoticeRuntimeState { get; set; }
    }

    internal sealed class BridgePlayerEntry
    {
        internal string SessionPlayerId { get; set; }
        internal string DisplayName { get; set; }
        internal bool Online { get; set; }
        internal long JoinedAtUnixMs { get; set; }
        internal string Location { get; set; }
    }
}
