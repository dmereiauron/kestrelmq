import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { verify as argon2Verify } from 'argon2';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type { RedisService } from '../../common/redis/redis.service.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { AuthController } from './auth.controller.js';
import { AuthService, ROTATE_REFRESH_TOKEN_LUA } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterDto } from './dto/register.dto.js';

interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  createdAt: Date;
}

describe('AuthService & AuthController', () => {
  let usersById: Map<string, StoredUser>;
  let redisStore: Map<string, string>;
  let jwtService: JwtService;
  let accessSecret: string;
  let refreshSecret: string;
  let authService: AuthService;
  let authController: AuthController;

  beforeEach(() => {
    usersById = new Map<string, StoredUser>();
    redisStore = new Map<string, string>();
    jwtService = new JwtService();
    accessSecret = randomBytes(32).toString('hex');
    refreshSecret = randomBytes(32).toString('hex');

    const prismaService = {
      user: {
        findUnique: vi.fn(
          async ({ where }: { where: { id?: string; email?: string } }): Promise<StoredUser | null> => {
            if (where.id) {
              return usersById.get(where.id) ?? null;
            }
            if (where.email) {
              for (const u of usersById.values()) {
                if (u.email === where.email) return u;
              }
            }
            return null;
          },
        ),
        create: vi.fn(
          async ({
            data,
          }: {
            data: { email: string; passwordHash: string; fullName: string };
          }): Promise<StoredUser> => {
            for (const existing of usersById.values()) {
              if (existing.email === data.email) {
                throw Object.assign(new Error('Unique violation'), { code: 'P2002' });
              }
            }
            const created: StoredUser = {
              id: randomUUID(),
              email: data.email,
              passwordHash: data.passwordHash,
              fullName: data.fullName,
              createdAt: new Date(),
            };
            usersById.set(created.id, created);
            return created;
          },
        ),
      },
    } as unknown as PrismaService;

    const redisService = {
      setEx: vi.fn(async (key: string, _ttl: number, value: string): Promise<void> => {
        redisStore.set(key, value);
      }),
      del: vi.fn(async (...keys: string[]): Promise<number> => {
        let removed = 0;
        for (const k of keys) {
          if (redisStore.delete(k)) removed += 1;
        }
        return removed;
      }),
      eval: vi.fn(
        async (
          script: string,
          keys: readonly string[],
          args: readonly (string | number)[],
        ): Promise<string> => {
          expect(script).toBe(ROTATE_REFRESH_TOKEN_LUA);
          const familyKey = keys[0]!;
          const expected = String(args[0]);
          const next = String(args[1]);

          const current = redisStore.get(familyKey);
          if (current === undefined) {
            return 'MISSING';
          }
          if (current !== expected) {
            redisStore.delete(familyKey);
            return 'REUSED';
          }
          redisStore.set(familyKey, next);
          return 'ROTATED';
        },
      ),
    } as unknown as RedisService;

    const configMap: Record<string, unknown> = {
      JWT_ACCESS_SECRET: accessSecret,
      JWT_REFRESH_SECRET: refreshSecret,
      JWT_ACCESS_TTL_SEC: 900,
      JWT_REFRESH_TTL_SEC: 604800,
    };

    const configService = {
      get: (key: string): unknown => configMap[key],
    } as unknown as ConfigService<EnvConfig, true>;

    authService = new AuthService(prismaService, redisService, jwtService, configService);
    authController = new AuthController(authService);
  });

  it('registers a user with Argon2id password hash, normalizes email, and rejects duplicates with 409', async () => {
    const rawPassword = randomBytes(16).toString('hex');
    const result = await authController.register({
      email: '  Founder@KestrelMQ.io ',
      password: rawPassword,
      fullName: '  Ada Lovelace ',
    });

    expect(result.user.email).toBe('founder@kestrelmq.io');
    expect(result.user.fullName).toBe('Ada Lovelace');
    expect(result.expiresIn).toBe(900);
    expect(result.accessToken.split('.')).toHaveLength(3);
    expect(result.refreshToken.split('.')).toHaveLength(3);

    const persisted = usersById.get(result.user.id)!;
    expect(persisted.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await argon2Verify(persisted.passwordHash, rawPassword)).toBe(true);

    await expect(
      authController.register({
        email: 'founder@kestrelmq.io',
        password: rawPassword,
        fullName: 'Duplicate User',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('authenticates valid login credentials and rejects wrong password or unknown email with 401', async () => {
    const rawPassword = randomBytes(16).toString('hex');
    await authService.register({
      email: 'ops@kestrelmq.io',
      password: rawPassword,
      fullName: 'Ops User',
    });

    const loginRes = await authController.login({
      email: 'OPS@kestrelmq.io',
      password: rawPassword,
    });
    expect(loginRes.user.email).toBe('ops@kestrelmq.io');

    await expect(
      authService.login({
        email: 'ops@kestrelmq.io',
        password: randomBytes(16).toString('hex'),
      }),
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      authService.login({
        email: 'unknown@kestrelmq.io',
        password: rawPassword,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rotates refresh tokens atomically and revokes entire session family upon token reuse detection', async () => {
    const rawPassword = randomBytes(16).toString('hex');
    const initial = await authService.register({
      email: 'sec@kestrelmq.io',
      password: rawPassword,
      fullName: 'Security Engineer',
    });

    // Legitimate rotation #1 (via Authorization Bearer header in controller)
    const rotated = await authController.refresh(`Bearer ${initial.refreshToken}`, {});
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    expect(rotated.accessToken).not.toBe(initial.accessToken);

    // Replay of already-rotated initial.refreshToken -> triggers REUSE DETECTION!
    await expect(authController.refresh(undefined, { refreshToken: initial.refreshToken })).rejects.toThrow(
      /reuse detected/i,
    );

    // Compromised session family was deleted -> rotated.refreshToken is ALSO now invalid!
    await expect(authService.refresh(rotated.refreshToken)).rejects.toThrow(UnauthorizedException);
  });

  it('revokes refresh session on logout and rejects access tokens passed to refresh', async () => {
    const rawPassword = randomBytes(16).toString('hex');
    const session = await authService.register({
      email: 'logout@kestrelmq.io',
      password: rawPassword,
      fullName: 'Logout User',
    });

    // Passing an access token to refresh must fail
    await expect(authService.refresh(session.accessToken)).rejects.toThrow(UnauthorizedException);
    await expect(authService.refresh('')).rejects.toThrow(UnauthorizedException);

    const decodedAccess = jwtService.decode<{ sub: string; email: string; sid: string }>(
      session.accessToken,
    );
    await authController.logout({
      userId: decodedAccess.sub,
      email: decodedAccess.email,
      sessionId: decodedAccess.sid,
    });

    await expect(authService.refresh(session.refreshToken)).rejects.toThrow(UnauthorizedException);
  });

  it('validates RegisterDto, LoginDto, and RefreshTokenDto constraints via class-validator', async () => {
    const validPassword = randomBytes(12).toString('hex');
    const validRegister = plainToInstance(RegisterDto, {
      email: 'valid@kestrelmq.io',
      password: validPassword,
      fullName: 'Valid User',
    });
    expect(await validate(validRegister)).toHaveLength(0);

    const invalidRegister = plainToInstance(RegisterDto, {
      email: 'not-an-email',
      password: 'short',
      fullName: '',
    });
    expect((await validate(invalidRegister)).length).toBeGreaterThanOrEqual(3);

    const validLogin = plainToInstance(LoginDto, {
      email: 'valid@kestrelmq.io',
      password: validPassword,
    });
    expect(await validate(validLogin)).toHaveLength(0);

    const emptyRefresh = plainToInstance(RefreshTokenDto, {});
    expect(await validate(emptyRefresh)).toHaveLength(0);
  });
});
