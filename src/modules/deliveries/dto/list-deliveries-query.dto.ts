import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DeliveryStatus } from '../../../generated/prisma/enums.js';

export class ListDeliveriesQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Page size (1–100)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Opaque Base64URL keyset pagination cursor returned as nextCursor',
    minLength: 1,
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({
    enum: DeliveryStatus,
    enumName: 'DeliveryStatus',
    description: 'Filter deliveries by lifecycle status',
  })
  @IsOptional()
  @IsEnum(DeliveryStatus)
  status?: DeliveryStatus;

  @ApiPropertyOptional({
    example: 'order.paid',
    minLength: 1,
    maxLength: 128,
    description: 'Filter deliveries by exact parent event name',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  eventName?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Filter deliveries by target integration UUID',
  })
  @IsOptional()
  @IsUUID()
  integrationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Optional workspace UUID fallback when authenticating via JWT',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}
