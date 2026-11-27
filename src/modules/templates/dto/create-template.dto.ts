import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateTemplateDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  subjectTemplate?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  bodyTemplate!: string;
}
