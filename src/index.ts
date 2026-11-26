import { env } from "./config/env.js";
import { startOutboxRelay } from "./worker/outboxRelay.js";
import { startExpirationWorker } from "./worker/expirationWorker.js";
import { pool } from './db/index.js';
import { redis } from "./redis/index.js";
import { subscriber } from "./websocket/roomManager.js";

import { buildApp } from "./app.js";


let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let relayTimer: NodeJS.Timeout | null = null;
let expirationWorker: ReturnType<typeof startExpirationWorker> | null = null;


export const start = async () => {

    app = await buildApp();
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    relayTimer = startOutboxRelay();
    expirationWorker = startExpirationWorker();
};

const gracefulShutdown = async (signal: string) => {
    try {
        if (app) {
            app.log.info(`Получен сигнал ${signal}, начинаеться плавная остановка...`);
            await app.close();
        }

        if (expirationWorker) await expirationWorker.close();
        if (relayTimer) clearInterval(relayTimer);

        await redis.quit();
        await subscriber.quit();

        await pool.end();

        process.exit(0);
    } catch (err) {
        app?.log.error(err, 'Ошибка во время останвки:');
        process.exit(1);
    }
}

start();
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));