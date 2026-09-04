using System;

namespace DysonControl.Bridge
{
    /// <summary>
    /// Produces bounded measurements from two independent runtime clocks:
    /// FPSController.currentUPS (the game's HighStopwatch-backed update rate)
    /// and GameMain.gameTick advancement over Stopwatch elapsed time. No
    /// configured target participates in either actual value.
    /// </summary>
    internal sealed class SimulationTelemetrySampler
    {
        private readonly string sessionId;
        private readonly int processId;
        private readonly long processStartedAtUnixMs;
        private readonly long bridgeStartedAtUnixMs;
        private readonly long monotonicFrequency;
        private readonly long minimumWindowTicks;
        private readonly long maximumWindowTicks;
        private Baseline baseline;
        private long sequence;

        internal SimulationTelemetrySampler(
            string sessionId,
            int processId,
            long processStartedAtUnixMs,
            long bridgeStartedAtUnixMs,
            long monotonicFrequency,
            int minimumWindowMilliseconds = 1500,
            int maximumWindowMilliseconds = 10000)
        {
            if (!Guid.TryParseExact(sessionId, "D", out var parsedSessionId) || processId <= 0 ||
                processStartedAtUnixMs <= 0 || bridgeStartedAtUnixMs < processStartedAtUnixMs ||
                monotonicFrequency <= 0 || minimumWindowMilliseconds < 1000 ||
                maximumWindowMilliseconds > 10000 || maximumWindowMilliseconds < minimumWindowMilliseconds)
            {
                throw new ArgumentException("Simulation telemetry sampler identity or bounds are invalid.");
            }
            this.sessionId = parsedSessionId.ToString("D").ToLowerInvariant();
            this.processId = processId;
            this.processStartedAtUnixMs = processStartedAtUnixMs;
            this.bridgeStartedAtUnixMs = bridgeStartedAtUnixMs;
            this.monotonicFrequency = monotonicFrequency;
            minimumWindowTicks = DurationTicks(minimumWindowMilliseconds);
            maximumWindowTicks = DurationTicks(maximumWindowMilliseconds);
        }

        internal BridgeSimulationTelemetry Observe(
            bool simulationReady,
            long gameTick,
            double currentUps,
            long nowUnixMs,
            long nowMonotonicTicks)
        {
            if (!simulationReady || gameTick < 0 || nowUnixMs <= 0 || nowMonotonicTicks < 0 ||
                double.IsNaN(currentUps) || double.IsInfinity(currentUps) || currentUps < 0 ||
                currentUps * 1000.0 > BridgeProtocol.MaximumSimulationMilliRate)
            {
                baseline = null;
                return null;
            }

            if (baseline == null)
            {
                baseline = new Baseline(gameTick, nowUnixMs, nowMonotonicTicks);
                return null;
            }

            if (nowMonotonicTicks < baseline.MonotonicTicks || nowUnixMs < baseline.UnixMs ||
                gameTick < baseline.GameTick)
            {
                baseline = new Baseline(gameTick, nowUnixMs, nowMonotonicTicks);
                return null;
            }

            var elapsedTicks = nowMonotonicTicks - baseline.MonotonicTicks;
            if (elapsedTicks < minimumWindowTicks)
            {
                return null;
            }
            if (elapsedTicks > maximumWindowTicks || nowUnixMs - baseline.UnixMs > 120000)
            {
                baseline = new Baseline(gameTick, nowUnixMs, nowMonotonicTicks);
                return null;
            }

            var windowDurationMs = (long)Math.Round(
                elapsedTicks * 1000.0 / monotonicFrequency,
                MidpointRounding.AwayFromZero);
            var tickDelta = gameTick - baseline.GameTick;
            var upsMilli = (long)Math.Round(currentUps * 1000.0, MidpointRounding.AwayFromZero);
            var tpsMilli = (long)Math.Round(
                tickDelta * 1000000.0 / windowDurationMs,
                MidpointRounding.AwayFromZero);
            if (windowDurationMs < 1000 || windowDurationMs > 10000 ||
                upsMilli < 0 || upsMilli > BridgeProtocol.MaximumSimulationMilliRate ||
                tpsMilli < 0 || tpsMilli > BridgeProtocol.MaximumSimulationMilliRate ||
                sequence == long.MaxValue)
            {
                baseline = new Baseline(gameTick, nowUnixMs, nowMonotonicTicks);
                return null;
            }

            var telemetry = new BridgeSimulationTelemetry
            {
                SessionId = sessionId,
                ProcessId = processId,
                ProcessStartedAtUnixMs = processStartedAtUnixMs,
                BridgeStartedAtUnixMs = bridgeStartedAtUnixMs,
                Sequence = ++sequence,
                SampleStartedAtUnixMs = baseline.UnixMs,
                SampleFinishedAtUnixMs = nowUnixMs,
                WrittenAtUnixMs = nowUnixMs,
                WindowDurationMs = windowDurationMs,
                TickStarted = baseline.GameTick,
                TickFinished = gameTick,
                UpsMilli = upsMilli,
                TpsMilli = tpsMilli
            };
            baseline = new Baseline(gameTick, nowUnixMs, nowMonotonicTicks);
            return telemetry;
        }

        private long DurationTicks(long milliseconds)
        {
            checked
            {
                var wholeSeconds = milliseconds / 1000;
                var remainingMilliseconds = milliseconds % 1000;
                return wholeSeconds * monotonicFrequency +
                       (remainingMilliseconds * monotonicFrequency + 999) / 1000;
            }
        }

        private sealed class Baseline
        {
            internal Baseline(long gameTick, long unixMs, long monotonicTicks)
            {
                GameTick = gameTick;
                UnixMs = unixMs;
                MonotonicTicks = monotonicTicks;
            }

            internal long GameTick { get; }
            internal long UnixMs { get; }
            internal long MonotonicTicks { get; }
        }
    }
}
