declare function sql<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;

export async function load(id: number) {
  const [user] = await sql<{ id: number; name: string | null; role: "admin" | "member" | "owner" }>`SELECT id, name, role FROM users WHERE id = ${id}`;
  return user;
}

export const broken = () => sql`SELECT nope FROM users`;
