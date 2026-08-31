using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using NebulaAPI;
using NebulaAPI.GameState;
using NebulaModel.Networking;

namespace DysonControl.Bridge
{
    /// <summary>
    /// Publishes a read-only, privacy-bounded view of Nebula's authoritative connected-player collection.
    /// It deliberately exposes no connection handles, network endpoints, Steam data, or moderation actions.
    /// </summary>
    internal sealed class PlayerRosterPublisher : IDisposable
    {
        private const long PublishIntervalMilliseconds = 2000;
        private readonly object gate = new object();
        private readonly BridgeFileStore store;
        private readonly Dictionary<ushort, RosterEntry> roster = new Dictionary<ushort, RosterEntry>();
        private string sessionId = Guid.NewGuid().ToString("D").ToLowerInvariant();
        private long nextPublishUnixMs;
        private long nextPlayerOrdinal;
        private long sequence;
        private bool dirty = true;
        private bool sessionActive;
        private bool disposed;

        internal PlayerRosterPublisher(BridgeFileStore store)
        {
            this.store = store ?? throw new ArgumentNullException(nameof(store));
            NebulaModAPI.OnMultiplayerGameStarted += OnMultiplayerGameStarted;
            NebulaModAPI.OnMultiplayerGameEnded += OnMultiplayerGameEnded;
            NebulaModAPI.OnPlayerJoinedGame += OnPlayerJoinedGame;
            NebulaModAPI.OnPlayerLeftGame += OnPlayerLeftGame;

            if (NebulaModAPI.IsMultiplayerActive)
            {
                OnMultiplayerGameStarted();
            }
        }

        internal void Tick(long nowUnixMs)
        {
            if (disposed || nowUnixMs <= 0)
            {
                return;
            }

            lock (gate)
            {
                if (!dirty && nowUnixMs < nextPublishUnixMs)
                {
                    return;
                }
                dirty = false;
                nextPublishUnixMs = nowUnixMs + PublishIntervalMilliseconds;
            }

            PublishAuthoritativeSnapshot(nowUnixMs);
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            NebulaModAPI.OnMultiplayerGameStarted -= OnMultiplayerGameStarted;
            NebulaModAPI.OnMultiplayerGameEnded -= OnMultiplayerGameEnded;
            NebulaModAPI.OnPlayerJoinedGame -= OnPlayerJoinedGame;
            NebulaModAPI.OnPlayerLeftGame -= OnPlayerLeftGame;
        }

        private void OnMultiplayerGameStarted()
        {
            lock (gate)
            {
                sessionId = Guid.NewGuid().ToString("D").ToLowerInvariant();
                sequence = 0;
                nextPlayerOrdinal = 0;
                roster.Clear();
                sessionActive = true;
                dirty = true;
            }
        }

        private void OnMultiplayerGameEnded()
        {
            lock (gate)
            {
                sessionActive = false;
                roster.Clear();
                dirty = true;
            }
        }

        private void OnPlayerJoinedGame(IPlayerData playerData)
        {
            if (playerData == null)
            {
                return;
            }
            var nowUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            lock (gate)
            {
                Upsert(playerData, nowUnixMs, true);
                dirty = true;
            }
        }

        private void OnPlayerLeftGame(IPlayerData playerData)
        {
            if (playerData == null)
            {
                return;
            }
            lock (gate)
            {
                roster.Remove(playerData.PlayerId);
                dirty = true;
            }
        }

        private void PublishAuthoritativeSnapshot(long nowUnixMs)
        {
            bool active;
            lock (gate)
            {
                active = sessionActive;
            }
            if (!active || !NebulaModAPI.IsMultiplayerActive || NebulaModAPI.MultiplayerSession == null)
            {
                WriteSnapshot(nowUnixMs, "inactive", false, Array.Empty<BridgePlayerEntry>());
                return;
            }

            try
            {
                var session = NebulaModAPI.MultiplayerSession;
                if (!session.IsServer || !(session.Network is IServer server))
                {
                    WriteSnapshot(nowUnixMs, "unavailable", false, Array.Empty<BridgePlayerEntry>());
                    return;
                }

                // Nebula's collection returns connected clients plus the local host when this is not a dedicated server.
                // Take one extra row so truncation is explicit and work remains bounded even if the upstream collection grows.
                var authoritative = server.Players.GetAllPlayerData()
                    .Where(player => player != null)
                    .OrderBy(player => player.PlayerId)
                    .Take(BridgeProtocol.MaximumPlayers + 1)
                    .ToList();
                if (authoritative.Select(player => player.PlayerId).Distinct().Count() != authoritative.Count)
                {
                    throw new InvalidOperationException("Nebula returned duplicate connected player IDs.");
                }

                var truncated = authoritative.Count > BridgeProtocol.MaximumPlayers;
                if (truncated)
                {
                    authoritative.RemoveAt(authoritative.Count - 1);
                }

                List<BridgePlayerEntry> publicRows;
                lock (gate)
                {
                    var currentIds = new HashSet<ushort>(authoritative.Select(player => player.PlayerId));
                    foreach (var missingId in roster.Keys.Where(id => !currentIds.Contains(id)).ToList())
                    {
                        roster.Remove(missingId);
                    }
                    foreach (var playerData in authoritative)
                    {
                        Upsert(playerData, nowUnixMs, false);
                    }

                    publicRows = authoritative.Select(playerData => ToPublicEntry(roster[playerData.PlayerId]))
                        .OrderBy(player => player.SessionPlayerId, StringComparer.Ordinal)
                        .ToList();
                }
                WriteSnapshot(nowUnixMs, "active", truncated, publicRows);
            }
            catch
            {
                // A collection/read compatibility failure must never publish stale players as current.
                WriteSnapshot(nowUnixMs, "unavailable", false, Array.Empty<BridgePlayerEntry>());
            }
        }

        private void Upsert(IPlayerData playerData, long nowUnixMs, bool forceNewConnection)
        {
            if (roster.TryGetValue(playerData.PlayerId, out var existing) && !forceNewConnection)
            {
                existing.Data = playerData;
                return;
            }

            nextPlayerOrdinal++;
            if (nextPlayerOrdinal > 999999999999L)
            {
                throw new InvalidOperationException("Player session ordinal is exhausted.");
            }
            roster[playerData.PlayerId] = new RosterEntry
            {
                Data = playerData,
                JoinedAtUnixMs = nowUnixMs,
                SessionPlayerId = "player-" + nextPlayerOrdinal.ToString("D6", CultureInfo.InvariantCulture)
            };
        }

        private void WriteSnapshot(
            long nowUnixMs,
            string state,
            bool truncated,
            IReadOnlyList<BridgePlayerEntry> players)
        {
            BridgePlayerSnapshot snapshot;
            lock (gate)
            {
                sequence++;
                snapshot = new BridgePlayerSnapshot
                {
                    SessionId = sessionId,
                    WrittenAtUnixMs = nowUnixMs,
                    Sequence = sequence,
                    State = state,
                    Truncated = truncated,
                    Players = players
                };
            }
            store.WritePlayerCapabilities(new BridgePlayerCapabilitySnapshot
            {
                SessionId = snapshot.SessionId,
                WrittenAtUnixMs = snapshot.WrittenAtUnixMs
            });
            store.WritePlayerSnapshot(snapshot);
        }

        private static BridgePlayerEntry ToPublicEntry(RosterEntry entry)
        {
            return new BridgePlayerEntry
            {
                SessionPlayerId = entry.SessionPlayerId,
                DisplayName = PlayerRosterText.ClampDisplayName(entry.Data.Username, entry.SessionPlayerId),
                Online = true,
                JoinedAtUnixMs = entry.JoinedAtUnixMs,
                Location = PlayerRosterText.SummarizeLocation(entry.Data.LocalPlanetId, entry.Data.LocalStarId)
            };
        }

        private sealed class RosterEntry
        {
            internal IPlayerData Data { get; set; }
            internal string SessionPlayerId { get; set; }
            internal long JoinedAtUnixMs { get; set; }
        }
    }

    internal static class PlayerRosterText
    {
        internal static string ClampDisplayName(string value, string sessionPlayerId)
        {
            var normalized = NormalizeBoundedInput(value);
            var builder = new StringBuilder();
            var elements = StringInfo.GetTextElementEnumerator(normalized);
            var scalarCount = 0;
            while (elements.MoveNext())
            {
                var element = elements.GetTextElement();
                if (ContainsUnsafeControl(element))
                {
                    continue;
                }
                var elementScalars = CountUnicodeScalars(element);
                if (scalarCount + elementScalars > 64)
                {
                    break;
                }
                if (Encoding.UTF8.GetByteCount(builder.ToString() + element) > 128)
                {
                    break;
                }
                builder.Append(element);
                scalarCount += elementScalars;
            }
            var result = builder.ToString().Trim();
            return result.Length == 0 ? "Player " + sessionPlayerId : result;
        }

        internal static string SummarizeLocation(int localPlanetId, int localStarId)
        {
            if (localPlanetId > 0)
            {
                return "planet:" + localPlanetId.ToString(CultureInfo.InvariantCulture);
            }
            if (localStarId > 0)
            {
                return "star:" + localStarId.ToString(CultureInfo.InvariantCulture);
            }
            return "deep-space";
        }

        private static bool ContainsUnsafeControl(string value)
        {
            for (var index = 0; index < value.Length; index++)
            {
                if (char.IsControl(value[index]) || value[index] == '\0')
                {
                    return true;
                }
            }
            return false;
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

        private static string NormalizeBoundedInput(string value)
        {
            var source = value ?? string.Empty;
            if (source.Length > 512)
            {
                source = source.Substring(0, 512);
                if (source.Length > 0 && char.IsHighSurrogate(source[source.Length - 1]))
                {
                    source = source.Substring(0, source.Length - 1);
                }
            }

            var valid = new StringBuilder(source.Length);
            for (var index = 0; index < source.Length; index++)
            {
                var character = source[index];
                if (char.IsHighSurrogate(character))
                {
                    if (index + 1 < source.Length && char.IsLowSurrogate(source[index + 1]))
                    {
                        valid.Append(character).Append(source[++index]);
                    }
                    else
                    {
                        valid.Append('\uFFFD');
                    }
                }
                else if (char.IsLowSurrogate(character))
                {
                    valid.Append('\uFFFD');
                }
                else
                {
                    valid.Append(character);
                }
            }
            return valid.ToString().Normalize(NormalizationForm.FormC);
        }
    }
}
