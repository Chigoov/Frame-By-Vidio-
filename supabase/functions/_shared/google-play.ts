const encode = (value: Uint8Array | string) => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

export const sha256Hex = async (value: string) => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  (byte) => byte.toString(16).padStart(2, '0'),
).join('');

export async function getPlayAccessToken(accountJson: string) {
  const account = JSON.parse(accountJson);
  if (typeof account.client_email !== 'string' || typeof account.private_key !== 'string') {
    throw new Error('Akun layanan Google tidak valid.');
  }
  const tokenUrl = account.token_uri || 'https://oauth2.googleapis.com/token';
  if (tokenUrl !== 'https://oauth2.googleapis.com/token') throw new Error('Alamat token Google tidak valid.');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${encode(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: tokenUrl,
    iat: now,
    exp: now + 3600,
  }))}`;
  const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const pkcs8 = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${encode(new Uint8Array(signature))}`;
  const response = await fetch(tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await response.json();
  if (!response.ok || typeof data.access_token !== 'string') throw new Error('Google Play API belum memberi akses.');
  return data.access_token as string;
}

export async function getSubscriptionPurchase(packageName: string, purchaseToken: string, accessToken: string) {
  const response = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  return { response, data };
}

export const playSubscriptionStates: Record<string, string> = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'in_grace_period',
  SUBSCRIPTION_STATE_CANCELED: 'cancelled',
  SUBSCRIPTION_STATE_ON_HOLD: 'on_hold',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
  SUBSCRIPTION_STATE_PENDING: 'pending',
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'expired',
};
