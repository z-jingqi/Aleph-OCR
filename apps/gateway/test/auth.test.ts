import { describe, expect, it } from 'vitest';
import { parseApiKeys } from '../src/auth';

describe('API key parsing', () => {
  it('maps JSON object keys to stable client IDs', () => {
    expect(parseApiKeys('{"example-client-dev":"dev-key"}')).toEqual([
      { clientId: 'example-client-dev', key: 'dev-key' },
    ]);
  });

  it('rejects non-object key formats', () => {
    expect(parseApiKeys('["a","b"]')).toEqual([]);
    expect(parseApiKeys('a,b')).toEqual([]);
    expect(parseApiKeys('')).toEqual([]);
  });
});
