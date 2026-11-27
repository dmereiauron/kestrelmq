import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InboundProviderType } from '../../../generated/prisma/enums.js';
import {
  verifyCustomHmacSignature,
  verifyGithubSignature,
  verifyInboundWebhookSignature,
  verifyShopifySignature,
  verifyStripeSignature,
} from './inbound-signature.util.js';

describe('inbound-signature.util (Constant-Time RawBody Verifiers)', () => {
  const fixedNowSec = 1_760_000_000;
  const rawBody = Buffer.from('{"id":"evt_1","amount":2500,"nested":  { "ok": true } }', 'utf8');

  it('verifies STRIPE signatures (single & rotated multi-v1) and rejects replay or tampered bytes', () => {
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    const oldSecret = `whsec_${randomBytes(24).toString('hex')}`;

    const validSig = createHmac('sha256', secret)
      .update(`${fixedNowSec}.`, 'utf8')
      .update(rawBody)
      .digest('hex');

    const rotatedOldSig = createHmac('sha256', oldSecret)
      .update(`${fixedNowSec}.`, 'utf8')
      .update(rawBody)
      .digest('hex');

    expect(
      verifyInboundWebhookSignature({
        providerType: InboundProviderType.STRIPE,
        rawBody,
        headers: { 'Stripe-Signature': `t=${fixedNowSec},v1=${rotatedOldSig},v1=${validSig}` },
        signingSecret: secret,
        nowSec: fixedNowSec,
      }),
    ).toBe(true);

    // Tampered whitespace in rawBody fails verification
    expect(
      verifyStripeSignature(
        Buffer.from('{"id":"evt_1","amount":2500,"nested":{"ok":true}}', 'utf8'),
        `t=${fixedNowSec},v1=${validSig}`,
        secret,
        300,
        fixedNowSec,
      ),
    ).toBe(false);

    // Replay attack older than 5-minute (300s) window fails
    expect(
      verifyStripeSignature(
        rawBody,
        `t=${fixedNowSec - 301},v1=${validSig}`,
        secret,
        300,
        fixedNowSec,
      ),
    ).toBe(false);

    // Duplicate t= or malformed header fails
    expect(
      verifyStripeSignature(
        rawBody,
        `t=${fixedNowSec},t=${fixedNowSec},v1=${validSig}`,
        secret,
        300,
        fixedNowSec,
      ),
    ).toBe(false);
  });

  it('verifies GITHUB X-Hub-Signature-256 sha256=<hex> signatures', () => {
    const secret = randomBytes(24).toString('hex');
    const hex = createHmac('sha256', secret).update(rawBody).digest('hex');

    expect(
      verifyInboundWebhookSignature({
        providerType: InboundProviderType.GITHUB,
        rawBody,
        headers: { 'X-Hub-Signature-256': `sha256=${hex}` },
        signingSecret: secret,
      }),
    ).toBe(true);

    expect(verifyGithubSignature(rawBody, hex, secret)).toBe(false);
    expect(verifyGithubSignature(rawBody, `sha256=${'0'.repeat(64)}`, secret)).toBe(false);
  });

  it('verifies SHOPIFY X-Shopify-Hmac-Sha256 Base64 signatures', () => {
    const secret = randomBytes(24).toString('hex');
    const base64Hmac = createHmac('sha256', secret).update(rawBody).digest('base64');

    expect(
      verifyInboundWebhookSignature({
        providerType: InboundProviderType.SHOPIFY,
        rawBody,
        headers: { 'X-Shopify-Hmac-Sha256': base64Hmac },
        signingSecret: secret,
      }),
    ).toBe(true);

    expect(verifyShopifySignature(rawBody, 'not-valid-base64', secret)).toBe(false);
    const wrongSecretHmac = createHmac('sha256', `${secret}-wrong`)
      .update(rawBody)
      .digest('base64');
    expect(verifyShopifySignature(rawBody, wrongSecretHmac, secret)).toBe(false);
  });

  it('verifies CUSTOM_HMAC (X-KestrelMQ-Timestamp + X-KestrelMQ-Signature) and NONE', () => {
    const secret = randomBytes(24).toString('hex');
    const hex = createHmac('sha256', secret)
      .update(`${fixedNowSec}.`, 'utf8')
      .update(rawBody)
      .digest('hex');

    expect(
      verifyInboundWebhookSignature({
        providerType: InboundProviderType.CUSTOM_HMAC,
        rawBody,
        headers: {
          'X-KestrelMQ-Timestamp': String(fixedNowSec),
          'X-KestrelMQ-Signature': `v1=${hex}`,
        },
        signingSecret: secret,
        nowSec: fixedNowSec,
      }),
    ).toBe(true);

    expect(
      verifyCustomHmacSignature(
        rawBody,
        String(fixedNowSec - 600),
        `v1=${hex}`,
        secret,
        300,
        fixedNowSec,
      ),
    ).toBe(false);

    expect(
      verifyInboundWebhookSignature({
        providerType: InboundProviderType.NONE,
        rawBody: Buffer.alloc(0),
        headers: {},
        signingSecret: null,
      }),
    ).toBe(true);
  });
});
