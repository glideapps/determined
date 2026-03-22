import { type BrandedString, makeBrandString } from "@glideapps/ts-necessities";

export type ErrorType = BrandedString<"ErrorType">;
export const makeErrorType = makeBrandString<ErrorType>();

export class ApplicationFailure extends Error {
    public readonly type: ErrorType | undefined;
    public readonly nonRetryable: boolean;

    constructor(message: string, type?: ErrorType, nonRetryable?: boolean) {
        super(message);
        this.type = type;
        this.nonRetryable = nonRetryable ?? false;
    }
}

export function isApplicationFailure(error: unknown): error is ApplicationFailure {
    return error instanceof ApplicationFailure;
}
