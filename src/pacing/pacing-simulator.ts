/**
 * Predictive-dialing pacing simulator.
 *
 * Model (deliberately simplified, documented so the limitations are explicit
 * rather than hidden):
 *
 *  - Discrete-time simulation, ticked every `tickSec` seconds.
 *  - A dialed call resolves (is determined answered or not) after
 *    `meanRingSetupSec` -- rounded to whole ticks -- has elapsed, not
 *    instantly. This delay is the entire reason predictive pacing is a hard
 *    problem: by the time you find out a batch of calls was answered, you
 *    have already had to decide (blind) how many more calls to dial in the
 *    ticks in between. A pacer that ignores its own not-yet-resolved
 *    ("in-flight") calls when deciding how many more to dial will
 *    over-commit agent demand once several batches land close together.
 *  - Each dialed call is independently answered by a human with probability
 *    `answerRate` (the rest are no-answer/busy/voicemail and simply consume
 *    a line without ever needing an agent).
 *  - An answered call needs an agent *at the moment it resolves*. If one is
 *    idle, the agent goes busy for a handle time drawn from an exponential
 *    distribution with mean `meanHandleTimeSec` (a standard first-order
 *    approximation for handle-time variability). If no agent is idle, the
 *    call is abandoned.
 *
 * What this model does NOT capture, on purpose (out of scope for a
 * portfolio project): full Erlang-C/Erlang-X queueing, abandonment while
 * still ringing (before an agent would even be sought), heterogeneous
 * agents/skills, multiple call-outcome classes with different handle-time
 * distributions, or answer rates that vary over the course of a shift. A
 * production predictive dialer would account for all of these.
 *
 * The **predictive** strategy forecasts *net new* agent capacity each tick:
 * currently-idle agents, plus busy agents expected to free up within one
 * ring-setup window, minus calls it has already dialed that haven't
 * resolved yet (`linesInFlight`) -- since those are already-committed
 * demand against that same forecast capacity. It converts that net capacity
 * into a dial count using a *running estimate* of the answer rate (updated
 * from observed outcomes, not the true configured rate -- the pacer doesn't
 * get to peek). If the trailing abandonment rate creeps toward
 * `abandonRateCeiling`, throughput is throttled directly regardless of how
 * much capacity is being forecast -- the ceiling is a hard constraint, not
 * one input among several.
 *
 * The **fixed** strategy is the naive baseline it's compared against: dial a
 * constant multiple of currently-idle agents every tick. Critically, it does
 * NOT account for `linesInFlight` -- exactly the naive mistake predictive
 * pacing exists to fix -- so once ring delay lets multiple dial batches
 * overlap, it can commit more demand than the agent pool can actually serve.
 */

export type PacingStrategy = 'predictive' | 'fixed';

export interface PacingSimConfig {
  numAgents: number;
  answerRate: number;
  meanHandleTimeSec: number;
  meanRingSetupSec: number;
  simDurationSec: number;
  tickSec: number;
  abandonRateCeiling: number;
  /** Fixed-ratio dialer only: lines dialed per idle agent per tick. */
  fixedRatio: number;
  /** Predictive dialer only: aggressiveness multiplier before the abandon-rate governor. */
  predictiveAggressiveness: number;
  randomSeed: number;
}

export interface PacingSimResult {
  strategy: PacingStrategy;
  totalDialed: number;
  totalAnswered: number;
  totalHandled: number;
  totalAbandoned: number;
  abandonRate: number;
  agentUtilization: number;
}

/** Deterministic PRNG (mulberry32) so simulations are reproducible in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function exponentialSample(rand: () => number, mean: number): number {
  const u = Math.max(rand(), Number.EPSILON);
  return -Math.log(u) * mean;
}

export function runPacingSimulation(strategy: PacingStrategy, config: PacingSimConfig): PacingSimResult {
  const rand = mulberry32(config.randomSeed);
  const numTicks = Math.floor(config.simDurationSec / config.tickSec);
  const ringSetupTicks = Math.max(1, Math.round(config.meanRingSetupSec / config.tickSec));

  // agentBusyUntilSec[i] = simulation second at which agent i becomes idle. 0 = idle now.
  const agentBusyUntilSec = new Array<number>(config.numAgents).fill(0);

  let totalDialed = 0;
  let totalAnswered = 0;
  let totalHandled = 0;
  let totalAbandoned = 0;
  let busyAgentSeconds = 0;

  // Running (observed, not configured) estimate of answer rate, used by the predictive pacer.
  // Seeded with a conservative warm-up assumption (a pacer would normally start a shift from a
  // historical/rolling estimate, not a clairvoyant one) so the very first ticks -- before any
  // observations exist -- don't over-dial.
  let observedAnswers = 0;
  let observedDials = 0;
  let runningAnswerRate = 0.5;

  // Ring-delay pipeline: pendingAnswered[o] = count of already-answered calls that will need an
  // agent `o` ticks from now (o in [0, ringSetupTicks)). Sized as a circular buffer so a dial
  // placed now, resolving ringSetupTicks ticks later, lands back on the same slot it was read
  // from `ringSetupTicks` ticks ago. Only *answered* calls are tracked here -- unanswered calls
  // never need an agent, so once their outcome is sampled at dial time there's nothing left to do.
  const pendingAnswered = new Array<number>(ringSetupTicks).fill(0);
  let linesInFlightAnswered = 0; // sum(pendingAnswered), tracked incrementally

  // True sliding window (not an exponential decay) over the last WINDOW_TICKS ticks' answered/
  // abandoned counts, so the abandon-rate governor is self-healing: a past spike ages out of the
  // window after WINDOW_TICKS ticks even if the governor throttled dialing to zero in the
  // meantime. An exponential decay of both counters together does NOT self-heal, since decaying
  // numerator and denominator by the same factor leaves their ratio unchanged forever once the
  // governor has cut dialing to zero.
  const WINDOW_TICKS = 50;
  const answeredWindow = new Array<number>(WINDOW_TICKS).fill(0);
  const abandonedWindow = new Array<number>(WINDOW_TICKS).fill(0);
  let windowAnsweredSum = 0;
  let windowAbandonedSum = 0;

  for (let tick = 0; tick < numTicks; tick++) {
    const nowSec = tick * config.tickSec;
    const ringSlot = tick % ringSetupTicks;
    const windowSlot = tick % WINDOW_TICKS;

    // --- Resolve calls dialed ringSetupTicks ago that mature this tick ---
    const maturing = pendingAnswered[ringSlot];
    pendingAnswered[ringSlot] = 0;
    linesInFlightAnswered -= maturing;

    let tickAbandoned = 0;
    for (let i = 0; i < maturing; i++) {
      const freeIdx = agentBusyUntilSec.findIndex((t) => t <= nowSec);
      if (freeIdx === -1) {
        totalAbandoned++;
        tickAbandoned++;
        continue;
      }
      const handleTime = exponentialSample(rand, config.meanHandleTimeSec);
      agentBusyUntilSec[freeIdx] = nowSec + handleTime;
      totalHandled++;
      // Only count busy-seconds that fall within the observed simulation window -- a handle
      // time that runs past `simDurationSec` shouldn't inflate utilization measured over it.
      busyAgentSeconds += Math.min(handleTime, Math.max(0, config.simDurationSec - nowSec));
    }

    // --- Decide how many new lines to dial this tick ---
    const idleAgents = agentBusyUntilSec.filter((t) => t <= nowSec).length;

    let numToDial: number;
    if (strategy === 'fixed') {
      // Naive: reacts only to currently-idle agents, blind to linesInFlightAnswered.
      numToDial = Math.round(idleAgents * config.fixedRatio);
    } else {
      const agentsFinishingSoon = agentBusyUntilSec.filter(
        (t) => t > nowSec && t <= nowSec + config.meanRingSetupSec,
      ).length;
      const netForecastCapacity = Math.max(0, idleAgents + agentsFinishingSoon - linesInFlightAnswered);

      const runningAbandonRate = windowAnsweredSum > 0 ? windowAbandonedSum / windowAnsweredSum : 0;
      // Hard ceiling: throttle aggressiveness toward zero as the observed abandon rate
      // approaches/exceeds the ceiling, overriding throughput optimization.
      const governor =
        runningAbandonRate >= config.abandonRateCeiling
          ? 0
          : 1 - runningAbandonRate / config.abandonRateCeiling;

      const raw = (netForecastCapacity / Math.max(runningAnswerRate, 0.05)) * config.predictiveAggressiveness * governor;
      numToDial = Math.max(0, Math.round(raw));
    }

    let tickAnswered = 0;
    for (let i = 0; i < numToDial; i++) {
      totalDialed++;
      observedDials++;
      if (rand() < config.answerRate) {
        totalAnswered++;
        observedAnswers++;
        tickAnswered++;
      }
    }
    pendingAnswered[ringSlot] += tickAnswered;
    linesInFlightAnswered += tickAnswered;

    if (observedDials >= 5) {
      runningAnswerRate = observedAnswers / observedDials;
    }

    windowAnsweredSum += tickAnswered - answeredWindow[windowSlot];
    windowAbandonedSum += tickAbandoned - abandonedWindow[windowSlot];
    answeredWindow[windowSlot] = tickAnswered;
    abandonedWindow[windowSlot] = tickAbandoned;
  }

  const totalAgentSeconds = config.numAgents * config.simDurationSec;
  return {
    strategy,
    totalDialed,
    totalAnswered,
    totalHandled,
    totalAbandoned,
    abandonRate: totalAnswered > 0 ? totalAbandoned / totalAnswered : 0,
    agentUtilization: Math.min(1, busyAgentSeconds / totalAgentSeconds),
  };
}
