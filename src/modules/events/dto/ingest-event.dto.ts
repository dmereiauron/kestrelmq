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
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S+$/u, {
    message: 'event must be a non-empty identifier without whitespace',
  })
  event!: string;

  @IsObject()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  recipient?: Record<string, unknown>;

  @IsOptional()
  @IsISO8601({ strict: true })
  deliverAt?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idempotencyKey?: string;
}
