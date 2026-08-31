using System;
using System.Diagnostics;
using BepInEx;
using BepInEx.Configuration;

namespace DysonControl.Bridge
{
    [BepInPlugin(PluginGuid, PluginName, PluginVersion)]
    [BepInDependency("dsp.nebula-multiplayer", BepInDependency.DependencyFlags.HardDependency)]
    [BepInDependency("dsp.nebula-multiplayer-api", BepInDependency.DependencyFlags.HardDependency)]
    public sealed class DysonControlBridgePlugin : BaseUnityPlugin
    {
        public const string PluginGuid = "io.github.mikutea.dyson-control-bridge";
        public const string PluginName = "Dyson Control Bridge";
        public const string PluginVersion = "0.1.0";

        private ConfigEntry<bool> bridgeEnabled;
        private ConfigEntry<string> controlRoot;
        private ConfigEntry<string> secretFile;
        private ConfigEntry<int> pollMilliseconds;
        private ConfigEntry<int> stabilityMilliseconds;
        private ConfigEntry<int> saveTimeoutSeconds;
        private ConfigEntry<int> saveCooldownSeconds;

        private BridgeFileStore store;
        private GameSaveAdapter adapter;
        private PlayerRosterPublisher playerRoster;
        private PendingSave pending;
        private bool operational;
        private long nextPollMonotonicTicks;
        private long lastSaveStartedMonotonicTicks = -1;
        private long startedAtUnixMs;
        private long nextHeartbeatMonotonicTicks;

        private void Awake()
        {
            bridgeEnabled = Config.Bind("Bridge", "Enabled", false,
                "Fail-closed master switch. The bridge does not create or read request directories while false.");
            controlRoot = Config.Bind("Bridge", "ControlRoot", string.Empty,
                "Absolute private directory containing requests, receipts, and archives.");
            secretFile = Config.Bind("Bridge", "SecretFile", string.Empty,
                "Absolute ACL-protected file containing a random shared secret of at least 32 characters.");
            pollMilliseconds = Config.Bind("Timing", "PollMilliseconds", 250,
                "Request polling interval. Runtime value is clamped to 100-2000 ms.");
            stabilityMilliseconds = Config.Bind("Timing", "StabilityMilliseconds", 2000,
                "Time the paired save fingerprints must remain unchanged before a success receipt is emitted.");
            saveTimeoutSeconds = Config.Bind("Timing", "SaveTimeoutSeconds", 30,
                "Maximum post-save observation window before a failed receipt is emitted.");
            saveCooldownSeconds = Config.Bind("Timing", "SaveCooldownSeconds", 60,
                "Minimum interval between accepted save calls, matching Nebula's remote-save safety interval.");

            if (!bridgeEnabled.Value)
            {
                Logger.LogInfo("Dyson Control Bridge is disabled by default.");
                return;
            }

            try
            {
                store = new BridgeFileStore(controlRoot.Value, secretFile.Value);
                if (!GameSaveAdapter.TryCreate(out adapter, out var compatibilityError))
                {
                    Logger.LogError("Dyson Control Bridge is fail-closed: " + compatibilityError);
                    return;
                }
                operational = true;
                startedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                WriteHeartbeat(startedAtUnixMs, BridgeMonotonicTime.NowTicks());
                try
                {
                    playerRoster = new PlayerRosterPublisher(store);
                    playerRoster.Tick(startedAtUnixMs);
                }
                catch (Exception exception)
                {
                    playerRoster?.Dispose();
                    playerRoster = null;
                    Logger.LogWarning("Player roster bridge is unavailable: " + exception.GetType().Name);
                }
                Logger.LogInfo("Dyson Control Bridge receipt V2 is enabled for signed local save requests and read-only player snapshots.");
            }
            catch (Exception exception)
            {
                Logger.LogError("Dyson Control Bridge initialization failed: " + exception.GetType().Name);
            }
        }

        private void Update()
        {
            if (!operational)
            {
                return;
            }

            var nowUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var nowMonotonicTicks = BridgeMonotonicTime.NowTicks();
            try
            {
                if (nowMonotonicTicks >= nextHeartbeatMonotonicTicks)
                {
                    WriteHeartbeat(nowUnixMs, nowMonotonicTicks);
                }
                if (playerRoster != null)
                {
                    try
                    {
                        playerRoster.Tick(nowUnixMs);
                    }
                    catch (Exception exception)
                    {
                        Logger.LogWarning("Player roster snapshot failed safely: " + exception.GetType().Name);
                    }
                }
                if (pending != null)
                {
                    ObservePendingSave(nowUnixMs, nowMonotonicTicks);
                    return;
                }
                if (nowMonotonicTicks < nextPollMonotonicTicks)
                {
                    return;
                }
                nextPollMonotonicTicks = BridgeMonotonicTime.DeadlineAfter(
                    nowMonotonicTicks,
                    BridgeMonotonicTime.DurationTicks(Clamp(pollMilliseconds.Value, 100, 2000)));
                var claim = store.TryClaimNext();
                if (claim != null)
                {
                    ProcessClaim(claim, nowUnixMs, nowMonotonicTicks);
                }
            }
            catch (Exception exception)
            {
                Logger.LogError("Dyson Control Bridge update failed safely: " + exception.GetType().Name);
                if (pending != null)
                {
                    FailPending("BRIDGE_IO_ERROR", nowUnixMs);
                }
            }
        }

        private void OnDestroy()
        {
            playerRoster?.Dispose();
            playerRoster = null;
        }

        private void WriteHeartbeat(long nowUnixMs, long nowMonotonicTicks)
        {
            store.WriteHeartbeat(
                PluginVersion,
                Process.GetCurrentProcess().Id,
                startedAtUnixMs,
                Math.Max(startedAtUnixMs, nowUnixMs));
            nextHeartbeatMonotonicTicks = BridgeMonotonicTime.DeadlineAfter(
                nowMonotonicTicks,
                BridgeMonotonicTime.DurationTicks(2000));
        }

        private void ProcessClaim(BridgeClaim claim, long nowUnixMs, long nowMonotonicTicks)
        {
            if (!store.TryReadRequest(claim, out var request, out var parseError))
            {
                store.Reject(claim);
                Logger.LogWarning("Rejected a bridge request: " + parseError);
                return;
            }
            if (store.ReceiptExists(request.RequestId))
            {
                store.ArchiveCompletedDuplicate(claim);
                return;
            }
            if (claim.Recovered)
            {
                CompleteFailure(claim, request, "INTERRUPTED_UNCERTAIN", nowUnixMs, nowUnixMs);
                return;
            }
            // Signed request timestamps are absolute UTC protocol data. Local
            // elapsed windows below deliberately use Stopwatch ticks instead.
            if (nowUnixMs < request.CreatedAtUnixMs - 5000 || nowUnixMs > request.ExpiresAtUnixMs)
            {
                CompleteFailure(claim, request, "REQUEST_EXPIRED", nowUnixMs, nowUnixMs);
                return;
            }
            var cooldownTicks = BridgeMonotonicTime.DurationTicks(
                Clamp(saveCooldownSeconds.Value, 30, 600) * 1000L);
            if (lastSaveStartedMonotonicTicks >= 0 &&
                !BridgeMonotonicTime.HasElapsed(
                    lastSaveStartedMonotonicTicks,
                    nowMonotonicTicks,
                    cooldownTicks))
            {
                CompleteFailure(claim, request, "SAVE_COOLDOWN", nowUnixMs, nowUnixMs);
                return;
            }
            if (!adapter.TryPrepare(out var context, out var prepareError))
            {
                CompleteFailure(claim, request, prepareError, nowUnixMs, nowUnixMs);
                return;
            }

            lastSaveStartedMonotonicTicks = nowMonotonicTicks;
            if (!adapter.TryInvokeSave(context, out var immediateObservation, out var saveError))
            {
                CompleteFailure(
                    claim,
                    request,
                    saveError,
                    nowUnixMs,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    context,
                    immediateObservation ?? context.BeforeObservation);
                return;
            }

            // The adapter captured and validated this exact tuple before
            // returning. The monotonic timestamp is taken afterwards so the
            // stability window can never be shorter than configured.
            var capturedAtMonotonicTicks = BridgeMonotonicTime.NowTicks();
            pending = new PendingSave
            {
                Claim = claim,
                Request = request,
                Context = context,
                StartedAtUnixMs = nowUnixMs,
                DeadlineMonotonicTicks = BridgeMonotonicTime.DeadlineAfter(
                    capturedAtMonotonicTicks,
                    BridgeMonotonicTime.DurationTicks(Clamp(saveTimeoutSeconds.Value, 10, 180) * 1000L)),
                Tracker = new SaveObservationStabilityTracker(
                    context.BeforeObservation,
                    immediateObservation,
                    capturedAtMonotonicTicks)
            };
            Logger.LogInfo("Accepted signed save request " + request.RequestId + ".");
        }

        private void ObservePendingSave(long nowUnixMs, long nowMonotonicTicks)
        {
            SaveObservation observation;
            try
            {
                observation = adapter.Observe(pending.Context);
            }
            catch
            {
                FailPending("SAVE_OBSERVATION_FAILED", nowUnixMs);
                return;
            }

            var stable = pending.Tracker.Observe(
                observation,
                nowMonotonicTicks,
                BridgeMonotonicTime.DurationTicks(Clamp(stabilityMilliseconds.Value, 500, 15000)));
            if (pending.Tracker.IsUnstable)
            {
                FailPending("SAVE_PAIR_UNSTABLE", nowUnixMs, observation);
                return;
            }
            if (nowMonotonicTicks >= pending.DeadlineMonotonicTicks)
            {
                FailPending("SAVE_PAIR_UNSTABLE", nowUnixMs, observation);
                return;
            }
            if (stable)
            {
                var target = pending.Tracker.Target;
                store.Complete(pending.Claim, new BridgeReceipt
                {
                    RequestId = pending.Request.RequestId,
                    State = "succeeded",
                    StartedAtUnixMs = pending.StartedAtUnixMs,
                    FinishedAtUnixMs = NormalizeFinishedAt(pending.StartedAtUnixMs, nowUnixMs),
                    SaveName = BridgeProtocol.LastExitSaveName,
                    SaveTimeBefore = pending.Context.SaveTimeBefore,
                    SaveTimeAfter = target.SaveTime,
                    DsvBytes = target.DsvBytes,
                    DsvWriteTimeUtcTicks = target.DsvWriteTimeUtcTicks,
                    ServerBytes = target.ServerBytes,
                    ServerWriteTimeUtcTicks = target.ServerWriteTimeUtcTicks,
                    DsvChanged = pending.Tracker.DsvChanged,
                    ServerChanged = pending.Tracker.ServerChanged,
                    ErrorCode = "NONE"
                });
                Logger.LogInfo("Save request " + pending.Request.RequestId + " completed with paired V2 generation evidence.");
                pending = null;
            }
        }

        private void FailPending(string errorCode, long finishedAtUnixMs, SaveObservation observation = null)
        {
            var current = pending;
            pending = null;
            var effective = observation ?? current.Context.BeforeObservation;
            var dsvChanged = effective != null && effective.DsvChangedFrom(current.Context.BeforeObservation);
            var serverChanged = effective != null && effective.ServerChangedFrom(current.Context.BeforeObservation);
            store.Complete(current.Claim, new BridgeReceipt
            {
                RequestId = current.Request.RequestId,
                State = "failed",
                StartedAtUnixMs = current.StartedAtUnixMs,
                FinishedAtUnixMs = NormalizeFinishedAt(current.StartedAtUnixMs, finishedAtUnixMs),
                SaveName = BridgeProtocol.LastExitSaveName,
                SaveTimeBefore = current.Context.SaveTimeBefore,
                SaveTimeAfter = effective?.SaveTime ?? -1,
                DsvBytes = effective?.DsvBytes ?? -1,
                DsvWriteTimeUtcTicks = effective?.DsvWriteTimeUtcTicks ?? -1,
                ServerBytes = effective?.ServerBytes ?? -1,
                ServerWriteTimeUtcTicks = effective?.ServerWriteTimeUtcTicks ?? -1,
                DsvChanged = dsvChanged,
                ServerChanged = serverChanged,
                ErrorCode = errorCode
            });
            Logger.LogWarning("Save request " + current.Request.RequestId + " failed safely: " + errorCode);
        }

        private void CompleteFailure(
            BridgeClaim claim,
            BridgeRequest request,
            string errorCode,
            long startedAtUnixMs,
            long finishedAtUnixMs,
            SaveContext context = null,
            SaveObservation observation = null)
        {
            var dsvChanged = context != null && observation != null &&
                             observation.DsvChangedFrom(context.BeforeObservation);
            var serverChanged = context != null && observation != null &&
                                observation.ServerChangedFrom(context.BeforeObservation);
            store.Complete(claim, new BridgeReceipt
            {
                RequestId = request.RequestId,
                State = "failed",
                StartedAtUnixMs = startedAtUnixMs,
                FinishedAtUnixMs = NormalizeFinishedAt(startedAtUnixMs, finishedAtUnixMs),
                SaveName = context == null
                    ? BridgeProtocol.UnavailableSaveName
                    : BridgeProtocol.LastExitSaveName,
                SaveTimeBefore = context?.SaveTimeBefore ?? -1,
                SaveTimeAfter = observation?.SaveTime ?? -1,
                DsvBytes = observation?.DsvBytes ?? -1,
                DsvWriteTimeUtcTicks = observation?.DsvWriteTimeUtcTicks ?? -1,
                ServerBytes = observation?.ServerBytes ?? -1,
                ServerWriteTimeUtcTicks = observation?.ServerWriteTimeUtcTicks ?? -1,
                DsvChanged = dsvChanged,
                ServerChanged = serverChanged,
                ErrorCode = errorCode
            });
        }

        private static int Clamp(int value, int minimum, int maximum)
        {
            return Math.Max(minimum, Math.Min(maximum, value));
        }

        private static long NormalizeFinishedAt(long startedAtUnixMs, long finishedAtUnixMs)
        {
            return Math.Max(startedAtUnixMs, finishedAtUnixMs);
        }

        private sealed class PendingSave
        {
            internal BridgeClaim Claim { get; set; }
            internal BridgeRequest Request { get; set; }
            internal SaveContext Context { get; set; }
            internal long StartedAtUnixMs { get; set; }
            internal long DeadlineMonotonicTicks { get; set; }
            internal SaveObservationStabilityTracker Tracker { get; set; }
        }
    }
}
