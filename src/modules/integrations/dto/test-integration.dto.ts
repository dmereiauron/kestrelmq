import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class TestIntegrationDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  target?: string;
}
