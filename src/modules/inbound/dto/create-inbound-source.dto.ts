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
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'sourceSlug must contain only lowercase alphanumeric characters and single hyphens',
  })
  sourceSlug?: string;

  @IsEnum(InboundProviderType)
  providerType!: InboundProviderType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  signingSecret?: string;

  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(2048)
  targetUrl!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxRatePerSec?: number;
}
