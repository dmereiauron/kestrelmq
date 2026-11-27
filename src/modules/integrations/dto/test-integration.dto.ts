import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class TestIntegrationDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Optional workspace UUID fallback when x-workspace-id header is omitted',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @ApiPropertyOptional({
    example: 'https://hooks.example.com/kestrelmq',
    minLength: 1,
    maxLength: 512,
    description: 'Optional recipient target override (email address, chat ID, or webhook URL)',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  target?: string;
}
