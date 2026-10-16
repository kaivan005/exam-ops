import { describe, expect, it } from 'vitest';
import { api } from './api';

describe('api client', () => {
  it('uses the versioned API base path and credentials', () => {
    expect(api.defaults.baseURL).toContain('/api/v1');
    expect(api.defaults.withCredentials).toBe(true);
  });
});
