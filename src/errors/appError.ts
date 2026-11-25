export class AppError extends Error {
    statusCode: number;
    code?: string

    constructor(message: string, statusCode: number, code?: string) {
        super(message);
        this.statusCode = statusCode;
        if (code) {
            this.code = code;
        }
        this.name = this.constructor.name;
    };
};

export class BadRequestError extends AppError {
    constructor(message: string, code?: string) {
        super(message, 400, code)
    }
}

export class NotFoundError extends AppError {
    constructor(message: string, code?: string) {
        super(message, 404, code)
    }
}

export class ConflictError extends AppError {
    constructor(message: string, code?: string) {
        super(message, 409, code)
    }
}