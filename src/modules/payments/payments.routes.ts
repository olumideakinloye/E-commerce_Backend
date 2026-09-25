import type { FastifyInstance } from 'fastify';
import { handleWebhook } from './payments.controller.js';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Capture the raw body Buffer for cryptographic HMAC signature verification
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    (request as FastifyRequestWithRawBody).rawBody = body as Buffer;
    try {
      const json = JSON.parse((body as Buffer).toString('utf-8'));
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // POST /webhooks/:provider — payment gateway callbacks
  app.post('/:provider', { config: { rateLimit: false } }, handleWebhook);
}

export interface FastifyRequestWithRawBody {
  rawBody?: Buffer;
}
