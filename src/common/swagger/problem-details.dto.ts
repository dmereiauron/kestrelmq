import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ProblemDetails } from '../filters/http-exception.filter.js';

export class ProblemDetailsDto implements ProblemDetails {
  @ApiProperty({
    example: 'https://errors.kestrelmq.io/bad-request',
    description: 'URI reference identifying the problem type (RFC 9457)',
  })
  readonly type!: string;

  @ApiProperty({
    example: 'Bad Request',
    description: 'Short, human-readable summary of the problem type',
  })
  readonly title!: string;

  @ApiProperty({
    example: 400,
    description: 'HTTP status code generated for this occurrence of the problem',
  })
  readonly status!: number;

  @ApiProperty({
    example: 'event must be a non-empty identifier without whitespace',
    description: 'Human-readable explanation specific to this occurrence of the problem',
  })
  readonly detail!: string;

  @ApiProperty({
    example: '/v1/events',
    description: 'URI reference identifying the specific request instance',
  })
  readonly instance!: string;

  @ApiProperty({
    example: '2026-11-27T18:00:00.000Z',
    format: 'date-time',
    description: 'ISO-8601 timestamp when the error occurred',
  })
  readonly timestamp!: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['event must be a non-empty identifier without whitespace'],
    description: 'Optional list of granular validation error messages',
  })
  readonly errors?: readonly string[];
}
