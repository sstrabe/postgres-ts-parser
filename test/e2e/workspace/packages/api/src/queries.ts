declare function sql<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;

export async function load(id: number) {
  const [user] = await sql`SELECT id, name, role FROM users WHERE id = ${id}`;
  return user;
}

export async function longQuery() {
  const rows = await sql`SELECT * FROM users WHERE id = ${1}`;
  return rows[0];
}

export const broken = () => sql`SELECT nope FROM users`;

export const nextId = async () => ((await load(1)).id + 1).toFixed();
