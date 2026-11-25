// Cliente Supabase con el JWT del usuario que llama: TODAS las consultas pasan por RLS.
// Nunca se usa la service_role en estas funciones.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2';

export async function userClient(req: Request): Promise<{ client: SupabaseClient; user: User } | null> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(auth.slice(7));
  if (error || !data.user) return null;
  return { client, user: data.user };
}
