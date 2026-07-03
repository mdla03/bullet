const TWITTER_AUTH_URL = "https://twitter.com/i/oauth2/authorize";
const TWITTER_TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const TWITTER_ME_URL = "https://api.twitter.com/2/users/me?user.fields=username";

export function isConfigured(): boolean {
  return Boolean(
    process.env.X_CLIENT_ID &&
      process.env.X_CLIENT_SECRET &&
      process.env.X_OAUTH_CALLBACK_URL
  );
}

export { generatePKCE } from "./oauth-utils.js";

export function buildAuthUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.X_CLIENT_ID ?? "",
    redirect_uri: process.env.X_OAUTH_CALLBACK_URL ?? "",
    scope: "users.read tweet.read",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${TWITTER_AUTH_URL}?${params}`;
}

export async function exchangeCode(
  code: string,
  codeVerifier: string
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.X_OAUTH_CALLBACK_URL ?? "",
    code_verifier: codeVerifier,
  });
  const credentials = Buffer.from(
    `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`
  ).toString("base64");
  const res = await fetch(TWITTER_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("no access_token in response");
  return data.access_token;
}

export interface TwitterProfile {
  subject: string;    // stable numeric ID
  username: string;   // handle without leading '@'
}

export async function fetchProfile(accessToken: string): Promise<TwitterProfile> {
  const res = await fetch(TWITTER_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`/users/me failed: ${res.status}`);
  const data = (await res.json()) as { data?: { id?: string; username?: string } };
  const subject = data.data?.id;
  const username = data.data?.username;
  if (!subject || !username) throw new Error("missing id/username in response");
  return { subject, username };
}
