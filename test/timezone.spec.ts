import { TimezoneService } from '../src/timezone/timezone.service';

describe('TimezoneService', () => {
  const service = new TimezoneService();

  it('resolves a known area code to the correct IANA zone', () => {
    const res = service.resolve('+12125550100', false); // 212 -> NYC
    expect(res.isAmbiguous).toBe(false);
    expect(res.timezone).toBe('America/New_York');
    expect(res.source).toBe('npa-lookup');
  });

  it('resolves Arizona (no-DST) numbers distinctly from other Mountain numbers', () => {
    const phoenix = service.resolve('+16025550100', false);
    const denver = service.resolve('+13035550100', false);
    expect(phoenix.timezone).toBe('America/Phoenix');
    expect(denver.timezone).toBe('America/Denver');
  });

  it('resolves Hawaii (no-DST) and Newfoundland (half-hour offset) numbers', () => {
    expect(service.resolve('+18085550100', false).timezone).toBe('Pacific/Honolulu');
    expect(service.resolve('+17095550100', false).timezone).toBe('America/St_Johns');
  });

  it('denies by default for ported numbers regardless of area code validity', () => {
    const res = service.resolve('+12125550100', true);
    expect(res.isAmbiguous).toBe(true);
    expect(res.timezone).toBeNull();
    expect(res.source).toBe('ported-ambiguous');
  });

  it('denies by default for unknown area codes', () => {
    const res = service.resolve('+19995550100', false);
    expect(res.isAmbiguous).toBe(true);
    expect(res.source).toBe('unknown-area-code');
  });

  it('denies by default for unparseable numbers', () => {
    const res = service.resolve('12345', false);
    expect(res.isAmbiguous).toBe(true);
    expect(res.source).toBe('unparseable-number');
  });
});
