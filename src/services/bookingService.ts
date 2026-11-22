import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { seats } from "../db/schema/seats.js";
import { CreateBookingInput } from "../schemas/booking.js";
import { bookingSeats } from "../db/schema/bookingSeats.js";
import { bookings } from "../db/schema/bookings.js";
import { outboxEvents } from "../db/schema/outboxEvents.js";
import { redis } from "../redis/index.js";
import { publishSeatUpdate } from "../websocket/roomManager.js";

export async function createBooking(input: CreateBookingInput, userId: string, idempotencyKey: string) {
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

    let result;
    try {
        result = await db.transaction(async (tx) => {
            const sortedSeatIds = [...input.seatIds].sort();

            const lockedSeats = await tx
                .select()
                .from(seats)
                .where(inArray(seats.id, sortedSeatIds))
                .orderBy(asc(seats.id))
                .for('update');

            if (lockedSeats.length !== sortedSeatIds.length) {
                throw new Error('Одно или несколько мест не найдены');
            }

            for (const s of lockedSeats) {
                if (s.eventId !== input.eventId) {
                    throw new Error('Выбранные места не принадлежат данному мероприятию')
                }
            }

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
                    userId: userId,
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
                    userId: userId,
                    eventId: input.eventId,
                    seatIds: sortedSeatIds,
                    totalCents,
                    expiresAt: expiresAt.toISOString(),
                },
            });

            return newBooking;
        });
    } catch (err) {
        await redis.del(idempKey)
        throw err;
    }
    try {
        await redis.set(idempKey, JSON.stringify(result), "EX", 86400);
        await publishSeatUpdate(result!.eventId, input.seatIds, 'LOCKED')
    } catch (err) {
        console.error('Пост-коммит сбой:', err);
    }
    return result;
}

export async function payBooking(bookingId: string, userId: string) {
    try {
        const [confirmedBooking] = await db
            .update(bookings)
            .set({ status: 'CONFIRMED' })
            .where(and(
                eq(bookings.id, bookingId),
                eq(bookings.userId, userId),
                eq(bookings.status, 'PENDING'),
                gt(bookings.expiresAt, new Date())
            ))
            .returning()

        if (!confirmedBooking) {
            const [existing] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
            if (!existing || existing.userId !== userId) {
                throw new Error('Бронь не найдена');
            }
            if (existing.status === 'CONFIRMED') {
                throw new Error('Бронь уже оплачена');
            }
            if (existing.status === 'EXPIRED' || existing.expiresAt <= new Date()) {
                throw new Error('Срок действия брони истек');
            }
            throw new Error('Не удалось оплатить бронь');
        }
        return confirmedBooking;
    } catch (err) {
        console.error('Ошибка при оплате:', err);
        throw err;
    }
}