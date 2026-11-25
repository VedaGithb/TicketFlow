import { FastifyInstance } from "fastify";
import { bookingSchema } from "../schemas/booking.js";
import { createBooking, payBooking } from "../services/bookingService.js";

export const bookingRoutes = async (app: FastifyInstance) => {
    app.post('/bookings', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
        const idempotencyKey = request.headers['idempotency-key'];
        const user = request.user as { id: string; email: string };
        const userId = user.id;
        if (!idempotencyKey || typeof idempotencyKey !== 'string') {
            return reply.status(400).send({
                error: "Заголовок 'Idempotency-Key' обязателен"
            });
        };

        const parseResult = bookingSchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({
                error: 'Неверные данные запроса',
                details: parseResult.error.format(),
            });
        };

        const booking = await createBooking(parseResult.data, userId, idempotencyKey);
        return reply.status(201).send(booking);
    });

    app.post('/bookings/:id/pay', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const user = request.user as { id: string; email: string };
        const userId = user.id;

        const paid = await payBooking(id, userId);
        return reply.status(200).send(paid);
    })
};