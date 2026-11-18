import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const testData = JSON.parse(open('./k6-test-data.json'));

const successfulBookings = new Counter('successful_bookings');
const conflictBookings = new Counter('conflict_bookings');
const unexpectedErrors = new Counter('unexpected_errors');

export const options = {
    scenarios: {
        flash_sale_spike: {
            executor: 'shared-iterations',
            vus: 100,
            iterations: 100,
            maxDuration: '45s',
        },
    },
    thresholds: {
        unexpected_errors: ['count==0'],
        successful_bookings: ['count>=1'],
        http_req_duration: ['p(95)<300'],
    },
};

export default function () {
    const seatA = testData.seatIds[0];
    const seatB = testData.seatIds[1];

    const seatsToBook = (__VU % 2 === 0)
        ? [seatA, seatB]
        : [seatB, seatA];

    const idempotencyKey = `k6-${__VU}-${__ITER}-${Date.now()}-${Math.random()}`;

    const url = 'http://host.docker.internal:4000/bookings';
    const payload = JSON.stringify({
        userId: testData.userId,
        eventId: testData.eventId,
        seatIds: seatsToBook,
    });

    const params = {
        headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
        },
    };

    const res = http.post(url, payload, params);

    if (res.status === 201) {
        successfulBookings.add(1);
    } else if (res.status === 409) {
        conflictBookings.add(1);
    } else {
        unexpectedErrors.add(1);
        console.error(`[ERROR] Непредвиденный статус ${res.status}: ${res.body}`);
    }

    check(res, {
        'status is 201 or 409': (r) => r.status === 201 || r.status === 409,
    });
}

