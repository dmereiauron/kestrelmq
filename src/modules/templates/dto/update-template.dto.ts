import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class UpdateTemplateDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  subjectTemplate?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  bodyTemplate?: string;
}
