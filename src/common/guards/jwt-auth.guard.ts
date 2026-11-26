import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { EnvConfig } from '../../config/env.validation.js';
import type { JwtAccessPayload } from '../../modules/auth/interfaces/jwt-payload.interface.js';
import type { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  readonly #jwtService: JwtService;
  readonly #accessSecret: string;

  constructor(jwtService: JwtService, configService: ConfigService<EnvConfig, true>) {
    this.#jwtService = jwtService;
    this.#accessSecret = configService.get('JWT_ACCESS_SECRET', { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = request.headers.authorization;

    if (typeof authHeader !== 'string') {
      throw new UnauthorizedException('Missing Authorization Bearer token');
    }

    const match = BEARER_PATTERN.exec(authHeader.trim());
    const token = match?.[1];

    if (!token || token.startsWith('kmq_live_')) {
      throw new UnauthorizedException('Invalid Authorization Bearer token');
    }

    let payload: JwtAccessPayload;
    try {
      payload = await this.#jwtService.verifyAsync<JwtAccessPayload>(token, {
        secret: this.#accessSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    if (
      payload.type !== 'access' ||
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      typeof payload.email !== 'string' ||
      payload.email.length === 0 ||
      typeof payload.sid !== 'string' ||
      payload.sid.length === 0
    ) {
      throw new UnauthorizedException('Malformed access token claims');
    }

    request.user = {
      userId: payload.sub,
      email: payload.email,
      sessionId: payload.sid,
    };

    return true;
  }
}
