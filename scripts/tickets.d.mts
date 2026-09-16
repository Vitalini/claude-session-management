export function ticketsEnabled(): boolean;
export function ticketBaseUrl(): string;
export function ticketKeyPattern(): string;
export function ticketKeyRe(flags?: string): RegExp;
export function parseTicketKey(text: string | null | undefined): string | null;
export function bareKeyExact(text: string | null | undefined): string | null;
export function ticketKeyExact(text: string | null | undefined): string | null;
export function ticketUrl(key: string | null | undefined): string | null;
export function keyFromUrl(text: string | null | undefined): string | null;
