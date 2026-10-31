import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { rateLimiterFactory } from './rate-limit.js';

describe('rateLimiterFactory', () => {
  it('answers with the API error shape when the budget is spent', async () => {
    const app = express();
    app.get('/', rateLimiterFactory()({ name: 'test', windowMs: 60_000, limit: 1 }), (_req, res) => {
      res.status(204).end();
    });
    await request(app).get('/').expect(204);
    const limited = await request(app).get('/').expect(429);
    expect(limited.body).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' } });
  });

  it('rejects duplicate limiter names (they would share one bucket in a shared store)', () => {
    const limit = rateLimiterFactory();
    limit({ name: 'x', windowMs: 1000, limit: 1 });
    expect(() => limit({ name: 'x', windowMs: 1000, limit: 1 })).toThrow(/Duplicate/);
  });
});
