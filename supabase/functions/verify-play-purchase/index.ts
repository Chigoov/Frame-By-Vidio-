import { createClient } from 'npm:@supabase/supabase-js@2';
import { getPlayAccessToken, getSubscriptionPurchase, playSubscriptionStates, sha256Hex } from '../_shared/google-play.ts';

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
  const productId = typeof body?.productId === 'string' ? body.productId : '';
  const purchaseToken = typeof body?.purchaseToken === 'string' ? body.purchaseToken : '';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(productId) || purchaseToken.length < 20 || purchaseToken.length > 4096) {
    return json({ error: 'Data pembelian tidak valid.' }, 400);
  }
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Sesi akun diperlukan.' }, 401);
  const url = Deno.env.get('SUPABASE_URL');
  const publicKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const packageName = Deno.env.get('GOOGLE_PLAY_PACKAGE_NAME');
  const allowlist = new Set((Deno.env.get('GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_IDS') ?? '').split(',').map((item) => item.trim()).filter(Boolean));
  const accountJson = Deno.env.get('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
  if (!url || !publicKey || !serviceKey || !packageName || !accountJson || allowlist.size === 0) {
    return json({ error: 'Verifikasi Google Play belum dikonfigurasi.' }, 503);
  }
  if (!allowlist.has(productId)) return json({ error: 'Produk langganan tidak dikenal.' }, 400);

  const userClient = createClient(url, publicKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth.user) return json({ error: 'Sesi akun tidak valid.' }, 401);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const tokenHash = await sha256Hex(purchaseToken);
  const { data: previous, error: previousError } = await admin.from('play_purchases').select('user_id').eq('token_hash', tokenHash).maybeSingle();
  if (previousError) return json({ error: 'Status pembelian belum dapat diperiksa.' }, 500);
  if (previous && previous.user_id !== auth.user.id) return json({ error: 'Pembelian ini sudah terhubung ke akun Jeda lain.' }, 409);

  try {
    const accessToken = await getPlayAccessToken(accountJson);
    const { response: playResponse, data: purchase } = await getSubscriptionPurchase(packageName, purchaseToken, accessToken);
    if (!playResponse.ok) return json({ error: 'Google Play belum mengonfirmasi pembelian ini.' }, 402);
    const lineItem = purchase.lineItems?.find((item: { productId?: string }) => item.productId === productId);
    if (!lineItem) return json({ error: 'Produk pada bukti pembelian tidak cocok.' }, 400);
    if (purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId !== await sha256Hex(auth.user.id)) {
      return json({ error: 'Pembelian tidak terikat ke akun Jeda ini.' }, 409);
    }
    const state = playSubscriptionStates[purchase.subscriptionState];
    if (!state) return json({ error: 'Status langganan dari Google Play tidak dikenal.' }, 502);
    const expiresAt = lineItem.expiryTime ?? null;
    const hasFutureExpiry = Boolean(expiresAt) && Date.parse(expiresAt) > Date.now();
    const thisPurchaseEntitled = hasFutureExpiry && ['active', 'in_grace_period', 'cancelled'].includes(state);
    const verifiedAt = new Date().toISOString();
    const purchaseRow = {
      token_hash: tokenHash,
      user_id: auth.user.id,
      product_id: productId,
      state,
      expires_at: expiresAt,
      last_verified_at: verifiedAt,
    };
    const { error: insertError } = await admin.from('play_purchases').upsert(purchaseRow, { onConflict: 'token_hash', ignoreDuplicates: true });
    if (insertError) throw new Error('Status transaksi belum dapat disimpan.');
    const { data: storedPurchase, error: storedError } = await admin.from('play_purchases')
      .select('user_id').eq('token_hash', tokenHash).maybeSingle();
    if (storedError) throw new Error('Status transaksi belum dapat diperiksa.');
    if (storedPurchase?.user_id !== auth.user.id) return json({ error: 'Pembelian ini sudah terhubung ke akun Jeda lain.' }, 409);
    const { error: updatePurchaseError } = await admin.from('play_purchases')
      .update({ state, expires_at: expiresAt, last_verified_at: verifiedAt })
      .eq('token_hash', tokenHash).eq('user_id', auth.user.id);
    if (updatePurchaseError) throw new Error('Status transaksi belum dapat diperbarui.');

    const { data: activePurchases, error: activeError } = await admin.from('play_purchases')
      .select('product_id,state,expires_at')
      .eq('user_id', auth.user.id)
      .in('state', ['active', 'in_grace_period', 'cancelled'])
      .gt('expires_at', verifiedAt)
      .order('expires_at', { ascending: false });
    if (activeError) throw new Error('Status langganan belum dapat dihitung.');
    const bestEntitlement = activePurchases?.[0];
    const entitled = Boolean(bestEntitlement);
    const { error: subscriptionError } = await admin.from('subscriptions').upsert({
      user_id: auth.user.id,
      provider: 'google_play',
      product_id: bestEntitlement?.product_id ?? productId,
      state: bestEntitlement?.state ?? state,
      current_period_end: bestEntitlement?.expires_at ?? expiresAt,
      updated_at: verifiedAt,
    }, { onConflict: 'user_id' });
    if (subscriptionError) throw new Error('Status langganan belum dapat disimpan.');

    if (thisPurchaseEntitled && purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
      const acknowledge = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!acknowledge.ok) return json({ error: 'Pembelian terverifikasi, tetapi pengakuan transaksi Google Play gagal. Tekan Pulihkan Pembelian untuk mencoba kembali.' }, 502);
    }
    return json({ entitled, state, currentPeriodEnd: expiresAt });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Verifikasi Google Play gagal.' }, 502);
  }
});
