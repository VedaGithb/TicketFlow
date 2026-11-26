import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import { env } from "./config/env.js";
import { redis } from "./redis/index.js";
import { httpRequestCounter, httpRequestDuration, register } from "./metrics.js";
import { bookingRoutes } from "./routes/booking.js";
import websocket from "@fastify/websocket";
import { websocketRoutes } from "./routes/websocket.js";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import fastifyJwt from "@fastify/jwt";
import { authRoutes } from "./routes/auth.js";
import { AppError } from "./errors/appError.js";

export async function buildApp(options?: { logger?: boolean }) {
    const app = Fastify({ logger: options?.logger ?? true });

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
    });

    app.setErrorHandler((error, request, reply) => {
        if (error instanceof AppError) {
            return reply.status(error.statusCode).send(
                error.code ? {
                    error: error.message,
                    code: error.code,
                } : {
                    error: error.message,
                }
            )
        };

        if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
            return reply.status(error.statusCode).send({ error: error.message })
        };

        request.log.error(error);
        return reply.status(500).send({
            error: 'Внутренняя ошибка сервера',
        });
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

    await app.register(fastifyJwt, {
        secret: env.JWT_SECRET
    });

    app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            await request.jwtVerify();
        } catch (err) {
            reply.status(401).send({ error: 'Не авторизован' });
        }
    });

    app.register(authRoutes);

    await app.register(fastifySwaggerUi, {
        routePrefix: '/docs',
    });

    app.register(websocketRoutes);

    app.register(bookingRoutes);

    return app;
}