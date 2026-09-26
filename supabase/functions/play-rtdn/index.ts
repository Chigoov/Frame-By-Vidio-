import { createClient } from 'npm:@supabase/supabase-js@2';
import { getPlayAccessToken, getSubscriptionPurchase, playSubscriptionStates, sha256Hex } from '../_shared/google-play.ts';

type Claims = { aud?: string | string[]; email?: string; email_verified?: boolean; exp?: number; iat?: number; iss?: string };
type GoogleJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
let signingKeys: GoogleJwk[] = [];
let keysExpireAt = 0;

const response = (status: number) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
const decodeBase64Url = (value: string) => {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};
const decodeJson = (value: string) => JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));

async function getSigningKey(kid: string, refresh = false): Promise<GoogleJwk | undefined> {
  if (refresh || Date.now() >= keysExpireAt) {
    const result = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(10000) });
    if (!result.ok) throw new Error('Google signing keys unavailable.');
    const data = await result.json();
    if (!Array.isArray(data.keys)) throw new Error('Google signing keys invalid.');
    signingKeys = data.keys;
    const maxAge = Number(result.headers.get('cache-control')?.match(/max-age=(\d+)/i)?.[1] ?? 300);
    keysExpireAt = Date.now() + Math.min(86400, Math.max(60, maxAge)) * 1000;
  }
  return signingKeys.find((key) => key.kid === kid && key.kty === 'RSA' && key.alg === 'RS256' && key.use === 'sig');
}

async function verifyPushToken(token: string, audience: string, serviceEmail: string): Promise<boolean> {
  if (token.length > 8192) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  let header: { alg?: string; kid?: string };
  let claims: Claims;
  try { header = decodeJson(parts[0]); claims = decodeJson(parts[1]); }
  catch { return false; }
  if (header.alg !== 'RS256' || !header.kid || header.kid.length > 128) return false;
  const expectedAudience = Array.isArray(claims.aud) ? claims.aud.includes(audience) : claims.aud === audience;
  const now = Math.floor(Date.now() / 1000);
  if (!expectedAudience || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss ?? '')
      || claims.email !== serviceEmail || claims.email_verified !== true
      || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
      || claims.iat! > now + 60 || claims.exp! <= now - 60 || claims.exp! <= claims.iat!
      || claims.exp! - claims.iat! > 3900) return false;
  let key = await getSigningKey(header.kid);
  if (!key) key = await getSigningKey(header.kid, true);
  if (!key) return false;
  try {
    const publicKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { return false; }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return response(405);
  const audience = Deno.env.get('PLAY_RTDN_AUDIENCE');
  const serviceEmail = Deno.env.get('PLAY_RTDN_SERVICE_ACCOUNT_EMAIL');
  const subscriptionName = Deno.env.get('PLAY_RTDN_SUBSCRIPTION_NAME');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const packageName = Deno.env.get('GOOGLE_PLAY_PACKAGE_NAME');
  const accountJson = Deno.env.get('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
  const products = new Set((Deno.env.get('GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_IDS') ?? '').split(',').map((item) => item.trim()).filter(Boolean));
  if (!audience || !serviceEmail || !subscriptionName || !supabaseUrl || !serviceKey || !packageName || !accountJson || !products.size) return response(503);

  const authorization = request.headers.get('Authorization') ?? '';
  const bearer = authorization.match(/^Bearer ([A-Za-z0-9._-]+)$/)?.[1];
  if (!bearer) return response(401);
  let authenticated: boolean;
  try { authenticated = await verifyPushToken(bearer, audience, serviceEmail); }
  catch { return response(503); }
  if (!authenticated) return response(401);

  let envelope: { subscription?: string; message?: { data?: string } };
  try {
    const body = await request.text();
    if (body.length > 65536) return response(413);
    envelope = JSON.parse(body);
  } catch { return response(400); }
  if (envelope.subscription !== subscriptionName || typeof envelope.message?.data !== 'string') return response(401);
  let notification: Record<string, any>;
  try { notification = JSON.parse(new TextDecoder().decode(decodeBase64Url(envelope.message.data))); }
  catch { return response(400); }
  if (notification.testNotification) return response(204);
  if (notification.packageName !== packageName) return response(400);

  const purchaseToken = notification.subscriptionNotification?.purchaseToken ?? notification.voidedPurchaseNotification?.purchaseToken;
  if (typeof purchaseToken !== 'string' || purchaseToken.length < 20 || purchaseToken.length > 4096) return response(204);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let accessToken: string;
  try { accessToken = await getPlayAccessToken(accountJson); }
  catch { return response(503); }
  let purchaseResult;
  try { purchaseResult = await getSubscriptionPurchase(packageName, purchaseToken, accessToken); }
  catch { return response(503); }
  if (!purchaseResult.response.ok) {
    return response(purchaseResult.response.status === 404 || purchaseResult.response.status === 410 ? 204 : 503);
  }

  const purchase = purchaseResult.data;
  const lineItems = Array.isArray(purchase.lineItems) ? purchase.lineItems : [];
  const lineItem = lineItems.find((item: { productId?: string }) => products.has(item.productId ?? ''));
  const tokenHash = await sha256Hex(purchaseToken);
  const { data: direct, error: directError } = await admin.from('play_purchases').select('user_id,product_id').eq('token_hash', tokenHash).maybeSingle();
  if (directError) return response(503);

  let linkedUser = direct?.user_id;
  if (!linkedUser && typeof purchase.linkedPurchaseToken === 'string') {
    const linkedHash = await sha256Hex(purchase.linkedPurchaseToken);
    const { data: previous, error: previousError } = await admin.from('play_purchases').select('user_id').eq('token_hash', linkedHash).maybeSingle();
    if (previousError) return response(503);
    linkedUser = previous?.user_id;
  }
  if (!linkedUser) return response(204);
  if (!lineItem) return response(503);

  const state = playSubscriptionStates[purchase.subscriptionState];
  if (!state) return response(503);
  const now = new Date().toISOString();
  const revoked = Boolean(notification.voidedPurchaseNotification);
  const expiresAt = revoked ? now : lineItem.expiryTime ?? null;
  const purchaseRow = {
    token_hash: tokenHash, user_id: linkedUser, product_id: lineItem.productId,
    state: revoked ? 'expired' : state, expires_at: expiresAt, last_verified_at: now,
  };
  const { error: saveError } = await admin.from('play_purchases').upsert(purchaseRow, { onConflict: 'token_hash', ignoreDuplicates: true });
  if (saveError) return response(503);
  const { data: stored, error: storedError } = await admin.from('play_purchases').select('user_id').eq('token_hash', tokenHash).maybeSingle();
  if (storedError) return response(503);
  if (stored?.user_id !== linkedUser) return response(204);
  const { error: updateError } = await admin.from('play_purchases').update({ state: purchaseRow.state, expires_at: expiresAt, last_verified_at: now })
    .eq('token_hash', tokenHash).eq('user_id', linkedUser);
  if (updateError) return response(503);

  const { data: active, error: activeError } = await admin.from('play_purchases').select('product_id,state,expires_at')
    .eq('user_id', linkedUser).in('state', ['active', 'in_grace_period', 'cancelled']).gt('expires_at', now)
    .order('expires_at', { ascending: false });
  if (activeError) return response(503);
  const best = active?.[0];
  const { error: subscriptionError } = await admin.from('subscriptions').upsert({
    user_id: linkedUser, provider: 'google_play', product_id: best?.product_id ?? lineItem.productId,
    state: best?.state ?? (revoked ? 'expired' : state), current_period_end: best?.expires_at ?? expiresAt, updated_at: now,
  }, { onConflict: 'user_id' });
  return subscriptionError ? response(503) : response(204);
});
