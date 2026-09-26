import {
  ConnectError,
  ConnectorInstallationRequiredError,
  getTokenResponse,
  NoValidTokenError,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import { FatalError } from "workflow";

type TokenParams = Parameters<typeof getTokenResponse>[1];

/**
 * getTokenResponse, but authorization problems (connector not authorized, not linked
 * to this project, grant revoked) become FatalErrors: a person has to fix them, so
 * retrying the step would only waste time. Rate limits and server errors still retry.
 */
export async function connectToken(connector: string, params: TokenParams) {
  try {
    return await getTokenResponse(connector, params);
  } catch (error) {
    const needsPerson =
      error instanceof ConnectorInstallationRequiredError ||
      error instanceof UserAuthorizationRequiredError ||
      error instanceof NoValidTokenError ||
      (error instanceof ConnectError && isClientError((error as ConnectError & { status?: number }).status));
    if (needsPerson) throw new FatalError(`Vercel Connect ${connector}: ${(error as Error).message}`);
    throw error;
  }
}

function isClientError(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 429;
}
