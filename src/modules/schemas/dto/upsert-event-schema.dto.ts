import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiPropertyOptional({
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @ApiProperty({
    example: 'order.paid',
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  eventName!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { orderId: 'ord_123', amount: 99.5 },
  })
  @IsObject()
  samplePayload!: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Explicit JSON Schema override (inferred automatically from samplePayload if omitted)',
  })
  @IsOptional()
  @IsObject()
  jsonSchema?: Record<string, unknown>;

  @ApiPropertyOptional({
    enum: SchemaValidationMode,
    enumName: 'SchemaValidationMode',
    default: SchemaValidationMode.DISABLED,
  })
  @IsOptional()
  @IsEnum(SchemaValidationMode)
  validationMode?: SchemaValidationMode;
}
