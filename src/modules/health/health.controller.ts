import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import { ProblemDetailsDto } from '../../common/swagger/problem-details.dto.js';
import { type HealthCheckResponse, HealthService } from './health.service.js';

@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  readonly #healthService: HealthService;

  constructor(healthService: HealthService) {
    this.#healthService = healthService;
  }

  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Readiness & liveness check probing PostgreSQL (SELECT 1) and Redis (PING)',
  })
  @ApiOkResponse({ description: 'PostgreSQL and Redis are healthy' })
  @ApiResponse({
    status: 503,
    description: 'One or more infrastructure dependencies are unavailable',
    type: ProblemDetailsDto,
  })
  async check(): Promise<HealthCheckResponse> {
    return this.#healthService.check();
  }
}
