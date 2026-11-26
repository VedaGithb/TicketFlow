import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { db, pool } from "../src/db/index.js";
import { redis } from "../src/redis/index.js";
import { subscriber } from "../src/websocket/roomManager.js";
import { bookingExpirationQueue } from "../src/queues/bookingQueue.js";
import { events } from "../src/db/schema/events.js";
import { seats } from "../src/db/schema/seats.js";
import { bookings } from "../src/db/schema/bookings.js";
import { outboxEvents } from "../src/db/schema/outboxEvents.js";
import { users } from "../src/db/schema/users.js";
import { processOutboxBatch } from "../src/worker/outboxRelay.js";

describe('TicketFlow Integration', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    let eventId: string;
    let seatIds: string[] = [];
    let tokenA: string;
    let userIdA: string;
    let tokenB: string;
    let userIdB: string;
    const createdBookingIds: string[] = [];
    const createdOutboxIds: string[] = [];
    const createdIdempKeys: string[] = [];

    before(async () => {
        app = await buildApp({ logger: false });

        const [event] = await db.insert(events).values({
            title: `Integration Test Event ${Date.now()}`,
            description: 'Тест: 5 мест',
        }).returning();
        eventId = event!.id;

        const seatsToInsert = Array.from({ length: 5 }, (_, i) => ({
            sector: 'VIP',
            row: 1,
            number: i + 1,
            eventId,
            priceCents: 100000,
        }));

        const createdSeats = await db.insert(seats).values(seatsToInsert).returning();
        seatIds = createdSeats.map((s) => s.id);

        const suffix = `${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
        const user1Res = await app.inject({
            method: 'POST',
            url: '/auth/register',
            payload: { email: `test_a_${suffix}@test.com`, password: 'password1234' },
        });
        const dataUser1 = user1Res.json() as { user: { id: string }; token: string };
        tokenA = dataUser1.token;
        userIdA = dataUser1.user.id;

        const user2Res = await app.inject({
            method: 'POST',
            url: '/auth/register',
            payload: { email: `test_b_${suffix}@test.com`, password: 'password1234' },
        });
        const dataUser2 = user2Res.json() as { user: { id: string }; token: string };
        tokenB = dataUser2.token;
        userIdB = dataUser2.user.id;
    });

    it('Authorization: rejects unauthenticated booking requests with 401', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/bookings',
            payload: { eventId, seatIds: [seatIds[0]!] },
        });

        assert.equal(res.statusCode, 401);
    });

    it('Idempotency: returns the same booking on duplicate Idempotency-Key', async () => {
        const key = crypto.randomUUID();
        createdIdempKeys.push(`idemp:${key}`);

        const res1 = await app.inject({
            method: 'POST',
            url: '/bookings',
            headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': key },
            payload: { eventId, seatIds: [seatIds[0]!] },
        });
        const res2 = await app.inject({
            method: 'POST',
            url: '/bookings',
            headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': key },
            payload: { eventId, seatIds: [seatIds[0]!] },
        });

        assert.equal(res1.statusCode, 201);
        assert.equal(res2.statusCode, 201);
        assert.equal(res1.json().id, res2.json().id);
        createdBookingIds.push(res1.json().id);
    });

    it('Concurrency and Deadlocks: handles 10 opposing pair requests with 0 deadlocks', async () => {
        const responses = await Promise.all(
            Array.from({ length: 10 }, (_, i) => {
                const key = crypto.randomUUID();
                createdIdempKeys.push(`idemp:${key}`);
                const pair = i % 2 === 0
                    ? [seatIds[1]!, seatIds[2]!]
                    : [seatIds[2]!, seatIds[1]!];

                return app.inject({
                    method: 'POST',
                    url: '/bookings',
                    headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': key },
                    payload: { eventId, seatIds: pair },
                });
            })
        );

        const succeeded = responses.filter((r) => r.statusCode === 201);
        const conflicts = responses.filter(
            (r) => r.statusCode === 409 && r.json().code === 'SEATS_OCCUPIED'
        );

        assert.equal(succeeded.length, 1);
        assert.equal(conflicts.length, 9);
        createdBookingIds.push(succeeded[0]!.json().id);
    });

    it('Payment and Expiration Race: enforces ownership and rejects expired bookings', async () => {
        const bookingId = createdBookingIds[0]!;

        const resOtherUser = await app.inject({
            method: 'POST',
            url: `/bookings/${bookingId}/pay`,
            headers: { authorization: `Bearer ${tokenB}` },
            payload: {},
        });
        assert.equal(resOtherUser.statusCode, 404);
        assert.equal(resOtherUser.json().code, 'BOOKING_NOT_FOUND');

        const resPay = await app.inject({
            method: 'POST',
            url: `/bookings/${bookingId}/pay`,
            headers: { authorization: `Bearer ${tokenA}` },
            payload: {},
        });
        assert.equal(resPay.statusCode, 200);
        assert.equal(resPay.json().status, 'CONFIRMED');

        const expKey = crypto.randomUUID();
        createdIdempKeys.push(`idemp:${expKey}`);
        const newBookingRes = await app.inject({
            method: 'POST',
            url: '/bookings',
            headers: { authorization: `Bearer ${tokenA}`, 'idempotency-key': expKey },
            payload: { eventId, seatIds: [seatIds[3]!] },
        });
        assert.equal(newBookingRes.statusCode, 201);
        const expiredBookingId = newBookingRes.json().id as string;
        createdBookingIds.push(expiredBookingId);

        await db
            .update(bookings)
            .set({ expiresAt: new Date(Date.now() - 60_000) })
            .where(eq(bookings.id, expiredBookingId));

        const resExpired = await app.inject({
            method: 'POST',
            url: `/bookings/${expiredBookingId}/pay`,
            headers: { authorization: `Bearer ${tokenA}` },
            payload: {},
        });
        assert.equal(resExpired.statusCode, 409);
        assert.equal(resExpired.json().code, 'BOOKING_EXPIRED');
    });

    it('Outbox Poison Pill: marks malformed event FAILED after 3 retries without blocking valid events', async () => {
        const now = Date.now();
        const goodBookingId = `test-outbox-${now}`;
        const future = new Date(now + 10 * 60 * 1000).toISOString();

        const inserted = await db.insert(outboxEvents).values([
            {
                aggregateType: 'BOOKING',
                aggregateId: 'poison:id',
                eventType: 'BOOKING_CREATED',
                payload: { bookingId: 'poison:id', eventId, seatIds: [seatIds[4]!], expiresAt: future },
                createdAt: new Date(now - 2000),
            },
            {
                aggregateType: 'BOOKING',
                aggregateId: goodBookingId,
                eventType: 'BOOKING_CREATED',
                payload: { bookingId: goodBookingId, eventId, seatIds: [seatIds[4]!], expiresAt: future },
                createdAt: new Date(now - 1000),
            },
        ]).returning();

        const ids = inserted.map((e) => e.id);
        createdOutboxIds.push(...ids);

        for (let attempt = 0; attempt < 3; attempt++) {
            await processOutboxBatch();
        }

        const rows = await db.select().from(outboxEvents).where(inArray(outboxEvents.id, ids));
        const poisonRow = rows.find((r) => r.aggregateId === 'poison:id');
        const goodRow = rows.find((r) => r.aggregateId === goodBookingId);

        assert.equal(goodRow?.status, 'PROCESSED');
        assert.equal(poisonRow?.status, 'FAILED');
        assert.equal(poisonRow?.retryCount, 3);

        const job = await bookingExpirationQueue.getJob(`expire-${goodBookingId}`);
        if (job) await job.remove();
    });

    after(async () => {
        if (createdBookingIds.length > 0) {
            await db.delete(outboxEvents).where(inArray(outboxEvents.aggregateId, createdBookingIds));
            await db.delete(bookings).where(inArray(bookings.id, createdBookingIds));
        }
        if (createdOutboxIds.length > 0) {
            await db.delete(outboxEvents).where(inArray(outboxEvents.id, createdOutboxIds));
        }
        if (eventId) {
            await db.delete(events).where(eq(events.id, eventId));
        }
        const userIds = [userIdA, userIdB].filter(Boolean);
        if (userIds.length > 0) {
            await db.delete(users).where(inArray(users.id, userIds));
        }
        if (createdIdempKeys.length > 0) {
            await redis.del(...createdIdempKeys);
        }

        await app.close();
        await bookingExpirationQueue.close();
        await redis.quit();
        await subscriber.quit();
        await pool.end();
    });
});
