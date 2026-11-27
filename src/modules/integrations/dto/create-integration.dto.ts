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
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsEnum(IntegrationChannel)
  channel!: IntegrationChannel;

  @IsEnum(IntegrationProvider)
  provider!: IntegrationProvider;

  @IsObject()
  @IsNotEmptyObject()
  credentials!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
