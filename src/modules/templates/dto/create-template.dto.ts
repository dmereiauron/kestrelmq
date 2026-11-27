import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateTemplateDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Optional workspace UUID fallback when x-workspace-id header is omitted',
  })
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @ApiProperty({
    example: 'Order Paid Receipt',
    minLength: 1,
    maxLength: 120,
    description: 'Unique or descriptive template name within the workspace',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Order #{{orderId}} confirmed',
    maxLength: 500,
    description: 'Optional Handlebars subject template (used for email channels)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subjectTemplate?: string | null;

  @ApiProperty({
    example: '{ "orderId": "{{orderId}}", "customer": "{{customer.name}}", "amount": {{amount}} }',
    minLength: 1,
    maxLength: 100_000,
    description: 'Handlebars body template rendered against event.payload',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  bodyTemplate!: string;
}
