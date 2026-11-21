import 'dotenv/config'
import z from 'zod'

export const envSchema = z.object({
    PORT: z.coerce.number().default(4000),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string(),
    RATE_LIMIT_MAX: z.coerce.number().default(100),
})

export const env = envSchema.parse(process.env)