import { IsEmail, IsEnum, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { WorkspaceRole } from '../../../generated/prisma/enums.js';

export class AddWorkspaceMemberDto {
  @ValidateIf((dto: AddWorkspaceMemberDto) => !dto.email)
  @IsUUID()
  userId?: string;

  @ValidateIf((dto: AddWorkspaceMemberDto) => !dto.userId)
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsEnum(WorkspaceRole)
  role!: WorkspaceRole;
}
