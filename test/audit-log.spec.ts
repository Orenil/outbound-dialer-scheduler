import { DateTime } from 'luxon';
import { TimezoneService } from '../src/timezone/timezone.service';
import { ComplianceService } from '../src/compliance/compliance.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { ScheduleGeneratorService } from '../src/scheduling/schedule-generator.service';
import { Contact } from '../src/scheduling/types';

describe('Audit log completeness', () => {
  it('logs exactly one audit entry per attempted contact, with every compliance input populated', () => {
    const ledger = new LedgerService(':memory:');
    const generator = new ScheduleGeneratorService(new TimezoneService(), new ComplianceService(), ledger);

    const contacts: Contact[] = [
      { id: 'c-scheduled', phoneNumber: '+12125550100', ported: false }, // will be scheduled
      { id: 'c-ported', phoneNumber: '+13035550100', ported: true }, // rejected: ambiguous
      { id: 'c-unknown-npa', phoneNumber: '+19995550100', ported: false }, // rejected: ambiguous
      { id: 'c-unparseable', phoneNumber: 'garbage', ported: false }, // rejected: ambiguous
    ];

    const horizonStartUtc = DateTime.fromISO('2026-06-01T12:00:00Z', { zone: 'utc' }); // 08:00 EDT
    const horizonEndUtc = horizonStartUtc.plus({ days: 5 });

    const result = generator.generate(contacts, {
      campaignId: 'audit-test',
      frequencyCap: 2,
      frequencyWindowDays: 7,
      slotIntervalMinutes: 15,
      horizonStartUtc,
      horizonEndUtc,
    });

    const audits = ledger.getAuditLogs('audit-test');

    // Completeness: every attempted contact (scheduled or rejected) has exactly one audit row.
    expect(audits).toHaveLength(contacts.length);
    expect(audits).toHaveLength(result.scheduled.length + result.rejected.length);

    const auditsByPhone = new Map(audits.map((a) => [a.phoneNumber, a]));

    const scheduledAudit = auditsByPhone.get('+12125550100')!;
    expect(scheduledAudit.decision).toBe('scheduled');
    expect(scheduledAudit.timezone).toBe('America/New_York');
    expect(scheduledAudit.timezoneSource).toBe('npa-lookup');
    expect(scheduledAudit.frequencyCountAtDecision).toBe(0);
    expect(scheduledAudit.frequencyCap).toBe(2);
    expect(scheduledAudit.scheduledAtUtc).not.toBeNull();
    expect(scheduledAudit.decidedAtUtc).toBeTruthy();

    const portedAudit = auditsByPhone.get('+13035550100')!;
    expect(portedAudit.decision).toBe('rejected');
    expect(portedAudit.timezone).toBeNull();
    expect(portedAudit.timezoneSource).toBe('ported-ambiguous');
    expect(portedAudit.scheduledAtUtc).toBeNull();

    const unknownNpaAudit = auditsByPhone.get('+19995550100')!;
    expect(unknownNpaAudit.decision).toBe('rejected');
    expect(unknownNpaAudit.timezoneSource).toBe('unknown-area-code');

    const unparseableAudit = auditsByPhone.get('garbage')!;
    expect(unparseableAudit.decision).toBe('rejected');
    expect(unparseableAudit.timezoneSource).toBe('unparseable-number');

    // Every audit row, regardless of outcome, has a non-empty reason and decidedAtUtc --
    // "logs its compliance inputs per attempted call" means no attempt is ever silent.
    for (const audit of audits) {
      expect(audit.reason.length).toBeGreaterThan(0);
      expect(audit.decidedAtUtc.length).toBeGreaterThan(0);
      expect(audit.frequencyCap).toBe(2);
      expect(typeof audit.frequencyCountAtDecision).toBe('number');
    }

    ledger.close();
  });

  it('logs a rejection (not silence) when frequency cap exhausts the entire horizon', () => {
    const ledger = new LedgerService(':memory:');
    const generator = new ScheduleGeneratorService(new TimezoneService(), new ComplianceService(), ledger);

    const contacts: Contact[] = Array.from({ length: 4 }, (_, i) => ({
      id: `c${i}`,
      phoneNumber: '+12125550100',
      ported: false,
    }));

    const horizonStartUtc = DateTime.fromISO('2026-06-01T12:00:00Z', { zone: 'utc' });
    generator.generate(contacts, {
      campaignId: 'audit-cap-test',
      frequencyCap: 1,
      frequencyWindowDays: 30,
      slotIntervalMinutes: 15,
      horizonStartUtc,
      horizonEndUtc: horizonStartUtc.plus({ days: 2 }),
    });

    const audits = ledger.getAuditLogs('audit-cap-test');
    expect(audits).toHaveLength(4);
    expect(audits.filter((a) => a.decision === 'scheduled')).toHaveLength(1);
    expect(audits.filter((a) => a.decision === 'rejected')).toHaveLength(3);
    for (const rejected of audits.filter((a) => a.decision === 'rejected')) {
      expect(rejected.reason).toBe('no-compliant-slot-in-horizon');
    }

    ledger.close();
  });
});
