import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { WorkspaceRole } from '../../../generated/prisma/enums.js';

export class AddWorkspaceMemberDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Target user UUID (required if email is omitted)',
  })
  @ValidateIf((dto: AddWorkspaceMemberDto) => !dto.email)
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    example: 'teammate@kestrelmq.io',
    maxLength: 255,
    description: 'Target user email address (required if userId is omitted)',
  })
  @ValidateIf((dto: AddWorkspaceMemberDto) => !dto.userId)
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiProperty({
    enum: WorkspaceRole,
    enumName: 'WorkspaceRole',
    example: WorkspaceRole.ADMIN,
    description: 'RBAC role assigned within the workspace',
  })
  @IsEnum(WorkspaceRole)
  role!: WorkspaceRole;
}
