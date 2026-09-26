import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { ...cors, 'Cache-Control': 'no-store' } });

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json({ error: 'Method tidak didukung.' }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Permintaan tidak valid.' }, 400); }
  if (body?.confirmation !== 'HAPUS') return json({ error: 'Konfirmasi penghapusan tidak cocok.' }, 400);
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Sesi akun diperlukan.' }, 401);

  const url = Deno.env.get('SUPABASE_URL');
  const publicKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !publicKey || !serviceKey) return json({ error: 'Konfigurasi backend belum lengkap.' }, 503);
  const userClient = createClient(url, publicKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth.user) return json({ error: 'Sesi akun tidak valid.' }, 401);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: deleteAfter, error } = await admin.rpc('request_account_deletion', { p_user_id: auth.user.id });
  if (error) {
    if (error.message?.includes('account_not_found')) return json({ error: 'Akun tidak ditemukan.' }, 404);
    return json({ error: 'Permintaan penghapusan belum dapat dijadwalkan.' }, 500);
  }
  return json({ deleted: false, requested: true, deleteAfter });
});
