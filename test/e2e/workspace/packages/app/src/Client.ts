import postgres from 'postgres';

export class Client {
  readonly sql = postgres(process.env.DATABASE_URL ?? '');
}

export const dbClient = new Client();
