using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace DysonControl.Bridge
{
    /// <summary>
    /// Strict, separate protocol for the only verified player mutation. Notice text is selected from
    /// this bridge-owned allowlist; callers cannot supply chat text or a raw Nebula player identifier.
    /// </summary>
    internal static class PlayerNoticeProtocol
    {
        internal const string RequestProtocol = "DYSON_CONTROL_PLAYER_NOTICE_REQUEST_V1";
        internal const string ReceiptProtocol = "DYSON_CONTROL_PLAYER_NOTICE_RECEIPT_V1";
        internal const string Action = "player.notice";
        internal const string Rollback = "not-possible";
        internal const int MaximumPayloadBytes = 4096;

        private static readonly string[] RequestKeys =
        {
            "protocol", "requestId", "createdAtUnixMs", "expiresAtUnixMs", "action",
            "rosterSessionId", "rosterSequence", "sessionPlayerId", "targetJoinedAtUnixMs",
            "templateId", "nonce", "hmac"
        };

        private static readonly string[] ReceiptKeys =
        {
            "protocol", "requestId", "action", "state", "startedAtUnixMs", "finishedAtUnixMs",
            "rosterSessionId", "rosterSequence", "sessionPlayerId", "targetJoinedAtUnixMs",
            "templateId", "mutationMayHaveOccurred", "recoveryRequired", "rollback", "errorCode", "hmac"
        };

        private static readonly Regex NoncePattern = new Regex(
            @"\A[A-Za-z0-9_-]{22,64}\z", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex HmacPattern = new Regex(
            @"\A[0-9A-Fa-f]{64}\z", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex ErrorCodePattern = new Regex(
            @"\A(?:NONE|[A-Z][A-Z0-9_]{2,47})\z", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex SessionPlayerIdPattern = new Regex(
            @"\Aplayer-[0-9]{6,12}\z", RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex TemplateIdPattern = new Regex(
            @"\A(?:maintenance-5m|maintenance-now|reconnect-required)\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex RfcGuidPattern = new Regex(
            @"\A[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}\z",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);
        private static readonly Regex PositiveDecimalPattern = new Regex(
            @"\A[1-9][0-9]*\z", RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly IReadOnlyDictionary<string, string> Templates =
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["maintenance-5m"] = "[Server] Scheduled maintenance will begin in 5 minutes. Please finish current work.",
                ["maintenance-now"] = "[Server] Scheduled maintenance is starting now. Please reconnect after service returns.",
                ["reconnect-required"] = "[Server] The server was updated. Please reconnect to continue."
            };

        internal static bool TryResolveTemplate(string templateId, out string message)
        {
            message = null;
            return templateId != null && Templates.TryGetValue(templateId, out message);
        }

        internal static bool TryParseRequest(
            string payload,
            string secret,
            out PlayerNoticeRequest request,
            out string errorCode)
        {
            request = null;
            errorCode = "INVALID_REQUEST";
            if (!BridgeProtocol.TryValidateSecret(secret, out var normalizedSecret) ||
                !TryParseOrdered(payload, RequestKeys, out var values) ||
                values["protocol"] != RequestProtocol || values["action"] != Action ||
                !TryParseRfcGuid(values["requestId"], out var requestId) ||
                !TryParsePositiveLong(values["createdAtUnixMs"], out var createdAtUnixMs) ||
                !TryParsePositiveLong(values["expiresAtUnixMs"], out var expiresAtUnixMs) ||
                expiresAtUnixMs <= createdAtUnixMs || expiresAtUnixMs - createdAtUnixMs > 30000 ||
                !TryParseRfcGuid(values["rosterSessionId"], out var rosterSessionId) ||
                !TryParsePositiveLong(values["rosterSequence"], out var rosterSequence) ||
                !SessionPlayerIdPattern.IsMatch(values["sessionPlayerId"]) ||
                !TryParsePositiveLong(values["targetJoinedAtUnixMs"], out var targetJoinedAtUnixMs) ||
                !TemplateIdPattern.IsMatch(values["templateId"]) ||
                !NoncePattern.IsMatch(values["nonce"]) || !HmacPattern.IsMatch(values["hmac"]))
            {
                return false;
            }

            var normalizedRequestId = requestId.ToString("D").ToLowerInvariant();
            var normalizedSessionId = rosterSessionId.ToString("D").ToLowerInvariant();
            var canonical = RequestKeys.Take(RequestKeys.Length - 1).Select(key => key switch
            {
                "requestId" => normalizedRequestId,
                "createdAtUnixMs" => createdAtUnixMs.ToString(CultureInfo.InvariantCulture),
                "expiresAtUnixMs" => expiresAtUnixMs.ToString(CultureInfo.InvariantCulture),
                "rosterSessionId" => normalizedSessionId,
                "rosterSequence" => rosterSequence.ToString(CultureInfo.InvariantCulture),
                "targetJoinedAtUnixMs" => targetJoinedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                _ => values[key]
            });
            if (!FixedTimeEquals(values["hmac"], ComputeHmac(normalizedSecret, canonical)))
            {
                errorCode = "INVALID_SIGNATURE";
                return false;
            }

            request = new PlayerNoticeRequest
            {
                RequestId = normalizedRequestId,
                CreatedAtUnixMs = createdAtUnixMs,
                ExpiresAtUnixMs = expiresAtUnixMs,
                RosterSessionId = normalizedSessionId,
                RosterSequence = rosterSequence,
                SessionPlayerId = values["sessionPlayerId"],
                TargetJoinedAtUnixMs = targetJoinedAtUnixMs,
                TemplateId = values["templateId"],
                Nonce = values["nonce"]
            };
            errorCode = "NONE";
            return true;
        }

        internal static string SerializeReceipt(PlayerNoticeReceipt receipt, string secret)
        {
            if (receipt == null || !BridgeProtocol.TryValidateSecret(secret, out var normalizedSecret) ||
                !TryParseRfcGuid(receipt.RequestId, out var requestId) ||
                !TryParseRfcGuid(receipt.RosterSessionId, out var rosterSessionId) ||
                receipt.StartedAtUnixMs <= 0 || receipt.FinishedAtUnixMs < receipt.StartedAtUnixMs ||
                receipt.RosterSequence <= 0 || receipt.TargetJoinedAtUnixMs <= 0 ||
                !SessionPlayerIdPattern.IsMatch(receipt.SessionPlayerId ?? string.Empty) ||
                !TemplateIdPattern.IsMatch(receipt.TemplateId ?? string.Empty) ||
                !ErrorCodePattern.IsMatch(receipt.ErrorCode ?? string.Empty) ||
                (receipt.State != "transport-dispatched" && receipt.State != "rejected" &&
                 receipt.State != "failed" && receipt.State != "uncertain"))
            {
                throw new InvalidOperationException("Player notice receipt is invalid.");
            }

            if ((receipt.State == "transport-dispatched" &&
                 (!receipt.MutationMayHaveOccurred || receipt.RecoveryRequired || receipt.ErrorCode != "NONE")) ||
                (receipt.State == "uncertain" &&
                 (!receipt.MutationMayHaveOccurred || !receipt.RecoveryRequired || receipt.ErrorCode == "NONE")) ||
                ((receipt.State == "failed" || receipt.State == "rejected") &&
                 (receipt.MutationMayHaveOccurred || receipt.RecoveryRequired || receipt.ErrorCode == "NONE")))
            {
                throw new InvalidOperationException("Player notice receipt state evidence is inconsistent.");
            }

            var values = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["protocol"] = ReceiptProtocol,
                ["requestId"] = requestId.ToString("D").ToLowerInvariant(),
                ["action"] = Action,
                ["state"] = receipt.State,
                ["startedAtUnixMs"] = receipt.StartedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["finishedAtUnixMs"] = receipt.FinishedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["rosterSessionId"] = rosterSessionId.ToString("D").ToLowerInvariant(),
                ["rosterSequence"] = receipt.RosterSequence.ToString(CultureInfo.InvariantCulture),
                ["sessionPlayerId"] = receipt.SessionPlayerId,
                ["targetJoinedAtUnixMs"] = receipt.TargetJoinedAtUnixMs.ToString(CultureInfo.InvariantCulture),
                ["templateId"] = receipt.TemplateId,
                ["mutationMayHaveOccurred"] = receipt.MutationMayHaveOccurred ? "true" : "false",
                ["recoveryRequired"] = receipt.RecoveryRequired ? "true" : "false",
                ["rollback"] = Rollback,
                ["errorCode"] = receipt.ErrorCode
            };
            values["hmac"] = ComputeHmac(
                normalizedSecret,
                ReceiptKeys.Take(ReceiptKeys.Length - 1).Select(key => values[key]));

            var builder = new StringBuilder(768);
            foreach (var key in ReceiptKeys)
            {
                builder.Append(key).Append('=').Append(values[key]).Append('\n');
            }
            return builder.ToString();
        }

        private static bool TryParseOrdered(
            string payload,
            IReadOnlyList<string> keys,
            out Dictionary<string, string> values)
        {
            values = new Dictionary<string, string>(StringComparer.Ordinal);
            if (payload == null || payload.Length == 0 || Encoding.UTF8.GetByteCount(payload) > MaximumPayloadBytes ||
                payload.IndexOf('\0') >= 0 || payload[0] == '\uFEFF')
            {
                return false;
            }
            var lines = payload.Replace("\r\n", "\n").Split('\n');
            var count = lines.Length > 0 && lines[lines.Length - 1].Length == 0 ? lines.Length - 1 : lines.Length;
            if (count != keys.Count)
            {
                return false;
            }
            for (var index = 0; index < keys.Count; index++)
            {
                var prefix = keys[index] + "=";
                var line = lines[index];
                if (!line.StartsWith(prefix, StringComparison.Ordinal))
                {
                    return false;
                }
                var value = line.Substring(prefix.Length);
                if (value.Length == 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0 || value.IndexOf('\uFEFF') >= 0)
                {
                    return false;
                }
                values[keys[index]] = value;
            }
            return true;
        }

        private static bool TryParseRfcGuid(string value, out Guid parsed)
        {
            parsed = Guid.Empty;
            return RfcGuidPattern.IsMatch(value ?? string.Empty) && Guid.TryParseExact(value, "D", out parsed);
        }

        private static bool TryParsePositiveLong(string value, out long parsed)
        {
            parsed = 0;
            return PositiveDecimalPattern.IsMatch(value ?? string.Empty) &&
                   long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) && parsed > 0;
        }

        private static string ComputeHmac(string secret, IEnumerable<string> fields)
        {
            using (var algorithm = new HMACSHA256(Encoding.UTF8.GetBytes(secret)))
            {
                var digest = algorithm.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n", fields)));
                return string.Concat(digest.Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
            }
        }

        private static bool FixedTimeEquals(string actual, string expected)
        {
            if (actual == null || expected == null || actual.Length != expected.Length)
            {
                return false;
            }
            var difference = 0;
            for (var index = 0; index < actual.Length; index++)
            {
                difference |= char.ToLowerInvariant(actual[index]) ^ expected[index];
            }
            return difference == 0;
        }
    }

    internal sealed class PlayerNoticeRequest
    {
        internal string RequestId { get; set; }
        internal long CreatedAtUnixMs { get; set; }
        internal long ExpiresAtUnixMs { get; set; }
        internal string RosterSessionId { get; set; }
        internal long RosterSequence { get; set; }
        internal string SessionPlayerId { get; set; }
        internal long TargetJoinedAtUnixMs { get; set; }
        internal string TemplateId { get; set; }
        internal string Nonce { get; set; }
    }

    internal sealed class PlayerNoticeReceipt
    {
        internal string RequestId { get; set; }
        internal string State { get; set; }
        internal long StartedAtUnixMs { get; set; }
        internal long FinishedAtUnixMs { get; set; }
        internal string RosterSessionId { get; set; }
        internal long RosterSequence { get; set; }
        internal string SessionPlayerId { get; set; }
        internal long TargetJoinedAtUnixMs { get; set; }
        internal string TemplateId { get; set; }
        internal bool MutationMayHaveOccurred { get; set; }
        internal bool RecoveryRequired { get; set; }
        internal string ErrorCode { get; set; }
    }
}
