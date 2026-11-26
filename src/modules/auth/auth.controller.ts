import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-request.interface.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import type { AuthTokenResponse } from './interfaces/jwt-payload.interface.js';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

@Controller('auth')
export class AuthController {
  readonly #authService: AuthService;

  constructor(authService: AuthService) {
    this.#authService = authService;
  }

  @Post('register')
  async register(@Body() dto: RegisterDto): Promise<AuthTokenResponse> {
    return this.#authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto): Promise<AuthTokenResponse> {
    return this.#authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Headers('authorization') authHeader: string | undefined,
    @Body() dto: RefreshTokenDto,
  ): Promise<AuthTokenResponse> {
    let rawToken = dto.refreshToken;
    if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
      const match = BEARER_PATTERN.exec(authHeader.trim());
      if (match?.[1]) {
        rawToken = match[1];
      }
    }

    return this.#authService.refresh(rawToken);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.#authService.logout(user.sessionId);
  }
}
