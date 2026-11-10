import { Queue } from "bullmq";
import { redis } from "../redis/index.js";

export interface BookingExpirationJobData {
    bookingId: string;
    eventId: string;
    seatIds: string[];
}

export const bookingExpirationQueue = new Queue<BookingExpirationJobData>('booking-expiration', { connection: redis });