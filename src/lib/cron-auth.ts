export const CRON_SECRET_HEADER = "x-cron-secret";
export const REFRESH_TRIGGER_HEADER = "x-refresh-triggered-by";

export function isValidCronSecret(value: string | null | undefined): boolean {
  const configuredSecret = process.env.CRON_SECRET;

  if (!configuredSecret) {
    return false;
  }

  return value === configuredSecret;
}

export function isAuthorizedCronRequest(request: Pick<Request, "headers">): boolean {
  return isValidCronSecret(request.headers.get(CRON_SECRET_HEADER));
}
