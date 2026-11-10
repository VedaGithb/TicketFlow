import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { seats } from "../db/schema/seats.js";
import { CreateBookingInput } from "../schemas/booking.js";
import { bookingSeats } from "../db/schema/bookingSeats.js";
import { bookings } from "../db/schema/bookings.js";
import { outboxEvents } from "../db/schema/outboxEvents.js";
import { redis } from "../redis/index.js";
import { publishSeatUpdate } from "../websocket/roomManager.js";

export async function createBooking(input: CreateBookingInput, idempotencyKey: string) {
    const idempKey = `idemp:${idempotencyKey}`;
    const cached = await redis.get(idempKey);

    if (cached === 'PROCESSING') {
        throw new Error('Запрос уже обрабатывается, пожалуйста, подождите');
    }

    if (cached !== null) {
        return JSON.parse(cached);
    }

    const acquired = await redis.set(idempKey, 'PROCESSING', 'EX', 120, 'NX');
    if (!acquired) {
        throw new Error('Запрос уже обрабатывается, пожалуйста, подождите');
    }


    try {
        const result = await db.transaction(async (tx) => {
            const sortedSeatIds = [...input.seatIds].sort();

            const lockedSeats = await tx
                .select()
                .from(seats)
                .where(inArray(seats.id, sortedSeatIds))
                .orderBy(asc(seats.id))
                .for('update');

            const occupiedSeats = await tx
                .select({ seatId: bookingSeats.seatId })
                .from(bookingSeats)
                .innerJoin(bookings, eq(bookingSeats.bookingId, bookings.id))
                .where(
                    and(
                        inArray(bookingSeats.seatId, sortedSeatIds),
                        or(
                            eq(bookings.status, 'CONFIRMED'),
                            and(
                                eq(bookings.status, 'PENDING'),
                                gt(bookings.expiresAt, new Date())
                            )
                        )
                    )
                );

            if (occupiedSeats.length > 0) {
                throw new Error('Места уже заняты');
            }

            const totalCents = lockedSeats.reduce((sum, seat) => sum + seat.priceCents, 0);

            const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

            const [newBooking] = await tx
                .insert(bookings)
                .values({
                    userId: input.userId,
                    eventId: input.eventId,
                    status: 'PENDING',
                    totalCents,
                    idempotencyKey,
                    expiresAt,
                })
                .returning();

            await tx.insert(bookingSeats).values(
                sortedSeatIds.map((seatId) => ({
                    bookingId: newBooking!.id,
                    seatId,
                }))
            );

            await tx.insert(outboxEvents).values({
                aggregateType: 'BOOKING',
                aggregateId: newBooking!.id,
                eventType: 'BOOKING_CREATED',
                payload: {
                    bookingId: newBooking!.id,
                    userId: input.userId,
                    eventId: input.eventId,
                    seatIds: sortedSeatIds,
                    totalCents,
                    expiresAt: expiresAt.toISOString(),
                },
            });

            return newBooking;
        });
        await redis.set(idempKey, JSON.stringify(result), "EX", 86400);
        await publishSeatUpdate(result!.eventId, input.seatIds, 'LOCKED')
        return result;
    } catch (err) {
        await redis.del(idempKey)
        throw err;
    }
}
