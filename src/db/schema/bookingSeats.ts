import { index, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bookings } from "./bookings.js";
import { seats } from "./seats.js";

export const bookingSeats = pgTable('booking_seats', {
    id: uuid().primaryKey().defaultRandom(),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'cascade' }).notNull(),
    seatId: uuid('seat_id').references(() => seats.id, { onDelete: 'restrict' }).notNull(),
}, (t) => [
    uniqueIndex('booking_seat_unique_idx').on(t.bookingId, t.seatId),
    index('booking_seats_seat_id_idx').on(t.seatId),
])