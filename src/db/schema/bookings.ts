import { bigint, index, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { events } from "./events.js";

export const bookingEnum = pgEnum('booking_status', ['PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED']);

export const bookings = pgTable('bookings', {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }).notNull(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'restrict' }).notNull(),
    status: bookingEnum('status').default('PENDING').notNull(),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => new Date()),
}, (t) => [
    uniqueIndex('booking_idempotency_key_idx').on(t.idempotencyKey),
    index('booking_status_expires_at_idx').on(t.status, t.expiresAt),
])