import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { CryptoService } from './crypto.service.js';

async function createCryptoServiceWithKey(hexKey: unknown): Promise<CryptoService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      CryptoService,
      {
        provide: ConfigService,
        useValue: {
          get: (key: string): unknown =>
            key === 'ENCRYPTION_MASTER_KEY' ? hexKey : undefined,
        },
      },
    ],
  }).compile();

  return moduleRef.get(CryptoService);
}

describe('CryptoService', () => {
  let service: CryptoService;
  let masterKeyHex: string;

  beforeEach(async () => {
    masterKeyHex = randomBytes(32).toString('hex');
    service = await createCryptoServiceWithKey(masterKeyHex);
  });

  describe('constructor & key isolation', () => {
    it('rejects non-string or invalid-length master keys', async () => {
      await expect(createCryptoServiceWithKey(undefined)).rejects.toThrow(
        /ENCRYPTION_MASTER_KEY must be a valid 64-character hexadecimal string/,
      );
      await expect(createCryptoServiceWithKey('deadbeef')).rejects.toThrow(
        /ENCRYPTION_MASTER_KEY must be a valid 64-character hexadecimal string/,
      );
      await expect(createCryptoServiceWithKey('z'.repeat(64))).rejects.toThrow(
        /ENCRYPTION_MASTER_KEY must be a valid 64-character hexadecimal string/,
      );
    });

    it('never leaks key material via JSON.stringify or enumerable properties', () => {
      const serialized = JSON.stringify(service);
      expect(serialized).toBe('{}');
      expect(Object.keys(service)).toHaveLength(0);
    });
  });

  describe('AES-256-GCM packed binary layout (IV + AuthTag + CipherText)', () => {
    it('packs [12B IV | 16B AuthTag | NB CipherText] and round-trips UTF-8 strings', () => {
      const credentialJson = JSON.stringify({
        provider: 'MAILGUN',
        domain: 'mg.example.org',
        unicodeLabel: 'Повідомлення 🚀',
      });
      const plaintextByteLen = Buffer.byteLength(credentialJson, 'utf8');

      const encryptedBase64 = service.encrypt(credentialJson);
      const rawPacked = Buffer.from(encryptedBase64, 'base64');

      expect(rawPacked.byteLength).toBe(CryptoService.HEADER_BYTE_LENGTH + plaintextByteLen);

      const decrypted = service.decrypt(encryptedBase64);
      expect(decrypted).toBe(credentialJson);
    });

    it('supports empty plaintext (exact 28-byte header-only output)', () => {
      const encrypted = service.encrypt('');
      const packed = Buffer.from(encrypted, 'base64');

      expect(packed.byteLength).toBe(28);
      expect(service.decrypt(encrypted)).toBe('');
    });

    it('produces distinct random 12-byte IVs across identical plaintexts', () => {
      const first = Buffer.from(service.encrypt('same-payload'), 'base64');
      const second = Buffer.from(service.encrypt('same-payload'), 'base64');

      const firstIv = first.subarray(0, 12);
      const secondIv = second.subarray(0, 12);

      expect(firstIv.equals(secondIv)).toBe(false);
      expect(first.equals(second)).toBe(false);
    });

    it('binds Additional Authenticated Data (AAD) and rejects mismatched or missing AAD', () => {
      const aadWorkspaceA = Buffer.from('workspace:11111111-1111-1111-1111-111111111111');
      const aadWorkspaceB = Buffer.from('workspace:22222222-2222-2222-2222-222222222222');

      const encrypted = service.encrypt('bound-secret-payload', aadWorkspaceA);
      expect(service.decrypt(encrypted, aadWorkspaceA)).toBe('bound-secret-payload');

      expect(() => service.decrypt(encrypted, aadWorkspaceB)).toThrow();
      expect(() => service.decrypt(encrypted)).toThrow();
    });

    it('rejects truncated buffers shorter than 28 bytes', () => {
      const shortBuf = randomBytes(27);
      expect(() => service.decryptBuffer(shortBuf)).toThrow(
        /expected at least 28 bytes, received 27/,
      );
      expect(() => service.decrypt(shortBuf.toString('base64'))).toThrow(
        /expected at least 28 bytes/,
      );
    });

    it('detects tampering in IV, AuthTag, or CipherText and rejects wrong master key', async () => {
      const packed = service.encryptBuffer(Buffer.from('sensitive-payload', 'utf8'));

      // Tamper IV byte (offset 0)
      const tamperedIv = Buffer.from(packed);
      tamperedIv[0] = (tamperedIv[0] ?? 0) ^ 0xff;
      expect(() => service.decryptBuffer(tamperedIv)).toThrow();

      // Tamper AuthTag byte (offset 12)
      const tamperedTag = Buffer.from(packed);
      tamperedTag[12] = (tamperedTag[12] ?? 0) ^ 0xff;
      expect(() => service.decryptBuffer(tamperedTag)).toThrow();

      // Tamper CipherText byte (offset 28)
      const tamperedCipher = Buffer.from(packed);
      tamperedCipher[28] = (tamperedCipher[28] ?? 0) ^ 0xff;
      expect(() => service.decryptBuffer(tamperedCipher)).toThrow();

      // Decrypt with different master key
      const otherService = await createCryptoServiceWithKey(randomBytes(32).toString('hex'));
      expect(() => otherService.decryptBuffer(packed)).toThrow();
    });
  });

  describe('encryptDetached / decryptDetached (Prisma column helpers)', () => {
    it('round-trips detached { ciphertext, iv, authTag } with optional AAD', () => {
      const aad = Buffer.from('integration:test');
      const detached = service.encryptDetached('detached-payload', aad);

      expect(Buffer.from(detached.iv, 'base64').byteLength).toBe(12);
      expect(Buffer.from(detached.authTag, 'base64').byteLength).toBe(16);
      expect(service.decryptDetached(detached, aad)).toBe('detached-payload');
    });

    it('rejects malformed IV or AuthTag byte lengths in detached payloads', () => {
      const detached = service.encryptDetached('payload');

      expect(() =>
        service.decryptDetached({
          ...detached,
          iv: randomBytes(16).toString('base64'),
        }),
      ).toThrow(/Invalid IV length: expected 12 bytes, received 16/);

      expect(() =>
        service.decryptDetached({
          ...detached,
          authTag: randomBytes(12).toString('base64'),
        }),
      ).toThrow(/Invalid AuthTag length: expected 16 bytes, received 12/);
    });
  });

  describe('HMAC-SHA256 webhook signatures', () => {
    it('computes exact v1=<hex> signature for string and Buffer payloads', () => {
      const signingSecret = randomBytes(24).toString('hex');
      const body = '{"event":"order.paid","amount":1999}';
      const fixedTs = 1_760_000_000;

      const expectedDigest = createHmac('sha256', signingSecret)
        .update(`${fixedTs}.${body}`, 'utf8')
        .digest('hex');

      const signedFromString = service.signWebhookPayload(body, signingSecret, fixedTs);
      const signedFromBuffer = service.signWebhookPayload(
        Buffer.from(body, 'utf8'),
        signingSecret,
        fixedTs,
      );

      expect(signedFromString).toEqual({
        timestamp: fixedTs,
        signature: `v1=${expectedDigest}`,
      });
      expect(signedFromBuffer).toEqual(signedFromString);
    });

    it('defaults timestamp to current Unix epoch seconds and verifies within tolerance', () => {
      const signingSecret = randomBytes(24).toString('hex');
      const body = '{"ok":true}';

      const { timestamp, signature } = service.signWebhookPayload(body, signingSecret);
      expect(
        service.verifyWebhookSignature(body, signature, timestamp, signingSecret),
      ).toBe(true);
      expect(
        service.verifyWebhookSignature(
          Buffer.from(body, 'utf8'),
          signature,
          String(timestamp),
          signingSecret,
        ),
      ).toBe(true);
    });

    it('throws when signing with an empty secret', () => {
      expect(() => service.signWebhookPayload('{}', '')).toThrow(
        /Webhook signing secret must not be empty/,
      );
    });

    it('returns false on empty secret, bad prefix, non-integer timestamp, replay window breach, bad hex, or wrong signature', () => {
      const signingSecret = randomBytes(24).toString('hex');
      const body = '{"event":"invoice.created"}';
      const nowSec = Math.floor(Date.now() / 1000);
      const { signature } = service.signWebhookPayload(body, signingSecret, nowSec);

      // Empty secret
      expect(service.verifyWebhookSignature(body, signature, nowSec, '')).toBe(false);

      // Missing v1= prefix
      expect(
        service.verifyWebhookSignature(body, signature.slice(3), nowSec, signingSecret),
      ).toBe(false);

      // Invalid / non-integer timestamps
      expect(
        service.verifyWebhookSignature(body, signature, 'not-a-number', signingSecret),
      ).toBe(false);
      expect(
        service.verifyWebhookSignature(body, signature, 123.45, signingSecret),
      ).toBe(false);

      // Expired timestamp (> 300s ago) and future timestamp (> 300s ahead)
      const oldTs = nowSec - 301;
      const oldSig = service.signWebhookPayload(body, signingSecret, oldTs).signature;
      expect(service.verifyWebhookSignature(body, oldSig, oldTs, signingSecret)).toBe(false);

      const futureTs = nowSec + 301;
      const futureSig = service.signWebhookPayload(body, signingSecret, futureTs).signature;
      expect(
        service.verifyWebhookSignature(body, futureSig, futureTs, signingSecret),
      ).toBe(false);

      // Malformed hex digest after v1=
      expect(
        service.verifyWebhookSignature(body, 'v1=shorthex', nowSec, signingSecret),
      ).toBe(false);

      // Tampered payload or wrong secret
      expect(
        service.verifyWebhookSignature('{"tampered":true}', signature, nowSec, signingSecret),
      ).toBe(false);
      expect(
        service.verifyWebhookSignature(
          body,
          signature,
          nowSec,
          randomBytes(24).toString('hex'),
        ),
      ).toBe(false);
    });
  });

  describe('hashSha256', () => {
    it('produces deterministic 64-character lowercase hex SHA-256 digests', () => {
      const rawToken = `kmq_live_${randomBytes(24).toString('hex')}`;
      const digestA = service.hashSha256(rawToken);
      const digestB = service.hashSha256(Buffer.from(rawToken, 'utf8'));

      expect(digestA).toMatch(/^[0-9a-f]{64}$/);
      expect(digestA).toBe(digestB);
    });
  });
});
