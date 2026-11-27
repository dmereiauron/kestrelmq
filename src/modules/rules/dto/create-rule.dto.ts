import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRuleDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Optional workspace UUID fallback when x-workspace-id header is omitted',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @ApiProperty({
    example: 'order.paid',
    minLength: 1,
    maxLength: 128,
    description: 'Exact event name, prefix wildcard (e.g. "order.*"), or global wildcard "*"',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  eventName!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Target workspace integration UUID',
  })
  @IsUUID()
  integrationId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Optional Handlebars template UUID (omit or null for BYOT raw payload mode)',
  })
  @IsOptional()
  @IsUUID()
  templateId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 512,
    example: 'payload.customer.email',
    description: 'Static recipient target or dot-path expression (payload.* / recipient.*)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  targetOverride?: string | null;

  @ApiPropertyOptional({
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
