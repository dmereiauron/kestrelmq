import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import {
  type CancelDeliveryResponse,
  DeliveriesService,
  type DeliveryDetailResponse,
  type PaginatedDeliveriesResponse,
  type ReplayDeliveryResponse,
} from './deliveries.service.js';
import { ListDeliveriesQueryDto } from './dto/list-deliveries-query.dto.js';

@Controller('deliveries')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DeliveriesController {
  readonly #deliveriesService: DeliveriesService;

  constructor(deliveriesService: DeliveriesService) {
    this.#deliveriesService = deliveriesService;
  }

  @Get()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  async listDeliveries(
    @CurrentWorkspaceId() workspaceId: string,
    @Query() query: ListDeliveriesQueryDto,
  ): Promise<PaginatedDeliveriesResponse> {
    return this.#deliveriesService.listDeliveries(workspaceId, query);
  }

  @Get(':id')
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  async getDelivery(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) deliveryId: string,
  ): Promise<DeliveryDetailResponse> {
    return this.#deliveriesService.getDeliveryById(workspaceId, deliveryId);
  }

  @Post(':id/replay')
  @HttpCode(HttpStatus.OK)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  async replayDelivery(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) deliveryId: string,
  ): Promise<ReplayDeliveryResponse> {
    return this.#deliveriesService.replayDelivery(workspaceId, deliveryId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  async cancelDelivery(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) deliveryId: string,
  ): Promise<CancelDeliveryResponse> {
    return this.#deliveriesService.cancelDelivery(workspaceId, deliveryId);
  }
}
