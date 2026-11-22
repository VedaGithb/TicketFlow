import z from "zod";

export const bookingSchema = z.object({
    eventId: z.string().uuid(),
    seatIds: z.array(z.string().uuid())
        .min(1, "Нужно выбрать хотя бы одно место")
        .max(10, "Нельзя выбрать более десяти мест за один заказ")
        .refine((items) => {
            return new Set(items).size === items.length
        }, {
            message: 'Места в заказе не должны дублироваться'
        })
});

export type CreateBookingInput = z.infer<typeof bookingSchema>;