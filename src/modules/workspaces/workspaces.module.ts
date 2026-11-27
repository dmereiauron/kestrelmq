import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';

@Module({
  controllers: [WorkspacesController],
  providers: [WorkspacesService, JwtAuthGuard, RolesGuard],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
