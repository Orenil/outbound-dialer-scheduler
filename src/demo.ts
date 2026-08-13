import 'reflect-metadata';
import { DateTime } from 'luxon';
import * as fs from 'fs';
import { TimezoneService } from './timezone/timezone.service';
import { ComplianceService } from './compliance/compliance.service';
import { LedgerService } from './ledger/ledger.service';
import { ScheduleGeneratorService } from './scheduling/schedule-generator.service';
import { Contact } from './scheduling/types';
import { runPacingSimulation, PacingSimConfig } from './pacing/pacing-simulator';

const AREA_CODES = ['212', '312', '303', '602', '213', '907', '808', '709', '617', '415'];

function buildContacts(n: number): Contact[] {
  const contacts: Contact[] = [];
  for (let i = 0; i < n; i++) {
    const areaCode = AREA_CODES[i % AREA_CODES.length];
    const line = String(1000 + i).padStart(4, '0');
    const ported = i % 11 === 0; // ~9% ported/ambiguous, on purpose
    contacts.push({ id: `contact-${i}`, phoneNumber: `+1${areaCode}555${line}`, ported });
  }
  // A couple of genuinely unparseable / unknown-area-code numbers to show deny-by-default.
  contacts.push({ id: 'contact-bad-1', phoneNumber: '+19995550001', ported: false }); // unknown NPA
  contacts.push({ id: 'contact-bad-2', phoneNumber: '12345', ported: false }); // unparseable
  return contacts;
}

function runSchedulingDemo(): void {
  console.log('=== Scheduling demo ===');
  const dbFile = './data/demo-ledger.sqlite';
  fs.mkdirSync('./data', { recursive: true });
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);

  const timezoneService = new TimezoneService();
  const complianceService = new ComplianceService();
  const ledgerService = new LedgerService(dbFile);
  const generator = new ScheduleGeneratorService(timezoneService, complianceService, ledgerService);

  const contacts = buildContacts(40);
  const horizonStart = DateTime.fromISO('2026-03-06T00:00:00Z', { zone: 'utc' }); // spans US DST start (Mar 8, 2026)
  const horizonEnd = horizonStart.plus({ days: 10 });

  const result = generator.generate(contacts, {
    campaignId: 'spring-campaign',
    frequencyCap: 2,
    frequencyWindowDays: 7,
    slotIntervalMinutes: 15,
    horizonStartUtc: horizonStart,
    horizonEndUtc: horizonEnd,
  });

  console.log(`contacts submitted: ${contacts.length}`);
  console.log(`scheduled: ${result.scheduled.length}`);
  console.log(`rejected: ${result.rejected.length}`);
  console.log('rejection reasons:', [...new Set(result.rejected.map((r) => r.reason))]);
  console.log('\nsample scheduled calls:');
  for (const call of result.scheduled.slice(0, 5)) {
    const local = DateTime.fromISO(call.scheduledAtUtc).setZone(call.timezone);
    console.log(
      `  ${call.phoneNumber} -> ${call.scheduledAtUtc} (local ${local.toFormat('ccc yyyy-LL-dd HH:mm')} ${call.timezone}), freq_count_at_decision=${call.frequencyCountAtDecision}`,
    );
  }

  const audits = ledgerService.getAuditLogs('spring-campaign');
  console.log(`\naudit log entries: ${audits.length} (== scheduled + rejected: ${result.scheduled.length + result.rejected.length})`);

  ledgerService.close();
}

function runPacingDemo(): void {
  console.log('\n=== Pacing demo: predictive vs. fixed-ratio ===');
  const base: Omit<PacingSimConfig, 'fixedRatio' | 'predictiveAggressiveness'> = {
    numAgents: 20,
    answerRate: 0.32,
    meanHandleTimeSec: 240,
    meanRingSetupSec: 6,
    simDurationSec: 2 * 3600,
    tickSec: 2,
    abandonRateCeiling: 0.03,
    randomSeed: 42,
  };

  const predictive = runPacingSimulation('predictive', { ...base, fixedRatio: 0, predictiveAggressiveness: 0.3 });
  const fixedConservative = runPacingSimulation('fixed', { ...base, fixedRatio: 0.2, predictiveAggressiveness: 0 });
  const fixedAggressive = runPacingSimulation('fixed', { ...base, fixedRatio: 0.5, predictiveAggressiveness: 0 });

  const rows = [
    { label: 'predictive (aggressiveness=0.3)', r: predictive },
    { label: 'fixed-ratio (0.2x idle agents)', r: fixedConservative },
    { label: 'fixed-ratio (0.5x idle agents)', r: fixedAggressive },
  ];

  console.log(
    'strategy'.padEnd(32),
    'dialed'.padStart(8),
    'answered'.padStart(10),
    'handled'.padStart(9),
    'abandoned'.padStart(11),
    'abandonRate'.padStart(13),
    'utilization'.padStart(13),
  );
  for (const { label, r } of rows) {
    console.log(
      label.padEnd(32),
      String(r.totalDialed).padStart(8),
      String(r.totalAnswered).padStart(10),
      String(r.totalHandled).padStart(9),
      String(r.totalAbandoned).padStart(11),
      `${(r.abandonRate * 100).toFixed(2)}%`.padStart(13),
      `${(r.agentUtilization * 100).toFixed(1)}%`.padStart(13),
    );
  }
}

runSchedulingDemo();
runPacingDemo();
