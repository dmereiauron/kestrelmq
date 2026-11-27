import { IsObject, IsOptional, IsUUID } from 'class-validator';

export class InferSchemaDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsObject()
  samplePayload!: Record<string, unknown>;
}
