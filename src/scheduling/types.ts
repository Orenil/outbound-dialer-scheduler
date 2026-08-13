import { DateTime } from 'luxon';
import { CallWindow } from '../compliance/compliance.service';

export interface Contact {
  id: string;
  phoneNumber: string;
  /** True if telco porting metadata flags this number as ported (deny-by-default territory). */
  ported: boolean;
}

export interface CampaignConfig {
  campaignId: string;
  /** Max number of contacts allowed within the rolling frequency window. */
  frequencyCap: number;
  frequencyWindowDays: number;
  callWindow?: CallWindow;
  /** Granularity, in minutes, at which candidate slots are probed. */
  slotIntervalMinutes: number;
  horizonStartUtc: DateTime;
  horizonEndUtc: DateTime;
}

export interface ScheduledCall {
  contactId: string;
  phoneNumber: string;
  scheduledAtUtc: string;
  timezone: string;
  timezoneSource: string;
  frequencyCountAtDecision: number;
}

export interface RejectedContact {
  contactId: string;
  phoneNumber: string;
  reason: string;
}

export interface ScheduleResult {
  scheduled: ScheduledCall[];
  rejected: RejectedContact[];
}
