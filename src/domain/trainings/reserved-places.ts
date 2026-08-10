export const MIN_RESERVED_PLACES = 1;
export const MAX_RESERVED_PLACES = 4;

export function isValidReservedPlaces(value: number): boolean {
    return Number.isInteger(value) && value >= MIN_RESERVED_PLACES && value <= MAX_RESERVED_PLACES;
}

export function validateReservedPlaces(value: number): void {
    if (!isValidReservedPlaces(value)) {
        throw new Error(`Кількість місць має бути від ${MIN_RESERVED_PLACES} до ${MAX_RESERVED_PLACES}`);
    }
}
