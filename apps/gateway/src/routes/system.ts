import { ALEPH_TOOLS_VERSION } from '@aleph-tools/shared';
import { getEngineInfo } from '../ocr-client';
import { engineErrorResponse, jsonSuccess } from '../http/responses';
import type { GatewayApp } from './types';

export function registerSystemRoutes(app: GatewayApp) {
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'aleph-tools-gateway',
      version: ALEPH_TOOLS_VERSION,
      timestamp: new Date().toISOString(),
      requestId: c.get('requestId'),
    }),
  );

  app.get('/v1/engines', async (c) => {
    try {
      const engine = await getEngineInfo(c.env);
      return jsonSuccess(c, engine);
    } catch (error) {
      return engineErrorResponse(c, error);
    }
  });
}
