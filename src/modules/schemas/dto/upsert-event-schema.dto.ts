import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SchemaValidationMode } from '../../../generated/prisma/enums.js';

export class UpsertEventSchemaDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  eventName!: string;

  @IsObject()
  samplePayload!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  jsonSchema?: Record<string, unknown>;

  @IsOptional()
  @IsEnum(SchemaValidationMode)
  validationMode?: SchemaValidationMode;
}
