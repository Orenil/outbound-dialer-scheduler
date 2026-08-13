import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';

export const LEDGER_DB_PATH = 'LEDGER_DB_PATH';

/**
 * LEDGER_DB_PATH defaults to a local SQLite file. Swapping to Postgres in
 * production means replacing LedgerService's internals with a `pg` pool
 * (see LedgerService's doc comment) -- this module's shape doesn't change.
 */
@Module({
  providers: [
    {
      provide: LEDGER_DB_PATH,
      useValue: process.env.LEDGER_DB_PATH ?? './data/ledger.sqlite',
    },
    {
      provide: LedgerService,
      useFactory: (dbPath: string) => new LedgerService(dbPath),
      inject: [LEDGER_DB_PATH],
    },
  ],
  exports: [LedgerService],
})
export class LedgerModule {}
