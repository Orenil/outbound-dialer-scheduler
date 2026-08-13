import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

export interface CallWindow {
  /** Earliest permissible local hour, 0-23, inclusive. */
  startHour: number;
  /** Latest permissible local hour, 0-23, exclusive (calls must complete before this hour starts). */
  endHour: number;
}

/**
 * Default TCPA-style outbound calling window: 8:00am - 9:00pm recipient
 * local time. This is the commonly cited US federal floor; real deployments
 * would make this campaign/jurisdiction-configurable.
 */
export const DEFAULT_CALL_WINDOW: CallWindow = { startHour: 8, endHour: 21 };

/**
 * Evaluates time-of-day compliance in the recipient's *local* wall-clock
 * time. Because this converts a UTC instant into the target IANA zone via
 * luxon (which carries the full tz database, including DST transition
 * rules), a single fixed UTC calling window would silently drift into
 * non-compliant local hours across a DST transition -- this does not, since
 * it recomputes the local offset for the zone at the specific instant being
 * checked.
 */
@Injectable()
export class ComplianceService {
  isWithinCallWindow(
    timezone: string,
    instantUtc: DateTime,
    window: CallWindow = DEFAULT_CALL_WINDOW,
  ): boolean {
    const local = instantUtc.setZone(timezone);
    if (!local.isValid) {
      // Invalid/unknown IANA zone -> cannot verify -> non-compliant.
      return false;
    }
    const minuteOfDay = local.hour * 60 + local.minute;
    return minuteOfDay >= window.startHour * 60 && minuteOfDay < window.endHour * 60;
  }
}
