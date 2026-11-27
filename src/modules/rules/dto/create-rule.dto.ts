import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRuleDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  eventName!: string;

  @IsUUID()
  integrationId!: string;

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
