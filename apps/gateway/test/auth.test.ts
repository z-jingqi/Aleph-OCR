import { describe, expect, it } from 'vitest';
import { parseApiKeys } from '../src/auth';

describe('API key parsing', () => {
  it('maps JSON object keys to stable client IDs', () => {
    expect(parseApiKeys('{"example-client-dev":"dev-key"}')).toEqual([
      { clientId: 'example-client-dev', key: 'dev-key' },
    ]);
  });

  it('supports legacy arrays and comma-separated local values', () => {
    expect(parseApiKeys('["a","b"]')).toEqual([
      { clientId: 'client-1', key: 'a' },
      { clientId: 'client-2', key: 'b' },
    ]);
    expect(parseApiKeys('a,b')).toEqual([
      { clientId: 'client-1', key: 'a' },
      { clientId: 'client-2', key: 'b' },
    ]);
  });
});
