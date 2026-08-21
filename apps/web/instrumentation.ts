/**
 * Vercel reserves the whole `AWS_*` environment namespace for the Lambda that
 * runs each function — `AWS_REGION`, `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY` can't be set as project variables, and the values
 * that *are* present belong to Vercel's own execution role, which has no
 * Bedrock access. So the deployment carries the Bedrock credentials under
 * `GRAF_AWS_*` names and they're mapped back here.
 *
 * `register()` runs once per server instance before any request is handled,
 * which is what makes this safe: `@aws-sdk/client-bedrock-runtime` resolves the
 * credential chain when a client is first constructed, and every client in the
 * pipeline is constructed lazily inside a request.
 *
 * Local development sets the real `AWS_*` vars (via the root `.env` or an
 * ordinary AWS profile) and never has the `GRAF_AWS_*` ones, so this is a no-op
 * there rather than something to remember to keep in sync.
 */
export async function register() {
  const mapping = {
    AWS_REGION: process.env.GRAF_AWS_REGION,
    AWS_ACCESS_KEY_ID: process.env.GRAF_AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.GRAF_AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.GRAF_AWS_SESSION_TOKEN,
  }
  for (const [name, value] of Object.entries(mapping)) {
    if (value) process.env[name] = value
  }
}
