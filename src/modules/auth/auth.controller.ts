import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-request.interface.js';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/api-workspace-header.decorator.js';
import { ProblemDetailsDto } from '../../common/swagger/problem-details.dto.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import type { AuthTokenResponse } from './interfaces/jwt-payload.interface.js';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  readonly #authService: AuthService;

  constructor(authService: AuthService) {
    this.#authService = authService;
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user account and issue initial JWT pair' })
  @ApiResponse({ status: 201, description: 'User registered and token pair issued' })
  @ApiResponse({ status: 400, description: 'Validation error', type: ProblemDetailsDto })
  @ApiResponse({ status: 409, description: 'Email already registered', type: ProblemDetailsDto })
  async register(@Body() dto: RegisterDto): Promise<AuthTokenResponse> {
    return this.#authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate user credentials and issue Access/Refresh JWTs' })
  @ApiOkResponse({ description: 'Authenticated token pair and user profile' })
  @ApiResponse({ status: 401, description: 'Invalid email or password', type: ProblemDetailsDto })
  async login(@Body() dto: LoginDto): Promise<AuthTokenResponse> {
    return this.#authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({
    summary: 'Atomically rotate Refresh token in Redis and issue a new Access/Refresh pair',
  })
  @ApiOkResponse({ description: 'Rotated token pair' })
  @ApiResponse({
    status: 401,
    description: 'Invalid, expired, or reused Refresh token',
    type: ProblemDetailsDto,
  })
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
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({ summary: 'Revoke active Refresh token session family' })
  @ApiNoContentResponse({ description: 'Session revoked' })
  @ApiResponse({ status: 401, description: 'Unauthorized', type: ProblemDetailsDto })
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.#authService.logout(user.sessionId);
  }
}
