import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { InboundProviderType } from '../../../generated/prisma/enums.js';

export class CreateInboundSourceDto {
  @ApiPropertyOptional({
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @ApiProperty({
    example: 'Stripe Billing Webhooks',
    minLength: 1,
    maxLength: 120,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    example: 'stripe-billing-prod',
    minLength: 2,
    maxLength: 80,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description: 'Public URL slug mounted at POST /v1/inbound/:sourceSlug',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'sourceSlug must contain only lowercase alphanumeric characters and single hyphens',
  })
  sourceSlug?: string;

  @ApiProperty({
    enum: InboundProviderType,
    enumName: 'InboundProviderType',
    example: InboundProviderType.STRIPE,
    description: 'Upstream webhook signature verification strategy',
  })
  @IsEnum(InboundProviderType)
  providerType!: InboundProviderType;

  @ApiPropertyOptional({
    example: 'whsec_upstream_provider_secret',
    minLength: 1,
    maxLength: 512,
    description: 'Upstream HMAC signing secret (required unless providerType is NONE)',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  signingSecret?: string;

  @ApiProperty({
    example: 'https://api.acme.io/internal/webhooks/stripe',
    maxLength: 2048,
    description: 'Downstream HTTP(S) destination where verified webhooks are forwarded',
  })
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(2048)
  targetUrl!: string;

  @ApiPropertyOptional({
    example: 10,
    minimum: 1,
    maximum: 10_000,
    default: 10,
    description: 'Maximum ingress & egress forwarding rate per second',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxRatePerSec?: number;
}
