import { createHmac, timingSafeEqual } from 'node:crypto';
import { CryptoService } from '../../../common/crypto/crypto.service.js';
import { InboundProviderType } from '../../../generated/prisma/enums.js';

export const INBOUND_REPLAY_TOLERANCE_SEC = 300; // 5 minutes

export type InboundHeadersMap = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export interface VerifyInboundSignatureInput {
  readonly providerType: InboundProviderType;
  readonly rawBody: Buffer;
  readonly headers: InboundHeadersMap;
  readonly signingSecret: string | null;
  readonly toleranceSec?: number;
  readonly nowSec?: number;
}

const HEX_64_PATTERN = /^[0-9a-fA-F]{64}$/;
const CANONICAL_SHA256_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const INTEGER_DIGITS_PATTERN = /^\d+$/;

export function readHeaderCaseInsensitive(
  headers: InboundHeadersMap,
  targetNameLower: string,
): string | undefined {
  const direct = headers[targetNameLower];
  if (direct !== undefined) {
    const val = Array.isArray(direct) ? direct[0] : direct;
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
  }

  for (const [key, rawValue] of Object.entries(headers)) {
    if (key.toLowerCase() === targetNameLower && rawValue !== undefined) {
      const val = Array.isArray(rawValue) ? rawValue[0] : rawValue;
      return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
    }
  }

  return undefined;
}

/**
 * Verifies Stripe `Stripe-Signature: t=<unix_sec>,v1=<hex>[,v1=<hex>...]` against rawBody
 * using constant-time `timingSafeEqual` and a 5-minute replay window.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  toleranceSec: number = INBOUND_REPLAY_TOLERANCE_SEC,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader || secret.length === 0) {
    return false;
  }

  let timestampRaw: string | undefined;
  const v1Signatures: string[] = [];

  for (const segment of signatureHeader.split(',')) {
    const trimmed = segment.trim();
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (key === 't') {
      if (timestampRaw !== undefined) {
        return false;
      }
      timestampRaw = value;
    } else if (key === 'v1' && value.length > 0) {
      v1Signatures.push(value);
    }
  }

  if (!timestampRaw || !INTEGER_DIGITS_PATTERN.test(timestampRaw) || v1Signatures.length === 0) {
    return false;
  }

  const parsedTimestamp = Number(timestampRaw);
  if (!Number.isSafeInteger(parsedTimestamp)) {
    return false;
  }

  if (Math.abs(nowSec - parsedTimestamp) > toleranceSec) {
    return false;
  }

  const expectedDigest = createHmac('sha256', secret)
    .update(`${parsedTimestamp}.`, 'utf8')
    .update(rawBody)
    .digest();

  let matched = false;
  for (const candidateHex of v1Signatures) {
    if (!HEX_64_PATTERN.test(candidateHex)) {
      continue;
    }
    const providedDigest = Buffer.from(candidateHex, 'hex');
    if (
      providedDigest.byteLength === expectedDigest.byteLength &&
      timingSafeEqual(providedDigest, expectedDigest)
    ) {
      matched = true;
    }
  }

  return matched;
}

/**
 * Verifies GitHub `X-Hub-Signature-256: sha256=<64-hex>` against rawBody
 * using constant-time `timingSafeEqual`.
 */
export function verifyGithubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || secret.length === 0 || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const hexDigest = signatureHeader.slice('sha256='.length);
  if (!HEX_64_PATTERN.test(hexDigest)) {
    return false;
  }

  const providedDigest = Buffer.from(hexDigest, 'hex');
  const expectedDigest = createHmac('sha256', secret).update(rawBody).digest();

  return (
    providedDigest.byteLength === expectedDigest.byteLength &&
    timingSafeEqual(providedDigest, expectedDigest)
  );
}

/**
 * Verifies Shopify `X-Shopify-Hmac-Sha256: <base64>` against rawBody
 * using constant-time `timingSafeEqual`.
 */
export function verifyShopifySignature(
  rawBody: Buffer,
  hmacHeader: string | undefined,
  secret: string,
): boolean {
  if (!hmacHeader || secret.length === 0 || !CANONICAL_SHA256_BASE64_PATTERN.test(hmacHeader)) {
    return false;
  }

  const providedDigest = Buffer.from(hmacHeader, 'base64');
  const expectedDigest = createHmac('sha256', secret).update(rawBody).digest();

  return (
    providedDigest.byteLength === expectedDigest.byteLength &&
    timingSafeEqual(providedDigest, expectedDigest)
  );
}

/**
 * Verifies KestrelMQ `X-KestrelMQ-Timestamp` + `X-KestrelMQ-Signature: v1=<64-hex>`
 * against rawBody using constant-time `timingSafeEqual` and a 5-minute replay window.
 */
export function verifyCustomHmacSignature(
  rawBody: Buffer,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  secret: string,
  toleranceSec: number = CryptoService.DEFAULT_WEBHOOK_TOLERANCE_SEC,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (
    !timestampHeader ||
    !signatureHeader ||
    secret.length === 0 ||
    !signatureHeader.startsWith('v1=') ||
    !INTEGER_DIGITS_PATTERN.test(timestampHeader)
  ) {
    return false;
  }

  const parsedTimestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(parsedTimestamp)) {
    return false;
  }

  if (Math.abs(nowSec - parsedTimestamp) > toleranceSec) {
    return false;
  }

  const providedHex = signatureHeader.slice(3);
  if (!HEX_64_PATTERN.test(providedHex)) {
    return false;
  }

  const providedDigest = Buffer.from(providedHex, 'hex');
  const expectedDigest = createHmac('sha256', secret)
    .update(`${parsedTimestamp}.`, 'utf8')
    .update(rawBody)
    .digest();

  return (
    providedDigest.byteLength === expectedDigest.byteLength &&
    timingSafeEqual(providedDigest, expectedDigest)
  );
}

/**
 * Dispatches raw-body cryptographic signature verification across all 5 InboundProviderType strategies.
 */
export function verifyInboundWebhookSignature(input: VerifyInboundSignatureInput): boolean {
  const tolerance = input.toleranceSec ?? INBOUND_REPLAY_TOLERANCE_SEC;
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);

  switch (input.providerType) {
    case InboundProviderType.NONE:
      return true;

    case InboundProviderType.STRIPE: {
      if (!input.signingSecret) {
        return false;
      }
      const header = readHeaderCaseInsensitive(input.headers, 'stripe-signature');
      return verifyStripeSignature(input.rawBody, header, input.signingSecret, tolerance, now);
    }

    case InboundProviderType.GITHUB: {
      if (!input.signingSecret) {
        return false;
      }
      const header = readHeaderCaseInsensitive(input.headers, 'x-hub-signature-256');
      return verifyGithubSignature(input.rawBody, header, input.signingSecret);
    }

    case InboundProviderType.SHOPIFY: {
      if (!input.signingSecret) {
        return false;
      }
      const header = readHeaderCaseInsensitive(input.headers, 'x-shopify-hmac-sha256');
      return verifyShopifySignature(input.rawBody, header, input.signingSecret);
    }

    case InboundProviderType.CUSTOM_HMAC: {
      if (!input.signingSecret) {
        return false;
      }
      const timestampHeader = readHeaderCaseInsensitive(input.headers, 'x-kestrelmq-timestamp');
      const signatureHeader = readHeaderCaseInsensitive(input.headers, 'x-kestrelmq-signature');
      return verifyCustomHmacSignature(
        input.rawBody,
        timestampHeader,
        signatureHeader,
        input.signingSecret,
        tolerance,
        now,
      );
    }
  }
}
