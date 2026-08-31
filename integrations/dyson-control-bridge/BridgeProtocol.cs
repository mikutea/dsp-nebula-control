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
        internal const string PlayersProtocol = "DYSON_CONTROL_PLAYERS_V1";
        internal const string PlayerCapabilitiesProtocol = "DYSON_CONTROL_PLAYER_CAPABILITIES_V1";
        internal const string VerifiedNebulaRepository = "NebulaModTeam/nebula";
        internal const string VerifiedNebulaTag = "v0.9.22";
        internal const string VerifiedNebulaRuntimeFileVersion = "0.9.22.2";
        internal const string VerifiedNebulaCommit = "3cdf95c594a2f8010b0e87a43be828e6ba2f657f";
        internal const string PlayerCapabilityVerificationScope = "source-contract-only-runtime-unverified";
        internal const int MaximumPlayers = 64;

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
            "\\A[A-Za-z0-9_-]{22,64}\\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex HmacPattern = new Regex(
            "\\A[0-9A-Fa-f]{64}\\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex ErrorCodePattern = new Regex(
            "\\A(?:NONE|[A-Z][A-Z0-9_]{2,47})\\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex SessionPlayerIdPattern = new Regex(
            "\\Aplayer-[0-9]{6,12}\\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex PlayerLocationPattern = new Regex(
            "\\A(?:deep-space|planet:[1-9][0-9]{0,9}|star:[1-9][0-9]{0,9})\\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex PluginVersionPattern = new Regex(
            "\\A[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]{1,32})?\\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex RfcGuidPattern = new Regex(
            "\\A[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}\\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex CanonicalUnsignedDecimalPattern = new Regex(
            "\\A(?:0|[1-9][0-9]*)\\z",
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
                snapshot.WrittenAtUnixMs <= 0)
            {
                throw new InvalidOperationException("Player capability evidence is invalid.");
            }
            if (!TryValidateSecret(secret, out var normalizedSecret))
            {
                throw new InvalidOperationException("Bridge secret is invalid.");
            }

            var normalizedSessionId = parsedSessionId.ToString("D").ToLowerInvariant();
            var capabilitiesJsonB64 = ToBase64Url(Encoding.UTF8.GetBytes(SerializePlayerCapabilitiesJson()));
            var values = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["protocol"] = PlayerCapabilitiesProtocol,
                ["verifiedUpstreamRepository"] = VerifiedNebulaRepository,
                ["verifiedUpstreamTag"] = VerifiedNebulaTag,
                ["verifiedRuntimeFileVersion"] = VerifiedNebulaRuntimeFileVersion,
                ["verifiedUpstreamCommit"] = VerifiedNebulaCommit,
                ["verificationScope"] = PlayerCapabilityVerificationScope,
                ["sessionId"] = normalizedSessionId,
                ["writtenAtUnixMs"] = snapshot.WrittenAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["actionsEnabled"] = "false",
                ["capabilitiesJsonB64"] = capabilitiesJsonB64
            };
            values["hmac"] = ComputeHmac(normalizedSecret, new[]
            {
                PlayerCapabilitiesProtocol,
                VerifiedNebulaRepository,
                VerifiedNebulaTag,
                VerifiedNebulaRuntimeFileVersion,
                VerifiedNebulaCommit,
                PlayerCapabilityVerificationScope,
                normalizedSessionId,
                values["writtenAtUnixMs"],
                "false",
                capabilitiesJsonB64
            });

            var builder = new StringBuilder(2048);
            foreach (var key in PlayerCapabilitiesKeys)
            {
                builder.Append(key).Append('=').Append(values[key]).Append('\n');
            }
            return builder.ToString();
        }

        private static string SerializePlayerCapabilitiesJson()
        {
            return "[" +
                   "{\"capability\":\"observe-roster\",\"availability\":\"available\",\"mode\":\"read-only\",\"verifiedReasonCode\":\"UPSTREAM_ROSTER_API_VERIFIED\"}," +
                   "{\"capability\":\"disconnect\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_CONNECTED_DISCONNECT_UNSAFE\"}," +
                   "{\"capability\":\"kick\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_KICK_API_ABSENT\"}," +
                   "{\"capability\":\"ban\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_BAN_API_ABSENT\"}," +
                   "{\"capability\":\"whitelist\",\"availability\":\"unavailable\",\"mode\":\"mutation\",\"verifiedReasonCode\":\"UPSTREAM_WHITELIST_API_ABSENT\"}," +
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
                    case '\\': builder.Append("\\\\"); break;
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
