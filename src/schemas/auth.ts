import z from "zod";

export const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6, 'Пароль минимум 6 символов'),
});

export const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6, 'Пароль минимум 6 символов'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;