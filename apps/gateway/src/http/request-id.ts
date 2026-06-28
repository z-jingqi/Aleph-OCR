import type { MiddlewareHandler } from 'hono';

export const requestIdMiddleware: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header('X-Request-Id')?.trim();
  const requestId = incoming && incoming.length <= 128 ? incoming : `req_${crypto.randomUUID()}`;
  c.set('requestId', requestId);
  await next();
  c.res.headers.set('X-Request-Id', requestId);
};
