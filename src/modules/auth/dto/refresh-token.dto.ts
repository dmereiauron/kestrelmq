import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiPropertyOptional({
    description:
      'Refresh JWT token (optional in body when passed via Authorization: Bearer <refreshToken>)',
    minLength: 1,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  refreshToken?: string;
}
