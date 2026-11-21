import Fastify from "fastify";
import { env } from "./config/env.js";
import { httpRequestCounter, httpRequestDuration, register } from "./metrics.js";
import { bookingRoutes } from "./routes/booking.js";
import { startOutboxRelay } from "./worker/outboxRelay.js";
import { startExpirationWorker } from "./worker/expirationWorker.js";
import websocket from "@fastify/websocket";
import { websocketRoutes } from "./routes/websocket.js";
import { pool } from './db/index.js';
import { redis } from "./redis/index.js";
import { subscriber } from "./websocket/roomManager.js";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

const app = Fastify({ logger: true });

app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url || request.url;
    const labels = {
        method: request.method,
        route,
        status_code: reply.statusCode.toString(),
    };
    httpRequestCounter.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
    done();
})

app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
});

app.get('/metrics', async (request, reply) => {
    reply.header('Content-Type', register.contentType);
    return register.metrics();
})

await app.register(websocket);

await app.register(fastifyRateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    redis,
});

await app.register(fastifySwagger, {
    openapi: {
        info: {
            title: 'TicketFlow API',
            description: 'Высоконагруженный сервис бронирования билетов',
            version: '1.0.0',
        },
    },
});

await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
});

app.register(websocketRoutes);

app.register(bookingRoutes);


let relayTimer: NodeJS.Timeout | null = null;
let expirationWorker: ReturnType<typeof startExpirationWorker> | null = null;
export const start = async () => {
    try {
        await app.listen({ port: env.PORT, host: '0.0.0.0' });
        relayTimer = startOutboxRelay();
        expirationWorker = startExpirationWorker();

        console.log('Outbox Relay и Expiration Worker запущены!');
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();

const gracefulShutdown = async (signal: string) => {
    try {
        app.log.info(`Получен сигнал ${signal}, начинаеться плавная остановка...`);
        await app.close();

        if (expirationWorker) await expirationWorker.close();
        if (relayTimer) clearInterval(relayTimer);

        await redis.quit();
        await subscriber.quit();

        await pool.end();

        process.exit(0);
    } catch (err) {
        app.log.error(err, 'Ошибка во время останвки:');
        process.exit(1);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));