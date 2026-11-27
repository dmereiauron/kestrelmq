import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { ProblemDetailsDto } from './problem-details.dto.js';

export const SWAGGER_BEARER_AUTH = 'bearerAuth' as const;
export const SWAGGER_API_KEY_AUTH = 'apiKey' as const;

export function ApiWorkspaceHeader(required = true): MethodDecorator & ClassDecorator {
  return ApiHeader({
    name: 'x-workspace-id',
    required,
    description:
      'Target workspace UUID (required when authenticating via user Bearer JWT unless supplied in path/body/query; resolved automatically when using an API key)',
    schema: {
      type: 'string',
      format: 'uuid',
    },
  });
}

export function ApiWorkspaceJwtAuth(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiBearerAuth(SWAGGER_BEARER_AUTH),
    ApiWorkspaceHeader(true),
    ApiResponse({
      status: 401,
      description: 'Missing, invalid, or expired Bearer JWT',
      type: ProblemDetailsDto,
    }),
    ApiResponse({
      status: 403,
      description: 'Insufficient workspace role permissions',
      type: ProblemDetailsDto,
    }),
  );
}

export function ApiWorkspaceJwtOrApiKeyAuth(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiBearerAuth(SWAGGER_BEARER_AUTH),
    ApiSecurity(SWAGGER_API_KEY_AUTH),
    ApiWorkspaceHeader(false),
    ApiResponse({
      status: 401,
      description: 'Missing or invalid Bearer JWT / Workspace API Key',
      type: ProblemDetailsDto,
    }),
    ApiResponse({
      status: 403,
      description: 'Insufficient workspace permissions',
      type: ProblemDetailsDto,
    }),
  );
}
