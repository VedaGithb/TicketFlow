import client from 'prom-client';

client.collectDefaultMetrics({ prefix: 'ticketflow_' });

export const httpRequestCounter = new client.Counter({
    name: 'ticketflow_http_request_total',
    help: 'Total number of HTTP request',
    labelNames: ['method', 'route', 'status_code'] as const
});

export const httpRequestDuration = new client.Histogram({
    name: 'ticketflow_http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]
})

export const register = client.register