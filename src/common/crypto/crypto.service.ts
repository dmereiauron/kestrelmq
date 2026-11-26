import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { EnvConfig } from '../../config/env.validation.js';

export interface DetachedEncryptedPayload {
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
}

export interface WebhookSignatureResult {
  readonly timestamp: number;
  readonly signature: string;
}

@Injectable()
export class CryptoService {
  static readonly ALGORITHM = 'aes-256-gcm' as const;
  static readonly KEY_BYTE_LENGTH = 32;
  static readonly IV_BYTE_LENGTH = 12;
  static readonly AUTH_TAG_BYTE_LENGTH = 16;
  static readonly HEADER_BYTE_LENGTH = 28; // IV (12 bytes) + AuthTag (16 bytes)
  static readonly DEFAULT_WEBHOOK_TOLERANCE_SEC = 300; // 5 minutes (SPEC.md §3.4)

  readonly #masterKey: Buffer;

  constructor(configService: ConfigService<EnvConfig, true>) {
    const rawHexKey = configService.get('ENCRYPTION_MASTER_KEY', { infer: true });
    if (typeof rawHexKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(rawHexKey)) {
      throw new Error(
        'ENCRYPTION_MASTER_KEY must be a valid 64-character hexadecimal string (32 bytes)',
      );
    }
    this.#masterKey = Buffer.from(rawHexKey, 'hex');
  }

  /**
   * Encrypts UTF-8 plaintext with AES-256-GCM and packs `[IV (12B) | AuthTag (16B) | CipherText (NB)]`
   * encoded as Base64.
   */
  encrypt(plaintext: string, aad?: Buffer): string {
    return this.encryptBuffer(Buffer.from(plaintext, 'utf8'), aad).toString('base64');
  }

  /**
   * Unpacks a Base64 `[IV (12B) | AuthTag (16B) | CipherText (NB)]` payload, verifies the 16-byte GCM
   * authentication tag, and returns decrypted UTF-8 plaintext.
   */
  decrypt(packedBase64: string, aad?: Buffer): string {
    const packedBuffer = Buffer.from(packedBase64, 'base64');
    return this.decryptBuffer(packedBuffer, aad).toString('utf8');
  }

  /**
   * Binary-level AES-256-GCM encryption producing `[IV (12B) | AuthTag (16B) | CipherText (NB)]`.
   */
  encryptBuffer(plaintext: Buffer, aad?: Buffer): Buffer {
    const iv = randomBytes(CryptoService.IV_BYTE_LENGTH);
    const cipher = createCipheriv(CryptoService.ALGORITHM, this.#masterKey, iv, {
      authTagLength: CryptoService.AUTH_TAG_BYTE_LENGTH,
    });

    if (aad !== undefined) {
      cipher.setAAD(aad);
    }

    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, ciphertext]);
  }

  /**
   * Binary-level AES-256-GCM decryption reading `[0..12)` IV, `[12..28)` AuthTag, and `[28..)` CipherText.
   */
  decryptBuffer(packedBuffer: Buffer, aad?: Buffer): Buffer {
    if (packedBuffer.byteLength < CryptoService.HEADER_BYTE_LENGTH) {
      throw new Error(
        `Invalid encrypted payload: expected at least ${CryptoService.HEADER_BYTE_LENGTH} bytes, received ${packedBuffer.byteLength}`,
      );
    }

    const iv = packedBuffer.subarray(0, CryptoService.IV_BYTE_LENGTH);
    const authTag = packedBuffer.subarray(
      CryptoService.IV_BYTE_LENGTH,
      CryptoService.HEADER_BYTE_LENGTH,
    );
    const ciphertext = packedBuffer.subarray(CryptoService.HEADER_BYTE_LENGTH);

    const decipher = createDecipheriv(CryptoService.ALGORITHM, this.#masterKey, iv, {
      authTagLength: CryptoService.AUTH_TAG_BYTE_LENGTH,
    });
    decipher.setAuthTag(authTag);

    if (aad !== undefined) {
      decipher.setAAD(aad);
    }

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /**
   * Encrypts UTF-8 plaintext and returns detached Base64 `{ ciphertext, iv, authTag }` components
   * matching the `integrations` and `inbound_sources` columns in SPEC.md Section 4.
   */
  encryptDetached(plaintext: string, aad?: Buffer): DetachedEncryptedPayload {
    const packed = this.encryptBuffer(Buffer.from(plaintext, 'utf8'), aad);
    const iv = packed.subarray(0, CryptoService.IV_BYTE_LENGTH).toString('base64');
    const authTag = packed
      .subarray(CryptoService.IV_BYTE_LENGTH, CryptoService.HEADER_BYTE_LENGTH)
      .toString('base64');
    const ciphertext = packed.subarray(CryptoService.HEADER_BYTE_LENGTH).toString('base64');

    return { ciphertext, iv, authTag };
  }

  /**
   * Reassembles detached Base64 `{ ciphertext, iv, authTag }` into `[IV | AuthTag | CipherText]`
   * and decrypts via `decryptBuffer`.
   */
  decryptDetached(payload: DetachedEncryptedPayload, aad?: Buffer): string {
    const iv = Buffer.from(payload.iv, 'base64');
    const authTag = Buffer.from(payload.authTag, 'base64');

    if (iv.byteLength !== CryptoService.IV_BYTE_LENGTH) {
      throw new Error(
        `Invalid IV length: expected ${CryptoService.IV_BYTE_LENGTH} bytes, received ${iv.byteLength}`,
      );
    }

    if (authTag.byteLength !== CryptoService.AUTH_TAG_BYTE_LENGTH) {
      throw new Error(
        `Invalid AuthTag length: expected ${CryptoService.AUTH_TAG_BYTE_LENGTH} bytes, received ${authTag.byteLength}`,
      );
    }

    const ciphertext = Buffer.from(payload.ciphertext, 'base64');
    const packed = Buffer.concat([iv, authTag, ciphertext]);
    return this.decryptBuffer(packed, aad).toString('utf8');
  }

  /**
   * Generates an outbound webhook signature per SPEC.md Section 3.4:
   * `v1=` + HMAC-SHA256("{timestamp}.{rawBody}", secret).
   */
  signWebhookPayload(
    rawBody: string | Buffer,
    secret: string,
    timestampSec?: number,
  ): WebhookSignatureResult {
    if (secret.length === 0) {
      throw new Error('Webhook signing secret must not be empty');
    }

    const timestamp = timestampSec ?? Math.floor(Date.now() / 1000);
    const bodyBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;

    const hmac = createHmac('sha256', secret);
    hmac.update(`${timestamp}.`, 'utf8');
    hmac.update(bodyBuffer);
    const digest = hmac.digest('hex');

    return {
      timestamp,
      signature: `v1=${digest}`,
    };
  }

  /**
   * Verifies a timestamped `v1=<hex>` HMAC-SHA256 webhook signature in constant time (`timingSafeEqual`)
   * and enforces replay-attack window (`toleranceSec`, default 300s).
   */
  verifyWebhookSignature(
    rawBody: string | Buffer,
    signatureHeader: string,
    timestampSec: number | string,
    secret: string,
    toleranceSec: number = CryptoService.DEFAULT_WEBHOOK_TOLERANCE_SEC,
  ): boolean {
    if (secret.length === 0 || !signatureHeader.startsWith('v1=')) {
      return false;
    }

    const parsedTimestamp =
      typeof timestampSec === 'number' ? timestampSec : Number(timestampSec);
    if (!Number.isFinite(parsedTimestamp) || !Number.isInteger(parsedTimestamp)) {
      return false;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - parsedTimestamp) > toleranceSec) {
      return false;
    }

    const providedHex = signatureHeader.slice(3);
    if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
      return false;
    }

    const { signature: expectedHeader } = this.signWebhookPayload(
      rawBody,
      secret,
      parsedTimestamp,
    );
    const expectedHex = expectedHeader.slice(3);

    const providedBuf = Buffer.from(providedHex, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');

    return timingSafeEqual(providedBuf, expectedBuf);
  }

  /**
   * Computes deterministic lowercase hex SHA-256 digest (used for `api_keys.key_hash` lookups).
   */
  hashSha256(input: string | Buffer): string {
    return createHash('sha256').update(input).digest('hex');
  }
}
