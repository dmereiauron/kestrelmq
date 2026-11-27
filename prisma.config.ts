import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const SCHEMA_GENERATION_FALLBACK_URL = 'postgresql://localhost:5432/kestrelmq';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['POSTGRES_URL'] ?? SCHEMA_GENERATION_FALLBACK_URL,
  },
});
