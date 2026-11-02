import { FastifyInstance } from "fastify";
import { bookingSchema } from "../schemas/booking.js";
import { createBooking } from "../services/bookingService.js";

export const bookingRoutes = async (app: FastifyInstance) => {
    app.post('/bookings', async (request, reply) => {
        const idempotencyKey = request.headers['idempotency-key'];
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

        try {
            const booking = await createBooking(parseResult.data, idempotencyKey);
            return reply.status(201).send(booking);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Неизвестная ошибка';

            if (message.includes('уже заняты') || message.includes('уже обрабатывается')) {
                return reply.status(409).send({
                    error: message
                })
            }

            request.log.error(err);
            return reply.status(500).send({
                error: 'Внутренняя ошибка сервера'
            });
        };
    });
};