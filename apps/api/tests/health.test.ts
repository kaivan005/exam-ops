import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/server';
describe('health', () => { it('reports healthy', async () => { const response = await request(app).get('/health'); expect(response.status).toBe(200); expect(response.body.status).toBe('ok'); }); });
describe('adaptive authorization', () => {
	it('protects disruption history', async () => { const response = await request(app).get('/api/v1/disruptions'); expect(response.status).toBe(401); });
	it('rejects state changes without a CSRF token', async () => { const response = await request(app).post('/api/v1/auth/logout'); expect(response.status).toBe(403); });
});
