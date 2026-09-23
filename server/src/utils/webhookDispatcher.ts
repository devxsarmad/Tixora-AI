// Usage:
// Sends optional, non-blocking integration events to the configured n8n webhook.

import { env } from '../config/env.js';

const WEBHOOK_TIMEOUT_MS = 5_000;

async function sendEvent(eventType: string, payload: object): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(env.N8N_WEBHOOK_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        eventType,
        payload,
        timestamp: new Date().toISOString()
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      console.error(
        `Webhook dispatch failed for ${eventType}: ${response.status} ${response.statusText}`
      );
    }
  } catch (error) {
    console.error(`Webhook dispatch failed for ${eventType}`, error);
  } finally {
    clearTimeout(timeout);
  }
}

export function dispatchEvent(eventType: string, payload: object): void {
  if (env.N8N_WEBHOOK_ENABLED !== 'true' || !env.N8N_WEBHOOK_URL) {
    return;
  }

  void sendEvent(eventType, payload);
}
