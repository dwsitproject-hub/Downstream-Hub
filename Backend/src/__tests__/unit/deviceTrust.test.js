/**
 * Unit tests for device trust / MFA bypass window evaluation.
 */
const deviceTrust = require('../../lib/deviceTrust');

describe('deviceTrust', () => {
  describe('isWithinBypassWindow', () => {
    const policyRolling = { login_mfa_bypass_mode: 'rolling_24h', login_mfa_bypass_hours: 24 };
    const policyCalendar = { login_mfa_bypass_mode: 'calendar_day', login_mfa_bypass_timezone: 'UTC' };

    test('rolling_24h — within window', () => {
      const now = new Date('2026-08-05T14:00:00.000Z');
      const device = { last_verified_at: new Date('2026-08-05T02:00:00.000Z') };
      expect(deviceTrust.isWithinBypassWindow(device, policyRolling, now)).toBe(true);
    });

    test('rolling_24h — outside window', () => {
      const now = new Date('2026-08-05T14:00:00.000Z');
      const device = { last_verified_at: new Date('2026-08-04T13:00:00.000Z') };
      expect(deviceTrust.isWithinBypassWindow(device, policyRolling, now)).toBe(false);
    });

    test('calendar_day — same UTC day', () => {
      const now = new Date('2026-08-05T23:00:00.000Z');
      const device = { last_verified_at: new Date('2026-08-05T01:00:00.000Z') };
      expect(deviceTrust.isWithinBypassWindow(device, policyCalendar, now)).toBe(true);
    });

    test('calendar_day — different UTC day', () => {
      const now = new Date('2026-08-06T01:00:00.000Z');
      const device = { last_verified_at: new Date('2026-08-05T23:00:00.000Z') };
      expect(deviceTrust.isWithinBypassWindow(device, policyCalendar, now)).toBe(false);
    });

    test('returns false when last_verified_at missing', () => {
      expect(deviceTrust.isWithinBypassWindow({}, policyRolling, new Date())).toBe(false);
    });

    describe('rolling_days', () => {
      const policyDays = { login_mfa_bypass_mode: 'rolling_days', login_mfa_bypass_days: 7 };
      const now = new Date('2026-08-20T10:00:00.000Z');
      const daysAgo = (d) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

      test('within N days of the last real MFA', () => {
        const device = { last_mfa_at: daysAgo(3), last_verified_at: daysAgo(3) };
        expect(deviceTrust.isWithinBypassWindow(device, policyDays, now)).toBe(true);
      });

      test('outside N days of the last real MFA', () => {
        const device = { last_mfa_at: daysAgo(8), last_verified_at: daysAgo(8) };
        expect(deviceTrust.isWithinBypassWindow(device, policyDays, now)).toBe(false);
      });

      test('a recent bypassed login does not extend the window', () => {
        // last_verified_at is refreshed by every bypassed login; only last_mfa_at counts.
        const device = { last_mfa_at: daysAgo(10), last_verified_at: daysAgo(0.05) };
        expect(deviceTrust.isWithinBypassWindow(device, policyDays, now)).toBe(false);
      });

      test('requires MFA when the device has no last_mfa_at yet', () => {
        const device = { last_verified_at: daysAgo(1) };
        expect(deviceTrust.isWithinBypassWindow(device, policyDays, now)).toBe(false);
      });

      test('caps the window at MAX_BYPASS_DAYS', () => {
        const policyHuge = { login_mfa_bypass_mode: 'rolling_days', login_mfa_bypass_days: 365 };
        const device = { last_mfa_at: daysAgo(deviceTrust.MAX_BYPASS_DAYS + 1) };
        expect(deviceTrust.isWithinBypassWindow(device, policyHuge, now)).toBe(false);
      });
    });
  });

  describe('deviceHashFromToken', () => {
    test('produces stable SHA-256 hex', () => {
      const h1 = deviceTrust.deviceHashFromToken('abc');
      const h2 = deviceTrust.deviceHashFromToken('abc');
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64);
    });
  });
});
