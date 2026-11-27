import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class IngestEventDto {
  @ApiProperty({
    example: 'order.paid',
    minLength: 1,
    maxLength: 128,
    description: 'Event identifier without whitespace',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S+$/u, {
    message: 'event must be a non-empty identifier without whitespace',
  })
  event!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { orderId: 'ord_101', amount: 250, customer: { name: 'Ada Lovelace' } },
    description: 'Structured JSON event payload passed to templates and provider adapters',
  })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { email: 'ada@kestrelmq.io', webhookUrl: 'https://hooks.example.com/orders' },
    description: 'Optional explicit recipient routing envelope',
  })
  @IsOptional()
  @IsObject()
  recipient?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: '2026-12-01T12:00:00.000Z',
    format: 'date-time',
    description: 'Optional ISO-8601 timestamp for delayed BullMQ execution',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  deliverAt?: string;

  @ApiPropertyOptional({
    example: 'idem-order-101',
    minLength: 1,
    maxLength: 255,
    description: 'Optional deduplication key (must match Idempotency-Key header if both are sent)',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idempotencyKey?: string;
}
