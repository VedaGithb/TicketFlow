import Fastify from "fastify";
import { env } from "./config/env.js";
import { httpRequestCounter, httpRequestDuration, register } from "./metrics.js";
import { bookingRoutes } from "./routes/booking.js";
import { startOutboxRelay } from "./worker/outboxRelay.js";
import { startExpirationWorker } from "./worker/expirationWorker.js";
import websocket from "@fastify/websocket";
import { websocketRoutes } from "./routes/websocket.js";

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

app.register(websocketRoutes);

app.register(bookingRoutes);

export const start = async () => {
    try {
        await app.listen({ port: env.PORT, host: '0.0.0.0' });
        startOutboxRelay();
        startExpirationWorker();

        console.log('Outbox Relay и Expiration Worker запущены!');
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();