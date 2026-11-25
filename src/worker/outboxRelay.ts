import { asc, eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { outboxEvents } from "../db/schema/outboxEvents.js"
import { bookingExpirationQueue } from "../queues/bookingQueue.js"

const MAX_RETRIES = 3;

export const processOutboxBatch = async () => {
    await db.transaction(async (tx) => {
        const pendingResult = await tx
            .select()
            .from(outboxEvents)
            .where(eq(outboxEvents.status, 'PENDING'))
            .orderBy(asc(outboxEvents.createdAt))
            .limit(20)
            .for('update', { skipLocked: true })

        for (const event of pendingResult) {
            try {
                await tx.transaction(async (subTx) => {
                    if (event.eventType === 'BOOKING_CREATED') {
                        const payload = event.payload as {
                            bookingId: string;
                            eventId: string;
                            seatIds: string[];
                            expiresAt?: string;
                        };

                        if (!(typeof payload.bookingId === 'string' && typeof payload.eventId === 'string' && Array.isArray(payload.seatIds))) {
                            throw new Error('Неподходящие данные');
                        }
                        if (payload.expiresAt && Number.isNaN(new Date(payload.expiresAt).getTime())) {
                            throw new Error('Неправильное время');
                        }

                        const delay = payload.expiresAt
                            ? Math.max(0, new Date(payload.expiresAt).getTime() - Date.now())
                            : 15 * 60 * 1000

                        await bookingExpirationQueue.add(
                            'expire-booking',
                            {
                                bookingId: payload.bookingId,
                                eventId: payload.eventId,
                                seatIds: payload.seatIds,
                            },
                            { delay, jobId: `expire-${payload.bookingId}` }
                        );
                    }

                    await subTx
                        .update(outboxEvents)
                        .set({
                            status: 'PROCESSED',
                            processedAt: new Date(),
                            lastError: null,
                        })
                        .where(eq(outboxEvents.id, event.id))

                })
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                let nextRetryCount = event.retryCount + 1;
                await tx
                    .update(outboxEvents)
                    .set({
                        status: nextRetryCount >= MAX_RETRIES ? 'FAILED' : 'PENDING',
                        retryCount: nextRetryCount,
                        lastError: message,
                    })
                    .where(eq(outboxEvents.id, event.id))

                console.error(err)
            }
        }

    })

}

export const startOutboxRelay = () => {
    return setInterval(() => {
        processOutboxBatch().catch((err) => {
            console.error('Ошибка Outbox Relay:', err);
        })
    }, 2000);
};