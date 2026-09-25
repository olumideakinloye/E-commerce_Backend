import type { FastifyRequest, FastifyReply } from 'fastify';
import { processWebhook, verifyOrderPayment } from './payments.service.js';

export async function handleWebhook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { provider } = request.params as { provider: string };

  // Retrieve raw body buffer captured by the custom content type parser or fallback to body string
  const rawBody: Buffer | string =
    (request as FastifyRequest & { rawBody?: Buffer }).rawBody ??
    (typeof request.body === 'string' ? request.body : Buffer.from(JSON.stringify(request.body)));

  const signature =
    (request.headers['x-paystack-signature'] as string | undefined) ??
    (request.headers['stripe-signature'] as string | undefined);

  const result = await processWebhook(provider, rawBody, signature);

  // Always respond HTTP 200 to acknowledge webhook receipt immediately
  return reply.status(200).send({
    received: true,
    status: result.status,
    eventId: result.eventId,
  });
}

export async function handleVerifyOrderPayment(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as { id: string };
  const result = await verifyOrderPayment(id, request.user.id);

  return reply.status(200).send(result);
}
