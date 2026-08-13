import { LedgerService } from '../src/ledger/ledger.service';

describe('LedgerService', () => {
  let ledger: LedgerService;

  beforeEach(() => {
    ledger = new LedgerService(':memory:');
  });

  afterEach(() => {
    ledger.close();
  });

  it('persists contact history and counts within a fully-closed window', () => {
    ledger.recordContact('+12125550100', 'camp-1', '2026-01-01T00:00:00.000Z');
    ledger.recordContact('+12125550100', 'camp-1', '2026-01-05T00:00:00.000Z');

    // exact lower boundary is inclusive
    expect(
      ledger.countRecentContacts('+12125550100', 'camp-1', '2026-01-01T00:00:00.000Z', '2026-01-10T00:00:00.000Z'),
    ).toBe(2);

    // exact upper boundary ("as of") is also inclusive -- a contact landing on the exact
    // decision instant still counts, so coincident-timestamp slots can't dodge the cap.
    expect(
      ledger.countRecentContacts('+12125550100', 'camp-1', '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z'),
    ).toBe(2);
    expect(
      ledger.countRecentContacts('+12125550100', 'camp-1', '2026-01-01T00:00:00.000Z', '2026-01-04T23:59:59.999Z'),
    ).toBe(1);

    // a window that starts after the first contact excludes it
    expect(
      ledger.countRecentContacts('+12125550100', 'camp-1', '2026-01-01T00:00:00.001Z', '2026-01-10T00:00:00.000Z'),
    ).toBe(1);
  });

  it('scopes counts per phone number and per campaign independently', () => {
    ledger.recordContact('+12125550100', 'camp-1', '2026-01-01T00:00:00.000Z');
    ledger.recordContact('+12125550101', 'camp-1', '2026-01-01T00:00:00.000Z');
    ledger.recordContact('+12125550100', 'camp-2', '2026-01-01T00:00:00.000Z');

    expect(
      ledger.countRecentContacts('+12125550100', 'camp-1', '2025-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
    ).toBe(1);
    expect(
      ledger.countRecentContacts('+12125550100', 'camp-2', '2025-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
    ).toBe(1);
    expect(
      ledger.countRecentContacts('+19995550100', 'camp-1', '2025-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
    ).toBe(0);
  });

  it('records and retrieves audit log entries with all compliance-input fields intact', () => {
    ledger.appendAudit({
      campaignId: 'camp-1',
      phoneNumber: '+12125550100',
      decision: 'scheduled',
      reason: 'compliant-slot-found',
      timezone: 'America/New_York',
      timezoneSource: 'npa-lookup',
      frequencyCountAtDecision: 1,
      frequencyCap: 3,
      scheduledAtUtc: '2026-01-01T13:00:00.000Z',
      decidedAtUtc: '2026-01-01T00:00:00.000Z',
    });

    const rows = ledger.getAuditLogs('camp-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      campaignId: 'camp-1',
      phoneNumber: '+12125550100',
      decision: 'scheduled',
      timezone: 'America/New_York',
      timezoneSource: 'npa-lookup',
      frequencyCountAtDecision: 1,
      frequencyCap: 3,
    });
  });
});
