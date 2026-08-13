import { DateTime } from 'luxon';
import { TimezoneService } from '../src/timezone/timezone.service';
import { ComplianceService } from '../src/compliance/compliance.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { ScheduleGeneratorService } from '../src/scheduling/schedule-generator.service';
import { Contact } from '../src/scheduling/types';

describe('ScheduleGeneratorService', () => {
  let ledger: LedgerService;
  let generator: ScheduleGeneratorService;

  beforeEach(() => {
    ledger = new LedgerService(':memory:');
    generator = new ScheduleGeneratorService(new TimezoneService(), new ComplianceService(), ledger);
  });

  afterEach(() => ledger.close());

  const horizonStart = DateTime.fromISO('2026-06-01T00:00:00Z', { zone: 'utc' });
  const horizonEnd = horizonStart.plus({ days: 14 });

  it('schedules a compliant contact inside the recipient local calling window', () => {
    const contacts: Contact[] = [{ id: 'c1', phoneNumber: '+12125550100', ported: false }];
    const result = generator.generate(contacts, {
      campaignId: 'test',
      frequencyCap: 3,
      frequencyWindowDays: 7,
      slotIntervalMinutes: 15,
      horizonStartUtc: horizonStart,
      horizonEndUtc: horizonEnd,
    });

    expect(result.scheduled).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    const local = DateTime.fromISO(result.scheduled[0].scheduledAtUtc).setZone('America/New_York');
    expect(local.hour).toBeGreaterThanOrEqual(8);
    expect(local.hour).toBeLessThan(21);
  });

  it('rejects ambiguous (ported) numbers instead of guessing a timezone', () => {
    const contacts: Contact[] = [{ id: 'c1', phoneNumber: '+12125550100', ported: true }];
    const result = generator.generate(contacts, {
      campaignId: 'test',
      frequencyCap: 3,
      frequencyWindowDays: 7,
      slotIntervalMinutes: 15,
      horizonStartUtc: horizonStart,
      horizonEndUtc: horizonEnd,
    });
    expect(result.scheduled).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('timezone-ambiguous:ported-ambiguous');
  });

  it('enforces the exact frequency-cap boundary: the (cap+1)th contact within the window is rejected, the cap-th is allowed', () => {
    const phoneNumber = '+12125550100';
    const cap = 3;
    // 2026-06-01T12:00:00Z is exactly 08:00 local in America/New_York (EDT), i.e. the very
    // first instant in the calling window -- so it's also the first candidate slot examined.
    const boundaryStart = DateTime.fromISO('2026-06-01T12:00:00Z', { zone: 'utc' });

    // Pre-seed the ledger with (cap - 1) prior contacts, before the first candidate slot but
    // still well within the 7-day frequency window.
    for (let i = 0; i < cap - 1; i++) {
      ledger.recordContact(phoneNumber, 'test', boundaryStart.minus({ hours: 2 + i }).toISO()!);
    }

    const contacts: Contact[] = [
      { id: 'nth-contact', phoneNumber, ported: false }, // should be the cap-th -> allowed
      { id: 'over-cap-contact', phoneNumber, ported: false }, // would be cap+1-th -> rejected within this horizon
    ];

    const result = generator.generate(contacts, {
      campaignId: 'test',
      frequencyCap: cap,
      frequencyWindowDays: 7,
      slotIntervalMinutes: 15,
      horizonStartUtc: boundaryStart,
      // Keep the horizon inside the 7-day frequency window so there's no valid slot for the
      // over-cap contact to fall back to once the cap is reached.
      horizonEndUtc: boundaryStart.plus({ days: 2 }),
    });

    expect(result.scheduled.map((s) => s.contactId)).toEqual(['nth-contact']);
    expect(result.scheduled[0].scheduledAtUtc).toBe(boundaryStart.toUTC().toISO());
    expect(result.scheduled[0].frequencyCountAtDecision).toBe(cap - 1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].contactId).toBe('over-cap-contact');
    expect(result.rejected[0].reason).toBe('no-compliant-slot-in-horizon');
  });

  it('never double-books beyond the cap even when many contacts target the same number in one run', () => {
    const phoneNumber = '+12125550100';
    const cap = 2;
    const contacts: Contact[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      phoneNumber,
      ported: false,
    }));

    const result = generator.generate(contacts, {
      campaignId: 'test',
      frequencyCap: cap,
      frequencyWindowDays: 7,
      slotIntervalMinutes: 15,
      horizonStartUtc: horizonStart,
      horizonEndUtc: horizonStart.plus({ days: 3 }),
    });

    expect(result.scheduled).toHaveLength(cap);
    expect(result.rejected).toHaveLength(5 - cap);
  });
});
