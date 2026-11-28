import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { type WorkspacePlan, WorkspaceRole } from '../../generated/prisma/enums.js';
import type { AddWorkspaceMemberDto } from './dto/add-workspace-member.dto.js';
import type { CreateApiKeyDto } from './dto/create-api-key.dto.js';
import type { CreateWorkspaceDto } from './dto/create-workspace.dto.js';

export interface CreatedWorkspaceResponse {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly plan: WorkspacePlan;
  readonly webhookSigningSecret: string;
  readonly role: WorkspaceRole;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkspaceMemberResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: WorkspaceRole;
  readonly createdAt: Date;
}

export interface CreatedApiKeyResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly apiKey: string;
  readonly createdAt: Date;
}

export interface RotatedWebhookSecretResponse {
  readonly id: string;
  readonly webhookSigningSecret: string;
  readonly updatedAt: Date;
}

function slugifyName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return base.length >= 2 ? base : 'workspace';
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as Record<string, unknown>)['code'] === 'P2002'
  );
}

@Injectable()
export class WorkspacesService {
  static readonly API_KEY_PREFIX = 'kmq_live_' as const;
  static readonly WEBHOOK_SECRET_PREFIX = 'whsec_' as const;

  readonly #prismaService: PrismaService;
  readonly #cryptoService: CryptoService;

  constructor(prismaService: PrismaService, cryptoService: CryptoService) {
    this.#prismaService = prismaService;
    this.#cryptoService = cryptoService;
  }

  async createWorkspace(
    creatorUserId: string,
    dto: CreateWorkspaceDto,
  ): Promise<CreatedWorkspaceResponse> {
    const trimmedName = dto.name.trim();
    const webhookSigningSecret = `${WorkspacesService.WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('hex')}`;
    const slug = await this.#resolveWorkspaceSlug(trimmedName, dto.slug);

    try {
      const created = await this.#prismaService.workspace.create({
        data: {
          name: trimmedName,
          slug,
          webhookSigningSecret,
          members: {
            create: {
              userId: creatorUserId,
              role: WorkspaceRole.OWNER,
            },
          },
        },
      });

      return {
        id: created.id,
        name: created.name,
        slug: created.slug,
        plan: created.plan,
        webhookSigningSecret: created.webhookSigningSecret,
        role: WorkspaceRole.OWNER,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
    } catch (error: unknown) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException('Workspace slug is already in use');
      }
      throw error;
    }
  }

  async addMember(
    workspaceId: string,
    callerRole: WorkspaceRole,
    dto: AddWorkspaceMemberDto,
  ): Promise<WorkspaceMemberResponse> {
    if (callerRole !== WorkspaceRole.OWNER && dto.role === WorkspaceRole.OWNER) {
      throw new ForbiddenException('Only workspace owners can assign the OWNER role');
    }

    if (!dto.userId && !dto.email) {
      throw new BadRequestException('Either userId or email must be provided');
    }

    const targetUser = await this.#prismaService.user.findUnique({
      where: dto.userId ? { id: dto.userId } : { email: dto.email!.trim().toLowerCase() },
      select: {
        id: true,
        email: true,
        fullName: true,
      },
    });

    if (!targetUser) {
      throw new NotFoundException('Target user not found');
    }

    try {
      const membership = await this.#prismaService.workspaceMember.create({
        data: {
          workspaceId,
          userId: targetUser.id,
          role: dto.role,
        },
      });

      return {
        id: membership.id,
        workspaceId: membership.workspaceId,
        userId: targetUser.id,
        email: targetUser.email,
        fullName: targetUser.fullName,
        role: membership.role,
        createdAt: membership.createdAt,
      };
    } catch (error: unknown) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException('User is already a member of this workspace');
      }
      throw error;
    }
  }

  async createApiKey(
    workspaceId: string,
    dto: CreateApiKeyDto,
  ): Promise<CreatedApiKeyResponse> {
    const rawKey = `${WorkspacesService.API_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    const keyHash = this.#cryptoService.hashSha256(rawKey);

    const created = await this.#prismaService.apiKey.create({
      data: {
        workspaceId,
        name: dto.name.trim(),
        keyHash,
      },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        createdAt: true,
      },
    });

    return {
      id: created.id,
      workspaceId: created.workspaceId,
      name: created.name,
      apiKey: rawKey,
      createdAt: created.createdAt,
    };
  }

  async rotateWebhookSecret(workspaceId: string): Promise<RotatedWebhookSecretResponse> {
    const existing = await this.#prismaService.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Workspace not found');
    }

    const webhookSigningSecret = `${WorkspacesService.WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('hex')}`;

    const updated = await this.#prismaService.workspace.update({
      where: { id: existing.id },
      data: { webhookSigningSecret },
      select: {
        id: true,
        webhookSigningSecret: true,
        updatedAt: true,
      },
    });

    return updated;
  }

  async #resolveWorkspaceSlug(name: string, explicitSlug?: string): Promise<string> {
    if (explicitSlug) {
      const existing = await this.#prismaService.workspace.findUnique({
        where: { slug: explicitSlug },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException('Workspace slug is already in use');
      }
      return explicitSlug;
    }

    const baseSlug = slugifyName(name);
    const existing = await this.#prismaService.workspace.findUnique({
      where: { slug: baseSlug },
      select: { id: true },
    });

    if (!existing) {
      return baseSlug;
    }

    return `${baseSlug}-${randomBytes(3).toString('hex')}`;
  }
}
