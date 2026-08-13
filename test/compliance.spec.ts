import { DateTime } from 'luxon';
import { ComplianceService } from '../src/compliance/compliance.service';

describe('ComplianceService', () => {
  const service = new ComplianceService();
  const NY = 'America/New_York';
  const window = { startHour: 8, endHour: 21 };

  it('is exclusive at the window start boundary minus one minute, inclusive at the boundary itself', () => {
    const before = DateTime.fromISO('2026-06-01T11:59:00Z', { zone: 'utc' }); // EDT: local 07:59
    const atStart = DateTime.fromISO('2026-06-01T12:00:00Z', { zone: 'utc' }); // EDT: local 08:00
    expect(service.isWithinCallWindow(NY, before, window)).toBe(false);
    expect(service.isWithinCallWindow(NY, atStart, window)).toBe(true);
  });

  it('is inclusive one minute before the window end, exclusive at the end boundary itself', () => {
    const almostEnd = DateTime.fromISO('2026-06-02T00:59:00Z', { zone: 'utc' }); // EDT: local 20:59
    const atEnd = DateTime.fromISO('2026-06-02T01:00:00Z', { zone: 'utc' }); // EDT: local 21:00
    expect(service.isWithinCallWindow(NY, almostEnd, window)).toBe(true);
    expect(service.isWithinCallWindow(NY, atEnd, window)).toBe(false);
  });

  it('tracks the post-transition UTC offset on the US spring-forward DST day (2026-03-08)', () => {
    // 2026-03-08 07:00 UTC is the instant New York jumps from 01:59 EST straight to 03:00 EDT.
    const justBeforeWindowUsingNewOffset = DateTime.fromISO('2026-03-08T11:59:00Z', { zone: 'utc' }); // local 07:59 EDT
    const atWindowStartUsingNewOffset = DateTime.fromISO('2026-03-08T12:00:00Z', { zone: 'utc' }); // local 08:00 EDT
    expect(justBeforeWindowUsingNewOffset.setZone(NY).toFormat('HH:mm')).toBe('07:59');
    expect(atWindowStartUsingNewOffset.setZone(NY).toFormat('HH:mm')).toBe('08:00');
    expect(service.isWithinCallWindow(NY, justBeforeWindowUsingNewOffset, window)).toBe(false);
    expect(service.isWithinCallWindow(NY, atWindowStartUsingNewOffset, window)).toBe(true);

    // The nonexistent local hour (02:00-02:59 on 2026-03-08, skipped by the spring-forward) never
    // gets misclassified as "within window" or crashes the check either side of the gap.
    const justBeforeGap = DateTime.fromISO('2026-03-08T06:59:00Z', { zone: 'utc' }); // local 01:59 EST
    const justAfterGap = DateTime.fromISO('2026-03-08T07:00:00Z', { zone: 'utc' }); // local 03:00 EDT
    expect(service.isWithinCallWindow(NY, justBeforeGap, window)).toBe(false);
    expect(service.isWithinCallWindow(NY, justAfterGap, window)).toBe(false);
  });

  it('tracks the post-transition UTC offset on the US fall-back DST day (2026-11-01)', () => {
    const almostEnd = DateTime.fromISO('2026-11-02T01:59:00Z', { zone: 'utc' }); // local 20:59 EST
    const atEnd = DateTime.fromISO('2026-11-02T02:00:00Z', { zone: 'utc' }); // local 21:00 EST
    expect(almostEnd.setZone(NY).toFormat('HH:mm')).toBe('20:59');
    expect(atEnd.setZone(NY).toFormat('HH:mm')).toBe('21:00');
    expect(service.isWithinCallWindow(NY, almostEnd, window)).toBe(true);
    expect(service.isWithinCallWindow(NY, atEnd, window)).toBe(false);

    // Both UTC instants that map to the twice-occurring local 01:30 (once EDT, once EST) are
    // consistently outside the calling window, regardless of which occurrence it is.
    const firstOccurrence = DateTime.fromISO('2026-11-01T05:30:00Z', { zone: 'utc' }); // 01:30 EDT
    const secondOccurrence = DateTime.fromISO('2026-11-01T06:30:00Z', { zone: 'utc' }); // 01:30 EST
    expect(firstOccurrence.setZone(NY).toFormat('HH:mm')).toBe('01:30');
    expect(secondOccurrence.setZone(NY).toFormat('HH:mm')).toBe('01:30');
    expect(service.isWithinCallWindow(NY, firstOccurrence, window)).toBe(false);
    expect(service.isWithinCallWindow(NY, secondOccurrence, window)).toBe(false);
  });

  it('never observes DST drift for a zone that does not use it (Arizona)', () => {
    // Same UTC instants as the spring-forward test, but Phoenix does not move -- MST year round.
    const marchInstant = DateTime.fromISO('2026-03-08T15:00:00Z', { zone: 'utc' }); // 08:00 MST
    const julyInstant = DateTime.fromISO('2026-07-08T15:00:00Z', { zone: 'utc' }); // 08:00 MST (no DST shift)
    expect(marchInstant.setZone('America/Phoenix').toFormat('HH:mm')).toBe('08:00');
    expect(julyInstant.setZone('America/Phoenix').toFormat('HH:mm')).toBe('08:00');
    expect(service.isWithinCallWindow('America/Phoenix', marchInstant, window)).toBe(true);
    expect(service.isWithinCallWindow('America/Phoenix', julyInstant, window)).toBe(true);
  });

  it('treats an unresolvable/invalid IANA zone as non-compliant rather than throwing', () => {
    const instant = DateTime.fromISO('2026-06-01T12:00:00Z', { zone: 'utc' });
    expect(service.isWithinCallWindow('Not/A_Real_Zone', instant, window)).toBe(false);
  });
});
