import { pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const statusEnum = pgEnum('event_status', ['DRAFT', 'PUBLISHED', 'COMPLETED']);

export const events = pgTable('events', {
    id: uuid().primaryKey().defaultRandom(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text(),
    status: statusEnum('status').default('DRAFT').notNull(),
    startAt: timestamp('start_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().$onUpdate(() => new Date()),
})