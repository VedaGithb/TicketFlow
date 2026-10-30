import { bigint, integer, pgTable, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { events } from "./events.js";

export const seats = pgTable('seats', {
    id: uuid().primaryKey().defaultRandom(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'cascade' }).notNull(),
    sector: varchar('sector', { length: 50 }).notNull(),
    row: integer('row').notNull(),
    number: integer('number').notNull(),
    priceCents: bigint('price_cents', { mode: 'number' }).notNull(),
}, (t) => [
    uniqueIndex('event_seat_unique_idx').on(t.eventId, t.sector, t.row, t.number),
])