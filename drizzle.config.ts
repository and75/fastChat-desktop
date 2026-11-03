import { defineConfig } from 'drizzle-kit'

// Solo per `npm run db:generate`: genera le migrazioni SQL in ./drizzle,
// che il main process applica all'avvio.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './drizzle'
})
