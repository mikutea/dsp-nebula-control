using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace DysonControl.Bridge
{
    internal delegate bool TryObserveLoadedSave(out LoadedSaveObservation observation);

    /// <summary>Tracks successful load calls, never the name imported inside save data.</summary>
    internal sealed class LoadedSaveOriginTracker
    {
        private readonly object sync = new object();
        private long generation;
        private int activeLoads;
        private bool reentrantOrInvalidated;
        private object data;
        private object session;
        private string saveName;
        private LoadedSaveObservation loadedFiles;
        private bool observedReady;

        internal LoadAttempt BeginLoad()
        {
            lock (sync)
            {
                ClearOrigin();
                if (generation == long.MaxValue || activeLoads == int.MaxValue)
                    throw new InvalidOperationException("Loaded-save load generation exhausted.");
                if (activeLoads == 0) reentrantOrInvalidated = false;
                else reentrantOrInvalidated = true;
                activeLoads++;
                return new LoadAttempt(this, ++generation);
            }
        }

        internal void CompleteLoad(LoadAttempt attempt, bool succeeded, string actualLoadArgument,
            object loadedData, object multiplayerSession, LoadedSaveObservation files)
        {
            lock (sync)
            {
                if (attempt == null || !ReferenceEquals(attempt.Owner, this) || attempt.Completed) return;
                attempt.Completed = true;
                activeLoads--;
                if (attempt.Generation != generation || activeLoads != 0 || reentrantOrInvalidated || !succeeded ||
                    loadedData == null || multiplayerSession == null || files == null || !files.IsValid() ||
                    !string.Equals(files.SaveName, actualLoadArgument, StringComparison.Ordinal) ||
                    !string.Equals(actualLoadArgument, BridgeProtocol.LastExitSaveName, StringComparison.Ordinal))
                {
                    ClearOrigin();
                    return;
                }
                data = loadedData;
                session = multiplayerSession;
                saveName = actualLoadArgument;
                loadedFiles = files.Copy();
                observedReady = false;
            }
        }

        internal bool TryObserve(object currentData, object currentSession, bool hostGameLoaded, out string name)
        {
            lock (sync)
            {
                name = null;
                if (saveName == null) return false;
                if (!ReferenceEquals(data, currentData) || !ReferenceEquals(session, currentSession))
                {
                    ClearOrigin();
                    return false;
                }
                if (!hostGameLoaded)
                {
                    // The load postfix precedes Nebula's game-begin callback.
                    // Once readiness was observed, losing it revokes the origin.
                    if (observedReady) ClearOrigin();
                    return false;
                }
                observedReady = true;
                name = saveName;
                return true;
            }
        }

        internal void Invalidate()
        {
            lock (sync)
            {
                ClearOrigin();
                if (activeLoads != 0) reentrantOrInvalidated = true;
            }
        }

        internal bool TryMatchFiles(object currentData, object currentSession, LoadedSaveObservation current,
            out LoadedSaveObservation observation)
        {
            lock (sync)
            {
                observation = null;
                if (loadedFiles == null || !observedReady) return false;
                if (!ReferenceEquals(data, currentData) || !ReferenceEquals(session, currentSession) ||
                    current == null || !loadedFiles.MetadataEquals(current))
                {
                    ClearOrigin();
                    return false;
                }
                observation = loadedFiles.Copy();
                return true;
            }
        }

        private void ClearOrigin()
        {
            data = null;
            session = null;
            saveName = null;
            loadedFiles = null;
            observedReady = false;
        }

        internal sealed class LoadAttempt
        {
            internal LoadAttempt(LoadedSaveOriginTracker owner, long generation)
            {
                Owner = owner;
                Generation = generation;
            }
            internal LoadedSaveOriginTracker Owner { get; }
            internal long Generation { get; }
            internal bool Completed { get; set; }
        }
    }

    /// <summary>
    /// Maintains a signed proof for the exact save name retained by the running
    /// game. Hashing is performed away from Unity's main thread. The fixed output
    /// is removed before hashing and whenever the runtime name or either paired
    /// file identity becomes unavailable or changes.
    /// </summary>
    internal sealed class LoadedSaveEvidencePublisher : IDisposable
    {
        private readonly TryObserveLoadedSave tryObserve;
        private readonly Action<BridgeLoadedSaveEvidence> writeEvidence;
        private readonly Action removeEvidence;
        private readonly Func<LoadedSaveObservation, LoadedSaveHashResult> hashPair;
        private readonly Func<Func<LoadedSaveHashResult>, Task<LoadedSaveHashResult>> startHash;
        private readonly string sessionId;
        private readonly string pluginVersion;
        private readonly int processId;
        private readonly long processStartedAtUnixMs;
        private readonly long bridgeStartedAtUnixMs;
        private LoadedSaveObservation publishedObservation;
        private PendingHash pending;
        private long observationGeneration;
        private long nextAttemptUnixMs;
        private bool evidencePresent;
        private bool disposed;

        internal LoadedSaveEvidencePublisher(
            TryObserveLoadedSave tryObserve,
            Action<BridgeLoadedSaveEvidence> writeEvidence,
            Action removeEvidence,
            string sessionId,
            string pluginVersion,
            int processId,
            long processStartedAtUnixMs,
            long bridgeStartedAtUnixMs,
            Func<LoadedSaveObservation, LoadedSaveHashResult> hashPair = null,
            Func<Func<LoadedSaveHashResult>, Task<LoadedSaveHashResult>> startHash = null)
        {
            this.tryObserve = tryObserve ?? throw new ArgumentNullException(nameof(tryObserve));
            this.writeEvidence = writeEvidence ?? throw new ArgumentNullException(nameof(writeEvidence));
            this.removeEvidence = removeEvidence ?? throw new ArgumentNullException(nameof(removeEvidence));
            if (!Guid.TryParseExact(sessionId, "D", out var parsedSessionId) ||
                string.IsNullOrWhiteSpace(pluginVersion) || processId <= 0 ||
                processStartedAtUnixMs <= 0 || bridgeStartedAtUnixMs < processStartedAtUnixMs)
            {
                throw new InvalidOperationException("Loaded-save publisher identity is invalid.");
            }
            this.sessionId = parsedSessionId.ToString("D").ToLowerInvariant();
            this.pluginVersion = pluginVersion;
            this.processId = processId;
            this.processStartedAtUnixMs = processStartedAtUnixMs;
            this.bridgeStartedAtUnixMs = bridgeStartedAtUnixMs;
            this.hashPair = hashPair ?? LoadedSavePairHasher.Capture;
            this.startHash = startHash ?? (work => Task.Run(work));
            removeEvidence();
        }

        internal bool Tick(long nowUnixMs)
        {
            if (disposed)
            {
                throw new ObjectDisposedException(nameof(LoadedSaveEvidencePublisher));
            }
            if (nowUnixMs < bridgeStartedAtUnixMs)
            {
                throw new InvalidOperationException("Loaded-save observation time is invalid.");
            }

            if (!tryObserve(out var current) || current == null || !current.IsValid())
            {
                InvalidateEvidence();
                if (pending != null)
                {
                    pending.Invalidated = true;
                }
                return false;
            }

            if (pending != null)
            {
                if (!pending.Observation.MetadataEquals(current))
                {
                    pending.Invalidated = true;
                    InvalidateEvidence();
                }
                if (!pending.Task.IsCompleted)
                {
                    return false;
                }

                var completed = pending;
                pending = null;
                LoadedSaveHashResult result = null;
                try
                {
                    result = completed.Task.GetAwaiter().GetResult();
                }
                catch
                {
                    // A file fault or mutation during hashing is unavailable,
                    // never a partial or stale success.
                }
                if (completed.Invalidated || result == null ||
                    !completed.Observation.MetadataEquals(current) ||
                    !result.Matches(completed.Observation))
                {
                    nextAttemptUnixMs = nowUnixMs > long.MaxValue - 1000
                        ? long.MaxValue
                        : nowUnixMs + 1000;
                    return false;
                }

                var writtenAtUnixMs = Math.Max(nowUnixMs, bridgeStartedAtUnixMs);
                writeEvidence(new BridgeLoadedSaveEvidence
                {
                    SessionId = sessionId,
                    PluginVersion = pluginVersion,
                    ProcessId = processId,
                    ProcessStartedAtUnixMs = processStartedAtUnixMs,
                    BridgeStartedAtUnixMs = bridgeStartedAtUnixMs,
                    ObservationGeneration = completed.Generation,
                    ObservedAtUnixMs = writtenAtUnixMs,
                    WrittenAtUnixMs = writtenAtUnixMs,
                    SaveName = completed.Observation.SaveName,
                    DsvBytes = result.DsvBytes,
                    DsvWriteTimeUtcTicks = result.DsvWriteTimeUtcTicks,
                    DsvSha256 = result.DsvSha256,
                    ServerBytes = result.ServerBytes,
                    ServerWriteTimeUtcTicks = result.ServerWriteTimeUtcTicks,
                    ServerSha256 = result.ServerSha256
                });
                publishedObservation = completed.Observation.Copy();
                evidencePresent = true;
                return true;
            }

            if (publishedObservation != null && publishedObservation.MetadataEquals(current))
            {
                return false;
            }
            InvalidateEvidence();
            if (nowUnixMs < nextAttemptUnixMs)
            {
                return false;
            }
            if (observationGeneration == long.MaxValue)
            {
                throw new InvalidOperationException("Loaded-save observation generation was exhausted.");
            }
            var candidate = current.Copy();
            var generation = ++observationGeneration;
            var task = startHash(() => hashPair(candidate));
            if (task == null)
            {
                throw new InvalidOperationException("Loaded-save hash scheduler returned no task.");
            }
            pending = new PendingHash(candidate, generation, task);
            return false;
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            if (pending != null)
            {
                pending.Invalidated = true;
            }
            // Preserve the last complete signed evidence for stopped-baseline
            // reconciliation. The next bridge generation removes it in its
            // constructor before attempting any new observation.
            publishedObservation = null;
        }

        internal void FailClosed()
        {
            if (pending != null)
            {
                pending.Invalidated = true;
            }
            removeEvidence();
            evidencePresent = false;
            publishedObservation = null;
            disposed = true;
        }

        internal void InvalidateLoadedOrigin()
        {
            if (pending != null) pending.Invalidated = true;
            InvalidateEvidence();
            nextAttemptUnixMs = 0;
        }

        private void InvalidateEvidence()
        {
            if (!evidencePresent)
            {
                publishedObservation = null;
                return;
            }
            removeEvidence();
            evidencePresent = false;
            publishedObservation = null;
        }

        private sealed class PendingHash
        {
            internal PendingHash(
                LoadedSaveObservation observation,
                long generation,
                Task<LoadedSaveHashResult> task)
            {
                Observation = observation;
                Generation = generation;
                Task = task;
            }

            internal LoadedSaveObservation Observation { get; }
            internal long Generation { get; }
            internal Task<LoadedSaveHashResult> Task { get; }
            internal bool Invalidated { get; set; }
        }
    }

    internal sealed class LoadedSaveObservation
    {
        internal string SaveName { get; set; }
        internal string DsvPath { get; set; }
        internal long DsvBytes { get; set; }
        internal long DsvWriteTimeUtcTicks { get; set; }
        internal long DsvCreationTimeUtcTicks { get; set; }
        internal string ServerPath { get; set; }
        internal long ServerBytes { get; set; }
        internal long ServerWriteTimeUtcTicks { get; set; }
        internal long ServerCreationTimeUtcTicks { get; set; }

        internal bool IsValid()
        {
            return string.Equals(SaveName, BridgeProtocol.LastExitSaveName, StringComparison.Ordinal) &&
                   !string.IsNullOrWhiteSpace(DsvPath) && Path.IsPathRooted(DsvPath) &&
                   !string.IsNullOrWhiteSpace(ServerPath) && Path.IsPathRooted(ServerPath) &&
                   DsvBytes > 0 && DsvWriteTimeUtcTicks > 0 && DsvCreationTimeUtcTicks > 0 &&
                   ServerBytes > 0 && ServerWriteTimeUtcTicks > 0 && ServerCreationTimeUtcTicks > 0;
        }

        internal bool MetadataEquals(LoadedSaveObservation other)
        {
            return other != null &&
                   string.Equals(SaveName, other.SaveName, StringComparison.Ordinal) &&
                   string.Equals(DsvPath, other.DsvPath, StringComparison.OrdinalIgnoreCase) &&
                   DsvBytes == other.DsvBytes && DsvWriteTimeUtcTicks == other.DsvWriteTimeUtcTicks &&
                   DsvCreationTimeUtcTicks == other.DsvCreationTimeUtcTicks &&
                   string.Equals(ServerPath, other.ServerPath, StringComparison.OrdinalIgnoreCase) &&
                   ServerBytes == other.ServerBytes &&
                   ServerWriteTimeUtcTicks == other.ServerWriteTimeUtcTicks &&
                   ServerCreationTimeUtcTicks == other.ServerCreationTimeUtcTicks;
        }

        internal LoadedSaveObservation Copy()
        {
            return new LoadedSaveObservation
            {
                SaveName = SaveName,
                DsvPath = DsvPath,
                DsvBytes = DsvBytes,
                DsvWriteTimeUtcTicks = DsvWriteTimeUtcTicks,
                DsvCreationTimeUtcTicks = DsvCreationTimeUtcTicks,
                ServerPath = ServerPath,
                ServerBytes = ServerBytes,
                ServerWriteTimeUtcTicks = ServerWriteTimeUtcTicks,
                ServerCreationTimeUtcTicks = ServerCreationTimeUtcTicks
            };
        }
    }

    internal sealed class LoadedSaveHashResult
    {
        internal long DsvBytes { get; set; }
        internal long DsvWriteTimeUtcTicks { get; set; }
        internal string DsvSha256 { get; set; }
        internal long ServerBytes { get; set; }
        internal long ServerWriteTimeUtcTicks { get; set; }
        internal string ServerSha256 { get; set; }

        internal bool Matches(LoadedSaveObservation observation)
        {
            return observation != null && DsvBytes == observation.DsvBytes &&
                   DsvWriteTimeUtcTicks == observation.DsvWriteTimeUtcTicks &&
                   ServerBytes == observation.ServerBytes &&
                   ServerWriteTimeUtcTicks == observation.ServerWriteTimeUtcTicks &&
                   IsLowerSha256(DsvSha256) && IsLowerSha256(ServerSha256);
        }

        private static bool IsLowerSha256(string value)
        {
            if (value == null || value.Length != 64)
            {
                return false;
            }
            foreach (var character in value)
            {
                if (!((character >= '0' && character <= '9') ||
                      (character >= 'a' && character <= 'f')))
                {
                    return false;
                }
            }
            return true;
        }
    }

    internal static class LoadedSavePairHasher
    {
        internal static LoadedSaveHashResult Capture(LoadedSaveObservation observation)
        {
            if (observation == null || !observation.IsValid())
            {
                throw new InvalidOperationException("Loaded-save pair observation is invalid.");
            }
            var dsvSha256 = HashStableFile(
                observation.DsvPath,
                observation.DsvBytes,
                observation.DsvWriteTimeUtcTicks,
                observation.DsvCreationTimeUtcTicks);
            var serverSha256 = HashStableFile(
                observation.ServerPath,
                observation.ServerBytes,
                observation.ServerWriteTimeUtcTicks,
                observation.ServerCreationTimeUtcTicks);
            if (!MatchesCurrentFile(observation.DsvPath, observation.DsvBytes,
                    observation.DsvWriteTimeUtcTicks, observation.DsvCreationTimeUtcTicks) ||
                !MatchesCurrentFile(observation.ServerPath, observation.ServerBytes,
                    observation.ServerWriteTimeUtcTicks, observation.ServerCreationTimeUtcTicks))
            {
                throw new InvalidOperationException("Loaded-save pair changed during hashing.");
            }
            return new LoadedSaveHashResult
            {
                DsvBytes = observation.DsvBytes,
                DsvWriteTimeUtcTicks = observation.DsvWriteTimeUtcTicks,
                DsvSha256 = dsvSha256,
                ServerBytes = observation.ServerBytes,
                ServerWriteTimeUtcTicks = observation.ServerWriteTimeUtcTicks,
                ServerSha256 = serverSha256
            };
        }

        private static string HashStableFile(
            string path,
            long expectedBytes,
            long expectedWriteTimeUtcTicks,
            long expectedCreationTimeUtcTicks)
        {
            if (!MatchesCurrentFile(path, expectedBytes, expectedWriteTimeUtcTicks, expectedCreationTimeUtcTicks))
            {
                throw new InvalidOperationException("Loaded-save file changed before hashing.");
            }
            byte[] digest;
            using (var stream = new FileStream(
                       path,
                       FileMode.Open,
                       FileAccess.Read,
                       FileShare.Read,
                       1024 * 1024,
                       FileOptions.SequentialScan))
            using (var algorithm = SHA256.Create())
            {
                if (stream.Length != expectedBytes)
                {
                    throw new InvalidOperationException("Loaded-save file length changed before hashing.");
                }
                digest = algorithm.ComputeHash(stream);
                if (stream.Position != expectedBytes)
                {
                    throw new InvalidOperationException("Loaded-save file was truncated while hashing.");
                }
            }
            if (!MatchesCurrentFile(path, expectedBytes, expectedWriteTimeUtcTicks, expectedCreationTimeUtcTicks))
            {
                throw new InvalidOperationException("Loaded-save file changed during hashing.");
            }
            return ToLowerHex(digest);
        }

        private static bool MatchesCurrentFile(
            string path,
            long expectedBytes,
            long expectedWriteTimeUtcTicks,
            long expectedCreationTimeUtcTicks)
        {
            try
            {
                var file = new FileInfo(path);
                file.Refresh();
                return file.Exists && (file.Attributes & FileAttributes.ReparsePoint) == 0 &&
                       file.Length == expectedBytes &&
                       file.LastWriteTimeUtc.Ticks == expectedWriteTimeUtcTicks &&
                       file.CreationTimeUtc.Ticks == expectedCreationTimeUtcTicks;
            }
            catch
            {
                return false;
            }
        }

        private static string ToLowerHex(byte[] value)
        {
            var builder = new StringBuilder(value.Length * 2);
            foreach (var item in value)
            {
                builder.Append(item.ToString("x2", CultureInfo.InvariantCulture));
            }
            return builder.ToString();
        }
    }
}
