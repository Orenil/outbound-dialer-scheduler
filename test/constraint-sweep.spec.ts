import { DateTime } from 'luxon';
import { TimezoneService } from '../src/timezone/timezone.service';
import { ComplianceService, DEFAULT_CALL_WINDOW } from '../src/compliance/compliance.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { ScheduleGeneratorService } from '../src/scheduling/schedule-generator.service';
import { Contact } from '../src/scheduling/types';
import { NPA_TIMEZONE_TABLE } from '../src/timezone/npa-timezone-table';

/**
 * Constraint-violation sweep: generates a real schedule across a large,
 * deliberately adversarial contact set and horizon, then independently
 * re-derives (from scratch, without calling back into the code under test)
 * whether every single scheduled call honors the time-window and
 * frequency-cap constraints. Zero violations is the bar -- this is the
 * project's core correctness guarantee.
 */
describe('Constraint-violation sweep', () => {
  const AREA_CODES = Object.keys(NPA_TIMEZONE_TABLE); // every zone type: DST, no-DST, half-hour offset

  function buildAdversarialContacts(): Contact[] {
    const contacts: Contact[] = [];
    // Every known area code, each dialed multiple times (to stress the frequency cap),
    // interleaved with distinct numbers so the scheduler can't just serialize everything.
    for (const areaCode of AREA_CODES) {
      for (let i = 0; i < 4; i++) {
        contacts.push({ id: `${areaCode}-repeat-${i}`, phoneNumber: `+1${areaCode}5551234`, ported: false });
      }
    }
    // Ambiguous cases that must always be rejected, never guessed.
    contacts.push({ id: 'ported-1', phoneNumber: '+12125559999', ported: true });
    contacts.push({ id: 'unknown-npa', phoneNumber: '+19995550000', ported: false });
    contacts.push({ id: 'unparseable', phoneNumber: 'not-a-number', ported: false });
    return contacts;
  }

  it('produces zero time-window or frequency-cap violations across a DST-spanning horizon', () => {
    const ledger = new LedgerService(':memory:');
    const generator = new ScheduleGeneratorService(new TimezoneService(), new ComplianceService(), ledger);

    const frequencyCap = 2;
    const frequencyWindowDays = 5;
    // Spans the 2026-03-08 US spring-forward DST transition.
    const horizonStartUtc = DateTime.fromISO('2026-03-01T00:00:00Z', { zone: 'utc' });
    const horizonEndUtc = horizonStartUtc.plus({ days: 20 });

    const result = generator.generate(buildAdversarialContacts(), {
      campaignId: 'sweep',
      frequencyCap,
      frequencyWindowDays,
      slotIntervalMinutes: 15,
      horizonStartUtc,
      horizonEndUtc,
    });

    expect(result.scheduled.length).toBeGreaterThan(0);

    // --- Violation 1: any scheduled call outside its recipient's local calling window ---
    const windowViolations = result.scheduled.filter((call) => {
      const local = DateTime.fromISO(call.scheduledAtUtc, { zone: 'utc' }).setZone(call.timezone);
      const minuteOfDay = local.hour * 60 + local.minute;
      return (
        minuteOfDay < DEFAULT_CALL_WINDOW.startHour * 60 || minuteOfDay >= DEFAULT_CALL_WINDOW.endHour * 60
      );
    });
    expect(windowViolations).toEqual([]);

    // --- Violation 2: any number contacted more than `frequencyCap` times in any
    //     `frequencyWindowDays`-day trailing window, independently recomputed. ---
    const byNumber = new Map<string, DateTime[]>();
    for (const call of result.scheduled) {
      const list = byNumber.get(call.phoneNumber) ?? [];
      list.push(DateTime.fromISO(call.scheduledAtUtc, { zone: 'utc' }));
      byNumber.set(call.phoneNumber, list);
    }
    const frequencyViolations: string[] = [];
    for (const [phoneNumber, instants] of byNumber) {
      const sorted = [...instants].sort((a, b) => a.toMillis() - b.toMillis());
      for (const instant of sorted) {
        const windowStart = instant.minus({ days: frequencyWindowDays });
        const countInWindow = sorted.filter((t) => t >= windowStart && t <= instant).length;
        if (countInWindow > frequencyCap) {
          frequencyViolations.push(`${phoneNumber} @ ${instant.toISO()}: ${countInWindow} > cap ${frequencyCap}`);
        }
      }
    }
    expect(frequencyViolations).toEqual([]);

    // --- Violation 3: any scheduled call whose timezone resolution was ambiguous ---
    const ambiguousScheduled = result.scheduled.filter((c) => !c.timezone || c.timezoneSource !== 'npa-lookup');
    expect(ambiguousScheduled).toEqual([]);

    // The three intentionally-ambiguous contacts must always be rejected, never scheduled.
    const rejectedIds = new Set(result.rejected.map((r) => r.contactId));
    expect(rejectedIds.has('ported-1')).toBe(true);
    expect(rejectedIds.has('unknown-npa')).toBe(true);
    expect(rejectedIds.has('unparseable')).toBe(true);

    ledger.close();
  });

  it('produces zero violations across a horizon spanning the fall-back DST transition too', () => {
    const ledger = new LedgerService(':memory:');
    const generator = new ScheduleGeneratorService(new TimezoneService(), new ComplianceService(), ledger);

    const frequencyCap = 3;
    const frequencyWindowDays = 3;
    const horizonStartUtc = DateTime.fromISO('2026-10-25T00:00:00Z', { zone: 'utc' });
    const horizonEndUtc = horizonStartUtc.plus({ days: 14 }); // spans 2026-11-01 fall-back

    const result = generator.generate(buildAdversarialContacts(), {
      campaignId: 'sweep-fallback',
      frequencyCap,
      frequencyWindowDays,
      slotIntervalMinutes: 15,
      horizonStartUtc,
      horizonEndUtc,
    });

    expect(result.scheduled.length).toBeGreaterThan(0);

    const windowViolations = result.scheduled.filter((call) => {
      const local = DateTime.fromISO(call.scheduledAtUtc, { zone: 'utc' }).setZone(call.timezone);
      const minuteOfDay = local.hour * 60 + local.minute;
      return (
        minuteOfDay < DEFAULT_CALL_WINDOW.startHour * 60 || minuteOfDay >= DEFAULT_CALL_WINDOW.endHour * 60
      );
    });
    expect(windowViolations).toEqual([]);

    ledger.close();
  });
});
