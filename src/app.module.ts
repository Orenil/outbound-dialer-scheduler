import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LedgerModule } from './ledger/ledger.module';
import { TimezoneService } from './timezone/timezone.service';
import { ComplianceService } from './compliance/compliance.service';
import { ScheduleGeneratorService } from './scheduling/schedule-generator.service';
import { PacingService } from './pacing/pacing.service';

@Module({
  imports: [ScheduleModule.forRoot(), LedgerModule],
  providers: [TimezoneService, ComplianceService, ScheduleGeneratorService, PacingService],
  exports: [TimezoneService, ComplianceService, ScheduleGeneratorService, PacingService],
})
export class AppModule {}
