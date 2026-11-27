import { BadRequestException } from '@nestjs/common';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeliveryCursorInput {
  readonly createdAt: Date;
  readonly id: string;
}

export interface DecodedDeliveryCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeDeliveryCursor(cursor: DeliveryCursorInput): string {
  const payload = JSON.stringify({
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeDeliveryCursor(rawCursor: string): DecodedDeliveryCursor {
  const trimmed = rawCursor.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException('Invalid pagination cursor');
  }

  // Accept both Base64URL and standard Base64 encodings
  const normalizedBase64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+=*$/.test(normalizedBase64)) {
    throw new BadRequestException('Invalid pagination cursor');
  }

  let decodedJson: string;
  try {
    decodedJson = Buffer.from(normalizedBase64, 'base64').toString('utf8');
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedJson);
  } catch {
    throw new BadRequestException('Invalid pagination cursor');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException('Invalid pagination cursor');
  }

  const record = parsed as Record<string, unknown>;
  const rawCreatedAt = record['createdAt'];
  const rawId = record['id'];

  if (typeof rawCreatedAt !== 'string' || typeof rawId !== 'string' || !UUID_PATTERN.test(rawId)) {
    throw new BadRequestException('Invalid pagination cursor');
  }

  const createdAt = new Date(rawCreatedAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException('Invalid pagination cursor');
  }

  return {
    createdAt,
    id: rawId,
  };
}
