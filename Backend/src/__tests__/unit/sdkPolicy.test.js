/**
 * Unit tests for the embeddable SDK's origin, key and sanitising rules.
 */
const p = require('../../lib/sdkPolicy');

describe('sdkPolicy', () => {
  describe('keys', () => {
    test('generated keys are valid and unique', () => {
      const a = p.generateSdkKey();
      const b = p.generateSdkKey();
      expect(p.isValidSdkKey(a)).toBe(true);
      expect(a).not.toBe(b);
      expect(a.startsWith('dwsk_')).toBe(true);
    });

    test('rejects malformed keys', () => {
      ['', 'dwsk_short', 'abc_' + 'x'.repeat(30), null, 42, 'dwsk_' + 'x'.repeat(30) + ' '].forEach((k) => {
        expect(p.isValidSdkKey(k)).toBe(false);
      });
    });
  });

  describe('origins', () => {
    const app = {
      target_url: 'https://KLIP.example.com/dashboard?x=1',
      oidc_redirect_uris: ['https://klip.example.com/auth/callback', 'http://localhost:3001/cb', 'not a url'],
      sdk_allowed_origins: [],
    };

    test('normalizes origins and rejects non-http(s)', () => {
      expect(p.normalizeOrigin('https://App.Example.com:443/a/b')).toBe('https://app.example.com');
      expect(p.normalizeOrigin('http://localhost:3001/x')).toBe('http://localhost:3001');
      expect(p.normalizeOrigin('null')).toBeNull();
      expect(p.normalizeOrigin('file:///c:/x.html')).toBeNull();
      expect(p.normalizeOrigin('javascript:alert(1)')).toBeNull();
    });

    test('defaults come from target_url and redirect URIs', () => {
      expect(p.defaultAllowedOrigins(app).sort()).toEqual(['http://localhost:3001', 'https://klip.example.com']);
    });

    test('explicit allow-list replaces the defaults', () => {
      const explicit = { ...app, sdk_allowed_origins: ['https://klip-staging.example.com/'] };
      expect(p.effectiveAllowedOrigins(explicit)).toEqual(['https://klip-staging.example.com']);
      expect(p.isOriginAllowed('https://klip.example.com', explicit)).toBe(false);
      expect(p.isOriginAllowed('https://klip-staging.example.com', explicit)).toBe(true);
    });

    test('isOriginAllowed matches registered origins only', () => {
      expect(p.isOriginAllowed('https://klip.example.com', app)).toBe(true);
      expect(p.isOriginAllowed('https://evil.example.com', app)).toBe(false);
      expect(p.isOriginAllowed('null', app)).toBe(false);
      expect(p.isOriginAllowed(undefined, app)).toBe(false);
    });
  });

  describe('sanitizePath', () => {
    test('drops query strings, including OIDC callback codes', () => {
      expect(p.sanitizePath('/auth/callback?code=abc&state=xyz')).toBe('/auth/callback');
      expect(p.sanitizePath('/reset-password?token=secret')).toBe('/reset-password');
    });

    test('keeps hash-route paths but strips their queries', () => {
      expect(p.sanitizePath('/app#/orders/42?tab=items')).toBe('/app#/orders/42');
    });

    test('accepts full URLs and keeps only path + hash', () => {
      expect(p.sanitizePath('https://x.example.com/a/b?q=1#/c?d=2')).toBe('/a/b#/c');
    });

    test('rejects non-strings and caps length', () => {
      expect(p.sanitizePath(null)).toBeNull();
      expect(p.sanitizePath('/' + 'a'.repeat(900)).length).toBe(500);
    });
  });

  describe('identity and payload sanitising', () => {
    test('accepts a Hub UUID and a valid email; lower-cases both', () => {
      expect(p.sanitizeIdentity({ id: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', email: 'Jane.Doe@Example.com' }))
        .toEqual({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'jane.doe@example.com' });
    });

    test('ignores ids that are not UUIDs and invalid emails', () => {
      expect(p.sanitizeIdentity({ id: '42', email: 'nope' })).toEqual({ id: null, email: null });
      expect(p.sanitizeIdentity(null)).toEqual({ id: null, email: null });
    });

    test('event names and properties are bounded', () => {
      expect(p.sanitizeEventName('  export<script>.clicked  ')).toBe('exportscript.clicked');
      expect(p.sanitizeProperties({ a: 1 })).toEqual({ a: 1 });
      expect(p.sanitizeProperties([1, 2])).toBeNull();
      expect(p.sanitizeProperties({ big: 'x'.repeat(3000) })).toBeNull();
    });
  });
});
