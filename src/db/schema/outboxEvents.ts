import { index, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const outboxStatusEnum = pgEnum('outbox_status', ['PENDING', 'PROCESSED', 'FAILED']);

export const outboxEvents = pgTable('outbox_events', {
    id: uuid().primaryKey().defaultRandom(),
    aggregateType: varchar('aggregate_type', { length: 50 }).notNull(),
    aggregateId: varchar('aggregate_id', { length: 255 }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum('status').default('PENDING').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
}, (t) => [
    index('outbox_status_created_at_idx').on(t.status, t.createdAt)
])