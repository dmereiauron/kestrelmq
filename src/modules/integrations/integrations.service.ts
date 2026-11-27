import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { IntegrationChannel, IntegrationProvider } from '../../generated/prisma/enums.js';
import {
  ProviderConfigurationError,
  ProviderDeliveryError,
} from '../providers/errors/provider-delivery.error.js';
import { ProviderFactory } from '../providers/provider.factory.js';
import {
  parseProviderCredentials,
  type ProviderCredentials,
  validateChannelProviderPair,
} from '../providers/schemas/provider-credentials.schema.js';
import type { CreateIntegrationDto } from './dto/create-integration.dto.js';
import type { TestIntegrationDto } from './dto/test-integration.dto.js';

export interface IntegrationResponse {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly channel: IntegrationChannel;
  readonly provider: IntegrationProvider;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TestIntegrationResponse {
  readonly ok: true;
  readonly integrationId: string;
  readonly provider: IntegrationProvider;
  readonly statusCode: number;
  readonly durationMs: number;
}

export interface EncryptedIntegrationRecord {
  readonly provider: IntegrationProvider;
  readonly encryptedCredentials: string;
  readonly iv: string;
  readonly authTag: string;
}

const SAFE_INTEGRATION_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  channel: true,
  provider: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class IntegrationsService {
  readonly #prismaService: PrismaService;
  readonly #cryptoService: CryptoService;
  readonly #providerFactory: ProviderFactory;

  constructor(
    prismaService: PrismaService,
    cryptoService: CryptoService,
    providerFactory: ProviderFactory,
  ) {
    this.#prismaService = prismaService;
    this.#cryptoService = cryptoService;
    this.#providerFactory = providerFactory;
  }

  async createIntegration(
    workspaceId: string,
    dto: CreateIntegrationDto,
  ): Promise<IntegrationResponse> {
    const trimmedName = dto.name.trim();
    if (trimmedName.length === 0) {
      throw new BadRequestException('Integration name must not be empty');
    }

    let validatedCredentials: ProviderCredentials;
    try {
      validateChannelProviderPair(dto.channel, dto.provider);
      if (!this.#providerFactory.hasProvider(dto.provider)) {
        throw new ProviderConfigurationError(
          dto.provider,
          `Notification provider "${dto.provider}" is not supported`,
        );
      }
      validatedCredentials = parseProviderCredentials(dto.provider, dto.credentials);
    } catch (error: unknown) {
      if (error instanceof ProviderConfigurationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const { ciphertext, iv, authTag } = this.#cryptoService.encryptDetached(
      JSON.stringify(validatedCredentials),
    );

    return this.#prismaService.integration.create({
      data: {
        workspaceId,
        name: trimmedName,
        channel: dto.channel,
        provider: dto.provider,
        encryptedCredentials: ciphertext,
        iv,
        authTag,
        isActive: dto.isActive ?? true,
      },
      select: SAFE_INTEGRATION_SELECT,
    });
  }

  async listIntegrations(workspaceId: string): Promise<IntegrationResponse[]> {
    return this.#prismaService.integration.findMany({
      where: { workspaceId },
      select: SAFE_INTEGRATION_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteIntegration(workspaceId: string, integrationId: string): Promise<void> {
    const deleted = await this.#prismaService.integration.deleteMany({
      where: {
        id: integrationId,
        workspaceId,
      },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('Integration not found');
    }
  }

  decryptIntegrationCredentials(record: EncryptedIntegrationRecord): ProviderCredentials {
    const decryptedJson = this.#cryptoService.decryptDetached({
      ciphertext: record.encryptedCredentials,
      iv: record.iv,
      authTag: record.authTag,
    });

    const parsedJson: unknown = JSON.parse(decryptedJson);
    return parseProviderCredentials(record.provider, parsedJson);
  }

  async testIntegration(
    workspaceId: string,
    integrationId: string,
    dto?: TestIntegrationDto,
  ): Promise<TestIntegrationResponse> {
    const integration = await this.#prismaService.integration.findFirst({
      where: {
        id: integrationId,
        workspaceId,
      },
      select: {
        id: true,
        provider: true,
        encryptedCredentials: true,
        iv: true,
        authTag: true,
        workspace: {
          select: {
            webhookSigningSecret: true,
          },
        },
      },
    });

    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    try {
      const credentials = this.decryptIntegrationCredentials(integration);
      const adapter = this.#providerFactory.getProvider(integration.provider);
      const result = await adapter.testConnection(credentials, {
        target: dto?.target,
        workspaceSigningSecret: integration.workspace.webhookSigningSecret,
      });

      return {
        ok: true,
        integrationId: integration.id,
        provider: integration.provider,
        statusCode: result.statusCode,
        durationMs: result.durationMs,
      };
    } catch (error: unknown) {
      if (error instanceof ProviderConfigurationError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof ProviderDeliveryError) {
        throw new BadGatewayException(error.message);
      }
      throw error;
    }
  }
}
