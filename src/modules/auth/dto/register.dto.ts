import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({
    example: 'ada@kestrelmq.io',
    maxLength: 255,
    description: 'Unique user email address',
  })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    example: 'Str0ngPassw0rd!2026',
    minLength: 8,
    maxLength: 128,
    description: 'Plaintext password (hashed with Argon2id before storage)',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiProperty({
    example: 'Ada Lovelace',
    maxLength: 255,
    description: 'User full display name',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fullName!: string;
}
