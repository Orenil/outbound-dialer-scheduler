import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { TimezoneService } from '../timezone/timezone.service';
import { ComplianceService, DEFAULT_CALL_WINDOW } from '../compliance/compliance.service';
import { LedgerService } from '../ledger/ledger.service';
import { CampaignConfig, Contact, RejectedContact, ScheduledCall, ScheduleResult } from './types';

/**
 * Turns a contact list + campaign constraints into a call schedule that is
 * compliant *by construction*: every accepted slot has already been checked
 * against the recipient's local calling window and the durable frequency
 * ledger, and is written to the ledger the moment it's accepted (not at dial
 * time). That means a later scheduling pass, or a concurrent campaign
 * targeting the same number, immediately sees it -- the schedule can never
 * become non-compliant between "generate" and "dial" because there is no
 * separate last-second veto step to skip or race.
 */
@Injectable()
export class ScheduleGeneratorService {
  constructor(
    private readonly timezoneService: TimezoneService,
    private readonly complianceService: ComplianceService,
    private readonly ledgerService: LedgerService,
  ) {}

  generate(contacts: Contact[], config: CampaignConfig): ScheduleResult {
    const scheduled: ScheduledCall[] = [];
    const rejected: RejectedContact[] = [];
    const callWindow = config.callWindow ?? DEFAULT_CALL_WINDOW;

    for (const contact of contacts) {
      const resolution = this.timezoneService.resolve(contact.phoneNumber, contact.ported);

      if (resolution.isAmbiguous || !resolution.timezone) {
        const reason = `timezone-ambiguous:${resolution.source}`;
        this.ledgerService.appendAudit({
          campaignId: config.campaignId,
          phoneNumber: contact.phoneNumber,
          decision: 'rejected',
          reason,
          timezone: null,
          timezoneSource: resolution.source,
          frequencyCountAtDecision: 0,
          frequencyCap: config.frequencyCap,
          scheduledAtUtc: null,
          decidedAtUtc: DateTime.utc().toISO()!,
        });
        rejected.push({ contactId: contact.id, phoneNumber: contact.phoneNumber, reason });
        continue;
      }

      const timezone = resolution.timezone;
      const slot = this.findCompliantSlot(contact.phoneNumber, timezone, config, callWindow);

      if (!slot) {
        const reason = 'no-compliant-slot-in-horizon';
        this.ledgerService.appendAudit({
          campaignId: config.campaignId,
          phoneNumber: contact.phoneNumber,
          decision: 'rejected',
          reason,
          timezone,
          timezoneSource: resolution.source,
          frequencyCountAtDecision: config.frequencyCap,
          frequencyCap: config.frequencyCap,
          scheduledAtUtc: null,
          decidedAtUtc: DateTime.utc().toISO()!,
        });
        rejected.push({ contactId: contact.id, phoneNumber: contact.phoneNumber, reason });
        continue;
      }

      const { instant, frequencyCount } = slot;
      const scheduledAtUtc = instant.toUTC().toISO()!;

      // Reserve durably *before* moving to the next contact, so subsequent
      // contacts (and subsequent runs) see it in their frequency counts.
      this.ledgerService.recordContact(contact.phoneNumber, config.campaignId, scheduledAtUtc);
      this.ledgerService.appendAudit({
        campaignId: config.campaignId,
        phoneNumber: contact.phoneNumber,
        decision: 'scheduled',
        reason: 'compliant-slot-found',
        timezone,
        timezoneSource: resolution.source,
        frequencyCountAtDecision: frequencyCount,
        frequencyCap: config.frequencyCap,
        scheduledAtUtc,
        decidedAtUtc: DateTime.utc().toISO()!,
      });

      scheduled.push({
        contactId: contact.id,
        phoneNumber: contact.phoneNumber,
        scheduledAtUtc,
        timezone,
        timezoneSource: resolution.source,
        frequencyCountAtDecision: frequencyCount,
      });
    }

    return { scheduled, rejected };
  }

  private findCompliantSlot(
    phoneNumber: string,
    timezone: string,
    config: CampaignConfig,
    callWindow: { startHour: number; endHour: number },
  ): { instant: DateTime; frequencyCount: number } | null {
    let cursor = config.horizonStartUtc;

    while (cursor <= config.horizonEndUtc) {
      if (this.complianceService.isWithinCallWindow(timezone, cursor, callWindow)) {
        const windowStart = cursor.minus({ days: config.frequencyWindowDays }).toUTC().toISO()!;
        const asOf = cursor.toUTC().toISO()!;
        const frequencyCount = this.ledgerService.countRecentContacts(
          phoneNumber,
          config.campaignId,
          windowStart,
          asOf,
        );
        if (frequencyCount < config.frequencyCap) {
          return { instant: cursor, frequencyCount };
        }
      }
      cursor = cursor.plus({ minutes: config.slotIntervalMinutes });
    }
    return null;
  }
}
