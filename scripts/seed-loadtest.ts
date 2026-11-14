import { db } from "../src/db/index.js";
import { events } from "../src/db/schema/events.js";
import { seats } from "../src/db/schema/seats.js";
import { users } from "../src/db/schema/users.js";
import fs from "node:fs";
import path from "node:path";

async function seedLoadTest() {
    console.log("Генерация тестовых данных для k6 (100 мест)");

    const [user] = await db.insert(users).values({
        email: `loadtest_${Date.now()}@ticketflow.com`,
        passwordHash: 'hash_test_load',
    }).returning();

    const [event] = await db.insert(events).values({
        title: `Flash Sale Arena ${Date.now()}`,
        description: 'Стресс-тест k6: 100 мест под высокой нагрузкой',
    }).returning();

    const seatsToInsert = [];
    for (let row = 1; row <= 10; row++) {
        for (let num = 1; num <= 10; num++) {
            seatsToInsert.push({
                sector: 'VIP',
                row,
                number: num,
                eventId: event!.id,
                priceCents: 100000,
            });
        }
    }

    const createdSeats = await db.insert(seats).values(seatsToInsert).returning();

    console.log(`[Seed] Создано событие: "${event!.title}" (ID: ${event!.id})`);
    console.log(`[Seed] Создан пользователь ID: ${user!.id}`);
    console.log(`[Seed] Создано мест: ${createdSeats.length} шт.`);

    const testData = {
        userId: user!.id,
        eventId: event!.id,
        seatIds: createdSeats.map((s) => s.id),
    };

    const outputPath = path.resolve(process.cwd(), "k6-test-data.json");
    fs.writeFileSync(outputPath, JSON.stringify(testData, null, 2), "utf-8");

    console.log(`[Seed] Данные для k6 успешно сохранены в: ${outputPath}`);
    process.exit(0);
}

seedLoadTest().catch((err) => {
    console.error("[Seed Error]", err);
    process.exit(1);
});