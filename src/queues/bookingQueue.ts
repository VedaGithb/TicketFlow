import { Queue } from "bullmq";
import { redis } from "../redis/index.js";

export interface BookingExpirationJobData {
    bookingId: string,
}

export const bookingExpirationQueue = new Queue<BookingExpirationJobData>('booking-expiration', { connection: redis });