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
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard.js';
import { ApiWorkspaceJwtOrApiKeyAuth } from '../../common/swagger/api-workspace-header.decorator.js';
import { ProblemDetailsDto } from '../../common/swagger/problem-details.dto.js';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import {
  type CancelDeliveryResponse,
  DeliveriesService,
  type DeliveryDetailResponse,
  type PaginatedDeliveriesResponse,
  type ReplayDeliveryResponse,
} from './deliveries.service.js';
import { ListDeliveriesQueryDto } from './dto/list-deliveries-query.dto.js';

@ApiTags('Deliveries')
@ApiWorkspaceJwtOrApiKeyAuth()
@Controller('deliveries')
@UseGuards(JwtOrApiKeyGuard)
export class DeliveriesController {
  readonly #deliveriesService: DeliveriesService;

  constructor(deliveriesService: DeliveriesService) {
    this.#deliveriesService = deliveriesService;
  }

  @Get()
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  @ApiOperation({ summary: 'List deliveries using zero-OFFSET keyset cursor pagination' })
  @ApiOkResponse({ description: 'Keyset-paginated list of workspace deliveries' })
  async listDeliveries(
    @CurrentWorkspaceId() workspaceId: string,
    @Query() query: ListDeliveriesQueryDto,
  ): Promise<PaginatedDeliveriesResponse> {
    return this.#deliveriesService.listDeliveries(workspaceId, query);
  }

  @Get(':id')
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.VIEWER)
  @ApiOperation({ summary: 'Get delivery details and masked attempt audit timeline' })
  @ApiOkResponse({ description: 'Delivery detail with attempt history' })
  @ApiResponse({ status: 404, description: 'Delivery not found', type: ProblemDetailsDto })
  async getDelivery(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) deliveryId: string,
  ): Promise<DeliveryDetailResponse> {
    return this.#deliveriesService.getDeliveryById(workspaceId, deliveryId);
  }

  @Post(':id/replay')
  @HttpCode(HttpStatus.OK)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({ summary: 'Reset delivery to PENDING and re-enqueue into BullMQ for execution' })
  @ApiOkResponse({ description: 'Delivery re-enqueued' })
  @ApiResponse({ status: 404, description: 'Delivery not found', type: ProblemDetailsDto })
  async replayDelivery(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) deliveryId: string,
  ): Promise<ReplayDeliveryResponse> {
    return this.#deliveriesService.replayDelivery(workspaceId, deliveryId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  @ApiOperation({
    summary: 'Cancel an uncompleted delivery (PENDING, SCHEDULED, RETRYING, or PAUSED)',
  })
  @ApiOkResponse({ description: 'Delivery canceled' })
  @ApiResponse({
    status: 400,
    description: 'Delivery is already in a terminal state',
    type: ProblemDetailsDto,
  })
  @ApiResponse({ status: 404, description: 'Delivery not found', type: ProblemDetailsDto })
  async cancelDelivery(
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', ParseUUIDPipe) deliveryId: string,
  ): Promise<CancelDeliveryResponse> {
    return this.#deliveriesService.cancelDelivery(workspaceId, deliveryId);
  }
}
