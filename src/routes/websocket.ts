import { FastifyInstance } from "fastify";
import { addClient } from "../websocket/roomManager.js";

export const websocketRoutes = async (app: FastifyInstance) => {
    app.get('/events/:id/live', { websocket: true }, (socket, req) => {
        const { id } = req.params as { id: string };

        addClient(id, socket);
    })
}