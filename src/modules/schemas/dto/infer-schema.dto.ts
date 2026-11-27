import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsUUID } from 'class-validator';

export class InferSchemaDto {
  @ApiPropertyOptional({
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { orderId: 'ord_123', amount: 99.5, customer: { email: 'ada@kestrelmq.io' } },
    description: 'Representative JSON payload used to infer Draft-07 JSON Schema and dot-paths',
  })
  @IsObject()
  samplePayload!: Record<string, unknown>;
}
