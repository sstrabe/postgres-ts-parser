import postgres from 'postgres';

declare function rowTag<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
declare function plainTag(strings: TemplateStringsArray, ...values: unknown[]): string;

const dbClient = { sql: postgres() };

export const a = dbClient.sql`SELECT id FROM users`;
export const b = rowTag`SELECT id FROM users`;
export const c = plainTag`SELECT id FROM users`;
