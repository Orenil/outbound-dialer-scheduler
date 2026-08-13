/**
 * North American Numbering Plan (NANP) area code -> IANA timezone.
 *
 * This is real public NANP data (a representative subset, not the full ~350
 * area codes) deliberately chosen to cover every DST edge case the compliance
 * engine has to get right:
 *  - standard DST-observing zones (Eastern/Central/Mountain/Pacific)
 *  - Arizona, which shares the Mountain UTC offset but does NOT observe DST
 *    (America/Phoenix)
 *  - Hawaii, which does not observe DST (Pacific/Honolulu)
 *  - Newfoundland, a real UTC-3:30 half-hour offset zone (America/St_Johns)
 *
 * In production this table would be replaced by a carrier LRN (Local Routing
 * Number) / NPAC dip or a paid CNAM+timezone data provider, since area codes
 * are only a first-order approximation once a number has been ported. That is
 * exactly why `ported` numbers are treated as ambiguous below regardless of
 * what this table says.
 */
export const NPA_TIMEZONE_TABLE: Readonly<Record<string, string>> = Object.freeze({
  // Eastern (observes DST)
  '212': 'America/New_York', // New York, NY
  '617': 'America/New_York', // Boston, MA
  '305': 'America/New_York', // Miami, FL
  '202': 'America/New_York', // Washington, DC
  '404': 'America/New_York', // Atlanta, GA
  '215': 'America/New_York', // Philadelphia, PA
  '313': 'America/New_York', // Detroit, MI
  '416': 'America/Toronto', // Toronto, ON

  // Central (observes DST)
  '312': 'America/Chicago', // Chicago, IL
  '214': 'America/Chicago', // Dallas, TX
  '713': 'America/Chicago', // Houston, TX
  '615': 'America/Chicago', // Nashville, TN
  '314': 'America/Chicago', // St. Louis, MO

  // Mountain (observes DST)
  '303': 'America/Denver', // Denver, CO
  '505': 'America/Denver', // Albuquerque, NM
  '406': 'America/Denver', // Montana

  // Mountain offset, NO DST
  '602': 'America/Phoenix', // Phoenix, AZ
  '480': 'America/Phoenix', // Phoenix metro, AZ
  '623': 'America/Phoenix', // Phoenix metro, AZ

  // Pacific (observes DST)
  '213': 'America/Los_Angeles', // Los Angeles, CA
  '310': 'America/Los_Angeles', // Los Angeles, CA
  '415': 'America/Los_Angeles', // San Francisco, CA
  '206': 'America/Los_Angeles', // Seattle, WA
  '503': 'America/Los_Angeles', // Portland, OR

  // Alaska (observes DST)
  '907': 'America/Anchorage',

  // Hawaii, NO DST
  '808': 'Pacific/Honolulu',

  // Newfoundland, UTC-3:30, observes DST
  '709': 'America/St_Johns',
});

/**
 * Extracts the NANP area code (NPA) from an E.164-ish or bare 10/11-digit
 * North American number. Returns null if the number doesn't look like a
 * parseable NANP number at all (ambiguous by construction).
 */
export function extractAreaCode(phoneNumber: string): string | null {
  const digits = phoneNumber.replace(/\D/g, '');
  let national = digits;
  if (digits.length === 11 && digits.startsWith('1')) {
    national = digits.slice(1);
  }
  if (national.length !== 10) {
    return null;
  }
  return national.slice(0, 3);
}
