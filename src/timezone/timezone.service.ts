import { Injectable } from '@nestjs/common';
import { extractAreaCode, NPA_TIMEZONE_TABLE } from './npa-timezone-table';

export type TimezoneSource = 'npa-lookup' | 'ported-ambiguous' | 'unknown-area-code' | 'unparseable-number';

export interface TimezoneResolution {
  /** IANA zone name, or null when resolution is ambiguous (deny-by-default territory). */
  timezone: string | null;
  source: TimezoneSource;
  isAmbiguous: boolean;
}

/**
 * Resolves a recipient's local IANA timezone from number metadata.
 *
 * Deny-by-default: any number we can't confidently place in a timezone
 * (unparseable, unknown area code, or flagged as ported) resolves to
 * `timezone: null` / `isAmbiguous: true` rather than guessing. Callers must
 * treat an ambiguous resolution as "cannot verify compliance" and refuse to
 * schedule, not fall back to a default zone.
 */
@Injectable()
export class TimezoneService {
  resolve(phoneNumber: string, ported: boolean): TimezoneResolution {
    // A ported number may have moved to a carrier/region far from its
    // original area code. Without a real NPAC/LRN dip we cannot trust the
    // NPA table for it, so it is ambiguous by policy regardless of whether
    // the area code itself is known.
    if (ported) {
      return { timezone: null, source: 'ported-ambiguous', isAmbiguous: true };
    }

    const areaCode = extractAreaCode(phoneNumber);
    if (!areaCode) {
      return { timezone: null, source: 'unparseable-number', isAmbiguous: true };
    }

    const timezone = NPA_TIMEZONE_TABLE[areaCode];
    if (!timezone) {
      return { timezone: null, source: 'unknown-area-code', isAmbiguous: true };
    }

    return { timezone, source: 'npa-lookup', isAmbiguous: false };
  }
}
