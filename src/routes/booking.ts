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

        try {
            const booking = await createBooking(parseResult.data, userId, idempotencyKey);
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

    app.post('/bookings/:id/pay', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const user = request.user as { id: string; email: string };
        const userId = user.id;

        try {
            const paid = await payBooking(id, userId);
            return reply.status(200).send(paid);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Неизвестная ошибка';

            if (message.includes('не найдена')) {
                return reply.status(404).send({
                    error: message,
                });
            };

            if (message.includes('истек') || message.includes('уже оплачена')) {
                return reply.status(409).send({
                    error: message,
                });
            };

            request.log.error(err);
            return reply.status(500).send({
                error: 'Внутренняя ошибка сервера'
            });
        }
    })
};