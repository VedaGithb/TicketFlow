import { db } from "./index.js"
import { events } from "./schema/events.js";
import { seats } from "./schema/seats.js";
import { users } from "./schema/users.js"

export const seed = async () => {
    const [createdUser] = await db.insert(users).values({
        email: 'test@ticketflow.com',
        passwordHash: '412412515',
    }).returning();

    const [createdEvent] = await db.insert(events).values({
        title: 'Концерт на стадионе 2026',
        description: 'Главный концерт лета',
    }).returning();

    const seatsToInsert = [];
    for (let i = 1; i <= 20; i++) {
        seatsToInsert.push({
            sector: 'A',
            row: 1,
            number: i,
            eventId: createdEvent!.id,
            priceCents: 500000,
        });
    }
    const createdSeats = await db.insert(seats).values(seatsToInsert).returning();

    console.log(createdUser?.id)
    console.log(createdEvent?.id)
    console.log(createdSeats[0]?.id, createdSeats[1]?.id)
}

seed().then(() => {
    console.log('Seed успешно завершен');
    process.exit(0);
})