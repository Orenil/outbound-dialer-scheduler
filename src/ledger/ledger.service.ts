import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';

export interface AuditLogEntry {
  campaignId: string;
  phoneNumber: string;
  decision: 'scheduled' | 'rejected';
  reason: string;
  timezone: string | null;
  timezoneSource: string;
  frequencyCountAtDecision: number;
  frequencyCap: number;
  scheduledAtUtc: string | null;
  decidedAtUtc: string;
}

export interface AuditLogRow extends AuditLogEntry {
  id: number;
}

/**
 * Durable per-number contact-history ledger + compliance audit log, backed
 * by SQLite (better-sqlite3, synchronous). This stands in for a Postgres
 * table in production -- the swap is: replace this class's internals with a
 * `pg`/Postgres-client pool, keep the same method signatures, add the same
 * two tables via a migration (`contact_history`, `audit_log`) with the same
 * columns/index. Nothing above this class (scheduling, compliance, pacing)
 * would need to change, since they only depend on this interface.
 *
 * SQLite is a legitimate durable store for local dev/single-node use, but
 * unlike Postgres it has no built-in row-level locking for concurrent
 * writers across processes -- fine for this project's single-process
 * scheduler, not fine for a horizontally-scaled dialer fleet.
 */
@Injectable()
export class LedgerService implements OnModuleDestroy {
  private readonly db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contact_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        scheduled_at_utc TEXT NOT NULL,
        created_at_utc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contact_history_lookup
        ON contact_history(phone_number, campaign_id, scheduled_at_utc);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('scheduled','rejected')),
        reason TEXT NOT NULL,
        timezone TEXT,
        timezone_source TEXT NOT NULL,
        frequency_count_at_decision INTEGER NOT NULL,
        frequency_cap INTEGER NOT NULL,
        scheduled_at_utc TEXT,
        decided_at_utc TEXT NOT NULL
      );
    `);
  }

  /** Records a durably-reserved contact slot. Counts toward frequency caps immediately. */
  recordContact(phoneNumber: string, campaignId: string, scheduledAtUtc: string): void {
    this.db
      .prepare(
        `INSERT INTO contact_history (phone_number, campaign_id, scheduled_at_utc, created_at_utc)
         VALUES (?, ?, ?, ?)`,
      )
      .run(phoneNumber, campaignId, scheduledAtUtc, new Date().toISOString());
  }

  /**
   * Counts contacts for this number/campaign in the fully-closed interval
   * [windowStartUtc, asOfUtc]. The upper bound is deliberately inclusive
   * (not the more conventional half-open range): scheduling decisions are
   * evaluated *before* the candidate contact is recorded, so if two
   * candidate slots ever land on the exact same instant (possible at coarse
   * slot granularity), the first one's ledger write must still be visible
   * to the second one's cap check at that identical timestamp. An
   * exclusive upper bound would create a blind spot there and let the cap
   * be silently exceeded.
   */
  countRecentContacts(
    phoneNumber: string,
    campaignId: string,
    windowStartUtc: string,
    asOfUtc: string,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM contact_history
         WHERE phone_number = ? AND campaign_id = ?
           AND scheduled_at_utc >= ? AND scheduled_at_utc <= ?`,
      )
      .get(phoneNumber, campaignId, windowStartUtc, asOfUtc) as { n: number };
    return row.n;
  }

  appendAudit(entry: AuditLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log
          (campaign_id, phone_number, decision, reason, timezone, timezone_source,
           frequency_count_at_decision, frequency_cap, scheduled_at_utc, decided_at_utc)
         VALUES (@campaignId, @phoneNumber, @decision, @reason, @timezone, @timezoneSource,
           @frequencyCountAtDecision, @frequencyCap, @scheduledAtUtc, @decidedAtUtc)`,
      )
      .run(entry);
  }

  getAuditLogs(campaignId?: string): AuditLogRow[] {
    const rows = campaignId
      ? this.db.prepare(`SELECT * FROM audit_log WHERE campaign_id = ? ORDER BY id`).all(campaignId)
      : this.db.prepare(`SELECT * FROM audit_log ORDER BY id`).all();
    return (rows as any[]).map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      phoneNumber: r.phone_number,
      decision: r.decision,
      reason: r.reason,
      timezone: r.timezone,
      timezoneSource: r.timezone_source,
      frequencyCountAtDecision: r.frequency_count_at_decision,
      frequencyCap: r.frequency_cap,
      scheduledAtUtc: r.scheduled_at_utc,
      decidedAtUtc: r.decided_at_utc,
    }));
  }

  getContactHistory(phoneNumber: string, campaignId: string): { scheduledAtUtc: string }[] {
    const rows = this.db
      .prepare(
        `SELECT scheduled_at_utc FROM contact_history
         WHERE phone_number = ? AND campaign_id = ? ORDER BY scheduled_at_utc`,
      )
      .all(phoneNumber, campaignId) as { scheduled_at_utc: string }[];
    return rows.map((r) => ({ scheduledAtUtc: r.scheduled_at_utc }));
  }

  onModuleDestroy(): void {
    this.db.close();
  }

  close(): void {
    this.db.close();
  }
}
