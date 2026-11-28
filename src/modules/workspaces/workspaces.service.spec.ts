import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { AuthenticatedRequest } from '../../common/interfaces/authenticated-request.interface.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type { EnvConfig } from '../../config/env.validation.js';
import { WorkspacePlan, WorkspaceRole } from '../../generated/prisma/enums.js';
import { AddWorkspaceMemberDto } from './dto/add-workspace-member.dto.js';
import { CreateApiKeyDto } from './dto/create-api-key.dto.js';
import { CreateWorkspaceDto } from './dto/create-workspace.dto.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';

describe('WorkspacesService & WorkspacesController', () => {
  let cryptoService: CryptoService;
  let workspaceFindUniqueMock: ReturnType<typeof vi.fn>;
  let workspaceCreateMock: ReturnType<typeof vi.fn>;
  let workspaceUpdateMock: ReturnType<typeof vi.fn>;
  let userFindUniqueMock: ReturnType<typeof vi.fn>;
  let memberCreateMock: ReturnType<typeof vi.fn>;
  let apiKeyCreateMock: ReturnType<typeof vi.fn>;
  let service: WorkspacesService;
  let controller: WorkspacesController;

  beforeEach(() => {
    const masterKey = randomBytes(32).toString('hex');
    const configService = {
      get: () => masterKey,
    } as unknown as ConfigService<EnvConfig, true>;
    cryptoService = new CryptoService(configService);

    workspaceFindUniqueMock = vi.fn().mockResolvedValue(null);
    workspaceCreateMock = vi.fn();
    workspaceUpdateMock = vi.fn();
    userFindUniqueMock = vi.fn();
    memberCreateMock = vi.fn();
    apiKeyCreateMock = vi.fn();

    const prismaService = {
      workspace: {
        findUnique: workspaceFindUniqueMock,
        create: workspaceCreateMock,
        update: workspaceUpdateMock,
      },
      user: {
        findUnique: userFindUniqueMock,
      },
      workspaceMember: {
        create: memberCreateMock,
      },
      apiKey: {
        create: apiKeyCreateMock,
      },
    } as unknown as PrismaService;

    service = new WorkspacesService(prismaService, cryptoService);
    controller = new WorkspacesController(service);
  });

  it('creates a workspace with whsec_ signing secret, assigns creator as OWNER, and handles slug collisions', async () => {
    const creatorId = randomUUID();
    const wsId = randomUUID();
    const now = new Date();

    workspaceCreateMock.mockImplementation(
      async ({ data }: { data: { name: string; slug: string; webhookSigningSecret: string } }) => ({
        id: wsId,
        name: data.name,
        slug: data.slug,
        plan: WorkspacePlan.FREE,
        webhookSigningSecret: data.webhookSigningSecret,
        createdAt: now,
        updatedAt: now,
      }),
    );

    const created = await controller.createWorkspace(
      { userId: creatorId, email: 'owner@kestrelmq.io', sessionId: randomUUID() },
      { name: 'Acme Notifications' },
    );

    expect(created.id).toBe(wsId);
    expect(created.slug).toBe('acme-notifications');
    expect(created.role).toBe(WorkspaceRole.OWNER);
    expect(created.webhookSigningSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(workspaceCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          members: {
            create: { userId: creatorId, role: WorkspaceRole.OWNER },
          },
        }),
      }),
    );

    // Auto-slug appends suffix when base slug already exists
    workspaceFindUniqueMock.mockResolvedValueOnce({ id: randomUUID() });
    const suffixed = await service.createWorkspace(creatorId, { name: 'Acme Notifications' });
    expect(suffixed.slug).toMatch(/^acme-notifications-[0-9a-f]{6}$/);

    // Explicit slug collision throws 409 ConflictException
    workspaceFindUniqueMock.mockResolvedValueOnce({ id: randomUUID() });
    await expect(
      service.createWorkspace(creatorId, { name: 'Acme', slug: 'acme-notifications' }),
    ).rejects.toThrow(ConflictException);
  });

  it('adds workspace members with privilege-escalation protection and 404/409 handling', async () => {
    const workspaceId = randomUUID();
    const targetUserId = randomUUID();
    const now = new Date();

    // ADMIN cannot grant OWNER
    await expect(
      service.addMember(workspaceId, WorkspaceRole.ADMIN, {
        userId: targetUserId,
        role: WorkspaceRole.OWNER,
      }),
    ).rejects.toThrow(ForbiddenException);

    // Controller rejects missing req.memberRole
    await expect(
      controller.addMember(workspaceId, {} as AuthenticatedRequest, {
        userId: targetUserId,
        role: WorkspaceRole.VIEWER,
      }),
    ).rejects.toThrow(ForbiddenException);

    // Missing both userId and email -> 400
    await expect(
      service.addMember(workspaceId, WorkspaceRole.OWNER, { role: WorkspaceRole.VIEWER }),
    ).rejects.toThrow(BadRequestException);

    // Unknown target user -> 404
    userFindUniqueMock.mockResolvedValueOnce(null);
    await expect(
      service.addMember(workspaceId, WorkspaceRole.OWNER, {
        email: 'ghost@kestrelmq.io',
        role: WorkspaceRole.VIEWER,
      }),
    ).rejects.toThrow(NotFoundException);

    // Valid member addition via controller
    userFindUniqueMock.mockResolvedValueOnce({
      id: targetUserId,
      email: 'teammate@kestrelmq.io',
      fullName: 'Teammate',
    });
    memberCreateMock.mockResolvedValueOnce({
      id: randomUUID(),
      workspaceId,
      userId: targetUserId,
      role: WorkspaceRole.ADMIN,
      createdAt: now,
    });

    const added = await controller.addMember(
      workspaceId,
      { memberRole: WorkspaceRole.OWNER } as AuthenticatedRequest,
      { email: 'Teammate@KestrelMQ.io', role: WorkspaceRole.ADMIN },
    );
    expect(added.userId).toBe(targetUserId);
    expect(added.role).toBe(WorkspaceRole.ADMIN);

    // Duplicate member -> 409
    userFindUniqueMock.mockResolvedValueOnce({
      id: targetUserId,
      email: 'teammate@kestrelmq.io',
      fullName: 'Teammate',
    });
    memberCreateMock.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint'), { code: 'P2002' }),
    );
    await expect(
      service.addMember(workspaceId, WorkspaceRole.OWNER, {
        userId: targetUserId,
        role: WorkspaceRole.VIEWER,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('generates kmq_live_ API key, persists only SHA-256 keyHash, and returns raw key once', async () => {
    const workspaceId = randomUUID();
    const keyId = randomUUID();
    const now = new Date();
    let storedHash = '';

    apiKeyCreateMock.mockImplementation(
      async ({ data }: { data: { workspaceId: string; name: string; keyHash: string } }) => {
        storedHash = data.keyHash;
        return {
          id: keyId,
          workspaceId: data.workspaceId,
          name: data.name,
          createdAt: now,
        };
      },
    );

    const res = await controller.createApiKey(workspaceId, { name: 'Production Ingestion' });

    expect(res.id).toBe(keyId);
    expect(res.workspaceId).toBe(workspaceId);
    expect(res.name).toBe('Production Ingestion');
    expect(res.apiKey).toMatch(/^kmq_live_[0-9a-f]{48}$/);
    expect(storedHash).toBe(cryptoService.hashSha256(res.apiKey));
    expect(storedHash).not.toBe(res.apiKey);
  });

  it('rotates workspace webhookSigningSecret via POST /v1/workspaces/:id/rotate-secret and throws 404 when missing', async () => {
    const workspaceId = randomUUID();
    const updatedAt = new Date();

    workspaceFindUniqueMock.mockResolvedValueOnce(null);
    await expect(controller.rotateSecret(workspaceId)).rejects.toThrow(NotFoundException);

    workspaceFindUniqueMock.mockResolvedValueOnce({ id: workspaceId });
    workspaceUpdateMock.mockImplementationOnce(
      async ({ data }: { data: { webhookSigningSecret: string } }) => ({
        id: workspaceId,
        webhookSigningSecret: data.webhookSigningSecret,
        updatedAt,
      }),
    );

    const rotated = await controller.rotateSecret(workspaceId);
    expect(rotated.id).toBe(workspaceId);
    expect(rotated.webhookSigningSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(rotated.updatedAt).toBe(updatedAt);
  });

  it('validates CreateWorkspaceDto, AddWorkspaceMemberDto, and CreateApiKeyDto constraints', async () => {
    expect(
      await validate(plainToInstance(CreateWorkspaceDto, { name: 'Acme', slug: 'acme-prod' })),
    ).toHaveLength(0);
    expect(
      (await validate(plainToInstance(CreateWorkspaceDto, { name: 'A', slug: 'Invalid Slug!' })))
        .length,
    ).toBeGreaterThanOrEqual(2);

    expect(
      await validate(
        plainToInstance(AddWorkspaceMemberDto, {
          email: 'member@kestrelmq.io',
          role: WorkspaceRole.ADMIN,
        }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(AddWorkspaceMemberDto, {
          userId: randomUUID(),
          role: WorkspaceRole.VIEWER,
        }),
      ),
    ).toHaveLength(0);
    expect(
      (await validate(plainToInstance(AddWorkspaceMemberDto, { role: WorkspaceRole.VIEWER })))
        .length,
    ).toBeGreaterThanOrEqual(1);

    expect(
      await validate(plainToInstance(CreateApiKeyDto, { name: 'Primary Key' })),
    ).toHaveLength(0);
  });
});
