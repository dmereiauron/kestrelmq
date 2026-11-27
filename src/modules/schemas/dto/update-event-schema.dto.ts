import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsObject, IsOptional, IsUUID } from 'class-validator';
import { SchemaValidationMode } from '../../../generated/prisma/enums.js';

export class UpdateEventSchemaDto {
  @ApiPropertyOptional({
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  samplePayload?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  jsonSchema?: Record<string, unknown>;

  @ApiPropertyOptional({
    enum: SchemaValidationMode,
    enumName: 'SchemaValidationMode',
  })
  @IsOptional()
  @IsEnum(SchemaValidationMode)
  validationMode?: SchemaValidationMode;
}
