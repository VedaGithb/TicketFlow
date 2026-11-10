import { WebSocket } from "@fastify/websocket";
import { redis } from "../redis/index.js";


export const subscriber = redis.duplicate();

export const rooms = new Map<string, Set<WebSocket>>();

export async function publishSeatUpdate(
    eventId: string,
    seatIds: string[],
    status: 'LOCKED' | 'RELEASED' | 'SOLD'
) {
    const chanel = `event:${eventId}:seats`;
    const payload = JSON.stringify({
        eventId,
        seatIds,
        status,
        timestamp: new Date().toISOString(),
    });
    await redis.publish(chanel, payload);
}

export async function addClient(eventId: string, socket: WebSocket) {
    const hasEvent = rooms.has(eventId);
    if (!hasEvent) {
        rooms.set(eventId, new Set());
        subscriber.subscribe(`event:${eventId}:seats`);
    }

    rooms.get(eventId)?.add(socket);

    socket.on("close", () => removeClient(eventId, socket));
    socket.on("error", () => removeClient(eventId, socket));
}

export async function removeClient(eventId: string, socket: WebSocket) {
    const room = rooms.get(eventId);

    if (!room) return;

    room.delete(socket);

    if (room.size === 0) {
        rooms.delete(eventId);
        subscriber.unsubscribe(`event:${eventId}:seats`);
    }
}

subscriber.on("message", (channel, message) => {
    const eventId = channel.split(":")[1];

    if (!eventId) return;

    const room = rooms.get(eventId);

    if (!room) return;

    for (const client of room) {
        if (client.readyState === 1) client.send(message);
    }
})

setInterval(() => {
    for (const room of rooms.values()) {
        for (const client of room) {
            if (client.readyState === 1) {
                client.ping();
            }
        }
    }
}, 30000);