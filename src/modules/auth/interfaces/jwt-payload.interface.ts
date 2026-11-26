export interface JwtAccessPayload {
  readonly sub: string;
  readonly email: string;
  readonly sid: string;
  readonly jti: string;
  readonly type: 'access';
}

export interface JwtRefreshPayload {
  readonly sub: string;
  readonly email: string;
  readonly sid: string;
  readonly jti: string;
  readonly type: 'refresh';
}

export interface PublicUserProfile {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly createdAt?: Date;
}

export interface AuthTokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly user: PublicUserProfile;
}
