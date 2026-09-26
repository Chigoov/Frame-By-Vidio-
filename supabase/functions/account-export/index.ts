import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return Response.json({ error: 'Method tidak didukung.' }, { status: 405, headers: cors });
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return Response.json({ error: 'Sesi akun diperlukan.' }, { status: 401, headers: cors });

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !key) return Response.json({ error: 'Konfigurasi backend belum lengkap.' }, { status: 503, headers: cors });
  const client = createClient(url, key, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError || !auth.user) return Response.json({ error: 'Sesi akun tidak valid.' }, { status: 401, headers: cors });

  const [profile, projects, exports, jobs, assets, subscription, usage] = await Promise.all([
    client.from('profiles').select('display_name,created_at,updated_at').eq('user_id', auth.user.id).maybeSingle(),
    client.from('projects').select('*').eq('user_id', auth.user.id).order('created_at'),
    client.from('local_exports').select('*').eq('user_id', auth.user.id).order('created_at'),
    client.from('jobs').select('id,project_id,kind,status,request_key,options,output_count,error_code,created_at,updated_at,completed_at')
      .eq('user_id', auth.user.id).order('created_at'),
    client.from('assets').select('id,job_id,mime_type,width,height,size_bytes,sha256,created_at,expires_at')
      .eq('user_id', auth.user.id).order('created_at'),
    client.from('subscriptions').select('provider,product_id,state,current_period_end,updated_at').eq('user_id', auth.user.id).maybeSingle(),
    client.from('usage_ledger').select('usage_type,quantity,created_at').eq('user_id', auth.user.id).order('created_at'),
  ]);
  const failed = [profile, projects, exports, jobs, assets, subscription, usage].find((result) => result.error);
  if (failed?.error) return Response.json({ error: 'Data akun belum dapat diekspor.' }, { status: 500, headers: cors });

  return Response.json({
    exported_at: new Date().toISOString(),
    account: { id: auth.user.id, email: auth.user.email, created_at: auth.user.created_at, profile: profile.data },
    projects: projects.data,
    local_exports: exports.data,
    cloud_jobs: jobs.data,
    cloud_assets: assets.data,
    subscription: subscription.data,
    usage: usage.data,
  }, { headers: { ...cors, 'Cache-Control': 'no-store' } });
});
