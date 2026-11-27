import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { argon2id, hash as argon2Hash, verify as argon2Verify } from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { RedisService } from '../../common/redis/redis.service.js';
import type { EnvConfig } from '../../config/env.validation.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import type {
  AuthTokenResponse,
  JwtAccessPayload,
  JwtRefreshPayload,
  PublicUserProfile,
} from './interfaces/jwt-payload.interface.js';

/**
 * Atomic Redis Lua script for refresh token rotation with OAuth 2.0 (RFC 9700) reuse detection:
 * - KEYS[1]: `auth:rt:family:{sid}`
 * - ARGV[1]: expected `${userId}:${presentedJti}`
 * - ARGV[2]: next `${userId}:${nextJti}`
 * - ARGV[3]: TTL in seconds
 */
export const ROTATE_REFRESH_TOKEN_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 'MISSING'
end
if current ~= ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 'REUSED'
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 'ROTATED'
`;

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as Record<string, unknown>)['code'] === 'P2002'
  );
}

@Injectable()
export class AuthService {
  static readonly REFRESH_FAMILY_KEY_PREFIX = 'auth:rt:family:' as const;

  readonly #logger = new Logger(AuthService.name);
  readonly #prismaService: PrismaService;
  readonly #redisService: RedisService;
  readonly #jwtService: JwtService;
  readonly #accessSecret: string;
  readonly #refreshSecret: string;
  readonly #accessTtlSec: number;
  readonly #refreshTtlSec: number;
  readonly #dummyPasswordHashPromise: Promise<string>;

  constructor(
    prismaService: PrismaService,
    redisService: RedisService,
    jwtService: JwtService,
    configService: ConfigService<EnvConfig, true>,
  ) {
    this.#prismaService = prismaService;
    this.#redisService = redisService;
    this.#jwtService = jwtService;
    this.#accessSecret = configService.get('JWT_ACCESS_SECRET', { infer: true });
    this.#refreshSecret = configService.get('JWT_REFRESH_SECRET', { infer: true });
    this.#accessTtlSec = configService.get('JWT_ACCESS_TTL_SEC', { infer: true });
    this.#refreshTtlSec = configService.get('JWT_REFRESH_TTL_SEC', { infer: true });
    this.#dummyPasswordHashPromise = argon2Hash(randomBytes(32), { type: argon2id });
  }

  async register(dto: RegisterDto): Promise<AuthTokenResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const trimmedFullName = dto.fullName.trim();

    const existing = await this.#prismaService.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const passwordHash = await argon2Hash(dto.password, { type: argon2id });

    let createdUser: PublicUserProfile;
    try {
      createdUser = await this.#prismaService.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          fullName: trimmedFullName,
        },
        select: {
          id: true,
          email: true,
          fullName: true,
          createdAt: true,
        },
      });
    } catch (error: unknown) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException('A user with this email already exists');
      }
      throw error;
    }

    return this.#issueInitialSession(createdUser);
  }

  async login(dto: LoginDto): Promise<AuthTokenResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();

    const user = await this.#prismaService.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        fullName: true,
        passwordHash: true,
      },
    });

    if (!user) {
      const dummyHash = await this.#dummyPasswordHashPromise;
      await argon2Verify(dummyHash, dto.password);
      throw new UnauthorizedException('Invalid email or password');
    }

    const isValidPassword = await argon2Verify(user.passwordHash, dto.password);
    if (!isValidPassword) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.#issueInitialSession({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
    });
  }

  async refresh(rawRefreshToken: string | undefined): Promise<AuthTokenResponse> {
    if (!rawRefreshToken || rawRefreshToken.trim().length === 0) {
      throw new UnauthorizedException('Missing refresh token');
    }

    let payload: JwtRefreshPayload;
    try {
      payload = await this.#jwtService.verifyAsync<JwtRefreshPayload>(rawRefreshToken.trim(), {
        secret: this.#refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (
      payload.type !== 'refresh' ||
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      typeof payload.email !== 'string' ||
      payload.email.length === 0 ||
      typeof payload.sid !== 'string' ||
      payload.sid.length === 0 ||
      typeof payload.jti !== 'string' ||
      payload.jti.length === 0
    ) {
      throw new UnauthorizedException('Malformed refresh token claims');
    }

    const familyKey = `${AuthService.REFRESH_FAMILY_KEY_PREFIX}${payload.sid}`;
    const expectedValue = `${payload.sub}:${payload.jti}`;
    const nextRefreshJti = randomUUID();
    const nextValue = `${payload.sub}:${nextRefreshJti}`;

    const outcome = await this.#redisService.eval(
      ROTATE_REFRESH_TOKEN_LUA,
      [familyKey],
      [expectedValue, nextValue, this.#refreshTtlSec],
    );

    if (outcome === 'REUSED') {
      this.#logger.warn(
        JSON.stringify({
          event: 'refresh_token_reuse_detected',
          userId: payload.sub,
          sessionId: payload.sid,
        }),
      );
      throw new UnauthorizedException('Refresh token reuse detected; session revoked');
    }

    if (outcome !== 'ROTATED') {
      throw new UnauthorizedException('Refresh token expired or revoked');
    }

    const user = await this.#prismaService.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        fullName: true,
      },
    });

    if (!user) {
      await this.#redisService.del(familyKey);
      throw new UnauthorizedException('User account no longer exists');
    }

    return this.#signTokenPair(user, payload.sid, nextRefreshJti);
  }

  async logout(sessionId: string): Promise<void> {
    const familyKey = `${AuthService.REFRESH_FAMILY_KEY_PREFIX}${sessionId}`;
    await this.#redisService.del(familyKey);
  }

  async #issueInitialSession(user: PublicUserProfile): Promise<AuthTokenResponse> {
    const sessionId = randomUUID();
    const refreshJti = randomUUID();
    const familyKey = `${AuthService.REFRESH_FAMILY_KEY_PREFIX}${sessionId}`;

    await this.#redisService.setEx(
      familyKey,
      this.#refreshTtlSec,
      `${user.id}:${refreshJti}`,
    );

    return this.#signTokenPair(user, sessionId, refreshJti);
  }

  async #signTokenPair(
    user: PublicUserProfile,
    sessionId: string,
    refreshJti: string,
  ): Promise<AuthTokenResponse> {
    const accessPayload: JwtAccessPayload = {
      sub: user.id,
      email: user.email,
      sid: sessionId,
      jti: randomUUID(),
      type: 'access',
    };

    const refreshPayload: JwtRefreshPayload = {
      sub: user.id,
      email: user.email,
      sid: sessionId,
      jti: refreshJti,
      type: 'refresh',
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.#jwtService.signAsync(accessPayload, {
        secret: this.#accessSecret,
        expiresIn: this.#accessTtlSec,
      }),
      this.#jwtService.signAsync(refreshPayload, {
        secret: this.#refreshSecret,
        expiresIn: this.#refreshTtlSec,
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.#accessTtlSec,
      user,
    };
  }
}
