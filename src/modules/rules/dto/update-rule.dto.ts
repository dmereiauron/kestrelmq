import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateRuleDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  eventName?: string;

  @IsOptional()
  @IsUUID()
  integrationId?: string;

  @IsOptional()
  @IsUUID()
  templateId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  targetOverride?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
