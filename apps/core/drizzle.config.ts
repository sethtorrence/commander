import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/item-store/schema.ts',
  out: './drizzle',
});
