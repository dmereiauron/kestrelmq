import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IntegrationChannel, IntegrationProvider } from '../../../generated/prisma/enums.js';

export class CreateIntegrationDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Optional workspace UUID fallback when x-workspace-id header is omitted',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @ApiProperty({
    example: 'Order Fulfillment Webhook',
    minLength: 1,
    maxLength: 120,
    description: 'Human-readable integration name',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    enum: IntegrationChannel,
    enumName: 'IntegrationChannel',
    example: IntegrationChannel.WEBHOOK,
    description: 'Notification delivery channel',
  })
  @IsEnum(IntegrationChannel)
  channel!: IntegrationChannel;

  @ApiProperty({
    enum: IntegrationProvider,
    enumName: 'IntegrationProvider',
    example: IntegrationProvider.CUSTOM_WEBHOOK,
    description: 'Concrete provider adapter implementation',
  })
  @IsEnum(IntegrationProvider)
  provider!: IntegrationProvider;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { url: 'https://hooks.example.com/kestrelmq' },
    description: 'Provider-specific credentials object (encrypted at rest using AES-256-GCM)',
  })
  @IsObject()
  @IsNotEmptyObject()
  credentials!: Record<string, unknown>;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description: 'Whether this integration is active for routing',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
