# TicketFlow

Высоконагруженный сервис бронирования билетов на мероприятия в условиях пикового спроса (Flash Sale).

Проект решает классическую проблему конкурентности при ажиотажных продажах: сотни пользователей одновременно нажимают «Купить» на ограниченное количество мест. Архитектура гарантирует строгую целостность данных, нулевой овербукинг и отсутствие взаимных блокировок базы данных (дедлоков).

---

## Стек технологий

* **Язык и среда:** Node.js 24, TypeScript (строгий режим: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, zero `any`)
* **Веб-фреймворк:** Fastify 5 (плагинная архитектура, централизованный `setErrorHandler` и иерархия `AppError`)
* **СУБД:** PostgreSQL 16 + Drizzle ORM (ACID транзакции, строгие типы, миграции, `SAVEPOINT`)
* **Быстрое хранилище и брокер:** Redis 7 + ioredis (кэш, распределённые локи идемпотентности, Pub/Sub)
* **Очередь задач:** BullMQ (отложенные задачи автоматического истечения неоплаченной брони)
* **Безопасность и аутентификация:** `@fastify/jwt`, `bcryptjs`, `@fastify/rate-limit` (на базе Redis), валидация через Zod
* **Real-Time:** WebSockets (`@fastify/websocket`) с группировкой по комнатам и heartbeat
* **Мониторинг:** Prometheus (`prom-client`) + Grafana (RPS, latency p95/p99)
* **Документация:** Swagger / OpenAPI (`@fastify/swagger`, `@fastify/swagger-ui`) и лог решений ([docs/decisions.md](docs/decisions.md))
* **Тестирование и инфраструктура:** Интеграционные тесты (`node:test` + `tsx`), нагрузочные тесты `k6`, Multi-stage `Dockerfile`, Docker Compose

---

## Архитектурные решения

### 1. Защита от Race Condition, дедлоков и невалидных мест
* Блокировка мест на уровне строк: `SELECT ... FROM seats WHERE id IN (...) ORDER BY id FOR UPDATE`.
* **Устранение дедлоков:** массив запрашиваемых ID мест детерминированно сортируется перед запросом (`[...seatIds].sort()`) и фиксируется явный порядок `ORDER BY id` в SQL. Это исключает циклическое ожидание (Circular Wait) при встречных запросах (`[A, B]` и `[B, A]`).
* **Валидация границ:** дубликаты мест отсекаются на уровне Zod-схемы (`.refine`), а внутри транзакции проверяется существование всех запрошенных мест и их принадлежность указанному `eventId`.

### 2. Идемпотентность заказов (Idempotency Key)
* Запрос на создание брони принимает обязательный заголовок `Idempotency-Key: <uuid>`.
* В Redis атомарно выставляется блокировка через `SET key PROCESSING EX 120 NX`.
* При повторном клике или ретрае сервер возвращает закешированный результат успешного создания брони без дублирования в БД.
* **Изоляция пост-коммит сбоев:** запись результата в кэш Redis (`SET`) и отправка WebSocket-уведомления вынесены в отдельный `try/catch` после коммита транзакции PostgreSQL — сбой Redis после коммита не удаляет ключ идемпотентности и не превращает созданную бронь в ложный `500`.

### 3. Аутентификация (JWT) и оплата с защитой от Expiration Race
* Пользователи регистрируются и входят через `/auth/register` и `/auth/login` с хешированием паролей через `bcryptjs` и подписью JWT.
* **Защита от BOLA/IDOR:** `userId` никогда не принимается из тела запроса — он извлекается исключительно из проверенного JWT (`request.user.id`).
* **Оплата без гонки со временем:** `POST /bookings/:id/pay` переводит бронь из `PENDING` в `CONFIRMED` одним атомарным условным `UPDATE ... WHERE id = $1 AND user_id = $2 AND status = 'PENDING' AND expires_at > NOW()`. Это защищает от овербукинга на границе 15-минутного таймера, когда фоновый воркер и запрос на оплату приходят одновременно.

### 4. Transactional Outbox Pattern + изоляция Poison Pill
* Создание брони и запись события `BOOKING_CREATED` происходят в **единой ACID-транзакции PostgreSQL**.
* Фоновый **Outbox Relay** выбирает пачку до 20 `PENDING`-событий с `FOR UPDATE SKIP LOCKED` и ставит отложенную задачу в **BullMQ**.
* **Устойчивость к битым сообщениям:** обработка каждого события в пачке изолирована через вложенный PostgreSQL `SAVEPOINT` (`tx.transaction`). При ошибке валидации payload или сбое постановки в очередь пачка не откатывается целиком — увеличивается `retryCount`, сохраняется `lastError`, а после `3` неудачных попыток событие переводится в статус `FAILED` (Dead Letter), не блокируя остальные заказы.

### 5. Real-Time синхронизация зала (WebSockets + Redis Pub/Sub)
* Клиенты подключаются к комнате события: `ws://host/events/:id/live`.
* **Ленивая подписка (Lazy Subscription):** Redis подписывается на канал зала только при входе первого клиента и отписывается, когда комната пустеет.
* Серверный **Heartbeat (Ping-Pong)** с `.unref()` каждые 30 секунд очищает мёртвые соединения, не блокируя корректное завершение процесса.

### 6. Production Hardening
* **Единая обработка ошибок:** иерархия классов `AppError` (`BadRequestError`, `NotFoundError`, `ConflictError`) с машиночитаемыми кодами (`SEATS_OCCUPIED`, `BOOKING_EXPIRED`, `BOOKING_NOT_FOUND` и др.) и глобальный `setErrorHandler` в Fastify, скрывающий внутренние ошибки 500 от клиента.
* **Graceful Shutdown:** обработка `SIGINT`/`SIGTERM` закрывает HTTP-сервер, воркер BullMQ, таймер Outbox Relay, клиенты Redis и пул PostgreSQL.
* **Конфигурируемый Rate Limiting:** лимит запросов на базе Redis вынесен в переменную окружения `RATE_LIMIT_MAX` (по умолчанию `100` req/min на IP).

---

## Результаты стресс-тестирования (k6 Benchmark)

Сценарий проверяет конкуренцию за одну и ту же пару горячих мест во **встречном порядке** (`[seatA, seatB]` у чётных VU и `[seatB, seatA]` у нечётных VU): **100 виртуальных пользователей (VUs)**, **300 запросов на бронирование** с уникальными `Idempotency-Key` и предварительной JWT-аутентификацией в `setup()`.

Условия замера: локальный production-билд (`npm run build && node dist/src/index.js`) с `RATE_LIMIT_MAX=1000` (поднят для нагрузки с одного IP Docker-контейнера `host.docker.internal`), инфраструктура в Docker Compose.

```text
  █ THRESHOLDS

    http_req_duration
    ✓ 'p(95)<300' p(95)=291.85ms

    successful_bookings
    ✓ 'count>=1' count=1

    unexpected_errors
    ✓ 'count==0' count=0

  █ TOTAL RESULTS

    checks_total.......: 300     322.464583/s
    checks_succeeded...: 100.00% 300 out of 300
    checks_failed......: 0.00%   0 out of 300

    CUSTOM
    conflict_bookings..............: 299    321.389701/s
    successful_bookings............: 1      1.074882/s
    unexpected_errors..............: 0      0/s

    HTTP
    http_req_duration..............: avg=223.71ms min=66.18ms med=223.54ms max=330.16ms p(90)=271.63ms p(95)=291.85ms
    http_reqs......................: 301    323.539465/s
```

### Итоги проверки целостности данных:
* **Овербукинг:** ровно **0** (проверено SQL-запросом `GROUP BY seat_id HAVING count(*) > 1`).
* **Дедлоки:** ровно **0** ошибок `40P01` в логах PostgreSQL при 100% встречной блокировке пары мест.
* **Пропускная способность:** **~323 req/s**, **p95 = 291.85 ms** на одном инстансе Node.js.

---

## Быстрый старт

### 1. Предварительные требования
* Node.js 24+ (или Node.js 20+)
* Docker и Docker Compose

### 2. Установка и настройка окружения
```bash
git clone https://github.com/VedaGithb/TicketFlow.git
cd TicketFlow
npm install
cp .env.example .env
```
*(На Windows PowerShell: `copy .env.example .env`. В продакшене обязательно задайте надёжный `JWT_SECRET`.)*

### 3. Запуск инфраструктуры (PostgreSQL, Redis, Prometheus, Grafana)
```bash
docker compose up -d
```

### 4. Миграции БД и тестовые данные
```bash
npm run db:migrate
npx tsx src/db/seed.ts
```

### 5. Запуск сервера
* В dev-режиме:
```bash
npm run dev
```
* В production-режиме:
```bash
npm run build
npm start
```
* Сборка Docker-образа приложения (multi-stage):
```bash
docker build -t ticketflow .
```

Сервер запускается на `http://localhost:4000`.

---

## API Эндпоинты

| Метод | Путь | Авторизация | Описание |
| :--- | :--- | :---: | :--- |
| `POST` | `/auth/register` | — | Регистрация пользователя и выдача JWT |
| `POST` | `/auth/login` | — | Аутентификация и выдача JWT |
| `POST` | `/bookings` | Bearer JWT | Создание брони (обязателен `Idempotency-Key`) |
| `POST` | `/bookings/:id/pay` | Bearer JWT | Подтверждение оплаты брони (`PENDING` → `CONFIRMED`) |
| `GET` | `/events/:id/live` | — | WebSocket-канал обновлений мест зала |
| `GET` | `/docs` | — | Интерактивная Swagger / OpenAPI документация |
| `GET` | `/health` | — | Healthcheck сервиса |
| `GET` | `/metrics` | — | Метрики для Prometheus |

---

## Тестирование

### Интеграционные тесты
Проверяют реальные PostgreSQL и Redis (авторизация, идемпотентность, 10 конкурентных запросов с встречным порядком мест, оплату + гонку истечения срока и Poison Pill в Outbox Relay):
```bash
npm test
```

### Нагрузочный стресс-тест (k6)
1. Сгенерировать свежий пул из 100 мест:
```bash
npx tsx scripts/seed-loadtest.ts
```
2. Запустить сервер с повышенным лимитом запросов (чтобы не упереться в `RATE_LIMIT_MAX=100` с одного IP контейнера):
```bash
RATE_LIMIT_MAX=1000 npm start
```
*(В PowerShell: `$env:RATE_LIMIT_MAX=1000; npm start`.)*

3. Запустить стресс-тест через официальный Docker-контейнер `k6`:
```bash
docker run --rm -v "${PWD}:/scripts" -w /scripts grafana/k6 run k6-stress-test.js
```

---

## Ограничения и направления развития (Limitations & Future Improvements)

* **Оплата реализована как синхронная заглушка:** `POST /bookings/:id/pay` напрямую переводит бронь в `CONFIRMED` без интеграции с внешним платёжным провайдером (Stripe / ЮKassa) и асинхронного подтверждения по webhook.
* **Фиксированные ретраи в Outbox Relay:** сейчас воркер опрашивает БД каждые 2 секунды и при 3 ошибках подряд переводит событие в `FAILED` без отложенного времени следующей попытки (`nextRetryAt` / exponential backoff). При недоступности Redis дольше ~6 секунд корректные события могут попасть в `FAILED`.
* **Одиночные узлы PostgreSQL и Redis:** при масштабировании до десятков тысяч RPS потребуются read-реплики для чтения карты зала, шардирование по `eventId` и Redis Cluster, а также аутентификация на WebSocket-подключениях при переходе к приватным событиям.
* **Локальный бенчмарк:** результаты `k6` получены на одной машине в связке с Docker, а не в распределённом кластере с сетевыми задержками между узлами.
