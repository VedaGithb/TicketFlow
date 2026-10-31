import Fastify from "fastify";
import { env } from "./config/env.js";
import { httpRequestCounter, httpRequestDuration, register } from "./metrics.js";

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

export const start = async () => {
    try {
        await app.listen({ port: env.PORT, host: '0.0.0.0' });
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();