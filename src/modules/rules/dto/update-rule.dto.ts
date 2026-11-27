import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateRuleDto {
  @ApiPropertyOptional({
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @ApiPropertyOptional({
    example: 'order.*',
    minLength: 1,
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  eventName?: string;

  @ApiPropertyOptional({
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  integrationId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  templateId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  targetOverride?: string | null;

  @ApiPropertyOptional({
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
