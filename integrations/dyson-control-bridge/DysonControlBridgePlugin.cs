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
        private long nextPollUnixMs;
        private long lastSaveStartedUnixMs;
        private long startedAtUnixMs;
        private long nextHeartbeatUnixMs;

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
                WriteHeartbeat(startedAtUnixMs);
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
                Logger.LogInfo("Dyson Control Bridge V1 is enabled for signed local save requests and read-only player snapshots.");
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

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            try
            {
                if (now >= nextHeartbeatUnixMs)
                {
                    WriteHeartbeat(now);
                }
                if (playerRoster != null)
                {
                    try
                    {
                        playerRoster.Tick(now);
                    }
                    catch (Exception exception)
                    {
                        Logger.LogWarning("Player roster snapshot failed safely: " + exception.GetType().Name);
                    }
                }
                if (pending != null)
                {
                    ObservePendingSave(now);
                    return;
                }
                if (now < nextPollUnixMs)
                {
                    return;
                }
                nextPollUnixMs = now + Clamp(pollMilliseconds.Value, 100, 2000);
                var claim = store.TryClaimNext();
                if (claim != null)
                {
                    ProcessClaim(claim, now);
                }
            }
            catch (Exception exception)
            {
                Logger.LogError("Dyson Control Bridge update failed safely: " + exception.GetType().Name);
                if (pending != null)
                {
                    FailPending("BRIDGE_IO_ERROR", now);
                }
            }
        }

        private void OnDestroy()
        {
            playerRoster?.Dispose();
            playerRoster = null;
        }

        private void WriteHeartbeat(long now)
        {
            store.WriteHeartbeat(PluginVersion, Process.GetCurrentProcess().Id, startedAtUnixMs, now);
            nextHeartbeatUnixMs = now + 2000;
        }

        private void ProcessClaim(BridgeClaim claim, long now)
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
                CompleteFailure(claim, request, "INTERRUPTED_UNCERTAIN", now, now);
                return;
            }
            if (now < request.CreatedAtUnixMs - 5000 || now > request.ExpiresAtUnixMs)
            {
                CompleteFailure(claim, request, "REQUEST_EXPIRED", now, now);
                return;
            }
            var cooldown = Clamp(saveCooldownSeconds.Value, 30, 600) * 1000L;
            if (lastSaveStartedUnixMs > 0 && now - lastSaveStartedUnixMs < cooldown)
            {
                CompleteFailure(claim, request, "SAVE_COOLDOWN", now, now);
                return;
            }
            if (!adapter.TryPrepare(out var context, out var prepareError))
            {
                CompleteFailure(claim, request, prepareError, now, now);
                return;
            }

            lastSaveStartedUnixMs = now;
            if (!adapter.TryInvokeSave(context, out var saveError))
            {
                CompleteFailure(claim, request, saveError, now, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    context.SaveTimeBefore);
                return;
            }

            var afterCall = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            pending = new PendingSave
            {
                Claim = claim,
                Request = request,
                Context = context,
                StartedAtUnixMs = now,
                DeadlineUnixMs = afterCall + Clamp(saveTimeoutSeconds.Value, 10, 180) * 1000L
            };
            Logger.LogInfo("Accepted signed save request " + request.RequestId + ".");
        }

        private void ObservePendingSave(long now)
        {
            SaveObservation observation;
            try
            {
                observation = adapter.Observe(pending.Context);
            }
            catch
            {
                FailPending("SAVE_OBSERVATION_FAILED", now);
                return;
            }

            if (observation.PairPresent && observation.SaveTimeAfter > pending.Context.SaveTimeBefore)
            {
                if (pending.LastObservation == null || !pending.LastObservation.Equals(observation))
                {
                    pending.LastObservation = observation;
                    pending.StableSinceUnixMs = now;
                }
                else if (now - pending.StableSinceUnixMs >= Clamp(stabilityMilliseconds.Value, 500, 15000))
                {
                    store.Complete(pending.Claim, new BridgeReceipt
                    {
                        RequestId = pending.Request.RequestId,
                        State = "succeeded",
                        StartedAtUnixMs = pending.StartedAtUnixMs,
                        FinishedAtUnixMs = now,
                        SaveTimeBefore = pending.Context.SaveTimeBefore,
                        SaveTimeAfter = observation.SaveTimeAfter,
                        DsvBytes = observation.DsvBytes,
                        ServerBytes = observation.ServerBytes,
                        ErrorCode = "NONE"
                    });
                    Logger.LogInfo("Save request " + pending.Request.RequestId + " completed with paired evidence.");
                    pending = null;
                    return;
                }
            }

            if (now >= pending.DeadlineUnixMs)
            {
                var error = !observation.PairPresent
                    ? "SAVE_PAIR_MISSING"
                    : observation.SaveTimeAfter <= pending.Context.SaveTimeBefore
                        ? "SAVE_TIME_UNCHANGED"
                        : "SAVE_PAIR_UNSTABLE";
                FailPending(error, now, observation);
            }
        }

        private void FailPending(string errorCode, long finishedAtUnixMs, SaveObservation observation = null)
        {
            var current = pending;
            pending = null;
            store.Complete(current.Claim, new BridgeReceipt
            {
                RequestId = current.Request.RequestId,
                State = "failed",
                StartedAtUnixMs = current.StartedAtUnixMs,
                FinishedAtUnixMs = finishedAtUnixMs,
                SaveTimeBefore = current.Context.SaveTimeBefore,
                SaveTimeAfter = observation?.SaveTimeAfter ?? -1,
                DsvBytes = observation?.DsvBytes ?? -1,
                ServerBytes = observation?.ServerBytes ?? -1,
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
            long saveTimeBefore = -1)
        {
            store.Complete(claim, new BridgeReceipt
            {
                RequestId = request.RequestId,
                State = "failed",
                StartedAtUnixMs = startedAtUnixMs,
                FinishedAtUnixMs = finishedAtUnixMs,
                SaveTimeBefore = saveTimeBefore,
                SaveTimeAfter = -1,
                DsvBytes = -1,
                ServerBytes = -1,
                ErrorCode = errorCode
            });
        }

        private static int Clamp(int value, int minimum, int maximum)
        {
            return Math.Max(minimum, Math.Min(maximum, value));
        }

        private sealed class PendingSave
        {
            internal BridgeClaim Claim { get; set; }
            internal BridgeRequest Request { get; set; }
            internal SaveContext Context { get; set; }
            internal long StartedAtUnixMs { get; set; }
            internal long DeadlineUnixMs { get; set; }
            internal long StableSinceUnixMs { get; set; }
            internal SaveObservation LastObservation { get; set; }
        }
    }
}
