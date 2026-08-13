import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ScheduledCall } from '../scheduling/types';

export interface AgentPoolState {
  numAgents: number;
  busyUntilMs: number[];
}

/**
 * Live dial-queue driver: on a fixed `@nestjs/schedule` interval, checks
 * which agents are idle and how many due calls are waiting, and releases
 * lines using the same predictive-pacing intuition validated by the
 * offline simulator in `pacing-simulator.ts` (forecast near-term agent
 * availability, pace lines against it, never exceed line capacity). This is
 * the component that would, in production, actually originate calls through
 * a SIP/carrier layer; here it logs the pacing decision, since there's no
 * real telephony backend to drive.
 */
@Injectable()
export class PacingService {
  private readonly logger = new Logger(PacingService.name);
  private queue: ScheduledCall[] = [];
  private agentPool: AgentPoolState = { numAgents: 0, busyUntilMs: [] };
  private linesInFlight = 0;

  configureAgentPool(numAgents: number): void {
    this.agentPool = { numAgents, busyUntilMs: new Array(numAgents).fill(0) };
  }

  enqueue(calls: ScheduledCall[]): void {
    this.queue.push(...calls);
  }

  queueLength(): number {
    return this.queue.length;
  }

  /** Marks a line as finished so its agent becomes idle again (called by whatever completes the call). */
  releaseAgent(index: number): void {
    if (index >= 0 && index < this.agentPool.busyUntilMs.length) {
      this.agentPool.busyUntilMs[index] = Date.now();
      this.linesInFlight = Math.max(0, this.linesInFlight - 1);
    }
  }

  /** Runs every second: pace out due calls against currently-idle agent capacity. */
  @Interval(1000)
  tick(): void {
    const now = Date.now();
    const due = this.queue.filter((c) => new Date(c.scheduledAtUtc).getTime() <= now);
    if (due.length === 0) return;

    const idleAgents = this.agentPool.busyUntilMs.filter((t) => t <= now).length;
    const availableLines = Math.max(0, idleAgents - this.linesInFlight);
    const toDial = due.slice(0, availableLines);

    for (const call of toDial) {
      this.queue = this.queue.filter((c) => c !== call);
      this.linesInFlight++;
      this.logger.log(`dialing ${call.phoneNumber} (contact ${call.contactId}, tz ${call.timezone})`);
    }
  }
}
