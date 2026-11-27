import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class UpdateTemplateDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Optional workspace UUID fallback when x-workspace-id header is omitted',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @ApiPropertyOptional({
    example: 'Updated Order Paid Receipt',
    minLength: 1,
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subjectTemplate?: string | null;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 100_000,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  bodyTemplate?: string;
}
