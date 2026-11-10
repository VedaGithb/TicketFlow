import { asc, eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { outboxEvents } from "../db/schema/outboxEvents.js"
import { bookingExpirationQueue } from "../queues/bookingQueue.js"

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
            if (event.eventType === 'BOOKING_CREATED') {
                const payload = event.payload as {
                    bookingId: string;
                    eventId: string;
                    seatIds: string[];
                    expiresAt?: string;
                };


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

            await tx
                .update(outboxEvents)
                .set({
                    status: 'PROCESSED',
                    processedAt: new Date(),
                })
                .where(eq(outboxEvents.id, event.id))
        }

    })

}

export const startOutboxRelay = () => {
    setInterval(() => {
        processOutboxBatch().catch((err) => {
            console.error('Ошибка Outbox Relay:', err);
        })
    }, 2000);
};