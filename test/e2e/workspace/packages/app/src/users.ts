import { dbClient } from './Client';

export async function listUsers() {
  const users = await dbClient.sql`SELECT * FROM users;`;
  return users[0];
}
