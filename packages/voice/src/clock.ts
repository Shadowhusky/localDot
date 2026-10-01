export interface AudioClock {
  readonly currentTime: number;
  readonly outputLatency?: number;
  readonly baseLatency?: number;
  getOutputTimestamp?(): AudioTimestamp;
}

// When a sample scheduled at `contextTime` reaches the speaker, on the performance.now() clock.
export function audioToPerf(clock: AudioClock, contextTime: number, perfNow: number): number {
  const stamp = clock.getOutputTimestamp?.();
  if (stamp?.contextTime !== undefined && stamp.performanceTime) {
    return stamp.performanceTime + (contextTime - stamp.contextTime) * 1000;
  }
  const latency = clock.outputLatency || clock.baseLatency || 0;
  return perfNow + (contextTime - clock.currentTime + latency) * 1000;
}
