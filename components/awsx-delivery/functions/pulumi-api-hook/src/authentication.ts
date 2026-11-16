import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';

const sts = new STSClient({});

// Temporary preview authentication. Replace team tokens when service principals are available.
export async function getToken(
  apiUrl: string,
  organization: string,
  team: string,
): Promise<string> {
  const audience = `urn:pulumi:org:${organization}`;
  const identity = await sts.send(
    new GetWebIdentityTokenCommand({
      Audience: [audience],
      SigningAlgorithm: 'RS256',
      DurationSeconds: 300,
    }),
  );
  if (!identity.WebIdentityToken) throw new Error('AWS returned no identity token');

  const response = await fetch(`${apiUrl}/api/oauth/token`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      audience,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:pulumi:token-type:access_token:team',
      scope: `team:${team}`,
      expiration: '900',
      subject_token: identity.WebIdentityToken,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new HttpError(response.status);
  const token = (await response.json()) as { access_token?: string };
  if (!token.access_token) throw new Error('Pulumi returned no access token');
  return token.access_token;
}

// Deliberately omit response bodies, URLs, and credentials from errors.
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`Pulumi API returned HTTP ${status}`);
  }
}
