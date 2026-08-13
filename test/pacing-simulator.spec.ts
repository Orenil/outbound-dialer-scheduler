import { runPacingSimulation, PacingSimConfig } from '../src/pacing/pacing-simulator';

describe('Predictive vs. fixed-ratio pacing simulation', () => {
  const base: Omit<PacingSimConfig, 'fixedRatio' | 'predictiveAggressiveness'> = {
    numAgents: 20,
    answerRate: 0.32,
    meanHandleTimeSec: 240,
    meanRingSetupSec: 6,
    simDurationSec: 2 * 3600,
    tickSec: 2,
    abandonRateCeiling: 0.03,
    randomSeed: 42,
  };

  it('keeps the abandon rate at or below the configured ceiling', () => {
    const predictive = runPacingSimulation('predictive', {
      ...base,
      fixedRatio: 0,
      predictiveAggressiveness: 0.3,
    });
    expect(predictive.abandonRate).toBeLessThanOrEqual(base.abandonRateCeiling);
  });

  it('achieves materially higher agent utilization than a conservative fixed-ratio dialer that also stays under the ceiling', () => {
    const predictive = runPacingSimulation('predictive', {
      ...base,
      fixedRatio: 0,
      predictiveAggressiveness: 0.3,
    });
    const fixedConservative = runPacingSimulation('fixed', {
      ...base,
      fixedRatio: 0.2,
      predictiveAggressiveness: 0,
    });

    // The naive dialer never checks the abandon rate at all, so it happens to stay at zero here
    // -- that's exactly the "leaves capacity idle out of over-caution" failure mode from the spec.
    expect(fixedConservative.abandonRate).toBeLessThanOrEqual(base.abandonRateCeiling);
    expect(predictive.agentUtilization).toBeGreaterThan(fixedConservative.agentUtilization);
    // Meaningfully higher, not a rounding artifact.
    expect(predictive.agentUtilization - fixedConservative.agentUtilization).toBeGreaterThan(0.08);
  });

  it('shows a more aggressive fixed-ratio dialer breaching the abandon-rate ceiling that predictive pacing respects', () => {
    const predictive = runPacingSimulation('predictive', {
      ...base,
      fixedRatio: 0,
      predictiveAggressiveness: 0.3,
    });
    const fixedAggressive = runPacingSimulation('fixed', {
      ...base,
      fixedRatio: 0.5,
      predictiveAggressiveness: 0,
    });

    expect(fixedAggressive.abandonRate).toBeGreaterThan(base.abandonRateCeiling);
    expect(predictive.abandonRate).toBeLessThan(fixedAggressive.abandonRate);
  });

  it('is deterministic for a given random seed (reproducible load test)', () => {
    const a = runPacingSimulation('predictive', { ...base, fixedRatio: 0, predictiveAggressiveness: 0.3 });
    const b = runPacingSimulation('predictive', { ...base, fixedRatio: 0, predictiveAggressiveness: 0.3 });
    expect(a).toEqual(b);
  });

  it('dials zero lines when there are no agents and no history to forecast from', () => {
    const result = runPacingSimulation('predictive', {
      ...base,
      numAgents: 0,
      fixedRatio: 0,
      predictiveAggressiveness: 0.3,
    });
    expect(result.totalDialed).toBe(0);
    expect(result.totalAbandoned).toBe(0);
  });

  it('regression: the abandon-rate governor recovers after a spike instead of permanently zeroing throughput', () => {
    // A deliberately understaffed pool relative to a high-aggressiveness pacer forces an early
    // abandon spike. If the governor's trailing window doesn't self-heal (the bug this simulator
    // used to have -- decaying numerator and denominator by the same factor never changes their
    // ratio), dialing latches at zero forever and totalDialed stops growing with simulation time.
    const short = runPacingSimulation('predictive', {
      ...base,
      numAgents: 5,
      simDurationSec: 600,
      predictiveAggressiveness: 3,
      fixedRatio: 0,
    });
    const long = runPacingSimulation('predictive', {
      ...base,
      numAgents: 5,
      simDurationSec: 3600,
      predictiveAggressiveness: 3,
      fixedRatio: 0,
    });
    // 6x the simulated time should keep producing new dials, not flatline at the short run's total.
    expect(long.totalDialed).toBeGreaterThan(short.totalDialed * 2);
  });
});
