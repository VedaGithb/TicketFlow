import { Worker } from "bullmq"
import { redis } from "../redis/index.js"
import { db } from "../db/index.js";
import { bookings } from "../db/schema/bookings.js";
import { and, eq } from "drizzle-orm";
import { publishSeatUpdate } from "../websocket/roomManager.js";

export const startExpirationWorker = () => {
    const worker = new Worker('booking-expiration', async (job) => {
        const { bookingId, eventId, seatIds } = job.data;

        const [expiredBooking] = await db
            .update(bookings)
            .set({
                status: 'EXPIRED',
                updatedAt: new Date(),
            })
            .where(and(
                eq(bookings.id, bookingId),
                eq(bookings.status, 'PENDING')
            ))
            .returning()

        if (expiredBooking) {
            console.log(`[Воркер] Бронь ${bookingId} истекла!`);
            await publishSeatUpdate(eventId, seatIds, 'RELEASED')
        } else {
            console.log(`[Воркер] Бронь ${bookingId} уже была оплачена (или отменена ранее).`);
        }
    }, { connection: redis.duplicate() });

    worker.on('failed', (job, err) => {
        console.error(`[Воркер] Ошибка в задаче ${job?.id}:`, err);
    });
}