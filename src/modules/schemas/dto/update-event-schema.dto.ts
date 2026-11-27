import { IsEnum, IsObject, IsOptional, IsUUID } from 'class-validator';
import { SchemaValidationMode } from '../../../generated/prisma/enums.js';

export class UpdateEventSchemaDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsOptional()
  @IsObject()
  samplePayload?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  jsonSchema?: Record<string, unknown>;

  @IsOptional()
  @IsEnum(SchemaValidationMode)
  validationMode?: SchemaValidationMode;
}
