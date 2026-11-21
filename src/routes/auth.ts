import { FastifyInstance } from "fastify";
import { loginSchema, registerSchema } from "../schemas/auth.js";
import { db } from "../db/index.js";
import { users } from "../db/schema/users.js";
import { eq } from 'drizzle-orm'
import bcrypt from "bcryptjs";
import { JWT } from "@fastify/jwt";

export const authRoutes = async (app: FastifyInstance) => {
    app.post('/auth/register', async (request, reply) => {
        const parseResult = registerSchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({
                error: 'Некорректный email или пароль',
                details: parseResult.error.format(),
            });
        };

        const duplicateEmail = await db.select().from(users).where(eq(users.email, parseResult.data.email));
        if (duplicateEmail.length > 0) {
            return reply.status(409).send({
                error: 'Пользователь с таким email уже существует',
            });
        }

        const passwordHash = await bcrypt.hash(parseResult.data.password, 10);
        try {
            const [newUser] = await db.insert(users).values({
                email: parseResult.data.email,
                passwordHash: passwordHash,
            }).returning({
                id: users.id,
                email: users.email,
            })
            if (newUser) {
                const token = app.jwt.sign({ id: newUser.id, email: newUser.email });
                return reply.status(201).send({ user: newUser, token });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
            request.log.error(err);
            return reply.status(500).send({
                error: 'Внутренняя ошибка сервера'
            });
        }
    });

    app.post('/auth/login', async (request, reply) => {
        const parseResult = loginSchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({
                error: 'Некорректный email или пароль',
                details: parseResult.error.format(),
            });
        };

        try {
            const [user] = await db.select().from(users).where(eq(users.email, parseResult.data.email));

            if (!user || !(await bcrypt.compare(parseResult.data.password, user.passwordHash))) {
                return reply.status(401).send({ error: 'Неверный email или пароль' });
            }

            const token = app.jwt.sign({
                id: user.id,
                email: user.email,
            });
            return reply.status(200).send({ user: { id: user.id, email: user.email }, token })

        } catch (err) {
            const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
            request.log.error(err);
            return reply.status(500).send({
                error: 'Внутренняя ошибка сервера'
            });
        }
    });
}